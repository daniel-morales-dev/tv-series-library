import { Worker } from 'node:worker_threads';

// T38: a worker thread has its own event loop, so it can notice a main thread that is stuck
// (e.g. in a native futex) and SIGKILL the process so systemd (Restart=) brings it back.
// KillMode=process + SIGKILL on the main pid only: adoptable ffmpeg children (T40) keep running.

const DEFAULT_STALL_S = 30;

export function shouldKill(lastBeatAt: number, now: number, stallMs: number): boolean {
  return stallMs > 0 && now - lastBeatAt >= stallMs;
}

/** Stall window in ms, or 0 when disabled (env 0, tests, or an inspector attached so debugging never kills us). */
export function watchdogStallMs(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: string[] = process.execArgv,
): number {
  if (env.VITEST || env.NODE_ENV === 'test') return 0;
  const inspector = /--inspect/;
  if (execArgv.some((a) => inspector.test(a)) || inspector.test(env.NODE_OPTIONS ?? '')) return 0;
  const raw = env.WATCHDOG_STALL_S;
  const s = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return (Number.isFinite(s) && s >= 0 ? s : DEFAULT_STALL_S) * 1000;
}

/** Pure watcher: call tick() periodically; kills once the counter has not advanced for stallMs. */
export function createWatcher(opts: {
  read: () => number;
  now: () => number;
  stallMs: number;
  kill: () => void;
  log: (line: string) => void;
}): () => void {
  let last = opts.read();
  let lastBeatAt = opts.now();
  return () => {
    const now = opts.now();
    const beat = opts.read();
    if (beat !== last) {
      last = beat;
      lastBeatAt = now;
      return;
    }
    if (!shouldKill(lastBeatAt, now, opts.stallMs)) return;
    opts.log(`watchdog: event loop stalled ${Math.round((now - lastBeatAt) / 1000)}s, pid ${process.pid}; sending SIGKILL`);
    opts.kill();
  };
}

export interface WatchdogOptions {
  stallMs: number;
  heartbeatMs?: number;
  checkMs?: number;
}

/** Starts the heartbeat + watcher thread. Returns a stop function. A stallMs <= 0 does nothing. */
export function startWatchdog({ stallMs, heartbeatMs = 1000, checkMs = 2000 }: WatchdogOptions): () => void {
  if (stallMs <= 0) return () => {};
  const counter = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL('./watchdog-worker.ts', import.meta.url), {
    workerData: { counter, stallMs, checkMs },
    execArgv: [], // do not inherit --watch/--input-type/--inspect from the main thread
  });
  worker.unref();
  const timer = setInterval(() => Atomics.add(counter, 0, 1), heartbeatMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    void worker.terminate();
  };
}
