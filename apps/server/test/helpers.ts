import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/connection.ts';
import { buildApp } from '../src/app.ts';
import { run } from '../src/db/sql.ts';

export function setup() {
  const db = openDb(':memory:');
  const app = buildApp({ db });
  return { db, app };
}

export const addProfile = (db: DatabaseSync, name = 'ana') =>
  run(db, 'INSERT INTO profiles (name) VALUES (?)', name).lastInsertId;

export const addTitle = (
  db: DatabaseSync,
  title: string,
  extra: { kind?: string; year?: number; genres?: string[] } = {},
) =>
  run(
    db,
    'INSERT INTO titles (kind, title, year, genres) VALUES (?, ?, ?, ?)',
    extra.kind ?? 'movie',
    title,
    extra.year ?? null,
    JSON.stringify(extra.genres ?? []),
  ).lastInsertId;

export function addEpisode(db: DatabaseSync, titleId: number, season: number, number: number, durationS = 1000) {
  const seasonRow = db.prepare('SELECT id FROM seasons WHERE title_id = ? AND number = ?').get(titleId, season) as
    | { id: number }
    | undefined;
  const seasonId =
    seasonRow?.id ?? run(db, 'INSERT INTO seasons (title_id, number) VALUES (?, ?)', titleId, season).lastInsertId;
  const episodeId = run(db, 'INSERT INTO episodes (season_id, number, name) VALUES (?, ?, ?)', seasonId, number, `E${number}`)
    .lastInsertId;
  return addFile(db, titleId, { episodeId, durationS });
}

export const addFile = (
  db: DatabaseSync,
  titleId: number,
  o: { episodeId?: number; extraLabel?: string; durationS?: number; status?: string } = {},
) =>
  run(
    db,
    'INSERT INTO media_files (path, title_id, episode_id, extra_label, status, duration_s) VALUES (?, ?, ?, ?, ?, ?)',
    `/f/${Math.random()}`,
    titleId,
    o.episodeId ?? null,
    o.extraLabel ?? null,
    o.status ?? 'ready',
    o.durationS ?? 1000,
  ).lastInsertId;
