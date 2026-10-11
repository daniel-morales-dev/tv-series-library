import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';

// Linux-only (/proc): the processing server targets Linux (ADR 0005). Elsewhere every lookup reports "not alive".

// Starttime (clock ticks since boot, field 22 of /proc/<pid>/stat) identifies a process across pid reuse.
// Zombies count as gone: they have exited and only wait to be reaped.
export function procStart(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[0] === 'Z' ? null : Number(rest[19]);
  } catch {
    return null;
  }
}

function cmdline(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

// The recorded process is ours only if it is the same process (start time) and still works on this package folder.
export function isOurFfmpeg(pid: number, pidStart: number, tmpDir: string): boolean {
  if (procStart(pid) !== pidStart) return false;
  return cmdline(pid)?.some((a) => a.startsWith(`${tmpDir}/`)) ?? false;
}

// Every process writing under `<hlsRoot>/<id>.tmp/`: at most one may exist per package folder.
// /proc only exists on Linux (Windows runs without adoption): elsewhere there is nothing to scan.
export function findWriters(hlsRoot: string, platform: NodeJS.Platform = process.platform): { pid: number; pidStart: number }[] {
  if (platform !== 'linux') return [];
  const prefix = `${hlsRoot}/`;
  const found: { pid: number; pidStart: number }[] = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    if (!cmdline(pid)?.some((a) => a.startsWith(prefix) && /^\d+\.tmp\//.test(a.slice(prefix.length)))) continue;
    const pidStart = procStart(pid);
    if (pidStart !== null) found.push({ pid, pidStart });
  }
  return found;
}

// Signals the process only if it is still the one recorded (start time), so a recycled pid is never touched.
// The check and the kill are not atomic; the window is a few microseconds and the start time makes a hit negligible.
export function signalIfSame(pid: number, pidStart: number, signal: NodeJS.Signals): boolean {
  if (procStart(pid) !== pidStart) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// SIGTERM, then SIGKILL after the grace period. Never signals a process whose start time no longer matches.
export async function terminate(pid: number, pidStart: number, { graceMs = 5_000, pollMs = 50 } = {}): Promise<void> {
  const same = () => procStart(pid) === pidStart;
  for (const [signal, wait] of [['SIGTERM', graceMs], ['SIGKILL', 2_000]] as const) {
    if (!same()) return;
    // A stopped (SIGSTOP) process keeps SIGTERM pending until it is continued.
    if (!signalIfSame(pid, pidStart, signal)) return;
    if (signal === 'SIGTERM') signalIfSame(pid, pidStart, 'SIGCONT');
    for (let waited = 0; same() && waited < wait; waited += pollMs) await sleep(pollMs);
  }
}

// Not our child after a restart, so there is no exit event: poll until the process is gone.
export async function waitForExit(pid: number, pidStart: number, { signal, pollMs = 1_000 }: { signal?: AbortSignal; pollMs?: number } = {}): Promise<void> {
  while (procStart(pid) === pidStart) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    await sleep(pollMs);
  }
}

// ffmpeg appends a block per update to the `-progress` file; only the tail matters.
export function readProgress(file: string): { outTimeS: number | null; ended: boolean } | null {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 8192);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    const times = [...text.matchAll(/^out_time_us=(\d+)$/gm)];
    const states = [...text.matchAll(/^progress=(\w+)$/gm)];
    return { outTimeS: times.length ? Number(times.at(-1)![1]) / 1e6 : null, ended: states.at(-1)?.[1] === 'end' };
  } finally {
    closeSync(fd);
  }
}

export function watchProgress(file: string, onProgress: ((outTimeS: number) => void) | undefined, pollMs = 1_000): () => void {
  if (!onProgress) return () => {};
  const timer = setInterval(() => {
    const p = readProgress(file);
    if (p?.outTimeS != null) onProgress(p.outTimeS);
  }, pollMs);
  timer.unref();
  return () => clearInterval(timer);
}
