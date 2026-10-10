import { chmodSync, closeSync, mkdtempSync, openSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunFfmpeg } from '../src/modules/processing/ffmpeg.ts';

// T38: the ffmpeg children are fake (node scripts); nothing here touches a real ffmpeg or process of the owner.
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function fakeBin(body: string): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tvlib-pipes-'));
  roots.push(dir);
  const bin = join(dir, 'fake-ffmpeg');
  writeFileSync(bin, `#!${process.execPath}\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, dir };
}

// Writes ~20 MB to stdout and stderr (far past any pipe/socket buffer), then exits.
const FLOOD = `
const chunk = Buffer.alloc(1024 * 1024, 'x');
for (let i = 0; i < 20; i++) { process.stdout.write(chunk); process.stderr.write(chunk); }
process.stderr.write('TAIL-MARKER');
process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
`;

describe('ffmpeg output never blocks the child (T38)', () => {
  it('attached run: floods stdout/stderr without being read and still finishes', async () => {
    const { bin } = fakeBin(FLOOD);
    await createRunFfmpeg({ bin })(['x']);
  });

  it('attached run: the stderr tail in the error is capped', async () => {
    const { bin } = fakeBin(FLOOD.replace("Number(process.env.FAKE_EXIT ?? 0)", "3"));
    const err = await createRunFfmpeg({ bin })(['x']).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain('TAIL-MARKER');
    expect(err!.message.length).toBeLessThan(4200);
  });

  it('detached run: output goes to the log file, not to a pipe', async () => {
    const { bin, dir } = fakeBin(FLOOD);
    await createRunFfmpeg({ bin })(['x'], { detached: { progressFile: join(dir, 'p.txt'), logFile: join(dir, 'ffmpeg.log') } });
  });

  it('detached run: the error tail survives a huge log (read only the end, never the whole file)', async () => {
    const { bin, dir } = fakeBin(`process.stderr.write('TAIL-MARKER'); process.exit(3);`);
    const logFile = join(dir, 'ffmpeg.log');
    // Sparse 600 MB (> V8's max string length): readFileSync(..., 'utf8') on it throws, so the old tail came back empty.
    closeSync(openSync(logFile, 'w'));
    truncateSync(logFile, 600 * 1024 * 1024);
    const err = await createRunFfmpeg({ bin })(['x'], { detached: { progressFile: join(dir, 'p.txt'), logFile } }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain('TAIL-MARKER');
  });

  it('a child that ignores SIGTERM is SIGKILLed after the escalation delay and the run rejects', async () => {
    const { bin } = fakeBin(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.error('up');`);
    const ctl = new AbortController();
    const run = createRunFfmpeg({ bin, killAfterMs: 100 })(['x'], { signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 300));
    const startedAt = Date.now();
    ctl.abort();
    await expect(run).rejects.toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
