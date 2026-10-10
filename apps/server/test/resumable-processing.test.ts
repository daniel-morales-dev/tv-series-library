import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from '../src/db/sql.ts';
import { KeepChildren, type RunFfmpeg, createRunFfmpeg } from '../src/modules/processing/ffmpeg.ts';
import { findWriters, isOurFfmpeg, procStart, terminate, waitForExit } from '../src/modules/processing/proc.ts';
import { enqueue } from '../src/modules/processing/queue.ts';
import { type StreamInfo } from '../src/modules/processing/plan.ts';
import { createWorker } from '../src/modules/processing/worker.ts';
import { addFile, addTitle, setup } from './helpers.ts';

const roots: string[] = [];
const pids: number[] = [];
afterEach(() => {
  delete process.env.FAKE_FFMPEG_GATE;
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const INFO: StreamInfo = {
  durationS: 100,
  video: { index: 0, codec: 'h264', profile: 'High', pixFmt: 'yuv420p' },
  audio: [{ index: 1, codec: 'aac', language: 'jpn', title: null, channels: 2 }],
  subtitles: [],
  attachments: [],
};
const alive = (pid: number) => procStart(pid) !== null;

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-resume-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const contentDir = join(root, 'content');
  mkdirSync(contentDir, { recursive: true });
  const bin = join(root, 'ffmpeg');
  writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dirname, 'fake-ffmpeg.mjs')} "$@"\n`);
  chmodSync(bin, 0o755);
  const gate = join(root, 'gate');
  process.env.FAKE_FFMPEG_GATE = gate;

  const { db } = setup();
  writeFileSync(join(contentDir, 'a.mkv'), 'x');
  const fileId = addFile(db, addTitle(db, 'T'), { status: 'pending' });
  db.prepare("UPDATE media_files SET path = 'a.mkv', duration_s = 100 WHERE id = ?").run(fileId);
  enqueue(db, fileId);

  const real = createRunFfmpeg({ bin, pollMs: 40 });
  const mainRuns: string[][] = [];
  const spy: RunFfmpeg = (args, o) => {
    if (args.includes('-var_stream_map')) mainRuns.push(args);
    return real(args, o);
  };
  const worker = () =>
    createWorker({ db, dataDir, contentDir, runFfmpeg: spy, probeStreams: async () => INFO, pollMs: 40 });
  const job = () => get<any>(db, 'SELECT * FROM jobs')!;
  const file = () => get<any>(db, 'SELECT * FROM media_files WHERE id = ?', fileId)!;
  const tmpDir = join(dataDir, 'hls', `${fileId}.tmp`);
  const open = () => writeFileSync(gate, '1');
  // Runs the first worker until its detached ffmpeg is up and reporting, then "kills" the server without killing ffmpeg.
  async function crashMidJob() {
    const a = worker();
    a.start();
    await vi.waitFor(() => expect(job().pid).not.toBeNull());
    await vi.waitFor(() => expect(job().progress).toBeGreaterThan(0));
    const pid = job().pid as number;
    pids.push(pid);
    a.stop({ killChildren: false });
    await vi.waitFor(() => expect(alive(pid)).toBe(true));
    return { pid, progress: job().progress as number };
  }
  return { db, dataDir, bin, worker, job, file, fileId, tmpDir, open, mainRuns, crashMidJob };
}

describe('detached ffmpeg', () => {
  it('reports progress from the file and survives an abort that keeps children', async () => {
    const s = scene();
    const ctl = new AbortController();
    const seen: number[] = [];
    let spawned: { pid: number; pidStart: number } | undefined;
    mkdirSync(s.tmpDir, { recursive: true });
    const run = createRunFfmpeg({ bin: s.bin, pollMs: 40 })(
      ['-progress', join(s.tmpDir, 'progress.txt'), join(s.tmpDir, '%v/index.m3u8')],
      {
        signal: ctl.signal,
        detached: { progressFile: join(s.tmpDir, 'progress.txt'), logFile: join(s.tmpDir, 'ffmpeg.log') },
        onProgress: (sec) => seen.push(sec),
        onSpawn: (p) => (spawned = p),
      },
    );
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(1));
    pids.push(spawned!.pid);
    expect(procStart(spawned!.pid)).toBe(spawned!.pidStart);
    ctl.abort(new KeepChildren());
    await expect(run).rejects.toBeInstanceOf(KeepChildren);
    await new Promise((r) => setTimeout(r, 150));
    expect(alive(spawned!.pid)).toBe(true);
  });

  it('kills the process on a plain abort', async () => {
    const s = scene();
    const ctl = new AbortController();
    let pid = 0;
    mkdirSync(s.tmpDir, { recursive: true });
    const run = createRunFfmpeg({ bin: s.bin, pollMs: 40 })(['-progress', join(s.tmpDir, 'progress.txt'), join(s.tmpDir, '%v/x')], {
      signal: ctl.signal,
      detached: { progressFile: join(s.tmpDir, 'progress.txt'), logFile: join(s.tmpDir, 'ffmpeg.log') },
      onSpawn: (p) => (pid = p.pid),
    });
    await vi.waitFor(() => expect(pid).toBeGreaterThan(0));
    ctl.abort();
    await expect(run).rejects.toBeDefined();
    expect(alive(pid)).toBe(false);
  });
});

describe('process helpers', () => {
  it('identifies our ffmpeg only by cmdline and start time', () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)', '/x/hls/7.tmp/y'], { stdio: 'ignore' });
    pids.push(child.pid!);
    const start = procStart(child.pid!)!;
    expect(isOurFfmpeg(child.pid!, start, '/x/hls/7.tmp')).toBe(true);
    expect(isOurFfmpeg(child.pid!, start + 1, '/x/hls/7.tmp')).toBe(false);
    expect(isOurFfmpeg(child.pid!, start, '/x/hls/70.tmp')).toBe(false);
    expect(isOurFfmpeg(process.pid, procStart(process.pid)!, '/x/hls/7.tmp')).toBe(false);
    expect(findWriters('/x/hls').map((w) => w.pid)).toEqual([child.pid]);
    expect(findWriters('/other/hls')).toEqual([]);
  });

  it('terminates only the verified process and waitForExit notices it', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
    const start = procStart(child.pid!)!;
    await terminate(child.pid!, start + 1, { graceMs: 100 });
    expect(alive(child.pid!)).toBe(true);
    const gone = waitForExit(child.pid!, start, { pollMs: 20 });
    await terminate(child.pid!, start, { graceMs: 1000 });
    await gone;
    expect(alive(child.pid!)).toBe(false);
  });
});

describe('adoption after a server restart', () => {
  it('adopts the surviving ffmpeg: no new run, same pid, job finishes', async () => {
    const s = scene();
    const { pid, progress } = await s.crashMidJob();
    expect(s.job().status).toBe('running');

    const b = s.worker();
    b.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(s.job()).toMatchObject({ status: 'running', pid });
    expect(s.job().progress).toBeGreaterThanOrEqual(progress);
    expect(existsSync(s.tmpDir)).toBe(true);

    s.open();
    await b.drain();
    b.stop();
    expect(s.mainRuns).toHaveLength(1); // only worker A's run
    expect(s.job()).toMatchObject({ status: 'done', progress: 1, pid: null });
    expect(s.file().status).toBe('ready');
    expect(existsSync(join(s.dataDir, 'hls', String(s.fileId), 'master.m3u8'))).toBe(true);
    expect(existsSync(join(s.dataDir, 'hls', String(s.fileId), 'progress.txt'))).toBe(false);
    expect(existsSync(s.tmpDir)).toBe(false);
  });

  it('a default stop() still kills the ffmpeg', async () => {
    const s = scene();
    const a = s.worker();
    a.start();
    await vi.waitFor(() => expect(s.job().pid).not.toBeNull());
    const pid = s.job().pid as number;
    pids.push(pid);
    a.stop();
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it('kills and restarts when the plan differs', async () => {
    const s = scene();
    const { pid } = await s.crashMidJob();
    s.db.prepare("UPDATE jobs SET plan_hash = 'something-else'").run();
    s.open();
    const b = s.worker();
    b.start();
    await b.drain();
    b.stop();
    expect(alive(pid)).toBe(false);
    expect(s.mainRuns).toHaveLength(2);
    expect(s.job().status).toBe('done');
  });

  it('kills and restarts when progress.txt is missing', async () => {
    const s = scene();
    const { pid } = await s.crashMidJob();
    rmSync(join(s.tmpDir, 'progress.txt'));
    s.open();
    const b = s.worker();
    b.start();
    await b.drain();
    b.stop();
    expect(alive(pid)).toBe(false);
    expect(s.mainRuns).toHaveLength(2);
    expect(s.job().status).toBe('done');
  });

  it('terminates a real orphan writer whose start time does not match the job', async () => {
    const s = scene();
    const { pid } = await s.crashMidJob();
    s.db.prepare('UPDATE jobs SET pid_start = pid_start + 1').run();
    s.open();
    const b = s.worker();
    b.start();
    await b.drain();
    b.stop();
    expect(alive(pid)).toBe(false);
    expect(s.mainRuns).toHaveLength(2);
    expect(s.job().status).toBe('done');
  });

  it('never kills a foreign process that reused the recorded pid', async () => {
    const s = scene();
    const foreign = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
    pids.push(foreign.pid!);
    s.db.exec("UPDATE jobs SET status = 'running'");
    s.db.exec("UPDATE media_files SET status = 'processing'");
    s.db.prepare('UPDATE jobs SET pid = ?, pid_start = ?, plan_hash = ?').run(foreign.pid!, procStart(foreign.pid!)!, 'h');
    s.open();
    const b = s.worker();
    b.start();
    await b.drain();
    b.stop();
    expect(alive(foreign.pid!)).toBe(true);
    expect(s.mainRuns).toHaveLength(1);
    expect(s.job().status).toBe('done');
  });
});
