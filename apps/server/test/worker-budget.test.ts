import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all } from '../src/db/sql.ts';
import { type BudgetConfig, type Hardware, budgetConfigFromEnv } from '../src/modules/processing/budget.ts';
import { type RunFfmpeg, createRunFfmpeg, niceFromEnv } from '../src/modules/processing/ffmpeg.ts';
import { type StreamInfo } from '../src/modules/processing/plan.ts';
import { procStart } from '../src/modules/processing/proc.ts';
import { enqueue } from '../src/modules/processing/queue.ts';
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

// HEVC 10-bit: forces the x264 branch, the only one where -threads exists.
const INFO: StreamInfo = {
  durationS: 100,
  video: { index: 0, codec: 'hevc', profile: 'Main 10', pixFmt: 'yuv420p10le' },
  audio: [{ index: 1, codec: 'aac', language: 'jpn', title: null, channels: 2 }],
  subtitles: [],
  attachments: [],
};

const alive = (pid: number) => procStart(pid) !== null;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hw = (over: Partial<Hardware> = {}): Hardware => ({ cores: 16, memAvailableMb: 8000, rotational: [false, false], ...over });

interface JobRow {
  id: number;
  media_file_id: number;
  status: string;
  pid: number | null;
  progress: number;
}

function scene(fileCount: number) {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-budget-'));
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
  const title = addTitle(db, 'T');
  const addQueued = (name: string, prioritized = false) => {
    writeFileSync(join(contentDir, name), 'x');
    const id = addFile(db, title, { status: 'pending' });
    db.prepare('UPDATE media_files SET path = ?, duration_s = 100 WHERE id = ?').run(name, id);
    enqueue(db, id, prioritized);
    return id;
  };
  const fileIds = Array.from({ length: fileCount }, (_, i) => addQueued(`f${i}.mkv`));

  const real = createRunFfmpeg({ bin, pollMs: 40 });
  const mainRuns: string[][] = [];
  const spy: RunFfmpeg = (args, o) => {
    if (args.includes('-var_stream_map')) mainRuns.push(args);
    return real(args, o);
  };
  const worker = (budget?: { hardware: () => Hardware; config: BudgetConfig }) =>
    createWorker({ db, dataDir, contentDir, runFfmpeg: spy, probeStreams: async () => INFO, pollMs: 40, lazyCopy: false, ...(budget ? { budget } : {}) });
  const jobs = () => all<JobRow>(db, 'SELECT id, media_file_id, status, pid, progress FROM jobs ORDER BY id');
  const jobOf = (mediaFileId: number) => jobs().find((j) => j.media_file_id === mediaFileId)!;
  const open = () => writeFileSync(gate, '1');
  const track = (mediaFileId: number) => pids.push(jobOf(mediaFileId).pid!);
  return { db, dataDir, contentDir, fileIds, addQueued, worker, jobs, jobOf, open, mainRuns, track };
}

describe('worker with a resource budget', () => {
  it('runs two jobs at once under a 2 x 4 budget and passes -threads 4 to each', async () => {
    const s = scene(2);
    const w = s.worker({ hardware: () => hw(), config: budgetConfigFromEnv({ PROCESS_MAX_JOBS: '4' }) });
    w.start();
    await vi.waitFor(() => expect(s.jobs().filter((j) => j.status === 'running' && j.pid !== null)).toHaveLength(2));
    for (const j of s.jobs()) s.track(j.media_file_id);
    expect(w.budget()).toEqual({ jobs: 2, threadsPerJob: 4, limitedBy: 'cpu' });
    for (const args of s.mainRuns) {
      const i = args.indexOf('-threads');
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe('4');
    }

    s.open();
    await w.drain();
    w.stop();
    expect(s.jobs().map((j) => j.status)).toEqual(['done', 'done']);
    expect(s.mainRuns).toHaveLength(2);
  });

  it('stops claiming when the RAM drops but never aborts the running job', async () => {
    let mem = 8000;
    const s = scene(3);
    const w = s.worker({ hardware: () => hw({ memAvailableMb: mem }), config: budgetConfigFromEnv({ PROCESS_MAX_JOBS: '4' }) });
    w.start();
    await vi.waitFor(() => expect(s.jobs().filter((j) => j.status === 'running' && j.pid !== null)).toHaveLength(2));
    const running = s.jobs().filter((j) => j.status === 'running');
    for (const j of running) s.track(j.media_file_id);

    mem = 100; // another app took the RAM
    w.kick();
    await pause(150);
    expect(s.jobOf(s.fileIds[2]!).status).toBe('queued');
    for (const j of running) {
      expect(alive(j.pid!)).toBe(true);
      expect(s.jobOf(j.media_file_id).status).toBe('running');
    }

    s.open();
    await w.drain();
    w.stop();
    expect(s.jobs().map((j) => j.status)).toEqual(['done', 'done', 'done']);
  });

  it('uses the play slot for a prioritized job when jobs=1 but the RAM allows one more', async () => {
    const s = scene(1);
    const w = s.worker({ hardware: () => hw({ cores: 2 }), config: budgetConfigFromEnv({ PROCESS_MAX_JOBS: '4' }) });
    w.start();
    await vi.waitFor(() => expect(s.jobs()[0]!.pid).not.toBeNull());
    const first = s.jobs()[0]!;
    s.track(first.media_file_id);

    const second = s.addQueued('b.mkv', true);
    w.kick();
    await vi.waitFor(() => expect(s.jobOf(second).pid).not.toBeNull());
    expect(s.jobOf(second).status).toBe('running');
    expect(s.jobOf(first.media_file_id).status).toBe('running'); // the extra slot, not a preemption
    s.track(second);

    s.open();
    await w.drain();
    w.stop();
    expect(s.mainRuns).toHaveLength(2);
  });

  it('worker.budget() is null without the budget option', () => {
    const { db } = setup();
    const w = createWorker({ db, dataDir: 'data', contentDir: 'content' });
    expect(w.budget()).toBeNull();
    w.kick();
    expect(w.budget()).toBeNull();
  });
});

describe('PROCESS_NICE', () => {
  it('defaults to 19 and only accepts a valid nice value', () => {
    expect(niceFromEnv({})).toBe(19);
    expect(niceFromEnv({ PROCESS_NICE: '10' })).toBe(10);
    expect(niceFromEnv({ PROCESS_NICE: '0' })).toBe(0);
    expect(niceFromEnv({ PROCESS_NICE: 'abc' })).toBe(19);
    expect(niceFromEnv({ PROCESS_NICE: '-25' })).toBe(19);
    expect(niceFromEnv({ PROCESS_NICE: '' })).toBe(19);
  });
});
