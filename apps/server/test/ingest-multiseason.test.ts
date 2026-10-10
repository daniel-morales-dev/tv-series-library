import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { all, get, run } from '../src/db/sql.ts';
import { createIngestor } from '../src/modules/ingest/ingestor.ts';
import type { Probe } from '../src/modules/ingest/probe.ts';
import type { SeasonDetails, TmdbClient, TvDetails } from '../src/modules/ingest/tmdb.ts';
import { makeFakeTmdb } from './fake-tmdb.ts';
import { addProfile, setup } from './helpers.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = Date.parse('2026-01-01T12:00:00Z');
const FRIEREN_ID = 209867;
const ep = (n: number) => ({ episode_number: n, name: `Ep ${n}`, overview: '', runtime: 24, still_path: null, air_date: '2023-09-29' });
const season = (number: number, count: number): SeasonDetails => ({
  season_number: number,
  name: `Season ${number}`,
  overview: '',
  poster_path: null,
  episode_count: count,
  episodes: Array.from({ length: count }, (_, i) => ep(i + 1)),
});
const SEASONS: Record<number, SeasonDetails> = { 1: season(1, 3), 2: season(2, 2) };
const frieren: TvDetails = {
  id: FRIEREN_ID,
  name: 'Sousou no Frieren',
  original_name: '葬送のフリーレン',
  overview: '',
  first_air_date: '2023-09-29',
  episode_run_time: [24],
  vote_average: 9,
  genres: [{ id: 16, name: 'Animación' }],
  poster_path: null,
  backdrop_path: null,
  origin_country: ['JP'],
  seasons: [
    { season_number: 1, name: 'S1', overview: '', poster_path: null, episode_count: 3 },
    { season_number: 2, name: 'S2', overview: '', poster_path: null, episode_count: 2 },
  ],
  alternative_titles: { results: [{ title: 'Frieren' }, { title: "Frieren: Beyond Journey's End" }] },
};

// Fake TMDB where "Frieren" resolves to one series with two official seasons.
function fakeFrieren(): TmdbClient {
  const base = makeFakeTmdb();
  return {
    ...base,
    searchTv: async (q) =>
      q.toLowerCase().includes('frieren') ? [{ id: FRIEREN_ID, name: frieren.name, original_name: frieren.original_name }] : [],
    tv: async (id) => (id === FRIEREN_ID ? frieren : base.tv(id)),
    tvSeason: async (id, n) => (id === FRIEREN_ID ? (SEASONS[n] ?? null) : base.tvSeason(id, n)),
    image: async () => null,
  };
}

function env() {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-multiseason-'));
  roots.push(root);
  const contentDir = join(root, 'content');
  const { db } = setup();
  const probe: Probe = async () => ({ durationS: 1440, audio: [], subtitles: [] });
  const ingestor = createIngestor({ db, tmdb: fakeFrieren(), dataDir: join(root, 'data'), contentDir, probe, now: () => NOW });
  const addFile = (rel: string) => {
    const abs = join(contentDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
    utimesSync(abs, (NOW - 3_600_000) / 1000, (NOW - 3_600_000) / 1000);
  };
  const removeFile = (rel: string) => unlinkSync(join(contentDir, rel));
  return { db, ingestor, addFile, removeFile };
}
type Db = ReturnType<typeof env>['db'];

const layout = (db: Db) =>
  all<{ title_id: number; season: number; episode: number; path: string }>(
    db,
    `SELECT m.title_id, s.number AS season, e.number AS episode, m.path FROM media_files m
     JOIN episodes e ON e.id = m.episode_id JOIN seasons s ON s.id = e.season_id ORDER BY s.number, e.number, m.path`,
  );

function expectOneTitleTwoSeasons(db: Db) {
  const titles = all<{ id: number; tmdb_id: number }>(db, 'SELECT id, tmdb_id FROM titles');
  expect(titles).toHaveLength(1);
  expect(titles[0]!.tmdb_id).toBe(FRIEREN_ID);
  expect(layout(db).map((r) => [r.season, r.episode])).toEqual([[1, 1], [1, 2], [1, 3], [2, 1], [2, 2]]);
  expect(all(db, 'SELECT * FROM pending_files')).toHaveLength(0);
}

describe('one anime, several seasons', () => {
  const single = [
    'shows/Frieren/Sousou no Frieren S1 - 01.mkv',
    'shows/Frieren/Sousou no Frieren S1 - 02.mkv',
    'shows/Frieren/Sousou no Frieren S1 - 03.mkv',
    'shows/Frieren/Sousou no Frieren S2 - 01.mkv',
    'shows/Frieren/Sousou no Frieren S2 - 02.mkv',
  ];

  it('single folder with "S1 - 01" / "S2 - 01" names', async () => {
    const e = env();
    single.forEach(e.addFile);
    expect(await e.ingestor.scan()).toMatchObject({ ingested: 5, pending: 0 });
    expectOneTitleTwoSeasons(e.db);
  });

  it('single folder with S01E01 / S02E03 names', async () => {
    const e = env();
    ['S01E01', 'S01E02', 'S01E03', 'S02E01', 'S02E02'].forEach((t) => e.addFile(`shows/Frieren/Sousou no Frieren ${t}.mkv`));
    await e.ingestor.scan();
    expectOneTitleTwoSeasons(e.db);
  });

  it('single folder with mixed release groups', async () => {
    const e = env();
    ['01', '02', '03'].forEach((n) => e.addFile(`shows/Frieren/[Cifer] Sousou no Frieren S1 - ${n} [BD 1080P].mkv`));
    ['01', '02'].forEach((n) => e.addFile(`shows/Frieren/[SubsPlease] Sousou no Frieren S2 - ${n} (1080p) [ABCD1234].mkv`));
    await e.ingestor.scan();
    expectOneTitleTwoSeasons(e.db);
  });

  it('single folder where the season is only in a "Season N" subfolder', async () => {
    const e = env();
    ['01', '02', '03'].forEach((n) => e.addFile(`shows/Frieren/Season 1/Sousou no Frieren - ${n}.mkv`));
    ['01', '02'].forEach((n) => e.addFile(`shows/Frieren/Season 2/Sousou no Frieren - ${n}.mkv`));
    await e.ingestor.scan();
    expectOneTitleTwoSeasons(e.db);
  });

  it('two folders (one per season) share the same title', async () => {
    const e = env();
    ['01', '02', '03'].forEach((n) => e.addFile(`shows/[Cifer] Sousou no Frieren S1 [BD 1080p]/[Cifer] Sousou no Frieren S1 - ${n} [BD].mkv`));
    ['01', '02'].forEach((n) => e.addFile(`shows/[SubsPlease] Sousou no Frieren S2 (01-02) [Batch]/[SubsPlease] Sousou no Frieren - ${n} (1080p).mkv`));
    await e.ingestor.scan();
    expectOneTitleTwoSeasons(e.db);
  });

  it('a rescan keeps title, season and media_file ids', async () => {
    const e = env();
    single.forEach(e.addFile);
    await e.ingestor.scan();
    const snap = () => ({
      titles: all(e.db, 'SELECT * FROM titles ORDER BY id'),
      seasons: all(e.db, 'SELECT id, title_id, number FROM seasons ORDER BY id'),
      files: all(e.db, 'SELECT id, title_id, episode_id, path FROM media_files ORDER BY id'),
    });
    const before = snap();
    expect(await e.ingestor.scan()).toMatchObject({ ingested: 0, pending: 0, failed: 0 });
    expect(snap()).toEqual(before);
  });

  it('SubsPlease replacing Cifer keeps one title and one file per episode, with progress', async () => {
    const e = env();
    const profile = addProfile(e.db);
    const cifer = (n: string) => `shows/Frieren/[Cifer] Sousou no Frieren S1 - ${n} [BD].mkv`;
    const subs = (n: string) => `shows/Frieren/[SubsPlease] Sousou no Frieren S1 - ${n} (1080p).mkv`;
    ['01', '02', '03'].forEach((n) => e.addFile(cifer(n)));
    await e.ingestor.scan();
    const old = get<{ id: number; episode_id: number }>(e.db, 'SELECT id, episode_id FROM media_files WHERE path = ?', cifer('01'))!;
    run(
      e.db,
      "INSERT INTO watch_progress (profile_id, media_file_id, position_s, duration_s, completed, updated_at) VALUES (?, ?, 600, 1440, 0, '2026-01-01T00:00:00Z')",
      profile,
      old.id,
    );

    ['01', '02', '03'].forEach((n) => e.removeFile(cifer(n)));
    ['01', '02', '03'].forEach((n) => e.addFile(subs(n)));
    await e.ingestor.scan();

    expect(all(e.db, 'SELECT id FROM titles')).toHaveLength(1);
    const files = all<{ path: string }>(e.db, 'SELECT path FROM media_files ORDER BY path');
    expect(files).toHaveLength(3);
    expect(files.every((f) => f.path.includes('SubsPlease'))).toBe(true);
    const swapped = get<{ id: number; episode_id: number }>(e.db, 'SELECT id, episode_id FROM media_files WHERE path = ?', subs('01'))!;
    expect(swapped.episode_id).toBe(old.episode_id);
    const progress = get<{ position_s: number }>(
      e.db,
      'SELECT position_s FROM watch_progress WHERE profile_id = ? AND media_file_id = ?',
      profile,
      swapped.id,
    );
    expect(progress?.position_s).toBe(600);
  });
});
