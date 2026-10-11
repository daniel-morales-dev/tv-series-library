import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db/connection.ts';
import { all, get, run } from '../src/db/sql.ts';
import { refreshSeasonAirDates, refreshTitleMetadata } from '../src/modules/ingest/metadata.ts';
import { makeFakeTmdb } from './fake-tmdb.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'tvlib-air-'));
  dirs.push(dataDir);
  const db = openDb(':memory:');
  const tmdb = makeFakeTmdb();
  return { db, tmdb, dataDir, ctx: { db, tmdb, dataDir } };
}

const addSeason = (db: DatabaseSync, titleId: number, number: number, name: string | null) =>
  run(db, 'INSERT INTO seasons (title_id, number, name) VALUES (?, ?, ?)', titleId, number, name).lastInsertId;

const addTvTitle = (db: DatabaseSync, tmdbId: number, episodeGroupId: string | null = null) =>
  run(
    db,
    "INSERT INTO titles (tmdb_type, tmdb_id, kind, title, metadata_status, episode_group_id) VALUES ('tv', ?, 'anime', 'Serie', 'ready', ?)",
    tmdbId,
    episodeGroupId,
  ).lastInsertId;

describe('015 season air date migration', () => {
  it('adds seasons.air_date and bumps the schema version', () => {
    const db = openDb(':memory:');
    expect(all<{ name: string }>(db, 'PRAGMA table_info(seasons)').map((c) => c.name)).toContain('air_date');
    expect(get(db, 'PRAGMA user_version')).toEqual({ user_version: 15 });
  });
});

describe('refreshSeasonAirDates', () => {
  it('fills official seasons by number from tv()', async () => {
    const { db, ctx } = setup();
    const id = addTvTitle(db, 300);
    addSeason(db, id, 3, 'Temporada 3');
    addSeason(db, id, 4, 'Temporada 4');

    await refreshSeasonAirDates(ctx, id);

    expect(all(db, 'SELECT number, air_date FROM seasons WHERE title_id = ? ORDER BY number', id)).toEqual([
      { number: 3, air_date: '2013-07-07' },
      { number: 4, air_date: '2012-12-31' },
    ]);
  });

  it('fills group seasons by normalized name, falls back to the group order, and leaves unmatched seasons null', async () => {
    const { db, ctx } = setup();
    const id = addTvTitle(db, 46195, 'g_mono2'); // 46195's official seasons carry no dates
    const neko = addSeason(db, id, 7, 'Nekomonogatari (Black)');
    const second = addSeason(db, id, 8, 'Monogatari Series: Second Season');
    const byOrder = addSeason(db, id, 5, 'Temporada rara'); // no name match: the group order is the fallback
    const unknown = addSeason(db, id, 9, 'Otra');

    await refreshSeasonAirDates(ctx, id);

    const dateOf = (seasonId: number) => get<{ air_date: string | null }>(db, 'SELECT air_date FROM seasons WHERE id = ?', seasonId)?.air_date;
    expect(dateOf(neko)).toBe('2012-12-31');
    expect(dateOf(second)).toBe('2013-07-07');
    expect(dateOf(byOrder)).toBe('2014-01-01');
    expect(dateOf(unknown)).toBeNull();
  });

  it('backfills the official dates through refreshTitleMetadata', async () => {
    const { db, ctx } = setup();
    const id = addTvTitle(db, 46195);
    addSeason(db, id, 1, 'Temporada 1');

    await refreshTitleMetadata(ctx, id);

    expect(get(db, 'SELECT air_date FROM seasons WHERE title_id = ? AND number = 1', id)).toEqual({ air_date: '2009-07-03' });
  });
});

describe('title detail season order', () => {
  it('orders seasons by air date (undated last) and exposes airDate', async () => {
    const { db, tmdb, dataDir } = setup();
    const id = addTvTitle(db, 300);
    const neko = addSeason(db, id, 4, 'Nekomonogatari (Black)');
    const second = addSeason(db, id, 3, 'Monogatari Series: Second Season');
    addSeason(db, id, 5, 'Temporada 5');
    run(db, 'UPDATE seasons SET air_date = ? WHERE id = ?', '2012-12-31', neko);
    run(db, 'UPDATE seasons SET air_date = ? WHERE id = ?', '2013-07-07', second);

    const app = buildApp({ db, dataDir, tmdb });
    const detail = (await app.inject(`/api/titles/${id}`)).json();

    expect(detail.seasons.map((s: { number: number; airDate: string | null }) => [s.number, s.airDate])).toEqual([
      [4, '2012-12-31'],
      [3, '2013-07-07'],
      [5, null],
    ]);
  });
});
