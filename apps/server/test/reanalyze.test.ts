import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { all, get, run } from '../src/db/sql.ts';
import { createIngestor } from '../src/modules/ingest/ingestor.ts';
import { parsePath } from '../src/modules/ingest/parser.ts';
import type { Probe } from '../src/modules/ingest/probe.ts';
import { showDirKey } from '../src/modules/ingest/scanner.ts';
import type { EpisodeGroupDetails, SeasonDetails, SeasonSummary, TmdbClient, TvDetails } from '../src/modules/ingest/tmdb.ts';
import { type FakeTmdb, makeFakeTmdb } from './fake-tmdb.ts';
import { setup } from './helpers.ts';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const OLD_S = (NOW - 3_600_000) / 1000;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ep = (n: number) => ({ episode_number: n, name: `Ep ${n}`, overview: null, runtime: 24, still_path: null, air_date: '2020-01-01' });
const eps = (count: number) => Array.from({ length: count }, (_, i) => ep(i + 1));
const season = (number: number, count: number): SeasonSummary => ({
  season_number: number,
  name: `Season ${number}`,
  overview: '',
  poster_path: null,
  episode_count: count,
});

// Fake TMDB per test: registered shows, groups and seasons answer; anything else falls back to the shared
// fake (so "Plain Show" keeps working). `searchable: false` makes a show resolvable by id but invisible to search.
function fakeLibrary() {
  const base = makeFakeTmdb();
  const searchable = new Map<number, TvDetails>();
  const byId = new Map<number, TvDetails>();
  const groups = new Map<string, EpisodeGroupDetails>();
  const seasons = new Map<string, SeasonDetails>();
  const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const hit = <T>(name: string, value: T): Promise<T> => {
    base.calls.push(name);
    return Promise.resolve(value);
  };
  const register = (tv: TvDetails, opts: { searchable?: boolean } = {}) => {
    byId.set(tv.id, tv);
    if (opts.searchable !== false) searchable.set(tv.id, tv);
  };
  const client: FakeTmdb = {
    ...base,
    searchTv: async (query) => {
      const wanted = norm(query);
      const local = [...searchable.values()].filter((s) => norm(s.name).includes(wanted) || wanted.includes(norm(s.name)));
      if (local.length > 0) return hit(`searchTv:${query}`, local.map((s) => ({ id: s.id, name: s.name, original_name: s.original_name })));
      return base.searchTv(query);
    },
    tv: (id) => (byId.has(id) ? hit(`tv:${id}`, byId.get(id)!) : base.tv(id)),
    tvSeason: (id, n) => (seasons.has(`${id}:${n}`) ? hit(`tvSeason:${id}:${n}`, seasons.get(`${id}:${n}`)!) : base.tvSeason(id, n)),
    episodeGroup: (id) => (groups.has(id) ? hit(`episodeGroup:${id}`, groups.get(id)!) : base.episodeGroup(id)),
    image: async () => null,
  };
  return { client, register, groups, seasons, calls: base.calls };
}

function env(tmdb: TmdbClient) {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-reanalyze-'));
  roots.push(root);
  const contentDir = join(root, 'content');
  const dataDir = join(root, 'data');
  const { db } = setup();
  const probe: Probe = async () => ({ durationS: 1440, audio: [], subtitles: [] });
  const ingestor = createIngestor({ db, tmdb, dataDir, contentDir, probe, now: () => NOW });
  const app = buildApp({ db, dataDir, ingestor });
  const addFile = (rel: string, content = 'x') => {
    const abs = join(contentDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    utimesSync(abs, OLD_S, OLD_S);
  };
  const reanalyze = (payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/library/reanalyze', payload });
  return { db, ingestor, app, addFile, reanalyze };
}

const layout = (db: ReturnType<typeof setup>['db'], titleId: number) =>
  all<{ season: number; episode: number }>(
    db,
    `SELECT s.number AS season, e.number AS episode FROM media_files m
     JOIN episodes e ON e.id = m.episode_id JOIN seasons s ON s.id = e.season_id
     WHERE m.title_id = ? ORDER BY s.number, e.number`,
    titleId,
  );

describe('POST /api/library/reanalyze', () => {
  it('re-adopts the full seasons set when the stored one has an empty season (T84)', async () => {
    const fake = fakeLibrary();
    // The type 6 "Cours" set lists a third season with 0 episodes: 24 of the 36 official episodes.
    fake.register({
      id: 700,
      name: 'Cours Show',
      original_name: 'Cours Show',
      first_air_date: '2020-01-01',
      overview: null,
      episode_run_time: [24],
      vote_average: 7,
      genres: [],
      poster_path: null,
      backdrop_path: null,
      origin_country: ['JP'],
      seasons: [season(1, 12), season(2, 12), season(3, 12)],
      episode_groups: {
        results: [
          { id: 'g_cours', name: 'Cours', type: 6, episode_count: 24 },
          { id: 'g_seasons', name: 'Seasons', type: 7, episode_count: 36 },
        ],
      },
    });
    fake.groups.set('g_cours', {
      id: 'g_cours',
      name: 'Cours',
      type: 6,
      groups: [
        { id: 'c1', name: 'Season 1', order: 1, episodes: eps(12) },
        { id: 'c2', name: 'Season 2', order: 2, episodes: eps(12) },
        { id: 'c3', name: 'Season 3', order: 3, episodes: [] },
      ],
    });
    fake.groups.set('g_seasons', {
      id: 'g_seasons',
      name: 'Seasons',
      type: 7,
      groups: [
        { id: 's1', name: 'Season 1', order: 1, episodes: eps(12) },
        { id: 's2', name: 'Season 2', order: 2, episodes: eps(12) },
        { id: 's3', name: 'Season 3', order: 3, episodes: eps(12) },
      ],
    });
    const e = env(fake.client);
    const titleId = Number(
      run(e.db, "INSERT INTO titles (tmdb_type, tmdb_id, kind, title, metadata_status, seasons_group_id, episode_group_id) VALUES ('tv', 700, 'series', 'Cours Show', 'ready', 'g_cours', 'g_cours')")
        .lastInsertId,
    );
    run(e.db, "INSERT INTO seasons (title_id, number, name) VALUES (?, 1, 'Temporada 1'), (?, 2, 'Temporada 2'), (?, 3, 'Temporada 3')", titleId, titleId, titleId);
    // The stale Cours adoption left the official season 3 (and its episodes) in place: the group's third
    // season is empty, so upserting it touched nothing. The S3E12 file is still placed there.
    const sid = (n: number) => Number(get<{ id: number }>(e.db, 'SELECT id FROM seasons WHERE title_id = ? AND number = ?', titleId, n)!.id);
    const season3 = sid(3);
    for (let n = 1; n <= 12; n++) run(e.db, 'INSERT INTO episodes (season_id, number) VALUES (?, ?)', season3, n);
    const rel = 'shows/Cours Show/Cours Show S3E12.mkv';
    e.addFile(rel);
    const episodeId = Number(get<{ id: number }>(e.db, 'SELECT id FROM episodes WHERE season_id = ? AND number = 12', season3)!.id);
    run(
      e.db,
      "INSERT INTO media_files (root_id, path, title_id, episode_id, status, parsed_season, parsed_number) VALUES (1, ?, ?, ?, 'ready', 3, 12)",
      rel,
      titleId,
      episodeId,
    );

    const res = await e.reanalyze();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scanned: 1, reparsed: 0, replaced: 0, missing: 0, promoted: 0, placed: 1, pending: 0, reseasoned: 1 });
    expect(get(e.db, 'SELECT seasons_group_id, episode_group_id FROM titles WHERE id = ?', titleId)).toEqual({
      seasons_group_id: 'g_seasons',
      episode_group_id: 'g_seasons',
    });
    expect(layout(e.db, titleId)).toEqual([{ season: 3, episode: 12 }]);
    expect(get(e.db, 'SELECT COUNT(*) AS n FROM seasons WHERE title_id = ?', titleId)).toEqual({ n: 3 });
    expect(get(e.db, 'SELECT COUNT(*) AS n FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE s.title_id = ?', titleId)).toEqual({ n: 36 });
  });

  it('places pending files of the title again and moves official S2 to the right cour (Frieren)', async () => {
    const fake = fakeLibrary();
    fake.register({
      id: 209867,
      name: 'Sousou no Frieren',
      original_name: 'Sousou no Frieren',
      first_air_date: '2023-09-29',
      overview: null,
      episode_run_time: [24],
      vote_average: 9,
      genres: [],
      poster_path: null,
      backdrop_path: null,
      origin_country: ['JP'],
      seasons: [season(1, 28), season(2, 10)],
      episode_groups: { results: [{ id: 'g_cours', name: 'Cours', type: 6, episode_count: 38 }] },
    });
    fake.groups.set('g_cours', {
      id: 'g_cours',
      name: 'Cours',
      type: 6,
      groups: [
        { id: 'c1', name: 'Cour 1', order: 1, episodes: eps(16) },
        { id: 'c2', name: 'Cour 2', order: 2, episodes: eps(12) },
        { id: 'c3', name: 'Cour 3', order: 3, episodes: eps(10) },
      ],
    });
    const e = env(fake.client);
    const titleId = Number(
      run(e.db, "INSERT INTO titles (tmdb_type, tmdb_id, kind, title, metadata_status, seasons_group_id, episode_group_id) VALUES ('tv', 209867, 'anime', 'Frieren', 'ready', 'g_cours', 'g_cours')")
        .lastInsertId,
    );
    for (const [n, count] of [[1, 16], [2, 12], [3, 10]] as const) {
      const sid = Number(run(e.db, 'INSERT INTO seasons (title_id, number, name) VALUES (?, ?, ?)', titleId, n, `Cour ${n}`).lastInsertId);
      for (let k = 1; k <= count; k++) run(e.db, 'INSERT INTO episodes (season_id, number) VALUES (?, ?)', sid, k);
    }
    const epId = (s: number, n: number) =>
      Number(get<{ id: number }>(e.db, 'SELECT e.id FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE s.title_id = ? AND s.number = ? AND e.number = ?', titleId, s, n)!.id);

    const pendingRel = 'shows/[Cifer] Sousou no Frieren S1 [BD 1080p Opus]/[Cifer] Sousou no Frieren S1 - 17 [BD 1080P Ma10p Opus].mkv';
    const s2Rel = 'shows/[SubsPlease] Sousou no Frieren S2 (01-10)/[SubsPlease] Sousou no Frieren S2 - 01 (1080p).mkv';
    for (const rel of [pendingRel, s2Rel]) {
      e.addFile(rel);
      const parsed = parsePath(rel);
      if (parsed.kind !== 'episode') throw new Error(`not an episode: ${rel}`);
      run(e.db, 'INSERT OR IGNORE INTO source_dirs (root_id, path, title_id) VALUES (1, ?, ?)', showDirKey(rel, parsed.show), titleId);
    }
    run(
      e.db,
      "INSERT INTO pending_files (root_id, path, size, parsed, reason, candidates) VALUES (1, ?, 1, ?, 'unmapped_episode', '[]')",
      pendingRel,
      JSON.stringify(parsePath(pendingRel)),
    );
    // The S2 release was placed literally on Cour 2 E1, which is really the second half of official S1.
    run(
      e.db,
      "INSERT INTO media_files (root_id, path, title_id, episode_id, status, parsed_season, parsed_number) VALUES (1, ?, ?, ?, 'ready', 2, 1)",
      s2Rel,
      titleId,
      epId(2, 1),
    );

    const res = await e.reanalyze({ titleId });

    expect(res.statusCode).toBe(200);
    expect(all(e.db, "SELECT id FROM pending_files WHERE status = 'open'")).toEqual([]);
    expect(layout(e.db, titleId)).toEqual([
      { season: 2, episode: 1 },
      { season: 3, episode: 1 },
    ]);
    expect(get(e.db, 'SELECT episode_id FROM media_files WHERE path = ?', pendingRel)).toEqual({ episode_id: epId(2, 1) });
  });

  it('adopts the group found through the alias and moves the files to the free season number (T83/T84)', async () => {
    const fake = fakeLibrary();
    fake.register({
      id: 800,
      name: 'Nekomonogatari',
      original_name: 'Nekomonogatari',
      first_air_date: '2021-01-01',
      overview: null,
      episode_run_time: [24],
      vote_average: 7,
      genres: [],
      poster_path: null,
      backdrop_path: null,
      origin_country: ['JP'],
      seasons: [season(1, 4), season(2, 4), season(3, 4)],
      episode_groups: { results: [{ id: 'g_neko', name: 'Nekomonogatari (Black)', type: 1, episode_count: 4 }] },
    });
    fake.groups.set('g_neko', {
      id: 'g_neko',
      name: 'Nekomonogatari (Black)',
      type: 1,
      groups: [{ id: 'n1', name: 'Nekomonogatari (Black)', order: 3, episodes: eps(4) }],
    });
    const e = env(fake.client);
    const titleId = Number(run(e.db, "INSERT INTO titles (tmdb_type, tmdb_id, kind, title, metadata_status) VALUES ('tv', 800, 'series', 'Nekomonogatari', 'ready')").lastInsertId);
    const sid = (n: number) => Number(run(e.db, 'INSERT INTO seasons (title_id, number, name) VALUES (?, ?, ?)', titleId, n, `Temporada ${n}`).lastInsertId);
    const official3 = sid(3);
    sid(1);
    sid(2);
    run(e.db, "INSERT INTO source_dirs (root_id, path, title_id, season_number) VALUES (1, 'shows/nekomonogatari kuro', ?, NULL)", titleId);
    for (let n = 1; n <= 4; n++) {
      const rel = `shows/nekomonogatari kuro/Nekomonogatari Kuro S3E0${n}.mkv`;
      e.addFile(rel);
      const episodeId = Number(run(e.db, 'INSERT INTO episodes (season_id, number) VALUES (?, ?)', official3, n).lastInsertId);
      run(e.db, "INSERT INTO media_files (root_id, path, title_id, episode_id, status, parsed_season, parsed_number) VALUES (1, ?, ?, ?, 'ready', 3, ?)", rel, titleId, episodeId, n);
    }

    const res = await e.reanalyze();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scanned: 4, reparsed: 1, replaced: 0, missing: 0, promoted: 0, placed: 4, pending: 0, reseasoned: 0 });
    expect(get(e.db, 'SELECT season_number FROM source_dirs WHERE path = ?', 'shows/nekomonogatari kuro')).toEqual({ season_number: 4 });
    expect(layout(e.db, titleId)).toEqual([
      { season: 4, episode: 1 },
      { season: 4, episode: 2 },
      { season: 4, episode: 3 },
      { season: 4, episode: 4 },
    ]);
  });

  it('leaves a title with folder-pinned seasons alone (T84 guard)', async () => {
    const fake = fakeLibrary();
    fake.register(
      {
        id: 900,
        name: 'Guard Show',
        original_name: 'Guard Show',
        first_air_date: '2020-01-01',
        overview: null,
        episode_run_time: [24],
        vote_average: 7,
        genres: [],
        poster_path: null,
        backdrop_path: null,
        origin_country: ['JP'],
        seasons: [season(1, 4), season(2, 4)],
        episode_groups: { results: [{ id: 'g_guard_seasons', name: 'Seasons', type: 6, episode_count: 8 }] },
      },
      { searchable: false },
    );
    fake.groups.set('g_guard_seasons', {
      id: 'g_guard_seasons',
      name: 'Seasons',
      type: 6,
      groups: [
        { id: 'gs1', name: 'Season 1', order: 1, episodes: eps(4) },
        { id: 'gs2', name: 'Season 2', order: 2, episodes: eps(4) },
      ],
    });
    const e = env(fake.client);
    const titleId = Number(
      run(e.db, "INSERT INTO titles (tmdb_type, tmdb_id, kind, title, metadata_status, seasons_group_id) VALUES ('tv', 900, 'series', 'Guard Show', 'ready', '')").lastInsertId,
    );
    run(e.db, "INSERT INTO source_dirs (root_id, path, title_id, season_number) VALUES (1, 'shows/guard show', ?, 2)", titleId);

    const res = await e.reanalyze();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reparsed: 0, reseasoned: 0 });
    expect(get(e.db, 'SELECT seasons_group_id FROM titles WHERE id = ?', titleId)).toEqual({ seasons_group_id: '' });
    expect(all(e.db, 'SELECT id FROM seasons WHERE title_id = ?', titleId)).toEqual([]);
    expect(fake.calls).not.toContain('tv:900'); // the guard skips the TMDB lookup entirely
  });

  it('with titleId touches only that title and 404s on an unknown one', async () => {
    const fake = fakeLibrary();
    fake.register({
      id: 1001,
      name: 'Alpha Show',
      original_name: 'Alpha Show',
      first_air_date: '2021-01-01',
      overview: null,
      episode_run_time: [24],
      vote_average: 7,
      genres: [],
      poster_path: null,
      backdrop_path: null,
      origin_country: ['JP'],
      seasons: [season(1, 3)],
    });
    fake.register({
      id: 1002,
      name: 'Beta Show',
      original_name: 'Beta Show',
      first_air_date: '2021-01-01',
      overview: null,
      episode_run_time: [24],
      vote_average: 7,
      genres: [],
      poster_path: null,
      backdrop_path: null,
      origin_country: ['JP'],
      seasons: [season(1, 2)],
      episode_groups: { results: [{ id: 'g_beta', name: 'Seasons', type: 6, episode_count: 2 }] },
    });
    fake.groups.set('g_beta', {
      id: 'g_beta',
      name: 'Seasons',
      type: 6,
      groups: [{ id: 'b1', name: 'Season 1', order: 1, episodes: eps(2) }],
    });
    fake.seasons.set('1001:1', { ...season(1, 3), episodes: eps(3) });
    const e = env(fake.client);
    const alpha = Number(run(e.db, "INSERT INTO titles (tmdb_type, tmdb_id, kind, title, metadata_status) VALUES ('tv', 1001, 'series', 'Alpha Show', 'ready')").lastInsertId);
    const beta = Number(run(e.db, "INSERT INTO titles (tmdb_type, tmdb_id, kind, title, metadata_status) VALUES ('tv', 1002, 'series', 'Beta Show', 'ready')").lastInsertId);
    const alphaRel = 'shows/Alpha Show/Alpha Show S01E01.mkv';
    const betaRel = 'shows/Beta Show/Beta Show S01E01.mkv';
    e.addFile(alphaRel);
    e.addFile(betaRel);
    run(e.db, "INSERT INTO media_files (root_id, path, title_id, status, parsed_season, parsed_number) VALUES (1, ?, ?, 'ready', 1, 1)", alphaRel, alpha);
    run(e.db, "INSERT INTO media_files (root_id, path, title_id, status, parsed_season, parsed_number) VALUES (1, ?, ?, 'ready', 1, 1)", betaRel, beta);

    const res = await e.reanalyze({ titleId: alpha });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scanned: 1, reparsed: 0, replaced: 0, missing: 0, promoted: 0, placed: 1, pending: 0, reseasoned: 0 });
    expect(get<{ episode_id: number | null }>(e.db, 'SELECT episode_id FROM media_files WHERE path = ?', alphaRel)!.episode_id).not.toBeNull();
    expect(get(e.db, 'SELECT episode_id FROM media_files WHERE path = ?', betaRel)).toEqual({ episode_id: null });
    expect(get(e.db, 'SELECT seasons_group_id FROM titles WHERE id = ?', beta)).toEqual({ seasons_group_id: null });
    expect(fake.calls).not.toContain('tv:1002');

    const missing = await e.reanalyze({ titleId: 999 });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not_found' });
  });

  it('counts a file replaced on disk and leaves it pending and queued', async () => {
    const e = env(makeFakeTmdb());
    const rel = 'shows/Plain Show/Plain Show S01E01.mkv';
    e.addFile(rel, 'first');
    expect(await e.ingestor.scan()).toMatchObject({ ingested: 1, pending: 0 });
    const row = get<{ id: number; episode_id: number }>(e.db, 'SELECT id, episode_id FROM media_files WHERE path = ?', rel)!;
    expect(row.episode_id).toBeGreaterThan(0);
    e.addFile(rel, 'second-and-longer');

    const res = await e.reanalyze();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ scanned: 1, replaced: 1, missing: 0, placed: 0, pending: 0 });
    expect(get(e.db, 'SELECT status FROM media_files WHERE id = ?', row.id)).toEqual({ status: 'pending' });
    expect(get(e.db, "SELECT COUNT(*) AS n FROM jobs WHERE media_file_id = ? AND status = 'queued'", row.id)).toEqual({ n: 1 });
    expect(get(e.db, 'SELECT episode_id FROM media_files WHERE id = ?', row.id)).toEqual({ episode_id: row.episode_id });
  });
});
