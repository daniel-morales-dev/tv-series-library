import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { all, get } from '../src/db/sql.ts';
import { createIngestor } from '../src/modules/ingest/ingestor.ts';
import type { Probe } from '../src/modules/ingest/probe.ts';
import { makeFakeTmdb } from './fake-tmdb.ts';
import { setup } from './helpers.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = Date.parse('2026-01-01T12:00:00Z');
const bake = (tag: string) => `shows/bakemonogatari/[Coalgirls]_Bakemonogatari_${tag}_(1920x1080_Blu-ray_FLAC)_[ABCD1234].mkv`;

function env({ offline = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-ingest-'));
  roots.push(root);
  const contentDir = join(root, 'content');
  const dataDir = join(root, 'data');
  const { db } = setup();
  const badFiles = new Set<string>();
  const probed: string[] = [];
  const probe: Probe = async (path) => {
    probed.push(path);
    if (badFiles.has(path)) throw new Error('moov atom not found');
    return {
      durationS: 1440.5,
      audio: [{ index: 1, codec: 'flac', language: 'jpn', title: null, channels: 2 }],
      subtitles: [{ index: 2, codec: 'ass', language: 'eng', title: 'Full' }],
    };
  };
  const tmdb = makeFakeTmdb({ offline });
  const make = (client = tmdb) => createIngestor({ db, tmdb: client, dataDir, contentDir, probe, now: () => NOW });
  const addFile = (rel: string, ageS = 3600) => {
    const abs = join(contentDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
    const t = (NOW - ageS * 1000) / 1000;
    utimesSync(abs, t, t);
    return abs;
  };
  return { db, tmdb, make, addFile, badFiles, probed, ingestor: make() };
}

describe('scanner and registration', () => {
  it('ingests videos only, linking episodes and extras with ffprobe data', async () => {
    const e = env();
    for (const t of ['01', '02', '15', 'OP2']) e.addFile(bake(t));
    e.addFile('shows/bakemonogatari/Commentary/15.xdelta');
    e.addFile('shows/bakemonogatari/Readme.txt');

    const summary = await e.ingestor.scan();
    expect(summary).toMatchObject({ ingested: 4, pending: 0 });

    const files = all<any>(e.db, 'SELECT * FROM media_files ORDER BY path');
    expect(files).toHaveLength(4);
    expect(files.every((f) => f.status === 'pending' && f.duration_s === 1440.5)).toBe(true);
    expect(JSON.parse(files[0].audio_tracks)).toEqual([{ index: 1, codec: 'flac', language: 'jpn', title: null, channels: 2 }]);
    expect(JSON.parse(files[0].subtitle_tracks)[0]).toMatchObject({ codec: 'ass', language: 'eng' });

    const linked = all<any>(e.db, 'SELECT m.extra_label, m.parsed_number, e.number FROM media_files m LEFT JOIN episodes e ON e.id = m.episode_id ORDER BY m.parsed_number');
    expect(linked.filter((l) => l.number !== null).map((l) => l.number)).toEqual([1, 2, 15]);
    expect(linked.find((l) => l.extra_label)).toMatchObject({ extra_label: 'OP2', number: null });
    expect(get<any>(e.db, 'SELECT COUNT(*) AS n FROM titles')?.n).toBe(1);
    expect(all(e.db, 'SELECT * FROM pending_files')).toHaveLength(0);
  });

  it('skips files that are too recent or that ffprobe cannot read, saving nothing', async () => {
    const e = env();
    e.addFile(bake('01'), 10);
    const broken = e.addFile(bake('02'));
    e.badFiles.add(broken);

    expect(await e.ingestor.scan()).toMatchObject({ ingested: 0, waiting: 2 });
    expect(all(e.db, 'SELECT * FROM titles')).toHaveLength(0);
    expect(all(e.db, 'SELECT * FROM media_files')).toHaveLength(0);
    expect(e.tmdb.calls).toEqual([]);

    e.badFiles.clear();
    e.addFile(bake('01'), 3600);
    expect(await e.ingestor.scan()).toMatchObject({ ingested: 2 });
  });

  it('does not touch known files or TMDB on a second scan', async () => {
    const e = env();
    e.addFile(bake('01'));
    await e.ingestor.scan();
    e.tmdb.calls.length = 0;
    e.probed.length = 0;
    expect(await e.ingestor.scan()).toMatchObject({ ingested: 0 });
    expect(e.tmdb.calls).toEqual([]);
    expect(e.probed).toEqual([]);
  });

  it('runs one scan at a time', async () => {
    const e = env();
    e.addFile(bake('01'));
    const [a, b] = await Promise.all([e.ingestor.scan(), e.ingestor.scan()]);
    expect(a).toBe(b);
    expect(e.probed).toHaveLength(1);
  });

  it('ingests a movie and a plain SxxEyy show', async () => {
    const e = env();
    e.addFile('films/Inception (2010).mkv');
    e.addFile('shows/Plain Show/Plain Show S02E01.mkv');
    e.addFile('shows/Plain Show/Plain Show S02E02.mkv');
    expect(await e.ingestor.scan()).toMatchObject({ ingested: 3 });
    expect(get<any>(e.db, "SELECT title FROM titles WHERE kind = 'movie'")?.title).toBe('Origen');
    expect(all<any>(e.db, 'SELECT s.number AS s, e.number AS e FROM media_files m JOIN episodes e ON e.id = m.episode_id JOIN seasons s ON s.id = e.season_id ORDER BY e.number')).toEqual([
      { s: 2, e: 1 },
      { s: 2, e: 2 },
    ]);
  });
});

describe('pending files', () => {
  it('records unparsed, unmatched and unmapped files with their reason', async () => {
    const e = env();
    e.addFile('shows/bakemonogatari/Bakemonogatari_16.mkv');
    e.addFile('shows/zzz/zzz 01.mkv');
    e.addFile('shows/zzz/zzz 02.mkv');
    e.addFile('shows/Plain Show/behind the scenes.mkv');
    e.addFile('shows/loose.mkv');

    const summary = await e.ingestor.scan();
    expect(summary).toMatchObject({ ingested: 0, pending: 5 });
    const rows = all<any>(e.db, 'SELECT path, reason, candidates, status FROM pending_files ORDER BY path');
    const by = (p: string) => rows.find((r) => r.path === p);
    expect(by('shows/bakemonogatari/Bakemonogatari_16.mkv').reason).toBe('unmapped_episode');
    expect(by('shows/zzz/zzz 01.mkv').reason).toBe('no_match');
    expect(JSON.parse(by('shows/zzz/zzz 01.mkv').candidates)).toHaveLength(2);
    expect(by('shows/Plain Show/behind the scenes.mkv').reason).toBe('unparsed');
    expect(by('shows/loose.mkv').reason).toBe('unparsed');
    expect(rows.every((r) => r.status === 'open')).toBe(true);
    // one search for the whole unmatched folder
    expect(e.tmdb.calls.filter((c) => c.startsWith('searchTv:zzz'))).toHaveLength(1);

    e.tmdb.calls.length = 0;
    await e.ingestor.scan();
    expect(e.tmdb.calls).toEqual([]);
  });
});

describe('offline mode', () => {
  it('creates local titles, then upgrades them in place once TMDB answers', async () => {
    const e = env({ offline: true });
    for (const t of ['01', '15', '16', 'OP2']) e.addFile(bake(t));
    e.addFile('films/Inception (2010).mkv');

    expect(await e.ingestor.scan()).toMatchObject({ ingested: 5, pending: 0 });
    const local = all<any>(e.db, 'SELECT id, title, metadata_status, tmdb_id FROM titles ORDER BY title COLLATE NOCASE');
    expect(local).toEqual([
      { id: expect.any(Number), title: 'bakemonogatari', metadata_status: 'pending', tmdb_id: null },
      { id: expect.any(Number), title: 'Inception', metadata_status: 'pending', tmdb_id: null },
    ]);
    expect(all(e.db, 'SELECT id FROM titles')).toHaveLength(2);
    expect(all(e.db, 'SELECT * FROM seasons')).toHaveLength(1);
    expect(all<any>(e.db, 'SELECT number FROM episodes ORDER BY number').map((r) => r.number)).toEqual([1, 15, 16]);
    const showId = local[0].id;
    const fileIds = all<any>(e.db, 'SELECT id FROM media_files ORDER BY id').map((r) => r.id);

    // still offline: nothing changes, nothing duplicates
    await e.make().scan();
    expect(all(e.db, 'SELECT id FROM titles')).toHaveLength(2);

    const online = e.make(makeFakeTmdb());
    await online.scan();
    const titles = all<any>(e.db, 'SELECT id, title, tmdb_id, metadata_status FROM titles ORDER BY tmdb_id DESC');
    expect(titles).toEqual([
      { id: showId, title: 'Monogatari', tmdb_id: 46195, metadata_status: 'ready' },
      { id: expect.any(Number), title: 'Origen', tmdb_id: 27205, metadata_status: 'ready' },
    ]);
    const files = all<any>(e.db, 'SELECT m.id, m.title_id, m.extra_label, e.number, s.name AS season FROM media_files m LEFT JOIN episodes e ON e.id = m.episode_id LEFT JOIN seasons s ON s.id = e.season_id ORDER BY m.id');
    expect(files.map((f) => f.id).filter((id) => fileIds.includes(id))).toHaveLength(4);
    const episodes = files.filter((f) => f.number !== null);
    expect(episodes.map((f) => [f.number, f.season])).toEqual([[1, 'Bakemonogatari'], [15, 'Bakemonogatari']]);
    expect(files.find((f) => f.extra_label)?.extra_label).toBe('OP2');
    // episode 16 does not exist in the group: it becomes a pending file
    expect(all<any>(e.db, 'SELECT reason FROM pending_files')).toEqual([{ reason: 'unmapped_episode' }]);
    expect(all(e.db, 'SELECT * FROM seasons')).toHaveLength(1);
  });

  it('merges an offline placeholder into a title that already exists', async () => {
    const e = env();
    e.addFile('shows/nisemonogatari/Nisemonogatari_01.mkv');
    await e.ingestor.scan();
    e.addFile(bake('01'));
    await e.make(makeFakeTmdb({ offline: true })).scan();
    expect(all(e.db, 'SELECT id FROM titles')).toHaveLength(2);

    await e.make(makeFakeTmdb()).scan();
    expect(all(e.db, 'SELECT id FROM titles')).toHaveLength(1);
    const files = all<any>(e.db, 'SELECT s.number AS s, e.number AS e FROM media_files m JOIN episodes e ON e.id = m.episode_id JOIN seasons s ON s.id = e.season_id ORDER BY s.number');
    expect(files).toEqual([{ s: 1, e: 1 }, { s: 2, e: 1 }]);
    expect(all(e.db, "SELECT * FROM search_index WHERE ref_type = 'title'")).toHaveLength(1);
  });
});
