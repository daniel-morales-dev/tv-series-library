import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWatcher, shouldKill, watchdogStallMs } from '../src/watchdog.ts';

describe('shouldKill', () => {
  it('kills only once the heartbeat is older than the stall window', () => {
    expect(shouldKill(1000, 30_999, 30_000)).toBe(false);
    expect(shouldKill(1000, 31_000, 30_000)).toBe(true);
  });
  it('never kills when disabled (stallMs <= 0)', () => {
    expect(shouldKill(0, 10 ** 9, 0)).toBe(false);
  });
});

describe('watchdogStallMs', () => {
  it('defaults to 30 s and honours the env override', () => {
    expect(watchdogStallMs({}, [])).toBe(30_000);
    expect(watchdogStallMs({ WATCHDOG_STALL_S: '5' }, [])).toBe(5_000);
  });
  it('0 disables; an invalid value falls back to the default', () => {
    expect(watchdogStallMs({ WATCHDOG_STALL_S: '0' }, [])).toBe(0);
    expect(watchdogStallMs({ WATCHDOG_STALL_S: 'abc' }, [])).toBe(30_000);
  });
  it('is disabled under tests and with an inspector attached', () => {
    expect(watchdogStallMs({ VITEST: 'true' }, [])).toBe(0);
    expect(watchdogStallMs({ NODE_ENV: 'test' }, [])).toBe(0);
    expect(watchdogStallMs({}, ['--inspect'])).toBe(0);
    expect(watchdogStallMs({}, ['--inspect-brk=9229'])).toBe(0);
    expect(watchdogStallMs({ NODE_OPTIONS: '--inspect' }, [])).toBe(0);
  });
});

describe('createWatcher', () => {
  it('kills after the beat stops advancing, not while it advances', () => {
    let beat = 0;
    let now = 0;
    const kill = vi.fn();
    const log = vi.fn();
    const tick = createWatcher({ read: () => beat, now: () => now, stallMs: 30_000, kill, log });
    for (let i = 0; i < 20; i++) { now += 2_000; beat++; tick(); }
    expect(kill).not.toHaveBeenCalled();
    for (let i = 0; i < 14; i++) { now += 2_000; tick(); }
    expect(kill).not.toHaveBeenCalled(); // 28 s stalled
    now += 2_000; tick();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`pid ${process.pid}`));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('30'));
  });
  it('recovers when the beat resumes', () => {
    let beat = 0;
    let now = 0;
    const kill = vi.fn();
    const tick = createWatcher({ read: () => beat, now: () => now, stallMs: 10_000, kill, log: () => {} });
    now = 9_000; tick();
    beat = 1; now = 12_000; tick();
    now = 21_000; tick();
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('worker wiring', () => {
  const children: ReturnType<typeof spawn>[] = [];
  afterEach(() => { for (const c of children.splice(0)) c.kill('SIGKILL'); });

  // The child arms a short watchdog, then (busy) blocks its own event loop; it also exits by itself so it can never linger.
  const run = (busy: boolean) => {
    const mod = pathToFileURL(resolve(import.meta.dirname, '../src/watchdog.ts')).href;
    const code = `
      import { startWatchdog } from ${JSON.stringify(mod)};
      startWatchdog({ stallMs: 600, heartbeatMs: 50, checkMs: 100 });
      setTimeout(() => { if (${busy}) { const end = Date.now() + 8000; while (Date.now() < end); } }, 300);
      setTimeout(() => process.exit(0), ${busy ? 9000 : 1500});
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((res) =>
      child.on('exit', (code, signal) => res({ code, signal, stderr })),
    );
  };

  it('SIGKILLs a process whose event loop is blocked', async () => {
    const r = await run(true);
    expect(r.signal).toBe('SIGKILL');
    expect(r.stderr).toContain('watchdog');
  }, 15_000);

  it('leaves a healthy process alone', async () => {
    const r = await run(false);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('watchdog');
  }, 15_000);
});
