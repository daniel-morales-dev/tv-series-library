// T21: hardware probe behind the resource budget. node:fs only, never throws: a failed source just
// degrades to a conservative value (cores >= 1, unknown storage).
import { readFileSync, statSync } from 'node:fs';
import { availableParallelism, freemem } from 'node:os';
import type { Hardware } from './budget.ts';

export interface HardwareDeps {
  availableParallelism: () => number;
  /** Free memory in bytes. */
  freemem: () => number;
  readText: (path: string) => string;
  statDev: (path: string) => bigint;
}

const MEMINFO = '/proc/meminfo';
const CGROUP_CPU_MAX = '/sys/fs/cgroup/cpu.max';

export function parseMemAvailableMb(text: string): number | null {
  const m = /^MemAvailable:\s*(\d+)\s*kB/m.exec(text);
  return m ? Math.floor(Number(m[1]) / 1024) : null;
}

export function parseCpuMax(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/);
  if (quota === undefined || period === undefined || quota === 'max') return null;
  const q = Number(quota);
  const p = Number(period);
  return Number.isFinite(q) && Number.isFinite(p) && q > 0 && p > 0 ? q / p : null;
}

// Same split as glibc's gnu_dev_major/gnu_dev_minor (12-bit major, 20-bit minor).
export function devMajorMinor(dev: bigint): { major: number; minor: number } {
  return {
    major: Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn)),
    minor: Number((dev & 0xffn) | ((dev >> 12n) & ~0xffn)),
  };
}

function detectCores(deps: HardwareDeps): number {
  let cores = 1;
  try {
    cores = Math.max(1, Math.floor(deps.availableParallelism()));
  } catch {}
  try {
    const quota = parseCpuMax(deps.readText(CGROUP_CPU_MAX));
    if (quota !== null) cores = Math.max(1, Math.min(cores, Math.floor(quota)));
  } catch {}
  return cores;
}

function detectMemAvailableMb(deps: HardwareDeps): number {
  try {
    const parsed = parseMemAvailableMb(deps.readText(MEMINFO));
    if (parsed !== null) return parsed;
  } catch {}
  try {
    return Math.max(0, Math.floor(deps.freemem() / 1024 / 1024));
  } catch {
    return 0;
  }
}

// A partition has no `queue/` of its own: `..` from `/sys/dev/block/<maj>:<min>` reaches the disk's.
function detectRotational(path: string, deps: HardwareDeps): boolean | null {
  try {
    const { major, minor } = devMajorMinor(deps.statDev(path));
    for (const candidate of [`/sys/dev/block/${major}:${minor}/queue/rotational`, `/sys/dev/block/${major}:${minor}/../queue/rotational`]) {
      try {
        const text = deps.readText(candidate).trim();
        if (text === '0') return false;
        if (text === '1') return true;
      } catch {}
    }
  } catch {}
  return null;
}

/** Reads memory on every call; the static facts (cores, volume types) are cached once. */
export function createHardwareProbe(paths: string[], overrides: Partial<HardwareDeps> = {}): () => Hardware {
  const deps: HardwareDeps = {
    availableParallelism: () => availableParallelism(),
    freemem: () => freemem(),
    readText: (p) => readFileSync(p, 'utf8'),
    statDev: (p) => statSync(p, { bigint: true }).dev,
    ...overrides,
  };
  const cores = detectCores(deps);
  const rotational = paths.map((p) => detectRotational(p, deps));
  return () => ({ cores, memAvailableMb: detectMemAvailableMb(deps), rotational: [...rotational] });
}
