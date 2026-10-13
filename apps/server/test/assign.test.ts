import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { all, get, run } from '../src/db/sql.ts';
import { assignMovie, assignSeries, findGroup, matchSeries, placeEpisode } from '../src/modules/ingest/assign.ts';
import { findSeasonsGroup, type IngestContext } from '../src/modules/ingest/metadata.ts';
import type { EpisodeGroupDetails, TmdbClient, TmdbEpisode, TvDetails, TvSearchResult } from '../src/modules/ingest/tmdb.ts';
import { suggest } from '../src/modules/search/repository.ts';
import { makeFakeTmdb } from './fake-tmdb.ts';
import { setup } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function ctx(opts: { offline?: boolean; tmdb?: TmdbClient } = {}) {
  const { db } = setup();
  const dataDir = mkdtempSync(join(tmpdir(), 'tvlib-'));
  dirs.push(dataDir);
  const fake = makeFakeTmdb({ offline: opts.offline });
  const tmdb: TmdbClient = opts.tmdb ?? fake;
  const context: IngestContext = { db, tmdb, dataDir };
  return { context, db, tmdb, fake, dataDir };
}

describe('assignSeries with episode groups', () => {
  it('maps the folder to the matching group of the preferred ordering', async () => {
    const { context, db, dataDir } = ctx();
    const out = await assignSeries(context, 'shows/bakemonogatari', 'bakemonogatari');
    expect(out).toMatchObject({ status: 'matched', seasonNumber: 1 });

    const title = get<any>(db, 'SELECT * FROM titles');
    expect(title).toMatchObject({ tmdb_type: 'tv', tmdb_id: 46195, kind: 'anime', title: 'Monogatari', episode_group_id: 'g_air', metadata_status: 'ready', year: 2009 });
    expect(title.poster_path).toBe('w500/mono.jpg');
    expect(existsSync(join(dataDir, 'images', 'w500', 'mono.jpg'))).toBe(true);
    expect(title.logo_path).toBe('w500/mono-logo.png');

    const seasons = all<any>(db, 'SELECT s.number, s.name, COUNT(e.id) AS n FROM seasons s JOIN episodes e ON e.season_id = s.id GROUP BY s.id');
    expect(seasons).toEqual([{ number: 1, name: 'Bakemonogatari', n: 15 }]);
    expect(get<any>(db, 'SELECT name FROM episodes WHERE number = 13')?.name).toBe('Tsubasa Cat 3');
    expect(get<any>(db, 'SELECT still_path FROM episodes WHERE number = 12')?.still_path).toBe('original/still12.jpg');
    expect(get<any>(db, 'SELECT still_path FROM episodes WHERE number = 13')?.still_path).toBeNull(); // image 404 is skipped
    expect(get<any>(db, 'SELECT * FROM source_dirs')).toMatchObject({ path: 'shows/bakemonogatari', season_number: 1 });
    expect(suggest(db, 'monog')[0]).toMatchObject({ type: 'title', label: 'Monogatari' });
    expect(all(db, 'SELECT * FROM credits')).toHaveLength(2);
  });

  it('places absolute episodes inside the group season and rejects unknown ones', async () => {
    const { context, db } = ctx();
    await assignSeries(context, 'shows/bakemonogatari', 'bakemonogatari');
    const titleId = get<{ id: number }>(db, 'SELECT id FROM titles')!.id;
    const id15 = await placeEpisode(context, titleId, 1, { season: null, number: 15 });
    expect(get<any>(db, 'SELECT number FROM episodes WHERE id = ?', id15!)?.number).toBe(15);
    expect(await placeEpisode(context, titleId, 1, { season: null, number: 16 })).toBeNull();
  });

  it('reuses the title for another folder of the same series', async () => {
    const { context, db } = ctx();
    await assignSeries(context, 'shows/bakemonogatari', 'bakemonogatari');
    const out = await assignSeries(context, 'shows/nisemonogatari', 'nisemonogatari');
    expect(out).toMatchObject({ status: 'matched', seasonNumber: 2 });
    expect(all(db, 'SELECT id FROM titles')).toHaveLength(1);
    expect(all(db, 'SELECT number FROM seasons ORDER BY number')).toEqual([{ number: 1 }, { number: 2 }]);
  });

  it('does not call TMDB again for a known folder', async () => {
    const { context, fake } = ctx();
    await assignSeries(context, 'shows/bakemonogatari', 'bakemonogatari');
    fake.calls.length = 0;
    await assignSeries(context, 'shows/bakemonogatari', 'bakemonogatari');
    expect(fake.calls).toEqual([]);
  });
});

describe('assignSeries without groups', () => {
  it('uses SxxEyy as is and imports the season on demand', async () => {
    const { context, db } = ctx();
    const out = await assignSeries(context, 'shows/Plain Show', 'Plain Show');
    expect(out).toMatchObject({ status: 'matched', seasonNumber: null });
    const titleId = get<{ id: number }>(db, 'SELECT id FROM titles')!.id;
    expect(get<any>(db, 'SELECT kind FROM titles')?.kind).toBe('series');

    const id = await placeEpisode(context, titleId, null, { season: 2, number: 1 });
    expect(get<any>(db, 'SELECT s.number AS s, e.number AS e FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE e.id = ?', id!)).toEqual({ s: 2, e: 1 });
    expect(await placeEpisode(context, titleId, null, { season: 9, number: 1 })).toBeNull();
    expect(await placeEpisode(context, titleId, null, { season: 2, number: 7 })).toBeNull();
  });

  it('spreads an absolute number over the regular seasons (never season 0)', async () => {
    const { context, db } = ctx();
    await assignSeries(context, 'shows/Plain Show', 'Plain Show');
    const titleId = get<{ id: number }>(db, 'SELECT id FROM titles')!.id;
    const id = await placeEpisode(context, titleId, null, { season: null, number: 4 });
    expect(get<any>(db, 'SELECT s.number AS s, e.number AS e FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE e.id = ?', id!)).toEqual({ s: 2, e: 1 });
    expect(await placeEpisode(context, titleId, null, { season: null, number: 6 })).toBeNull();
  });

  it('returns candidates and writes nothing when the match is not safe', async () => {
    const { context, db } = ctx();
    const out = await assignSeries(context, 'shows/zzz', 'zzz');
    expect(out).toMatchObject({ status: 'no_match' });
    expect((out as any).candidates.map((c: any) => c.tmdbId)).toEqual([100, 46195]);
    expect(all(db, 'SELECT id FROM titles')).toHaveLength(0);
    expect(all(db, 'SELECT path FROM source_dirs')).toHaveLength(0);
  });

  it('returns no_match for an empty search', async () => {
    const { context } = ctx();
    expect(await assignSeries(context, 'shows/nothing', 'nothing')).toEqual({ status: 'no_match', candidates: [] });
  });

  it('throws on network failure so the caller can fall back offline', async () => {
    const { context, db } = ctx({ offline: true });
    await expect(assignSeries(context, 'shows/bakemonogatari', 'bakemonogatari')).rejects.toThrow();
    expect(all(db, 'SELECT id FROM titles')).toHaveLength(0);
  });
});

describe('assignSeries with a "Seasons" episode group', () => {
  const seasonsOf = (db: any) =>
    all<any>(db, 'SELECT s.number, s.name, COUNT(e.id) AS n FROM seasons s JOIN episodes e ON e.season_id = s.id GROUP BY s.id ORDER BY s.number');
  const epAt = (db: any, id: number | null) =>
    get<any>(db, 'SELECT s.number AS s, e.number AS e FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE e.id = ?', id!);

  it('builds the seasons from the group when it splits the series further than the official ones', async () => {
    const { context, db } = ctx();
    expect(await assignSeries(context, 'shows/Seasoned Show', 'Seasoned Show')).toMatchObject({ status: 'matched', seasonNumber: null });
    expect(seasonsOf(db)).toEqual([
      { number: 0, name: 'Especiales', n: 3 },
      { number: 1, name: 'Temporada 1', n: 28 },
      { number: 2, name: 'Temporada 2', n: 10 },
    ]);
    expect(get<any>(db, 'SELECT seasons_group_id AS g FROM titles')?.g).toBe('g_s_seasons');
    expect(get<any>(db, 'SELECT name, still_path FROM episodes WHERE number = 4 AND season_id = (SELECT id FROM seasons WHERE number = 2)')).toEqual({ name: 'Episodio 4', still_path: 'original/still4.jpg' });
  });

  it('keeps the official seasons when the group covers fewer episodes', async () => {
    const { context, db } = ctx();
    await assignSeries(context, 'shows/Same Count', 'Same Count');
    expect(all(db, 'SELECT id FROM seasons')).toHaveLength(0); // official seasons are imported on demand
    expect(get<any>(db, 'SELECT seasons_group_id AS g FROM titles')?.g).toBe('');
    const titleId = get<{ id: number }>(db, 'SELECT id FROM titles')!.id;
    expect(epAt(db, await placeEpisode(context, titleId, null, { season: 2, number: 1 }))).toEqual({ s: 2, e: 1 });
  });

  it('lets the folder-name group win over the seasons group', async () => {
    const { context, db } = ctx();
    await assignSeries(context, 'shows/bakemonogatari', 'bakemonogatari');
    expect(seasonsOf(db)).toEqual([{ number: 1, name: 'Bakemonogatari', n: 15 }]);
    expect(get<any>(db, 'SELECT seasons_group_id AS g, episode_group_id AS eg FROM titles')).toEqual({ g: '', eg: 'g_air' });
  });

  it('places S1 - 05 in season 1 and absolute numbers across the group seasons, never in specials', async () => {
    const { context, db, fake } = ctx();
    await assignSeries(context, 'shows/Seasoned Show', 'Seasoned Show');
    const titleId = get<{ id: number }>(db, 'SELECT id FROM titles')!.id;
    const at = async (season: number | null, number: number) => epAt(db, await placeEpisode(context, titleId, null, { season, number }));
    expect(await at(1, 5)).toEqual({ s: 1, e: 5 });
    expect(await at(null, 28)).toEqual({ s: 1, e: 28 });
    expect(await at(null, 30)).toEqual({ s: 2, e: 2 });
    expect(await at(null, 38)).toEqual({ s: 2, e: 10 });
    expect(await at(0, 2)).toEqual({ s: 0, e: 2 });
    expect(await placeEpisode(context, titleId, null, { season: null, number: 39 })).toBeNull();
    expect(await placeEpisode(context, titleId, null, { season: 3, number: 1 })).toBeNull();
    expect(fake.calls.filter((c) => c.startsWith('season:'))).toEqual([]);
  });
});

describe('placeEpisode with a "Cours" group finer than the official seasons', () => {
  // Frieren on TMDB: official seasons 28 + 10, the adopted type 6 group splits them into cours 16 / 12 / 10.
  const FRIEREN_ID = 209867;
  const courGroups: Record<string, EpisodeGroupDetails> = {
    g_cours: {
      id: 'g_cours',
      name: 'Cours',
      type: 6,
      groups: [
        { id: 'c1', name: 'Cour 1', order: 1, episodes: geps(16) },
        { id: 'c2', name: 'Cour 2', order: 2, episodes: geps(12) },
        { id: 'c3', name: 'Cour 3', order: 3, episodes: geps(10) },
      ],
    },
  };
  const frierenTv = tvBase({
    id: FRIEREN_ID,
    name: 'Frieren',
    original_name: 'Sousou no Frieren',
    seasons: [gseason(1, 28), gseason(2, 10)],
    episode_groups: { results: [{ id: 'g_cours', name: 'Cours', type: 6, episode_count: 38 }] },
  });
  const client = () =>
    tmdbWith(courGroups, { [FRIEREN_ID]: frierenTv }, (q) =>
      q.toLowerCase().includes('frieren') ? [{ id: FRIEREN_ID, name: 'Frieren', original_name: 'Sousou no Frieren' }] : [],
    );
  const epAt = (db: any, id: number | null) =>
    get<any>(db, 'SELECT s.number AS s, e.number AS e FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE e.id = ?', id!);

  it('reads SxxEyy as the official numbering and finds it inside the cours', async () => {
    const { context, db } = ctx({ tmdb: client() });
    await assignSeries(context, 'shows/Sousou no Frieren S1', 'Sousou no Frieren');
    const titleId = get<{ id: number }>(db, 'SELECT id FROM titles')!.id;
    expect(get<any>(db, 'SELECT seasons_group_id AS g FROM titles')?.g).toBe('g_cours');
    const at = async (season: number | null, number: number) => epAt(db, await placeEpisode(context, titleId, null, { season, number }));
    expect(await at(1, 16)).toEqual({ s: 1, e: 16 });
    expect(await at(1, 17)).toEqual({ s: 2, e: 1 });
    expect(await at(1, 28)).toEqual({ s: 2, e: 12 });
    expect(await at(2, 1)).toEqual({ s: 3, e: 1 });
    expect(await at(null, 29)).toEqual({ s: 3, e: 1 });
    // A season the official numbering lacks keeps the literal group season.
    expect(await at(3, 2)).toEqual({ s: 3, e: 2 });
    expect(await placeEpisode(context, titleId, null, { season: 2, number: 11 })).toBeNull();
  });
});

describe('assignMovie', () => {
  it('creates the movie and its collection', async () => {
    const { context, db } = ctx();
    const out = await assignMovie(context, 'Inception', 2010);
    expect(out.status).toBe('matched');
    expect(get<any>(db, 'SELECT * FROM titles')).toMatchObject({ tmdb_type: 'movie', tmdb_id: 27205, kind: 'movie', title: 'Origen', year: 2010, runtime_min: 148 });
    expect(get<any>(db, 'SELECT c.name FROM collections c JOIN titles t ON t.collection_id = c.id')?.name).toBe('Saga Origen');
  });

  it('accepts a missing year but rejects a different one', async () => {
    const { context } = ctx();
    expect((await assignMovie(context, 'Inception', null)).status).toBe('matched');
    expect((await assignMovie(context, 'Inception', 1999)).status).toBe('no_match');
    expect(await assignMovie(context, 'Unknown film', 2001)).toEqual({ status: 'no_match', candidates: [] });
  });
});

// Fixtures for the group-alias matching (T83) and the season-set adoption rule (T73).
const gep = (n: number): TmdbEpisode => ({ episode_number: n, name: `Episodio ${n}`, overview: null, runtime: 24, still_path: null, air_date: null });
const geps = (count: number) => Array.from({ length: count }, (_, i) => gep(i + 1));
const gseason = (number: number, count: number) => ({ season_number: number, name: `Temporada ${number}`, overview: '', poster_path: null, episode_count: count });
const tvBase = (over: Partial<TvDetails> & { id: number }): TvDetails => ({
  name: 'Show',
  original_name: 'Show',
  overview: null,
  first_air_date: '2020-01-01',
  episode_run_time: [24],
  vote_average: null,
  genres: [],
  poster_path: null,
  backdrop_path: null,
  origin_country: ['JP'],
  seasons: [],
  ...over,
});
function tmdbWith(groups: Record<string, EpisodeGroupDetails>, tvById: Record<number, TvDetails> = {}, search?: (q: string) => TvSearchResult[]): TmdbClient {
  const base = makeFakeTmdb();
  return {
    ...base,
    tv: (id) => (tvById[id] ? Promise.resolve(tvById[id]!) : base.tv(id)),
    episodeGroup: (id) => Promise.resolve(groups[id]!),
    searchTv: (q) => (search ? Promise.resolve(search(q)) : base.searchTv(q)),
  };
}

const NEKO_ID = 46200;
const nekoGroups: Record<string, EpisodeGroupDetails> = {
  g_neko: {
    id: 'g_neko',
    name: 'Arcs',
    type: 1,
    groups: [
      { id: 'nb', name: 'Nekomonogatari (Black)', order: 3, episodes: geps(4) },
      { id: 'nw', name: 'Nekomonogatari  (White)', order: 4, episodes: geps(5) }, // double space, as on TMDB
    ],
  },
};
const nekoTv = tvBase({
  id: NEKO_ID,
  name: 'Monogatari',
  original_name: '物語シリーズ',
  seasons: [gseason(3, 23)],
  episode_groups: { results: [{ id: 'g_neko', name: 'Arcs', type: 1, episode_count: 9 }] },
});
const nekoClient = () =>
  tmdbWith(nekoGroups, { [NEKO_ID]: nekoTv }, (q) => {
    const n = q.toLowerCase();
    return n.includes('nekomonogatari') || n === 'monogatari' ? [{ id: NEKO_ID, name: 'Monogatari', original_name: '物語シリーズ' }] : [];
  });
const seasonsWith = (db: any) =>
  all<any>(db, 'SELECT s.number, s.name, COUNT(e.id) AS n FROM seasons s LEFT JOIN episodes e ON e.season_id = s.id GROUP BY s.id ORDER BY s.number');

describe('episode group aliases and season-number collisions (T83)', () => {
  it('matches the kuro folder to the group TMDB spells in English', async () => {
    const { context, db } = ctx({ tmdb: nekoClient() });
    const out = await assignSeries(context, 'shows/nekomonogatari kuro', 'nekomonogatari kuro');
    expect(out).toMatchObject({ status: 'matched', seasonNumber: 3 });
    expect(seasonsWith(db)).toEqual([{ number: 3, name: 'Nekomonogatari (Black)', n: 4 }]);
    expect(get<any>(db, 'SELECT season_number FROM source_dirs')?.season_number).toBe(3);
    expect(await findGroup(context, nekoTv, 'kurosawa')).toBeNull(); // word-bounded: never inside a longer word
  });

  it('gives the group the next free number when its order collides with a different season', async () => {
    const { context, db } = ctx({ tmdb: nekoClient() });
    await assignSeries(context, 'shows/monogatari', 'monogatari'); // title only: no group matches this folder
    const titleId = get<{ id: number }>(db, 'SELECT id FROM titles')!.id;
    run(db, "INSERT INTO seasons (title_id, number, name) VALUES (?, 3, 'Monogatari Series: Second Season')", titleId);

    const out = await assignSeries(context, 'shows/nekomonogatari kuro', 'nekomonogatari kuro');
    expect(out).toMatchObject({ status: 'matched', titleId, seasonNumber: 4 });
    expect(seasonsWith(db)).toEqual([
      { number: 3, name: 'Monogatari Series: Second Season', n: 0 },
      { number: 4, name: 'Nekomonogatari (Black)', n: 4 },
    ]);
    expect(get<any>(db, "SELECT season_number FROM source_dirs WHERE path = 'shows/nekomonogatari kuro'")?.season_number).toBe(4);

    // Re-adopting the same group from another folder reuses the season instead of duplicating it.
    expect(await assignSeries(context, 'shows/nekomonogatari black', 'nekomonogatari black')).toMatchObject({ seasonNumber: 4 });
    expect(seasonsWith(db)).toHaveLength(2);
    expect(get<any>(db, 'SELECT COUNT(*) AS n FROM episodes WHERE season_id = (SELECT id FROM seasons WHERE number = 4)')?.n).toBe(4);
  });
});

describe('matchSeries with a season marker in the folder (T83)', () => {
  it('matches "Show - Temporada 3" against the bare title', async () => {
    const show = tvBase({ id: 300, name: 'Show', original_name: 'Show' });
    const client = tmdbWith({}, { 300: show }, (q) => (q.toLowerCase().startsWith('show') ? [{ id: 300, name: 'Show', original_name: 'Show' }] : []));
    const { context } = ctx({ tmdb: client });
    const found = await matchSeries(context, 'Show - Temporada 3');
    expect('tv' in found && found.tv.id).toBe(300);
    expect(await matchSeries(context, 'Unrelated - Temporada 3')).toMatchObject({ candidates: [] });
  });
});

describe('findSeasonsGroup (T73)', () => {
  const mushokuTv = tvBase({
    id: 94664,
    name: 'Mushoku Tensei',
    seasons: [gseason(1, 23), gseason(2, 24), gseason(3, 14)],
    episode_groups: {
      results: [
        { id: 'g_cours', name: 'Cours', type: 6, episode_count: 50 },
        { id: 'g_mseasons', name: 'Seasons', type: 7, episode_count: 61 },
      ],
    },
  });
  const mushokuGroups: Record<string, EpisodeGroupDetails> = {
    g_cours: {
      id: 'g_cours',
      name: 'Cours',
      type: 6,
      groups: [
        { id: 'c1', name: 'Season 1 Part 1', order: 1, episodes: geps(11) },
        { id: 'c2', name: 'Season 1 Part 2', order: 2, episodes: geps(12) },
        { id: 'c3', name: 'OVA', order: 3, episodes: geps(2) },
        { id: 'c4', name: 'Season 2 Part 1', order: 4, episodes: geps(13) },
        { id: 'c5', name: 'Season 2 Part 2', order: 5, episodes: geps(12) },
        { id: 'c6', name: 'Season 3', order: 6, episodes: [] },
      ],
    },
    g_mseasons: {
      id: 'g_mseasons',
      name: 'Seasons',
      type: 7,
      groups: [
        { id: 'm1', name: 'Season 1', order: 1, episodes: geps(23) },
        { id: 'm2', name: 'Season 2', order: 2, episodes: geps(24) },
        { id: 'm3', name: 'Season 3', order: 3, episodes: geps(14) },
        { id: 'm0', name: 'OVA', order: 0, episodes: geps(3) },
      ],
    },
  };

  it('adopts the set that covers the official seasons, rejecting the incomplete one (Mushoku Tensei)', async () => {
    const { context } = ctx({ tmdb: tmdbWith(mushokuGroups) });
    expect((await findSeasonsGroup(context, mushokuTv))?.id).toBe('g_mseasons');
    const coursOnly: TvDetails = { ...mushokuTv, episode_groups: { results: [mushokuTv.episode_groups!.results[0]!] } };
    expect(await findSeasonsGroup(context, coursOnly)).toBeNull(); // its "Season 3" has 0 episodes
  });

  it('prefers the accepted set with more episodes', async () => {
    const alt: EpisodeGroupDetails = {
      id: 'g_alt',
      name: 'Alternative',
      type: 7,
      groups: [
        { id: 'a1', name: 'Season 1', order: 1, episodes: geps(24) },
        { id: 'a2', name: 'Season 2', order: 2, episodes: geps(24) },
        { id: 'a3', name: 'Season 3', order: 3, episodes: geps(24) },
      ],
    };
    const tv: TvDetails = {
      ...mushokuTv,
      episode_groups: { results: [...mushokuTv.episode_groups!.results, { id: 'g_alt', name: 'Alternative', type: 7, episode_count: 72 }] },
    };
    const { context } = ctx({ tmdb: tmdbWith({ ...mushokuGroups, g_alt: alt }) });
    expect((await findSeasonsGroup(context, tv))?.id).toBe('g_alt');
  });

  it('still adopts a set whose non-zero seasons cover the official episode count (Re:Zero)', async () => {
    const rezeroTv = tvBase({
      id: 65942,
      name: 'Re:Zero',
      seasons: [gseason(0, 90), gseason(1, 85)],
      episode_groups: { results: [{ id: 'g_rz', name: 'Seasons', type: 6, episode_count: 156 }] },
    });
    const rezero: EpisodeGroupDetails = {
      id: 'g_rz',
      name: 'Seasons',
      type: 6,
      groups: [
        { id: 'r1', name: 'Season 1', order: 1, episodes: geps(25) },
        { id: 'r2', name: 'Season 2', order: 2, episodes: geps(25) },
        { id: 'r0', name: 'Specials', order: 0, episodes: geps(81) },
        { id: 'r3', name: 'Season 3', order: 3, episodes: geps(16) },
        { id: 'r4', name: 'Season 4', order: 4, episodes: geps(19) },
      ],
    };
    const { context } = ctx({ tmdb: tmdbWith({ g_rz: rezero }) });
    expect((await findSeasonsGroup(context, rezeroTv))?.id).toBe('g_rz');
  });
});
