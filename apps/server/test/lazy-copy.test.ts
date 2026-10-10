import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { get, run } from '../src/db/sql.ts';
import type { RunFfmpeg } from '../src/modules/processing/ffmpeg.ts';
import type { StreamInfo } from '../src/modules/processing/plan.ts';
import { enqueue } from '../src/modules/processing/queue.ts';
import { createWorker } from '../src/modules/processing/worker.ts';
import { addFile, addTitle, setup } from './helpers.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const COPY: StreamInfo = {
  durationS: 100,
  video: { index: 0, codec: 'h264', profile: 'High', pixFmt: 'yuv420p' },
  audio: [{ index: 1, codec: 'aac', language: 'jpn', title: null, channels: 2 }],
  subtitles: [],
  attachments: [],
};
const X264: StreamInfo = { ...COPY, video: { index: 0, codec: 'h264', profile: 'High 10', pixFmt: 'yuv420p10le' } };

const roomy = async () => ({ bsize: 1024 * 1024, blocks: 2_000_000, bavail: 1_000_000 });

function writePackage(out: string) {
  writeFileSync(
    join(out, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="a",URI="a0/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="group_aud"\nv/index.m3u8\n',
  );
  for (const p of ['v/index.m3u8', 'a0/index.m3u8']) writeFileSync(join(out, p), '#EXTM3U\n#EXTINF:6.0,\nseg_00000.m4s\n');
  writeFileSync(join(out, 'v/seg_00000.m4s'), 'x'.repeat(1000));
}

function env(info: StreamInfo = COPY, workerOpts: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-lazy-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const contentDir = join(root, 'content');
  mkdirSync(contentDir, { recursive: true });
  const { db } = setup();
  const titleId = addTitle(db, 'T', { kind: 'anime' });
  const mainRuns: string[][] = [];
  const fake: RunFfmpeg = async (args) => {
    if (!args.includes('-var_stream_map')) return;
    mainRuns.push(args);
    writePackage(dirname(dirname(args.at(-1)!)));
  };
  const worker = createWorker({ db, dataDir, contentDir, runFfmpeg: fake, probeStreams: async () => info, statfs: roomy, ...workerOpts });
  const app = buildApp({ db, dataDir, worker });
  const source = (rel = 'a.mkv') => {
    writeFileSync(join(contentDir, rel), 'x');
    const id = addFile(db, titleId, { status: 'pending' });
    db.prepare('UPDATE media_files SET path = ?, duration_s = 100 WHERE id = ?').run(rel, id);
    enqueue(db, id);
    return id;
  };
  const file = (id: number) => get<any>(db, 'SELECT * FROM media_files WHERE id = ?', id);
  const job = (id: number) => get<any>(db, 'SELECT * FROM jobs WHERE media_file_id = ? ORDER BY id DESC', id);
  const play = (id: number) => app.inject({ method: 'POST', url: `/api/media-files/${id}/play` });
  return { db, app, dataDir, worker, source, file, job, play, mainRuns };
}

describe('lazy copy mode (T47c)', () => {
  it('leaves a copy-mode file ready without a package, keeping its tracks', async () => {
    const e = env(COPY);
    const id = e.source();
    await e.worker.drain();

    expect(e.file(id)).toMatchObject({ status: 'ready', hls_dir: null, pkg_mode: 'copy', error: null });
    expect(JSON.parse(e.file(id).audio_tracks)[0]).toMatchObject({ language: 'jpn', playlist: 'a0/index.m3u8' });
    expect(e.job(id)).toMatchObject({ status: 'done', progress: 1 });
    expect(e.mainRuns).toHaveLength(0);
    expect(existsSync(join(e.dataDir, 'hls', String(id)))).toBe(false);
  });

  it('keeps encoding re-encode (x264) files in the queue and records their package', async () => {
    const e = env(X264);
    const id = e.source();
    await e.worker.drain();

    expect(e.file(id)).toMatchObject({ status: 'ready', hls_dir: `hls/${id}`, pkg_mode: 'x264' });
    expect(e.file(id).pkg_bytes).toBeGreaterThan(1000);
    expect(e.mainRuns).toHaveLength(1);
  });

  it('can be switched off: copy files are packaged on import again', async () => {
    const e = env(COPY, { lazyCopy: false });
    const id = e.source();
    await e.worker.drain();
    expect(e.file(id)).toMatchObject({ status: 'ready', hls_dir: `hls/${id}`, pkg_mode: 'copy' });
  });

  it('generates the package on the first play, answering preparing until it is ready', async () => {
    const e = env(COPY);
    const id = e.source();
    await e.worker.drain();

    const res = await e.play(id);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'processing', preparing: true });
    await e.worker.drain();

    expect(e.file(id)).toMatchObject({ status: 'ready', hls_dir: `hls/${id}`, pkg_mode: 'copy' });
    expect(e.file(id).last_played_at).not.toBeNull();
    expect(e.mainRuns).toHaveLength(1);
    expect((await e.play(id)).json()).toEqual({ status: 'ready' });
  });

  it('also generates it when the player asks for the stream directly', async () => {
    const e = env(COPY);
    const id = e.source();
    await e.worker.drain();

    const res = await e.app.inject(`/api/stream/${id}/master.m3u8`);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'preparing' });
    await e.worker.drain();

    expect(e.file(id).hls_dir).toBe(`hls/${id}`);
    expect((await e.app.inject(`/api/stream/${id}/master.m3u8`)).statusCode).toBe(200);
  });

  it('records the playback time while streaming, at most once a minute', async () => {
    const e = env(X264);
    const id = e.source();
    await e.worker.drain();
    run(e.db, "UPDATE media_files SET last_played_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", id);

    expect((await e.app.inject(`/api/stream/${id}/master.m3u8`)).statusCode).toBe(200);
    const first = e.file(id).last_played_at;
    expect(first > '2026-01-01').toBe(true);
    await e.app.inject(`/api/stream/${id}/v/seg_00000.m4s`);
    expect(e.file(id).last_played_at).toBe(first);
  });

  it('leaves a ready file with an unknown package mode untouched by play', async () => {
    const e = env(COPY);
    const id = addFile(e.db, addTitle(e.db, 'Legacy'), { status: 'ready' });
    expect((await e.play(id)).json()).toEqual({ status: 'ready' });
    expect(get(e.db, 'SELECT COUNT(*) AS n FROM jobs')).toEqual({ n: 0 });
  });

  it('evicts the least recently played copy package once a new one pushes the cache over budget', async () => {
    const e = env(COPY, { cacheBudgetBytes: 1500 });
    const old = e.source('old.mkv');
    await e.worker.drain();
    await e.play(old);
    await e.worker.drain();
    run(e.db, "UPDATE media_files SET last_played_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", old);

    const fresh = e.source('fresh.mkv');
    await e.worker.drain();
    await e.play(fresh);
    await e.worker.drain();

    expect(e.file(old)).toMatchObject({ status: 'ready', hls_dir: null, pkg_mode: 'copy' });
    expect(existsSync(join(e.dataDir, 'hls', String(old)))).toBe(false);
    expect(e.file(fresh).hls_dir).toBe(`hls/${fresh}`);
    expect(existsSync(join(e.dataDir, 'hls', String(fresh)))).toBe(true);
  });
});
