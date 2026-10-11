import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { writeMarker } from '../src/config/config.ts';
import { all, get, run } from '../src/db/sql.ts';
import { available, availableFrom, rootAvailability, rootStatus } from '../src/library/roots.ts';
import { getTitleDetail, listTitles } from '../src/modules/catalog/repository.ts';
import { createIngestor } from '../src/modules/ingest/ingestor.ts';
import { setSourceDir } from '../src/modules/ingest/metadata.ts';
import type { Probe } from '../src/modules/ingest/probe.ts';
import type { RunFfmpeg } from '../src/modules/processing/ffmpeg.ts';
import type { StreamInfo } from '../src/modules/processing/plan.ts';
import { enqueue } from '../src/modules/processing/queue.ts';
import { createWorker } from '../src/modules/processing/worker.ts';
import { makeFakeTmdb } from './fake-tmdb.ts';
import { addFile, addTitle, setup } from './helpers.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (prefix = 'tvlib-avail-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
};

function addRoot(db: ReturnType<typeof setup>['db'], path: string, libraryId: string, label = 'HDD') {
  return run(db, 'INSERT INTO library_roots (library_id, last_known_path, label, position) VALUES (?, ?, ?, 1)', libraryId, path, label).lastInsertId;
}

describe('rootStatus', () => {
  it('reports a marked folder as present with its label and last known path', () => {
    const { db } = setup();
    const dir = tmp();
    writeMarker(dir, 'hdd-1');
    const id = addRoot(db, dir, 'hdd-1');
    expect(rootStatus(db, id)).toEqual({ present: true, label: 'HDD', lastKnownPath: dir, sameLibrary: true });
  });

  it('reports a root whose folder is gone as absent, without touching the catalog', () => {
    const { db } = setup();
    const dir = join(tmp(), 'gone');
    mkdirSync(dir);
    writeMarker(dir, 'hdd-1');
    const id = addRoot(db, dir, 'hdd-1');
    rmSync(dir, { recursive: true, force: true });
    expect(rootStatus(db, id)).toMatchObject({ present: false, sameLibrary: false, lastKnownPath: dir });
  });

  it('reports a folder that is no longer the saved device as absent', () => {
    const { db } = setup();
    const dir = tmp();
    writeMarker(dir, 'hdd-1');
    const id = addRoot(db, dir, 'hdd-1');
    expect(rootStatus(db, id, { dev: statSync(dir).dev + 1 }).present).toBe(false);
    expect(rootStatus(db, id, { dev: statSync(dir).dev }).present).toBe(true);
  });

  it('does not take a folder marked by another library', () => {
    const { db } = setup();
    const dir = tmp();
    writeMarker(dir, 'someone-else');
    const id = addRoot(db, dir, 'hdd-1');
    expect(rootStatus(db, id)).toMatchObject({ present: false, sameLibrary: false });
  });

  it('treats a root with no known path as present (legacy single-folder setups)', () => {
    const { db } = setup();
    expect(rootStatus(db, 1)).toMatchObject({ present: true, lastKnownPath: null });
    expect(rootAvailability(db).get(1)).toBe(true);
  });
});

describe('available', () => {
  it('follows the file root and keeps an x264 package playable without its source', () => {
    const { db } = setup();
    const dir = tmp();
    writeMarker(dir, 'hdd-1');
    const id = addRoot(db, dir, 'hdd-1');
    expect(available(db, { root_id: id, hls_dir: null, pkg_mode: null })).toBe(true);
    rmSync(dir, { recursive: true, force: true });
    expect(available(db, { root_id: id, hls_dir: null, pkg_mode: null })).toBe(false);
    expect(available(db, { root_id: id, hls_dir: 'hls/1', pkg_mode: 'x264' })).toBe(true);
    expect(available(db, { root_id: id, hls_dir: 'hls/1', pkg_mode: 'copy' })).toBe(false);
    expect(available(db, { root_id: id, hls_dir: null, pkg_mode: 'x264' })).toBe(false);
  });

  it('reads a precomputed root map for bulk DTOs', () => {
    const rootsMap = new Map([[2, false]]);
    expect(availableFrom(rootsMap, { root_id: 2, hls_dir: null, pkg_mode: null })).toBe(false);
    expect(availableFrom(rootsMap, { root_id: 2, hls_dir: 'hls/2', pkg_mode: 'x264' })).toBe(true);
    expect(availableFrom(rootsMap, { root_id: 1, hls_dir: null, pkg_mode: null })).toBe(true);
  });
});

const NOW = Date.parse('2026-01-01T12:00:00Z');

function ingestEnv() {
  const root = tmp('tvlib-avail-ingest-');
  const contentDir = join(root, 'content');
  const hdd = join(root, 'hdd');
  mkdirSync(join(contentDir, 'shows'), { recursive: true });
  mkdirSync(join(hdd, 'shows'), { recursive: true });
  writeMarker(hdd, 'hdd-1');
  const { db } = setup();
  const hddId = addRoot(db, hdd, 'hdd-1');
  const titleId = addTitle(db, 'Show A', { kind: 'series' });
  run(db, "UPDATE titles SET metadata_status = 'ready' WHERE id = ?", titleId);
  setSourceDir(db, 'shows/Show A', titleId, 1);
  setSourceDir(db, 'shows/Show B', titleId, 1, hddId);
  const probe: Probe = async () => ({ durationS: 100, audio: [], subtitles: [] });
  const ingestor = createIngestor({ db, tmdb: makeFakeTmdb(), dataDir: join(root, 'data'), contentDir, probe, now: () => NOW });
  const addVideo = (base: string, rel: string) => {
    const abs = join(base, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
    utimesSync(abs, (NOW - 3600_000) / 1000, (NOW - 3600_000) / 1000);
  };
  return { db, contentDir, hdd, hddId, titleId, ingestor, addVideo };
}

describe('ingest per root', () => {
  it('scans every present root and leaves the rows of an absent one untouched', async () => {
    const e = ingestEnv();
    e.addVideo(e.contentDir, 'shows/Show A/Show A S01E01.mkv');
    e.addVideo(e.hdd, 'shows/Show B/Show B S01E01.mkv');
    expect(await e.ingestor.scan()).toMatchObject({ ingested: 2, failed: 0 });
    expect(get(e.db, 'SELECT root_id FROM media_files WHERE path LIKE ?', '%Show B%')).toMatchObject({ root_id: e.hddId });

    rmSync(e.hdd, { recursive: true, force: true });
    e.addVideo(e.contentDir, 'shows/Show A/Show A S01E02.mkv');
    const before = all(e.db, 'SELECT id, path, status FROM media_files WHERE root_id = ?', e.hddId);
    expect(before).toHaveLength(1);
    expect(await e.ingestor.scan()).toMatchObject({ ingested: 1, failed: 0 });
    expect(all(e.db, 'SELECT id, path, status FROM media_files WHERE root_id = ?', e.hddId)).toEqual(before);
  });

  it('never supersedes a row of an absent root from another root', async () => {
    const e = ingestEnv();
    e.addVideo(e.contentDir, 'shows/Show A/Show A - 01.mkv');
    e.addVideo(e.hdd, 'shows/Show B/Show B S01E01.mkv');
    await e.ingestor.scan();
    const onHdd = get<{ id: number }>(e.db, 'SELECT id FROM media_files WHERE root_id = ?', e.hddId)!;

    rmSync(e.hdd, { recursive: true, force: true });
    e.addVideo(e.contentDir, 'shows/Show A/Show A S01E01.mkv');
    await e.ingestor.scan();
    expect(get(e.db, 'SELECT id FROM media_files WHERE id = ?', onHdd.id)).toBeDefined();
  });
});

const INFO: StreamInfo = {
  durationS: 100,
  video: { index: 0, codec: 'h264', profile: 'High 10', pixFmt: 'yuv420p10le' },
  audio: [{ index: 1, codec: 'aac', language: 'jpn', title: null, channels: 2 }],
  subtitles: [],
  attachments: [],
};
const roomy = async () => ({ bsize: 1024 * 1024, blocks: 2_000_000, bavail: 1_000_000 });

function writePackage(out: string) {
  writeFileSync(
    join(out, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="a",URI="a0/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="group_aud"\nv/index.m3u8\n',
  );
  for (const p of ['v/index.m3u8', 'a0/index.m3u8']) writeFileSync(join(out, p), '#EXTM3U\n#EXTINF:6.0,\nseg_00000.m4s\n');
  writeFileSync(join(out, 'v/seg_00000.m4s'), 'x'.repeat(1000));
}

describe('processing per root', () => {
  function env() {
    const root = tmp();
    const contentDir = join(root, 'content');
    const hdd = join(root, 'hdd');
    for (const dir of [join(contentDir, 'shows'), join(hdd, 'shows')]) mkdirSync(dir, { recursive: true });
    writeMarker(hdd, 'hdd-1');
    const { db } = setup();
    const hddId = addRoot(db, hdd, 'hdd-1');
    const titleId = addTitle(db, 'T', { kind: 'anime' });
    const primary = run(db, `INSERT INTO media_files (path, title_id, status, duration_s) VALUES ('shows/a.mkv', ?, 'pending', 100)`, titleId).lastInsertId;
    const onHdd = run(db, `INSERT INTO media_files (root_id, path, title_id, status, duration_s) VALUES (?, 'shows/b.mkv', ?, 'pending', 100)`, hddId, titleId).lastInsertId;
    writeFileSync(join(contentDir, 'shows/a.mkv'), 'x');
    writeFileSync(join(hdd, 'shows/b.mkv'), 'x');
    enqueue(db, primary);
    enqueue(db, onHdd);
    let probes = 0;
    const worker = createWorker({
      db,
      dataDir: join(root, 'data'),
      contentDir: (id) => (id === 1 ? contentDir : hdd),
      runFfmpeg: (async (args: string[]) => {
        if (args.includes('-var_stream_map')) writePackage(dirname(dirname(args.at(-1)!)));
      }) as RunFfmpeg,
      probeStreams: async () => {
        probes++;
        return INFO;
      },
      statfs: roomy,
    });
    return { db, contentDir, hdd, hddId, primary, onHdd, worker, probes: () => probes };
  }

  it('claims only jobs of present roots and leaves an absent root queued', async () => {
    const e = env();
    rmSync(e.hdd, { recursive: true, force: true });
    await e.worker.drain();
    expect(get(e.db, 'SELECT status FROM media_files WHERE id = ?', e.primary)).toMatchObject({ status: 'ready' });
    expect(get(e.db, 'SELECT status FROM media_files WHERE id = ?', e.onHdd)).toMatchObject({ status: 'pending' });
    expect(get(e.db, 'SELECT status FROM jobs WHERE media_file_id = ?', e.onHdd)).toMatchObject({ status: 'queued' });
    expect(e.probes()).toBe(1);
  });

  it('answers 503 disk_absent per the file root while the primary root keeps serving', async () => {
    const e = env();
    rmSync(e.hdd, { recursive: true, force: true });
    const lazy = run(
      e.db,
      `INSERT INTO media_files (root_id, path, title_id, status, pkg_mode) VALUES (?, 'shows/c.mkv', (SELECT title_id FROM media_files WHERE id = ?), 'ready', 'copy')`,
      e.hddId,
      e.primary,
    ).lastInsertId;
    const ready = run(e.db, `UPDATE media_files SET status = 'ready', hls_dir = 'hls/x', pkg_mode = 'x264' WHERE id = ?`, e.primary);
    const app = buildApp({ db: e.db, disk: { present: () => true } });

    const play = await app.inject({ method: 'POST', url: `/api/media-files/${lazy}/play` });
    expect(play.statusCode).toBe(503);
    expect(play.json()).toEqual({ error: 'disk_absent' });
    const ok = await app.inject({ method: 'POST', url: `/api/media-files/${e.primary}/play` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ status: 'ready' });
    const stream = await app.inject(`/api/stream/${lazy}/master.m3u8`);
    expect(stream.statusCode).toBe(503);
    expect(stream.json()).toEqual({ error: 'disk_absent' });
    expect(ready.changes).toBe(1);
  });
});

describe('catalog availability', () => {
  it('marks a title unavailable when all its files are, and recovers with an x264 package', () => {
    const { db } = setup();
    const dir = join(tmp(), 'hdd');
    mkdirSync(dir);
    writeMarker(dir, 'hdd-1');
    const hddId = addRoot(db, dir, 'hdd-1');
    const gone = addTitle(db, 'Gone');
    const fileId = run(db, `INSERT INTO media_files (root_id, path, title_id, status) VALUES (?, 'films/gone.mkv', ?, 'ready')`, hddId, gone).lastInsertId;
    const ok = addTitle(db, 'Ok');
    addFile(db, ok);
    rmSync(dir, { recursive: true, force: true });

    const listed = Object.fromEntries(listTitles(db, { limit: 10, offset: 0 }).map((t) => [t.title, t.available]));
    expect(listed).toEqual({ Gone: false, Ok: true });
    expect(getTitleDetail(db, gone)?.available).toBe(false);
    expect(getTitleDetail(db, gone)?.files[0]).toMatchObject({ available: false });

    run(db, "UPDATE media_files SET hls_dir = 'hls/x', pkg_mode = 'x264' WHERE id = ?", fileId);
    expect(getTitleDetail(db, gone)?.available).toBe(true);
    expect(listTitles(db, { limit: 10, offset: 0 }).find((t) => t.title === 'Gone')?.available).toBe(true);
  });
});
