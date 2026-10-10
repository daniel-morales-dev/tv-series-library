import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { get, run } from '../src/db/sql.ts';
import { LowDiskError, createCache, dirBytes, touchPlayed } from '../src/modules/processing/cache.ts';
import type { RunFfmpeg } from '../src/modules/processing/ffmpeg.ts';
import type { StreamInfo } from '../src/modules/processing/plan.ts';
import { enqueue } from '../src/modules/processing/queue.ts';
import { createWorker } from '../src/modules/processing/worker.ts';
import { addFile, addTitle, setup } from './helpers.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const OLD = '2026-10-01T00:00:00.000Z';
const RECENT = '2026-10-10T11:50:00.000Z';

const COPY: StreamInfo = {
  durationS: 100,
  video: { index: 0, codec: 'h264', profile: 'High', pixFmt: 'yuv420p' },
  audio: [],
  subtitles: [],
  attachments: [],
};
const X264: StreamInfo = { ...COPY, video: { index: 0, codec: 'h264', profile: 'High 10', pixFmt: 'yuv420p10le' } };

function base() {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-cache-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const contentDir = join(root, 'content');
  mkdirSync(join(dataDir, 'hls'), { recursive: true });
  mkdirSync(contentDir, { recursive: true });
  const { db } = setup();
  const titleId = addTitle(db, 'T', { kind: 'anime' });
  return { db, dataDir, contentDir, titleId };
}

// A 1000-block volume of 1-byte blocks whose used space is whatever sits under hls/.
const volume = (dataDir: string) => async () => ({ bsize: 1, blocks: 1000, bavail: 1000 - (await dirBytes(join(dataDir, 'hls'))) });

function cacheEnv(o: { budgetBytes?: number; minFreeBytes?: number; probe?: StreamInfo } = {}) {
  const b = base();
  const logs: string[] = [];
  let n = 0;
  const cache = createCache({
    db: b.db,
    dataDir: b.dataDir,
    contentDir: b.contentDir,
    budgetBytes: o.budgetBytes ?? 1e12,
    minFreeBytes: o.minFreeBytes ?? 0,
    minFreePct: 0,
    probeStreams: async () => o.probe ?? COPY,
    statfs: volume(b.dataDir),
    now: () => NOW,
    log: (_level, message) => void logs.push(message),
  });
  // A ready file with a package of `bytes` bytes on disk.
  const pkg = (p: { mode?: 'copy' | 'x264' | null; bytes?: number; played?: string | null; original?: boolean; package?: boolean } = {}) => {
    const rel = `f${++n}.mkv`;
    const id = addFile(b.db, b.titleId, { status: 'ready' });
    if (p.original !== false) writeFileSync(join(b.contentDir, rel), 'x');
    const hasPackage = p.package !== false;
    if (hasPackage) {
      mkdirSync(join(b.dataDir, 'hls', String(id)), { recursive: true });
      writeFileSync(join(b.dataDir, 'hls', String(id), 'seg.m4s'), 'x'.repeat(p.bytes ?? 100));
    }
    run(
      b.db,
      'UPDATE media_files SET path = ?, hls_dir = ?, pkg_mode = ?, pkg_bytes = ?, last_played_at = ? WHERE id = ?',
      rel,
      hasPackage ? `hls/${id}` : null,
      p.mode === undefined ? 'copy' : p.mode,
      hasPackage && p.mode !== null ? (p.bytes ?? 100) : null,
      p.played === undefined ? OLD : p.played,
      id,
    );
    return id;
  };
  const row = (id: number) => get<any>(b.db, 'SELECT * FROM media_files WHERE id = ?', id);
  const onDisk = (id: number) => existsSync(join(b.dataDir, 'hls', String(id)));
  return { ...b, cache, pkg, row, onDisk, logs };
}

describe('cache budget (LRU)', () => {
  it('evicts the least recently played copy packages until the cache fits, logging first', async () => {
    const e = cacheEnv({ budgetBytes: 250 });
    const a = e.pkg({ played: '2026-10-01T00:00:00.000Z' });
    const b = e.pkg({ played: '2026-10-02T00:00:00.000Z' });
    const c = e.pkg({ played: '2026-10-03T00:00:00.000Z' });

    await e.cache.enforceBudget(-1);

    expect(e.row(a)).toMatchObject({ status: 'ready', hls_dir: null, pkg_mode: 'copy', pkg_bytes: null });
    expect(e.onDisk(a)).toBe(false);
    expect([e.onDisk(b), e.onDisk(c)]).toEqual([true, true]);
    expect(e.logs.join('\n')).toMatch(/evict/i);
  });

  it('does nothing while the cache fits the budget', async () => {
    const e = cacheEnv({ budgetBytes: 300 });
    const ids = [e.pkg(), e.pkg(), e.pkg()];
    await e.cache.enforceBudget(-1);
    expect(ids.map(e.onDisk)).toEqual([true, true, true]);
    expect(e.logs).toEqual([]);
  });

  it('never evicts x264 packages, the one in use, active jobs, unknown modes or sources that are gone', async () => {
    const e = cacheEnv({ budgetBytes: 0 });
    const x264 = e.pkg({ mode: 'x264' });
    const unknown = e.pkg({ mode: null });
    const noOriginal = e.pkg({ original: false });
    const playing = e.pkg({ played: RECENT });
    const protectedId = e.pkg();
    const busy = e.pkg();
    enqueue(e.db, busy);
    const lazy = e.pkg({ package: false });

    await e.cache.enforceBudget(protectedId);

    expect([x264, unknown, noOriginal, playing, protectedId, busy].map(e.onDisk)).toEqual([true, true, true, true, true, true]);
    expect(e.row(lazy).hls_dir).toBeNull();
  });

  it('classifies packages that predate the cache by probing the source, and skips sources that are gone', async () => {
    const copy = cacheEnv({ probe: COPY });
    const a = copy.pkg({ mode: null, bytes: 120 });
    const gone = copy.pkg({ mode: null, original: false });
    await copy.cache.classifyLegacy();
    expect(copy.row(a)).toMatchObject({ pkg_mode: 'copy', pkg_bytes: 120 });
    expect(copy.row(gone).pkg_mode).toBeNull();

    const enc = cacheEnv({ probe: X264 });
    const b = enc.pkg({ mode: null });
    await enc.cache.classifyLegacy();
    expect(enc.row(b).pkg_mode).toBe('x264');
  });
});

describe('free space protection', () => {
  it('lets the work proceed when enough space stays free', async () => {
    const e = cacheEnv({ minFreeBytes: 100 });
    const a = e.pkg({ bytes: 300 });
    await e.cache.ensureSpace(100, -1); // free 700, needs 100 + 100
    expect(e.onDisk(a)).toBe(true);
  });

  it('evicts the least recently played copy packages to make room, and only as many as needed', async () => {
    const e = cacheEnv({ minFreeBytes: 100 });
    const a = e.pkg({ bytes: 300, played: '2026-10-01T00:00:00.000Z' });
    const b = e.pkg({ bytes: 300, played: '2026-10-02T00:00:00.000Z' });
    const c = e.pkg({ bytes: 300, played: '2026-10-03T00:00:00.000Z' });
    // free = 100; needs 250 + 100 → one eviction (+300) is enough.
    await e.cache.ensureSpace(250, -1);
    expect([e.onDisk(a), e.onDisk(b), e.onDisk(c)]).toEqual([false, true, true]);
  });

  it('throws LowDiskError without evicting when even the whole cache would not be enough', async () => {
    const e = cacheEnv({ minFreeBytes: 100 });
    const a = e.pkg({ bytes: 300 });
    e.pkg({ bytes: 300, mode: 'x264' });
    await expect(e.cache.ensureSpace(5000, -1)).rejects.toBeInstanceOf(LowDiskError);
    expect(e.onDisk(a)).toBe(true);
  });
});

describe('touchPlayed', () => {
  it('stamps the file and rewrites the stamp at most once a minute', () => {
    const { db, titleId } = base();
    const id = addFile(db, titleId, { status: 'ready' });
    const stamp = () => get<{ t: string | null }>(db, 'SELECT last_played_at AS t FROM media_files WHERE id = ?', id)!.t;
    touchPlayed(db, id, NOW);
    expect(stamp()).toBe('2026-10-10T12:00:00.000Z');
    touchPlayed(db, id, NOW + 10_000);
    expect(stamp()).toBe('2026-10-10T12:00:00.000Z');
    touchPlayed(db, id, NOW + 61_000);
    expect(stamp()).toBe('2026-10-10T12:01:01.000Z');
  });
});

describe('worker under low disk', () => {
  function workerEnv(free: { blocks: number }) {
    const b = base();
    const mainRuns: string[][] = [];
    const fake: RunFfmpeg = async (args) => {
      if (!args.includes('-var_stream_map')) return;
      mainRuns.push(args);
      const out = dirname(dirname(args.at(-1)!));
      writeFileSync(join(out, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv/index.m3u8\n');
      writeFileSync(join(out, 'v/index.m3u8'), '#EXTM3U\n#EXTINF:6.0,\nseg_00000.m4s\n');
    };
    const worker = createWorker({
      db: b.db,
      dataDir: b.dataDir,
      contentDir: b.contentDir,
      runFfmpeg: fake,
      probeStreams: async () => X264,
      statfs: async () => ({ bsize: 1, blocks: 1000, bavail: free.blocks }),
      minFreeBytes: 100,
      minFreePct: 0,
    });
    const app = buildApp({ db: b.db, dataDir: b.dataDir, worker });
    writeFileSync(join(b.contentDir, 'a.mkv'), 'x');
    const id = addFile(b.db, b.titleId, { status: 'pending' });
    b.db.prepare("UPDATE media_files SET path = 'a.mkv', duration_s = 100 WHERE id = ?").run(id);
    enqueue(b.db, id);
    const file = () => get<any>(b.db, 'SELECT * FROM media_files WHERE id = ?', id);
    const job = () => get<any>(b.db, 'SELECT * FROM jobs WHERE media_file_id = ?', id);
    const activity = async () => (await app.inject('/api/activity')).json();
    return { worker, file, job, activity, mainRuns };
  }
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(cond()).toBe(true);
  };

  it('pauses with a low_disk notice instead of writing, and resumes by itself once space is free', async () => {
    const free = { blocks: 50 };
    const e = workerEnv(free);
    await e.worker.drain();

    expect(e.worker.isPaused()).toBe(true);
    expect(e.worker.lowDisk()?.message).toMatch(/espacio/i);
    expect(e.mainRuns).toHaveLength(0);
    expect(e.job()).toMatchObject({ status: 'queued', progress: 0 });
    expect(e.file().status).toBe('pending');
    expect(await e.activity()).toMatchObject({ paused: true, lowDisk: true, lowDiskMessage: expect.stringMatching(/espacio/i) });

    free.blocks = 800;
    e.worker.kick();
    await until(() => e.file().status === 'ready');
    expect(e.worker.isPaused()).toBe(false);
    expect(e.worker.lowDisk()).toBeNull();
    expect(await e.activity()).toMatchObject({ lowDisk: false, lowDiskMessage: null });
  });

  it('stays paused while the space is only just above the threshold for the pending job', async () => {
    const free = { blocks: 50 };
    const e = workerEnv(free);
    await e.worker.drain();
    free.blocks = 101; // above the 100 minimum but below minimum + the job's estimate
    e.worker.kick();
    await new Promise((r) => setTimeout(r, 100));
    expect(e.worker.isPaused()).toBe(true);
    expect(e.mainRuns).toHaveLength(0);
  });

  it('a manual resume retries the job and pauses again when the disk is still low', async () => {
    const free = { blocks: 50 };
    const e = workerEnv(free);
    await e.worker.drain();
    e.worker.resume();
    await e.worker.drain();
    expect(e.worker.isPaused()).toBe(true);
    expect(e.worker.lowDisk()).not.toBeNull();

    free.blocks = 800;
    e.worker.resume();
    await until(() => e.file().status === 'ready');
    expect(e.worker.lowDisk()).toBeNull();
  });
});
