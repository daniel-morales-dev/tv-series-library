import type { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { KeepChildren, type ProbeStreams, type RunFfmpeg, probeStreams as realProbe, runFfmpeg as realRun } from './ffmpeg.ts';
import { type Adoption, InvalidPackageError, SourceMissingError, processMedia } from './process.ts';
import { findWriters, isOurFfmpeg, terminate } from './proc.ts';
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
  /** Stops all processing: running jobs are requeued and restart later, and nothing new is claimed. */
  pause(): void;
  /** Resumes claiming queued work by priority. */
  resume(): void;
  isPaused(): boolean;
}

export function createWorker(opts: WorkerOptions): Worker {
  const { db } = opts;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const deps = {
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
  const abort = new AbortController();
  let active = 0;
  const running = new Map<number, { mediaFileId: number; ctl: AbortController; preempted: boolean }>();
  let timer: NodeJS.Timeout | undefined;
  let idle: (() => void)[] = [];
  // In memory only: a server restart resumes processing with the backlog.
  let paused = false;
  // False while orphan ffmpeg processes from a previous server are being terminated: no job may start before that.
  let ready = true;
  let startup: Promise<void> = Promise.resolve();
  // One automatic reprocess per file per worker lifetime: a truncated package is usually transient, a loop is not.
  // In memory (no schema change); a restart grants at most one more reprocess for the file.
  const reprocessedInvalid = new Set<number>();

  async function runJob(job: NonNullable<ReturnType<typeof claimNext>>, adopt?: Adoption) {
    let lastWrite = Number.NEGATIVE_INFINITY;
    let retried = false;
    const entry = { mediaFileId: job.mediaFileId, ctl: new AbortController(), preempted: false };
    running.set(job.id, entry);
    try {
      let result: ProcessResult;
      for (;;) {
        try {
          result = await processMedia(deps, { id: job.mediaFileId, path: job.path }, {
            onTracks: (tracks) => setTracks(db, job, tracks),
            onSpawn: (p) => setSpawned(db, job.id, p),
            adopt: retried ? undefined : adopt,
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
      log('info', `processed ${job.path}`);
    } catch (err) {
      if (abort.signal.aborted) return; // shutting down: the job stays running and is requeued on the next start
      if (entry.preempted) {
        requeue(db, job);
        log('info', `${job.path}: interrupted for a play request, requeued`);
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

  function kick() {
    if (abort.signal.aborted || !ready) return;
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

  // Aborts every running job so the CPU frees immediately; runJob requeues each one and it restarts
  // from zero later (HLS packages are not resumable mid-encode).
  function pause() {
    if (paused) return;
    paused = true;
    for (const entry of running.values()) {
      entry.preempted = true;
      entry.ctl.abort();
    }
  }

  function resume() {
    paused = false;
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
    drain,
    start() {
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
