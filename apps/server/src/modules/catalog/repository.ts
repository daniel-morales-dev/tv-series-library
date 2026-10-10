import type { DatabaseSync } from 'node:sqlite';
import { all, get, parseJsonArray } from '../../db/sql.ts';
import { getFranchise } from './franchise.ts';
import { loadChapters } from './chapters.ts';

export interface TitleSummary {
  id: number;
  kind: 'movie' | 'series' | 'anime';
  title: string;
  originalTitle: string | null;
  overview: string | null;
  year: number | null;
  runtimeMin: number | null;
  rating: number | null;
  genres: unknown[];
  posterPath: string | null;
  backdropPath: string | null;
  logoPath: string | null;
  metadataStatus: string;
  /** Has files, and every one is still downloading. */
  comingSoon: boolean;
}

export interface TitleFilters {
  kind?: TitleSummary['kind'];
  year?: number;
  genre?: string;
  sort?: 'recent' | 'title' | 'year';
  limit: number;
  offset: number;
}

export const SUMMARY_COLUMNS = `t.id, t.kind, t.title, t.original_title, t.overview, t.year, t.runtime_min,
  t.rating, t.genres, t.poster_path, t.backdrop_path, t.logo_path, t.metadata_status,
  (EXISTS (SELECT 1 FROM media_files f WHERE f.title_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM media_files f WHERE f.title_id = t.id AND f.status <> 'downloading')) AS coming_soon`;

export function toSummary(r: Record<string, any>): TitleSummary {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    originalTitle: r.original_title,
    overview: r.overview,
    year: r.year,
    runtimeMin: r.runtime_min,
    rating: r.rating,
    genres: parseJsonArray(r.genres),
    posterPath: r.poster_path,
    backdropPath: r.backdrop_path,
    logoPath: r.logo_path,
    metadataStatus: r.metadata_status,
    comingSoon: r.coming_soon === 1,
  };
}

const ORDER: Record<NonNullable<TitleFilters['sort']>, string> = {
  recent: 't.created_at DESC, t.id DESC',
  title: 't.title COLLATE NOCASE, t.id',
  year: 't.year IS NULL, t.year DESC, t.id',
};

export function listTitles(db: DatabaseSync, f: TitleFilters): TitleSummary[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.kind) (where.push('t.kind = ?'), params.push(f.kind));
  if (f.year) (where.push('t.year = ?'), params.push(f.year));
  if (f.genre) (where.push('EXISTS (SELECT 1 FROM json_each(t.genres) WHERE value = ?)'), params.push(f.genre));
  const sql = `SELECT ${SUMMARY_COLUMNS} FROM titles t
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${ORDER[f.sort ?? 'recent']} LIMIT ? OFFSET ?`;
  return all<Record<string, any>>(db, sql, ...params, f.limit, f.offset).map(toSummary);
}

export function getTitleDetail(db: DatabaseSync, id: number, profileId?: number) {
  const row = get<Record<string, any>>(db, `SELECT ${SUMMARY_COLUMNS}, t.collection_id, t.franchise_id FROM titles t WHERE t.id = ?`, id);
  if (!row) return undefined;

  const episodes = all<Record<string, any>>(
    db,
    `SELECT e.*, s.number AS season_number FROM episodes e JOIN seasons s ON s.id = e.season_id
     WHERE s.title_id = ? ORDER BY s.number, e.number`,
    id,
  );
  const seasons = all<Record<string, any>>(db, 'SELECT * FROM seasons WHERE title_id = ? ORDER BY number', id).map((s) => ({
    id: s.id,
    number: s.number,
    name: s.name,
    overview: s.overview,
    posterPath: s.poster_path,
    episodes: episodes
      .filter((e) => e.season_id === s.id)
      .map((e) => ({
        id: e.id,
        number: e.number,
        name: e.name,
        overview: e.overview,
        runtimeMin: e.runtime_min,
        stillPath: e.still_path,
        airDate: e.air_date,
      })),
  }));

  const credits = all<Record<string, any>>(
    db,
    `SELECT p.id, p.name, p.profile_path, c.role, c.character FROM credits c JOIN people p ON p.id = c.person_id
     WHERE c.title_id = ? ORDER BY c.role, c.ord`,
    id,
  ).map((c) => ({ personId: c.id, name: c.name, profilePath: c.profile_path, role: c.role, character: c.character }));

  const collection = row.collection_id
    ? get<Record<string, any>>(db, 'SELECT * FROM collections WHERE id = ?', row.collection_id)
    : undefined;
  const saga = collection && {
    id: collection.id,
    name: collection.name,
    overview: collection.overview,
    posterPath: collection.poster_path,
    backdropPath: collection.backdrop_path,
    titles: all<Record<string, any>>(
      db,
      `SELECT ${SUMMARY_COLUMNS} FROM titles t WHERE t.collection_id = ? ORDER BY t.year, t.id`,
      collection.id,
    ).map(toSummary),
  };

  const files = all<Record<string, any>>(
    db,
    'SELECT * FROM media_files WHERE title_id = ? ORDER BY id',
    id,
  ).map((f) => ({
    id: f.id,
    status: f.status,
    episodeId: f.episode_id,
    extraLabel: f.extra_label,
    durationS: f.duration_s,
    audioTracks: parseJsonArray(f.audio_tracks),
    subtitleTracks: parseJsonArray(f.subtitle_tracks),
    chaptersChecked: f.chapters_checked === 1,
    chapters: loadChapters(db, f.id),
  }));

  const detail = { ...toSummary(row), seasons, credits, collection: saga ?? null, franchise: getFranchise(db, id, row.franchise_id), files };
  if (profileId === undefined) return detail;

  const state = get<{ finished: number }>(
    db,
    'SELECT finished FROM title_state WHERE profile_id = ? AND title_id = ?',
    profileId,
    id,
  );
  return {
    ...detail,
    inMyList: get(db, 'SELECT 1 AS x FROM my_list WHERE profile_id = ? AND title_id = ?', profileId, id) !== undefined,
    finished: state?.finished === 1,
    progress: all<Record<string, any>>(
      db,
      `SELECT wp.* FROM watch_progress wp JOIN media_files mf ON mf.id = wp.media_file_id
       WHERE wp.profile_id = ? AND mf.title_id = ?`,
      profileId,
      id,
    ).map((p) => ({
      mediaFileId: p.media_file_id,
      positionS: p.position_s,
      durationS: p.duration_s,
      completed: p.completed === 1,
    })),
  };
}

export function titleExists(db: DatabaseSync, id: number): boolean {
  return get(db, 'SELECT 1 AS x FROM titles WHERE id = ?', id) !== undefined;
}
