import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, get, run } from '../src/db/sql.ts';
import { getTitleDetail, listTitles } from '../src/modules/catalog/repository.ts';
import { RECENT_RESCAN_MS, createIngestor } from '../src/modules/ingest/ingestor.ts';
import type { Probe } from '../src/modules/ingest/probe.ts';
import { relinkFiles } from '../src/modules/ingest/register.ts';
import { requeueErrors } from '../src/modules/processing/queue.ts';
import { makeFakeTmdb } from './fake-tmdb.ts';
import { addProfile, setup } from './helpers.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = Date.parse('2026-01-01T12:00:00Z');
const bake = (tag: string) => `shows/bakemonogatari/[Coalgirls]_Bakemonogatari_${tag}_(1920x1080_Blu-ray_FLAC)_[ABCD1234].mkv`;

function env({ offline = false, diskPresent = (): boolean => true } = {}) {
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
  let clock = NOW;
  const tick = (ms: number) => {
    clock += ms;
  };
  const make = (client = tmdb, present = diskPresent) =>
    createIngestor({ db, tmdb: client, dataDir, contentDir, probe, now: () => clock, diskPresent: present });
  const addFile = (rel: string, ageS = 3600, content = 'x') => {
    const abs = join(contentDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    const t = (NOW - ageS * 1000) / 1000;
    utimesSync(abs, t, t);
    return abs;
  };
  const move = (from: string, to: string) => {
    mkdirSync(dirname(join(contentDir, to)), { recursive: true });
    renameSync(join(contentDir, from), join(contentDir, to));
  };
  return { db, tmdb, make, addFile, move, badFiles, probed, tick, ingestor: make() };
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

  it('waits on unplaceable files that are too recent or unreadable, saving nothing', async () => {
    const e = env();
    e.addFile('shows/zzz/zzz 01.mkv', 10);
    e.addFile('shows/loose.mkv', 10);
    const broken = e.addFile('shows/Plain Show/behind the scenes.mkv');
    e.badFiles.add(broken);

    expect(await e.ingestor.scan()).toMatchObject({ ingested: 0, pending: 0, waiting: 3 });
    expect(all(e.db, 'SELECT * FROM media_files')).toHaveLength(0);
    expect(all(e.db, 'SELECT * FROM pending_files')).toHaveLength(0);
  });

  it('relabels stored extras from the current parser on scan', async () => {
    const e = env();
    const rel = 'shows/bakemonogatari/NC/Bakemonogatari - NCED 01 [BD].mkv';
    e.addFile(bake('01'));
    e.addFile(rel);
    await e.ingestor.scan();
    run(e.db, 'UPDATE media_files SET extra_label = ? WHERE path = ?', 'NCED', rel);
    await e.ingestor.scan();
    expect(get<any>(e.db, 'SELECT extra_label FROM media_files WHERE path = ?', rel)?.extra_label).toBe('NCED 01');
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

describe('downloading files', () => {
  const titleOf = (e: ReturnType<typeof env>) => get<{ id: number }>(e.db, 'SELECT id FROM titles')!.id;

  it('registers a recent or unreadable placeable file as downloading, without a job', async () => {
    const e = env();
    e.addFile(bake('01'), 10);
    const broken = e.addFile(bake('02'));
    e.badFiles.add(broken);
    e.addFile(bake('OP1'), 10);

    expect(await e.ingestor.scan()).toMatchObject({ ingested: 0, pending: 0, waiting: 3 });
    const rows = all<any>(e.db, 'SELECT status, duration_s, audio_tracks, episode_id, extra_label FROM media_files ORDER BY path');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'downloading' && r.duration_s === null && r.audio_tracks === '[]')).toBe(true);
    expect(rows.filter((r) => r.episode_id !== null)).toHaveLength(2);
    expect(rows.filter((r) => r.extra_label === 'OP1')).toHaveLength(1);
    expect(all(e.db, 'SELECT * FROM jobs')).toHaveLength(0);
    expect(all(e.db, 'SELECT * FROM pending_files')).toHaveLength(0);
    expect(listTitles(e.db, { limit: 10, offset: 0 })[0]).toMatchObject({ comingSoon: true });
    expect(getTitleDetail(e.db, titleOf(e))).toMatchObject({ comingSoon: true });
  });

  it('promotes a finished download to pending with a job, and the title stops being coming soon', async () => {
    const e = env();
    e.addFile(bake('01'), 10);
    await e.ingestor.scan();
    const before = get<any>(e.db, 'SELECT id FROM media_files')!;

    e.addFile(bake('01'), 3600);
    expect(await e.ingestor.scan()).toMatchObject({ ingested: 0, waiting: 0 });
    const row = get<any>(e.db, 'SELECT id, status, duration_s, audio_tracks, subtitle_tracks FROM media_files')!;
    expect(row).toMatchObject({ id: before.id, status: 'pending', duration_s: 1440.5 });
    expect(JSON.parse(row.audio_tracks)).toHaveLength(1);
    expect(all(e.db, 'SELECT media_file_id, status FROM jobs')).toEqual([{ media_file_id: before.id, status: 'queued' }]);
    expect(getTitleDetail(e.db, titleOf(e))).toMatchObject({ comingSoon: false });
    expect(await e.ingestor.scan()).toMatchObject({ waiting: 0 });
    expect(all(e.db, 'SELECT * FROM jobs')).toHaveLength(1);
  });

  it('keeps downloading while ffprobe still fails', async () => {
    const e = env();
    const abs = e.addFile(bake('01'));
    e.badFiles.add(abs);
    await e.ingestor.scan();
    expect(await e.ingestor.scan()).toMatchObject({ waiting: 1 });
    expect(get<any>(e.db, 'SELECT status FROM media_files')?.status).toBe('downloading');
    expect(all(e.db, 'SELECT * FROM jobs')).toHaveLength(0);
  });
});

describe('moved or renamed files', () => {
  async function ingested() {
    const e = env();
    for (const t of ['01', '02']) e.addFile(bake(t));
    await e.ingestor.scan();
    const profile = run(e.db, "INSERT INTO profiles (name) VALUES ('ana')").lastInsertId;
    const file = get<any>(e.db, "SELECT m.id FROM media_files m WHERE m.path LIKE '%\\_01\\_%' ESCAPE '\\'")!;
    run(e.db, "UPDATE media_files SET status = 'ready', hls_dir = 'hls/1' WHERE id = ?", file.id);
    run(e.db, "INSERT INTO watch_progress (profile_id, media_file_id, position_s, duration_s, updated_at) VALUES (?, ?, 100, 1440, 'x')", profile, file.id);
    e.tmdb.calls.length = 0;
    return { e, file, titleId: get<any>(e.db, 'SELECT id FROM titles')!.id };
  }

  it('reuses the row of a renamed folder: same id, progress and HLS, no new title, no TMDB', async () => {
    const { e, file, titleId } = await ingested();
    e.move('shows/bakemonogatari', 'shows/baka');

    expect(await e.ingestor.scan()).toMatchObject({ ingested: 0, pending: 0, waiting: 0, failed: 0 });
    const rows = all<any>(e.db, 'SELECT id, path, status, hls_dir FROM media_files ORDER BY path');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.path.startsWith('shows/baka/'))).toBe(true);
    expect(rows.find((r) => r.id === file.id)).toMatchObject({ status: 'ready', hls_dir: 'hls/1' });
    expect(all(e.db, 'SELECT id FROM titles')).toHaveLength(1);
    expect(get<any>(e.db, 'SELECT COUNT(*) AS n FROM watch_progress WHERE media_file_id = ?', file.id)?.n).toBe(1);
    expect(e.tmdb.calls).toEqual([]);
    expect(get<any>(e.db, "SELECT title_id FROM source_dirs WHERE path = 'shows/baka'")?.title_id).toBe(titleId);
    expect(all(e.db, 'SELECT * FROM pending_files')).toHaveLength(0);
  });

  it('lets later files of the renamed folder reuse its title without TMDB', async () => {
    const { e, titleId } = await ingested();
    e.move('shows/bakemonogatari', 'shows/baka');
    e.addFile('shows/baka/[Coalgirls]_Bakemonogatari_03_(1920x1080_Blu-ray_FLAC)_[ABCD1234].mkv');
    await e.ingestor.scan();
    expect(all(e.db, 'SELECT id FROM titles')).toHaveLength(1);
    expect(get<any>(e.db, 'SELECT title_id FROM media_files WHERE path LIKE ?', '%_03_%')?.title_id).toBe(titleId);
    expect(e.tmdb.calls.filter((c) => c.startsWith('search'))).toEqual([]);
  });

  it('moves a downloading file too', async () => {
    const e = env();
    e.addFile(bake('01'), 10);
    await e.ingestor.scan();
    const id = get<any>(e.db, 'SELECT id FROM media_files')!.id;
    e.move('shows/bakemonogatari', 'shows/baka');
    await e.ingestor.scan();
    expect(get<any>(e.db, 'SELECT id, status FROM media_files')).toMatchObject({ id, status: 'downloading' });
    expect(all(e.db, 'SELECT id FROM titles')).toHaveLength(1);
  });

  it('does not merge when several missing rows share basename and size', async () => {
    const { e, file } = await ingested();
    const dup = get<any>(e.db, 'SELECT * FROM media_files WHERE id = ?', file.id)!;
    run(e.db, 'INSERT INTO media_files (path, size, title_id, status) VALUES (?, ?, ?, ?)', `shows/gone/${dup.path.split('/').at(-1)}`, dup.size, dup.title_id, 'ready');
    e.move('shows/bakemonogatari', 'shows/baka');

    await e.ingestor.scan();
    expect(get<any>(e.db, 'SELECT path FROM media_files WHERE id = ?', file.id)?.path).toBe(dup.path);
    expect(get<any>(e.db, 'SELECT COUNT(*) AS n FROM media_files WHERE path LIKE ?', 'shows/baka/%')?.n).toBe(2);
  });
});

describe('seasons group upgrade', () => {
  it('rebuilds a series imported with official seasons, keeping media_files rows and progress', async () => {
    const e = env();
    const early = 'shows/Seasoned Show/Seasoned Show - S01E05.mkv';
    const absolute = 'shows/Seasoned Show/Seasoned Show - 30.mkv';
    e.addFile(early);
    e.addFile(absolute);
    await e.ingestor.scan();
    const titleId = get<{ id: number }>(e.db, 'SELECT id FROM titles')!.id;
    const place = (path: string) =>
      get<any>(e.db, 'SELECT s.number AS s, e.number AS e FROM media_files m JOIN episodes e ON e.id = m.episode_id JOIN seasons s ON s.id = e.season_id WHERE m.path = ?', path);
    expect(place(absolute)).toEqual({ s: 2, e: 2 });

    // Back to the state before this feature: official season 1 (38 episodes), nothing decided yet.
    run(e.db, 'DELETE FROM seasons WHERE title_id = ?', titleId);
    run(e.db, 'UPDATE titles SET seasons_group_id = NULL, episode_group_id = NULL WHERE id = ?', titleId);
    const dataDir = mkdtempSync(join(tmpdir(), 'tvlib-'));
    roots.push(dataDir);
    await relinkFiles({ db: e.db, tmdb: e.tmdb, dataDir }, titleId);
    expect(place(absolute)).toEqual({ s: 1, e: 30 });
    expect(get<any>(e.db, 'SELECT COUNT(*) AS n FROM seasons')?.n).toBe(1);

    const kept = get<any>(e.db, 'SELECT id FROM media_files WHERE path = ?', absolute)!.id;
    run(e.db, "UPDATE media_files SET status = 'ready', hls_dir = 'hls/x' WHERE id = ?", kept);
    const profile = addProfile(e.db);
    run(e.db, "INSERT INTO watch_progress VALUES (?, ?, 120, 1440, 0, '2026-01-01T00:00:00Z')", profile, kept);
    const before = all<any>(e.db, 'SELECT id, path, status, hls_dir FROM media_files ORDER BY id');

    await e.make(makeFakeTmdb()).scan();

    expect(all<any>(e.db, 'SELECT id, path, status, hls_dir FROM media_files ORDER BY id')).toEqual(before);
    expect(all<any>(e.db, 'SELECT number FROM seasons ORDER BY number').map((s) => s.number)).toEqual([0, 1, 2]);
    expect(place(early)).toEqual({ s: 1, e: 5 });
    expect(place(absolute)).toEqual({ s: 2, e: 2 });
    expect(get<any>(e.db, 'SELECT position_s FROM watch_progress WHERE media_file_id = ?', kept)?.position_s).toBe(120);
    expect(all(e.db, 'SELECT * FROM pending_files')).toHaveLength(0);
    expect(get<any>(e.db, 'SELECT seasons_group_id AS g FROM titles')?.g).toBe('g_s_seasons');
  });

  it('marks a series without a better group as decided and leaves it alone', async () => {
    const e = env();
    e.addFile('shows/Plain Show/Plain Show - S01E01.mkv');
    await e.ingestor.scan();
    run(e.db, 'UPDATE titles SET seasons_group_id = NULL');
    await e.make(makeFakeTmdb()).scan();
    expect(get<any>(e.db, 'SELECT seasons_group_id AS g FROM titles')?.g).toBe('');
    expect(all(e.db, 'SELECT id FROM seasons')).toHaveLength(1);
    expect(get<any>(e.db, 'SELECT COUNT(*) AS n FROM media_files WHERE episode_id IS NOT NULL')?.n).toBe(1);
  });
});

describe('missing files', () => {
  it('marks a vanished file missing, keeping the row, its progress and its package', async () => {
    const e = env();
    const abs = e.addFile(bake('01'));
    await e.ingestor.scan();
    const row = get<any>(e.db, 'SELECT id, title_id FROM media_files')!;
    const profile = addProfile(e.db);
    run(e.db, "UPDATE media_files SET status = 'ready', hls_dir = 'hls/7' WHERE id = ?", row.id);
    run(e.db, "INSERT INTO watch_progress (profile_id, media_file_id, position_s, duration_s, updated_at) VALUES (?, ?, 120, 1440, '2026-01-01T00:00:00Z')", profile, row.id);

    rmSync(abs);
    expect(await e.ingestor.scan()).toMatchObject({ ingested: 0, failed: 0 });

    expect(get<any>(e.db, 'SELECT id, status, hls_dir FROM media_files WHERE id = ?', row.id)).toMatchObject({ id: row.id, status: 'missing', hls_dir: 'hls/7' });
    expect(get<any>(e.db, 'SELECT position_s FROM watch_progress WHERE media_file_id = ?', row.id)?.position_s).toBe(120);
    expect(all(e.db, 'SELECT * FROM jobs')).toHaveLength(0); // the queued job of the vanished file is dropped
    requeueErrors(e.db); // and error requeues never claim it
    expect(get<any>(e.db, 'SELECT status FROM media_files WHERE id = ?', row.id)?.status).toBe('missing');
    expect(getTitleDetail(e.db, row.title_id)?.files[0]).toMatchObject({ status: 'missing' });
  });

  it('marks a downloading row missing too, and re-registers it when the file comes back', async () => {
    const e = env();
    const abs = e.addFile(bake('01'), 10);
    await e.ingestor.scan();
    const row = get<any>(e.db, 'SELECT id FROM media_files')!;
    expect(get<any>(e.db, 'SELECT status FROM media_files WHERE id = ?', row.id)?.status).toBe('downloading');

    rmSync(abs);
    await e.ingestor.scan();
    expect(get<any>(e.db, 'SELECT status FROM media_files WHERE id = ?', row.id)?.status).toBe('missing');

    e.addFile(bake('01')); // same bytes, now old enough
    await e.ingestor.scan();
    const back = get<any>(e.db, 'SELECT id, status, mtime_ms FROM media_files WHERE id = ?', row.id)!;
    expect(back).toMatchObject({ id: row.id, status: 'pending' });
    expect(back.mtime_ms).toBe(statSync(abs).mtimeMs);
    expect(all(e.db, 'SELECT media_file_id, status FROM jobs')).toEqual([{ media_file_id: row.id, status: 'queued' }]);
  });

  it('never marks the rows of an absent root', async () => {
    const state = { present: true };
    const e = env({ diskPresent: () => state.present });
    const abs = e.addFile(bake('01'));
    await e.ingestor.scan();
    expect(get<any>(e.db, 'SELECT status FROM media_files')?.status).toBe('pending');

    state.present = false;
    rmSync(abs);
    await e.ingestor.scan();
    expect(get<any>(e.db, 'SELECT status FROM media_files')?.status).toBe('pending');
  });
});

describe('replacement in the same path', () => {
  it('reprocesses a file replaced in place: same row, stale tracks and chapters reset, package kept', async () => {
    const e = env();
    e.addFile(bake('01'));
    await e.ingestor.scan();
    const row = get<any>(e.db, 'SELECT id FROM media_files')!;
    const profile = addProfile(e.db);
    run(e.db, "UPDATE media_files SET status = 'ready', hls_dir = 'hls/9', pkg_mode = 'copy' WHERE id = ?", row.id);
    run(e.db, 'UPDATE media_files SET chapters_checked = 1 WHERE id = ?', row.id);
    run(e.db, "INSERT INTO media_chapters (media_file_id, idx, start_s, end_s, title) VALUES (?, 0, 0, 10, 'op')", row.id);
    run(e.db, "INSERT INTO watch_progress (profile_id, media_file_id, position_s, duration_s, updated_at) VALUES (?, ?, 300, 1440, '2026-01-01T00:00:00Z')", profile, row.id);

    e.addFile(bake('01'), 1800, 'y'); // same path and size, new bytes, old enough to process
    expect(await e.ingestor.scan()).toMatchObject({ ingested: 0, waiting: 0 });

    const after = get<any>(e.db, 'SELECT id, status, hls_dir, audio_tracks, subtitle_tracks, chapters_checked FROM media_files WHERE id = ?', row.id)!;
    expect(after).toMatchObject({ id: row.id, status: 'pending', hls_dir: 'hls/9', audio_tracks: '[]', subtitle_tracks: '[]', chapters_checked: 0 });
    expect(all(e.db, 'SELECT * FROM media_chapters')).toHaveLength(0);
    expect(all(e.db, 'SELECT media_file_id, status FROM jobs')).toEqual([{ media_file_id: row.id, status: 'queued' }]);
    expect(get<any>(e.db, 'SELECT position_s FROM watch_progress WHERE media_file_id = ?', row.id)?.position_s).toBe(300);
  });

  it('ignores a touch: the same fingerprint only refreshes mtime_ms', async () => {
    const e = env();
    const abs = e.addFile(bake('01'));
    await e.ingestor.scan();
    const row = get<any>(e.db, 'SELECT id, status FROM media_files')!;
    const t = (NOW - 300_000) / 1000;
    utimesSync(abs, t, t);
    e.probed.length = 0;

    await e.ingestor.scan();

    const after = get<any>(e.db, 'SELECT status, fingerprint, mtime_ms FROM media_files WHERE id = ?', row.id)!;
    expect(after.status).toBe(row.status);
    expect(after.mtime_ms).toBe(statSync(abs).mtimeMs);
    expect(all(e.db, 'SELECT * FROM jobs')).toHaveLength(1); // the original job only, nothing re-queued
    expect(e.probed).toEqual([]);
  });

  it('sends a file replaced while it is still copying back to downloading, then promotes it', async () => {
    const e = env();
    e.addFile(bake('01'));
    await e.ingestor.scan();
    const row = get<any>(e.db, 'SELECT id FROM media_files')!;
    expect(get<any>(e.db, 'SELECT status FROM media_files WHERE id = ?', row.id)?.status).toBe('pending');

    e.addFile(bake('01'), 10, 'y'); // a fresh copy is landing on the same path
    await e.ingestor.scan();
    expect(get<any>(e.db, 'SELECT status FROM media_files WHERE id = ?', row.id)?.status).toBe('downloading');
    expect(all(e.db, 'SELECT * FROM jobs')).toHaveLength(0); // the stale job is gone; promotion will re-queue

    e.addFile(bake('01'), 3600, 'y'); // the copy finished
    await e.ingestor.scan();
    expect(get<any>(e.db, 'SELECT id, status FROM media_files WHERE id = ?', row.id)).toMatchObject({ id: row.id, status: 'pending' });
    expect(all(e.db, 'SELECT media_file_id, status FROM jobs')).toEqual([{ media_file_id: row.id, status: 'queued' }]);
  });

  it('leaves a file being processed alone: the scan after the job re-queues it', async () => {
    const e = env();
    e.addFile(bake('01'));
    await e.ingestor.scan();
    const row = get<any>(e.db, 'SELECT id FROM media_files')!;
    run(e.db, "UPDATE media_files SET status = 'processing' WHERE id = ?", row.id);
    run(e.db, "UPDATE jobs SET status = 'running' WHERE media_file_id = ?", row.id);

    e.addFile(bake('01'), 1800, 'y');
    await e.ingestor.scan();
    expect(get<any>(e.db, 'SELECT status FROM media_files WHERE id = ?', row.id)?.status).toBe('processing');

    run(e.db, "UPDATE media_files SET status = 'ready', hls_dir = 'hls/1' WHERE id = ?", row.id);
    run(e.db, "UPDATE jobs SET status = 'done' WHERE media_file_id = ?", row.id);
    await e.ingestor.scan();
    expect(get<any>(e.db, 'SELECT id, status FROM media_files WHERE id = ?', row.id)).toMatchObject({ id: row.id, status: 'pending' });
    expect(all(e.db, "SELECT media_file_id, status FROM jobs WHERE status = 'queued'")).toEqual([{ media_file_id: row.id, status: 'queued' }]);
  });
});

describe('download promotion cadence', () => {
  it('re-scans waiting files on the short cadence instead of a full minute', async () => {
    expect(RECENT_RESCAN_MS).toBeLessThanOrEqual(15_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const e = env();
      const base = vi.getTimerCount();
      e.addFile(bake('01'), 10); // registered as downloading, too recent to probe
      expect(await e.ingestor.scan()).toMatchObject({ waiting: 1 });
      expect(e.probed).toEqual([]);
      expect(vi.getTimerCount()).toBe(base + 1); // the rescan is armed

      vi.advanceTimersByTime(RECENT_RESCAN_MS - 1_000);
      expect(vi.getTimerCount()).toBe(base + 1); // not due yet
      e.tick(65_000); // the file is now old enough to probe
      vi.advanceTimersByTime(1_000);
      expect(vi.getTimerCount()).toBe(base); // it fired and the new scan has not armed anything yet

      await e.ingestor.scan(); // joins the scan the timer started
      expect(e.probed).toHaveLength(1);
      expect(get<any>(e.db, 'SELECT status FROM media_files')?.status).toBe('pending');
      expect(all(e.db, 'SELECT media_file_id, status FROM jobs')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
