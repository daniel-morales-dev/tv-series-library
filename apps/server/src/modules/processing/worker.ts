import type { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { type Statfs, LowDiskError, createCache } from './cache.ts';
import { KeepChildren, type ProbeStreams, type RunFfmpeg, type SpawnInfo, probeStreams as realProbe, runFfmpeg as realRun } from './ffmpeg.ts';
import { type Adoption, InvalidPackageError, type ProcessDeps, SourceMissingError, processMedia } from './process.ts';
import { findWriters, isOurFfmpeg, signalIfSame, terminate } from './proc.ts';
import {
  type ProcessResult,
  claimNext,
  complete,
  fail,
  recover,
  requeue,
  runningWithProcess,
  setProgress,
  setSpawned,
  setTracks,
} from './queue.ts';

const POLL_MS = 5_000;
const PROGRESS_EVERY_MS = 1_000;
const MAX_ERROR_CHARS = 500;
// The main ffmpeg run is nearly all the work; the last stretch (subtitles, rename) completes the bar.
const MAIN_RUN_SHARE = 0.99;

export interface WorkerOptions {
  db: DatabaseSync;
  dataDir: string;
  contentDir: string;
  concurrency?: number;
  /** x264 encoder threads. */
  threads?: number;
  runFfmpeg?: RunFfmpeg;
  probeStreams?: ProbeStreams;
  /** Poll interval for progress files and adopted processes. */
  pollMs?: number;
  now?: () => number;
  /** T47c: copy-mode files stay unpackaged until first play (default true). */
  lazyCopy?: boolean;
  /** Cache of copy packages is evicted LRU above this many bytes (default 20 GB). */
  cacheBudgetBytes?: number;
  /** Free space kept on the HLS volume: the larger of this (default 10 GB) and `minFreePct` (default 10 %) of it. */
  minFreeBytes?: number;
  minFreePct?: number;
  statfs?: Statfs;
  log?: (level: 'info' | 'warn', message: string) => void;
}

export interface Worker {
  /** Starts queued jobs up to the concurrency limit; cheap to call any time. */
  kick(): void;
  /** Makes a file's queued job run next, interrupting a running job of another file (it is requeued). */
  prioritize(mediaFileId: number): void;
  /** Resolves once nothing is running and nothing is queued. */
  drain(): Promise<void>;
  /** Recovers interrupted work, then polls for queued jobs. */
  start(): void;
  /** `killChildren: false` leaves running ffmpeg processes alive so the next `start()` adopts them. */
  stop(opts?: { killChildren?: boolean }): void;
  /** Stops all processing: running ffmpeg are frozen in place (SIGSTOP) and nothing new is claimed. */
  pause(): void;
  /** Resumes claiming queued work by priority. */
  resume(): void;
  isPaused(): boolean;
  /** Set while processing is paused for lack of disk space. */
  lowDisk(): { message: string } | null;
}

export function createWorker(opts: WorkerOptions): Worker {
  const { db } = opts;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const deps: ProcessDeps = {
    dataDir: opts.dataDir,
    contentDir: opts.contentDir,
    runFfmpeg: opts.runFfmpeg ?? realRun,
    probeStreams: opts.probeStreams ?? realProbe,
    threads: opts.threads,
    pollMs: opts.pollMs,
  };
  const hlsRoot = join(resolve(opts.dataDir), 'hls');
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const lazyCopy = opts.lazyCopy ?? true;
  const cache = createCache({
    db,
    dataDir: opts.dataDir,
    contentDir: opts.contentDir,
    budgetBytes: opts.cacheBudgetBytes ?? 20 * 1024 ** 3,
    minFreeBytes: opts.minFreeBytes ?? 10 * 1024 ** 3,
    minFreePct: opts.minFreePct ?? 10,
    probeStreams: deps.probeStreams,
    statfs: opts.statfs,
    log,
  });
  deps.ensureSpace = (needed, id) => cache.ensureSpace(needed, id);
  const abort = new AbortController();
  let active = 0;
  // `proc` is the job's main ffmpeg once known; `stopped` means a pause froze it with SIGSTOP (job still running).
  const running = new Map<number, { mediaFileId: number; ctl: AbortController; preempted: boolean; proc?: SpawnInfo; stopped: boolean }>();
  let timer: NodeJS.Timeout | undefined;
  let idle: (() => void)[] = [];
  // In memory only: a server restart resumes processing with the backlog.
  let paused = false;
  // Set while the pause is for lack of disk space; `required` is the free space the job that hit it needs to start.
  let lowDisk: { message: string; needed: number } | null = null;
  let checkingDisk = false;
  // False while orphan ffmpeg processes from a previous server are being terminated: no job may start before that.
  let ready = true;
  let startup: Promise<void> = Promise.resolve();
  // One automatic reprocess per file per worker lifetime: a truncated package is usually transient, a loop is not.
  // In memory (no schema change); a restart grants at most one more reprocess for the file.
  const reprocessedInvalid = new Set<number>();

  async function runJob(job: NonNullable<ReturnType<typeof claimNext>>, adopt?: Adoption) {
    let lastWrite = Number.NEGATIVE_INFINITY;
    let retried = false;
    const entry: NonNullable<ReturnType<typeof running.get>> = {
      mediaFileId: job.mediaFileId,
      ctl: new AbortController(),
      preempted: false,
      proc: adopt && { pid: adopt.pid, pidStart: adopt.pidStart },
      stopped: false,
    };
    running.set(job.id, entry);
    try {
      let result: ProcessResult;
      for (;;) {
        try {
          result = await processMedia(deps, { id: job.mediaFileId, path: job.path }, {
            onTracks: (tracks) => setTracks(db, job, tracks),
            onSpawn: (p) => {
              entry.proc = p;
              setSpawned(db, job.id, p);
            },
            adopt: retried ? undefined : adopt,
            lazyCopy: lazyCopy && job.lazyEligible === true,
            signal: AbortSignal.any([abort.signal, entry.ctl.signal]),
            onProgress: (fraction) => {
              if (now() - lastWrite < PROGRESS_EVERY_MS) return;
              lastWrite = now();
              setProgress(db, job.id, Math.min(fraction, 1) * MAIN_RUN_SHARE);
            },
          });
          break;
        } catch (err) {
          const canRetry =
            err instanceof InvalidPackageError && !retried && !reprocessedInvalid.has(job.mediaFileId) && !abort.signal.aborted && !entry.preempted;
          if (!canRetry) throw err;
          retried = true;
          reprocessedInvalid.add(job.mediaFileId);
          lastWrite = Number.NEGATIVE_INFINITY;
          log('warn', `${job.path}: invalid HLS package produced, reprocessing once`);
        }
      }
      complete(db, job, result);
      if (result.hlsDir === null) log('info', `${job.path}: copy-mode source, package deferred until its first play`);
      else log('info', `processed ${job.path}`);
      if (result.mode === 'copy' && result.hlsDir !== null) {
        await cache.enforceBudget(job.mediaFileId).catch((e) => log('warn', `cache: eviction failed: ${(e as Error).message}`));
      }
    } catch (err) {
      if (abort.signal.aborted) return; // shutting down: the job stays running and is requeued on the next start
      if (entry.preempted) {
        requeue(db, job);
        log('info', `${job.path}: interrupted for a play request, requeued`);
        return;
      }
      if (err instanceof LowDiskError) {
        requeue(db, job);
        log('warn', err.message);
        lowDisk = { message: err.message, needed: err.neededBytes };
        pause();
        return;
      }
      const message = (
        err instanceof SourceMissingError
          ? err.message
          : `processing failed${retried ? ' after one automatic reprocess' : ''}: ${(err as Error).message}`
      ).slice(0, MAX_ERROR_CHARS);
      fail(db, job, message);
      log('warn', `${job.path}: ${message}`);
    } finally {
      running.delete(job.id);
    }
  }

  // Paused for lack of space: resumes by itself once the job that stopped can fit (evicting cache if that is enough).
  async function resumeIfSpace() {
    if (!lowDisk || checkingDisk) return;
    checkingDisk = true;
    try {
      await cache.ensureSpace(lowDisk.needed, -1);
    } catch {
      return;
    } finally {
      checkingDisk = false;
    }
    resume();
  }

  function kick() {
    if (abort.signal.aborted || !ready) return;
    if (lowDisk) void resumeIfSpace();
    while (active < concurrency) {
      if (paused) break;
      const job = claimNext(db);
      if (!job) break;
      active++;
      void runJob(job).finally(() => {
        active--;
        kick();
      });
    }
    if (active === 0) {
      idle.forEach((resolve) => resolve());
      idle = [];
    }
  }

  function prioritize(mediaFileId: number) {
    const jobs = [...running.values()];
    if (jobs.some((r) => r.mediaFileId === mediaFileId)) return;
    const victim = jobs[0];
    if (active < concurrency || !victim) return kick();
    victim.preempted = true;
    victim.ctl.abort(); // its runJob requeues it, then kick() claims the prioritized job
  }

  // Freezes every running job so the CPU frees immediately. A job whose main ffmpeg is known (also an adopted one)
  // is SIGSTOPped in place, keeping its package and progress; anything else (probe/extract phase, process already
  // gone) is aborted and requeued, restarting from zero later.
  function pause() {
    if (paused) return;
    paused = true;
    for (const entry of running.values()) {
      if (entry.proc && signalIfSame(entry.proc.pid, entry.proc.pidStart, 'SIGSTOP')) {
        entry.stopped = true;
        continue;
      }
      entry.preempted = true;
      entry.ctl.abort();
    }
  }

  function resume() {
    paused = false;
    lowDisk = null;
    for (const entry of running.values()) {
      if (!entry.stopped || !entry.proc) continue;
      signalIfSame(entry.proc.pid, entry.proc.pidStart, 'SIGCONT');
      entry.stopped = false;
    }
    kick();
  }

  function drain(): Promise<void> {
    if (!ready) return startup.then(drain);
    kick();
    return active === 0 ? Promise.resolve() : new Promise((resolve) => idle.push(resolve));
  }

  return {
    kick,
    prioritize,
    pause,
    resume,
    isPaused: () => paused,
    lowDisk: () => (lowDisk ? { message: lowDisk.message } : null),
    drain,
    start() {
      void cache.classifyLegacy().catch((e) => log('warn', `cache: classification failed: ${(e as Error).message}`));
      // Jobs whose ffmpeg survived the last server are adopted; any other writer on a package folder is an orphan.
      const adopted = new Map<number, Adoption & { job: ReturnType<typeof runningWithProcess>[number] }>();
      for (const job of runningWithProcess(db)) {
        if (isOurFfmpeg(job.pid, job.pidStart, join(hlsRoot, `${job.mediaFileId}.tmp`))) {
          adopted.set(job.id, { pid: job.pid, pidStart: job.pidStart, planHash: job.planHash, job });
        }
      }
      recover(db, new Set(adopted.keys()));
      const keep = new Set([...adopted.values()].map((a) => a.pid));
      const orphans = findWriters(hlsRoot).filter((w) => !keep.has(w.pid));
      if (orphans.length > 0) {
        ready = false;
        log('warn', `terminating ${orphans.length} orphan ffmpeg process(es) before processing`);
        startup = Promise.all(orphans.map((o) => terminate(o.pid, o.pidStart))).then(
          () => void (ready = true),
          () => void (ready = true),
        );
        void startup.then(kick);
      }
      for (const { job, ...adoption } of adopted.values()) {
        // Pause lives in memory only: a restart resumes processing, so an ffmpeg left stopped by a pause continues.
        signalIfSame(adoption.pid, adoption.pidStart, 'SIGCONT');
        active++;
        log('info', `${job.path}: adopting running ffmpeg ${job.pid}`);
        void runJob(job, adoption).finally(() => {
          active--;
          kick();
        });
      }
      kick();
      timer = setInterval(kick, POLL_MS);
      timer.unref();
    },
    stop({ killChildren = true } = {}) {
      clearInterval(timer);
      abort.abort(killChildren ? undefined : new KeepChildren());
    },
  };
}
