import type { DatabaseSync } from 'node:sqlite';
import { type ProbeStreams, type RunFfmpeg, probeStreams as realProbe, runFfmpeg as realRun } from './ffmpeg.ts';
import { InvalidPackageError, SourceMissingError, processMedia } from './process.ts';
import { type ProcessResult, claimNext, complete, fail, recover, requeue, setProgress, setTracks } from './queue.ts';

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
  stop(): void;
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
  };
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const abort = new AbortController();
  let active = 0;
  const running = new Map<number, { mediaFileId: number; ctl: AbortController; preempted: boolean }>();
  let timer: NodeJS.Timeout | undefined;
  let idle: (() => void)[] = [];
  // One automatic reprocess per file per worker lifetime: a truncated package is usually transient, a loop is not.
  // In memory (no schema change); a restart grants at most one more reprocess for the file.
  const reprocessedInvalid = new Set<number>();

  async function runJob(job: NonNullable<ReturnType<typeof claimNext>>) {
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
    if (abort.signal.aborted) return;
    while (active < concurrency) {
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

  return {
    kick,
    prioritize,
    drain: () => {
      kick();
      return active === 0 ? Promise.resolve() : new Promise((resolve) => idle.push(resolve));
    },
    start() {
      recover(db);
      kick();
      timer = setInterval(kick, POLL_MS);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      abort.abort();
    },
  };
}
