import { describe, expect, it } from 'vitest';
import { type HardwareDeps, createHardwareProbe, devMajorMinor, parseCpuMax, parseMemAvailableMb } from '../src/modules/processing/hardware.ts';

describe('parsers', () => {
  it('reads MemAvailable from /proc/meminfo in MB', () => {
    expect(parseMemAvailableMb('MemTotal: 16000000 kB\nMemFree: 1000 kB\nMemAvailable:    4194304 kB\n')).toBe(4096);
    expect(parseMemAvailableMb('MemTotal: 1 kB\n')).toBeNull();
    expect(parseMemAvailableMb('')).toBeNull();
  });
  it('reads cgroup v2 cpu.max as a fractional core count', () => {
    expect(parseCpuMax('max 100000\n')).toBeNull();
    expect(parseCpuMax('200000 100000')).toBe(2);
    expect(parseCpuMax('50000 100000')).toBe(0.5);
    expect(parseCpuMax('garbage')).toBeNull();
  });
  it('splits a dev_t like glibc (major 259, minor 1 = nvme0n1p1; 8:17 = sdb1)', () => {
    expect(devMajorMinor(259n * 256n + 1n)).toEqual({ major: 259, minor: 1 }.constructor === Object ? devMajorMinor(259n * 256n + 1n) : null);
    expect(devMajorMinor((8n << 8n) | 17n)).toEqual({ major: 8, minor: 17 });
    // 12-bit major above 255 uses bits 8..19; minor above 255 uses bits 20..
    expect(devMajorMinor((259n << 8n) | 1n)).toEqual({ major: 259, minor: 1 });
    expect(devMajorMinor((8n << 8n) | 0x11n | (0x3n << 20n))).toEqual({ major: 8, minor: 0x311 });
  });
});

function deps(files: Record<string, string>, over: Partial<HardwareDeps> = {}): HardwareDeps {
  return {
    availableParallelism: () => 16,
    freemem: () => 2048 * 1024 * 1024,
    readText: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p]!;
    },
    statDev: () => (8n << 8n) | 17n,
    ...over,
  };
}

describe('createHardwareProbe', () => {
  it('uses MemAvailable, the cores, and rotational=0 of the parent disk for a partition', () => {
    const probe = createHardwareProbe(['/lib', '/data'], deps({
      '/proc/meminfo': 'MemAvailable: 8388608 kB\n',
      '/sys/dev/block/8:17/queue/rotational': '', // partitions have no queue/: ENOENT below
    }, { readText: (p) => ({ '/proc/meminfo': 'MemAvailable: 8388608 kB\n', '/sys/dev/block/8:17/../queue/rotational': '0\n' })[p] ?? (() => { throw new Error('ENOENT'); })() }));
    expect(probe()).toEqual({ cores: 16, memAvailableMb: 8192, rotational: [false, false] });
  });

  it('reads rotational=1 and treats an unreadable flag as unknown', () => {
    const files = { '/proc/meminfo': 'MemAvailable: 1048576 kB', '/sys/dev/block/8:17/queue/rotational': '1\n' };
    expect(createHardwareProbe(['/lib'], deps(files))().rotational).toEqual([true]);
    expect(createHardwareProbe(['/lib'], deps({ '/proc/meminfo': files['/proc/meminfo'] }))().rotational).toEqual([null]);
    expect(createHardwareProbe(['/lib'], deps(files, { statDev: () => { throw new Error('ENOENT'); } }))().rotational).toEqual([null]);
  });

  it('falls back to os.freemem when /proc/meminfo is unavailable or has no MemAvailable', () => {
    expect(createHardwareProbe([], deps({}))().memAvailableMb).toBe(2048);
    expect(createHardwareProbe([], deps({ '/proc/meminfo': 'MemTotal: 1 kB' }))().memAvailableMb).toBe(2048);
  });

  it('caps the cores by the cgroup quota (rounded down, at least 1)', () => {
    expect(createHardwareProbe([], deps({ '/sys/fs/cgroup/cpu.max': '200000 100000' }))().cores).toBe(2);
    expect(createHardwareProbe([], deps({ '/sys/fs/cgroup/cpu.max': '50000 100000' }))().cores).toBe(1);
    expect(createHardwareProbe([], deps({ '/sys/fs/cgroup/cpu.max': 'max 100000' }))().cores).toBe(16);
    expect(createHardwareProbe([], deps({ '/sys/fs/cgroup/cpu.max': '3200000 100000' }))().cores).toBe(16);
  });

  it('reads memory on every call but the static facts once', () => {
    let mem = 1000;
    let stats = 0;
    const probe = createHardwareProbe(['/lib'], deps({}, { freemem: () => mem * 1024 * 1024, statDev: () => (stats++, 1n) }));
    expect(probe().memAvailableMb).toBe(1000);
    mem = 500;
    expect(probe().memAvailableMb).toBe(500);
    expect(stats).toBe(1);
  });

  it('never throws, even if every source fails', () => {
    const boom = () => {
      throw new Error('boom');
    };
    const hw = createHardwareProbe(['/lib'], { availableParallelism: boom, freemem: boom, readText: boom, statDev: boom })();
    expect(hw.cores).toBeGreaterThanOrEqual(1);
    expect(hw.memAvailableMb).toBeGreaterThanOrEqual(0);
    expect(hw.rotational).toEqual([null]);
  });
});
