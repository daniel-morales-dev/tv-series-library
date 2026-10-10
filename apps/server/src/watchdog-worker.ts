import { writeSync } from 'node:fs';
import { workerData } from 'node:worker_threads';
import { createWatcher } from './watchdog.ts';

const { counter, stallMs, checkMs } = workerData as { counter: Int32Array; stallMs: number; checkMs: number };

const tick = createWatcher({
  read: () => Atomics.load(counter, 0),
  now: () => Date.now(),
  stallMs,
  // process.stderr in a worker is piped through the main thread's loop (the stuck one): write straight to fd 2.
  log: (line) => {
    try { writeSync(2, line + '\n'); } catch { /* best effort */ }
  },
  kill: () => process.kill(process.pid, 'SIGKILL'),
});

setInterval(tick, checkMs);
