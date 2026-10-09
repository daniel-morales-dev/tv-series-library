import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { all, get } from '../src/db/sql.ts';
import { assignMovie, assignSeries, placeEpisode } from '../src/modules/ingest/assign.ts';
import type { IngestContext } from '../src/modules/ingest/metadata.ts';
import { suggest } from '../src/modules/search/repository.ts';
import { makeFakeTmdb } from './fake-tmdb.ts';
import { setup } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function ctx(opts: { offline?: boolean } = {}) {
  const { db } = setup();
  const dataDir = mkdtempSync(join(tmpdir(), 'tvlib-'));
  dirs.push(dataDir);
  const tmdb = makeFakeTmdb(opts);
  const context: IngestContext = { db, tmdb, dataDir };
  return { context, db, tmdb, dataDir };
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
    const { context, tmdb } = ctx();
    await assignSeries(context, 'shows/bakemonogatari', 'bakemonogatari');
    tmdb.calls.length = 0;
    await assignSeries(context, 'shows/bakemonogatari', 'bakemonogatari');
    expect(tmdb.calls).toEqual([]);
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

  it('keeps the official seasons when the group does not have more of them', async () => {
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
    const { context, db, tmdb } = ctx();
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
    expect(tmdb.calls.filter((c) => c.startsWith('season:'))).toEqual([]);
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
