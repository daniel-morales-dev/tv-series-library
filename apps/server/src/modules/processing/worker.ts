import type { DatabaseSync } from 'node:sqlite';
import { type ProbeStreams, type RunFfmpeg, probeStreams as realProbe, runFfmpeg as realRun } from './ffmpeg.ts';
import { SourceMissingError, processMedia } from './process.ts';
import { claimNext, complete, fail, recover, setProgress } from './queue.ts';

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
  runFfmpeg?: RunFfmpeg;
  probeStreams?: ProbeStreams;
  now?: () => number;
  log?: (level: 'info' | 'warn', message: string) => void;
}

export interface Worker {
  /** Starts queued jobs up to the concurrency limit; cheap to call any time. */
  kick(): void;
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
  };
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const abort = new AbortController();
  let active = 0;
  let timer: NodeJS.Timeout | undefined;
  let idle: (() => void)[] = [];

  async function runJob(job: NonNullable<ReturnType<typeof claimNext>>) {
    let lastWrite = Number.NEGATIVE_INFINITY;
    try {
      const result = await processMedia(deps, { id: job.mediaFileId, path: job.path }, {
        signal: abort.signal,
        onProgress: (fraction) => {
          if (now() - lastWrite < PROGRESS_EVERY_MS) return;
          lastWrite = now();
          setProgress(db, job.id, Math.min(fraction, 1) * MAIN_RUN_SHARE);
        },
      });
      complete(db, job, result);
      log('info', `processed ${job.path}`);
    } catch (err) {
      if (abort.signal.aborted) return; // shutting down: the job stays running and is requeued on the next start
      const message = (err instanceof SourceMissingError ? err.message : `processing failed: ${(err as Error).message}`).slice(0, MAX_ERROR_CHARS);
      fail(db, job, message);
      log('warn', `${job.path}: ${message}`);
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

  return {
    kick,
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
