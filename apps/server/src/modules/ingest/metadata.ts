import type { DatabaseSync } from 'node:sqlite';
import { get, run, transaction } from '../../db/sql.ts';
import { indexEntry } from '../search/repository.ts';
import { type ImageWant, saveImages } from './images.ts';
import type { Credits, EpisodeGroupDetails, EpisodeSubGroup, MovieDetails, SeasonDetails, TmdbClient, TmdbEpisode, TvDetails } from './tmdb.ts';

export interface IngestContext {
  db: DatabaseSync;
  tmdb: TmdbClient;
  dataDir: string;
}

const POSTER = 'w500';
const BACKDROP = 'w1280';
const PROFILE = 'w185';
// Stills fill the episode panel and Continue Watching cards, so w300 looks blurry there.
const STILL = 'original';
const ANIMATION_GENRE = 16;
const MAX_CAST = 15;

const yearOf = (date?: string | null) => (date ? Number(date.slice(0, 4)) || null : null);

function pickLogo(logos: { file_path: string; iso_639_1: string | null }[] = []): string | null {
  return (logos.find((l) => l.iso_639_1 === 'es') ?? logos.find((l) => l.iso_639_1 === 'en') ?? logos[0])?.file_path ?? null;
}

function creditPeople(credits?: Credits) {
  const cast = (credits?.cast ?? []).slice(0, MAX_CAST);
  const directors = (credits?.crew ?? []).filter((c) => c.job === 'Director').slice(0, 3);
  return { cast, directors };
}

type Saved = Awaited<ReturnType<typeof saveImages>>;

function writeCredits(db: DatabaseSync, titleId: number, credits: ReturnType<typeof creditPeople>, saved: Saved): void {
  run(db, 'DELETE FROM credits WHERE title_id = ?', titleId);
  const people = [
    ...credits.cast.map((c) => ({ ...c, role: 'cast', character: c.character, ord: c.order })),
    ...credits.directors.map((d, i) => ({ ...d, role: 'director', character: null, ord: i })),
  ];
  for (const p of people) {
    run(
      db,
      `INSERT INTO people (tmdb_id, name, profile_path) VALUES (?, ?, ?)
       ON CONFLICT(tmdb_id) DO UPDATE SET name = excluded.name, profile_path = COALESCE(excluded.profile_path, profile_path)`,
      p.id,
      p.name,
      saved(PROFILE, p.profile_path),
    );
    const personId = get<{ id: number }>(db, 'SELECT id FROM people WHERE tmdb_id = ?', p.id)!.id;
    indexEntry(db, 'person', personId, p.name);
    run(
      db,
      'INSERT OR IGNORE INTO credits (title_id, person_id, role, character, ord) VALUES (?, ?, ?, ?, ?)',
      titleId,
      personId,
      p.role,
      p.character,
      p.ord,
    );
  }
}

interface TitleFields {
  kind: 'movie' | 'series' | 'anime';
  title: string;
  originalTitle: string | null;
  overview: string | null;
  year: number | null;
  runtimeMin: number | null;
  rating: number | null;
  genres: string[];
  poster: string | null;
  backdrop: string | null;
  logo: string | null;
  collectionId: number | null;
}

// Re-importing the same TMDB id updates the row. `reuseId` turns an offline placeholder into the real title
// in place (keeping its id, files and lists), or merges it into the existing one.
function writeTitle(db: DatabaseSync, tmdbType: 'movie' | 'tv', tmdbId: number, f: TitleFields, reuseId?: number): number {
  const existing = get<{ id: number }>(db, 'SELECT id FROM titles WHERE tmdb_type = ? AND tmdb_id = ?', tmdbType, tmdbId)?.id;
  const values = [
    f.kind, f.title, f.originalTitle, f.overview, f.year, f.runtimeMin, f.rating,
    JSON.stringify(f.genres), f.poster, f.backdrop, f.logo, f.collectionId,
  ] as const;
  let id = existing ?? reuseId;
  if (id === undefined) {
    id = run(
      db,
      `INSERT INTO titles (tmdb_type, tmdb_id, kind, title, original_title, overview, year, runtime_min, rating,
         genres, poster_path, backdrop_path, logo_path, collection_id, metadata_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')`,
      tmdbType,
      tmdbId,
      ...values,
    ).lastInsertId;
  } else {
    run(
      db,
      `UPDATE titles SET tmdb_type = ?, tmdb_id = ?, kind = ?, title = ?, original_title = ?, overview = ?, year = ?,
         runtime_min = ?, rating = ?, genres = ?, poster_path = ?, backdrop_path = ?, logo_path = ?, collection_id = ?,
         metadata_status = 'ready', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      tmdbType,
      tmdbId,
      ...values,
      id,
    );
    if (reuseId !== undefined && reuseId !== id) mergeTitles(db, reuseId, id);
  }
  indexEntry(db, 'title', id, f.title);
  return id;
}

// Moves the placeholder's files and folders to `to`; callers re-place episodes with relinkFiles.
function mergeTitles(db: DatabaseSync, from: number, to: number): void {
  run(db, 'UPDATE media_files SET title_id = ?, episode_id = NULL WHERE title_id = ?', to, from);
  run(db, 'UPDATE source_dirs SET title_id = ? WHERE title_id = ?', to, from);
  run(db, 'UPDATE OR IGNORE my_list SET title_id = ? WHERE title_id = ?', to, from);
  run(db, 'UPDATE OR IGNORE title_state SET title_id = ? WHERE title_id = ?', to, from);
  run(db, 'DELETE FROM titles WHERE id = ?', from);
  run(db, "DELETE FROM search_index WHERE ref_type = 'title' AND ref_id = ?", from);
}

export async function importTv(ctx: IngestContext, tv: TvDetails, reuseId?: number): Promise<number> {
  const logo = pickLogo(tv.images?.logos);
  const credits = creditPeople(tv.credits);
  const saved = await saveImages(ctx.tmdb, ctx.dataDir, [
    [POSTER, tv.poster_path],
    [BACKDROP, tv.backdrop_path],
    [POSTER, logo],
    ...[...credits.cast, ...credits.directors].map((p): ImageWant => [PROFILE, p.profile_path]),
  ]);
  return transaction(ctx.db, () => {
    const anime = tv.genres.some((g) => g.id === ANIMATION_GENRE) && tv.origin_country.includes('JP');
    const id = writeTitle(
      ctx.db,
      'tv',
      tv.id,
      {
        kind: anime ? 'anime' : 'series',
        title: tv.name,
        originalTitle: tv.original_name,
        overview: tv.overview || null,
        year: yearOf(tv.first_air_date),
        runtimeMin: tv.episode_run_time?.[0] ?? null,
        rating: tv.vote_average,
        genres: tv.genres.map((g) => g.name),
        poster: saved(POSTER, tv.poster_path),
        backdrop: saved(BACKDROP, tv.backdrop_path),
        logo: saved(POSTER, logo),
        collectionId: null,
      },
      reuseId,
    );
    writeCredits(ctx.db, id, credits, saved);
    return id;
  });
}

export async function importMovie(ctx: IngestContext, movie: MovieDetails, reuseId?: number): Promise<number> {
  const logo = pickLogo(movie.images?.logos);
  const credits = creditPeople(movie.credits);
  const collection = movie.belongs_to_collection ? await ctx.tmdb.collection(movie.belongs_to_collection.id) : null;
  const saved = await saveImages(ctx.tmdb, ctx.dataDir, [
    [POSTER, movie.poster_path],
    [BACKDROP, movie.backdrop_path],
    [POSTER, logo],
    [POSTER, collection?.poster_path],
    [BACKDROP, collection?.backdrop_path],
    ...[...credits.cast, ...credits.directors].map((p): ImageWant => [PROFILE, p.profile_path]),
  ]);
  return transaction(ctx.db, () => {
    let collectionId: number | null = null;
    if (collection) {
      run(
        ctx.db,
        `INSERT INTO collections (tmdb_id, name, overview, poster_path, backdrop_path) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tmdb_id) DO UPDATE SET name = excluded.name, overview = excluded.overview,
           poster_path = excluded.poster_path, backdrop_path = excluded.backdrop_path`,
        collection.id,
        collection.name,
        collection.overview || null,
        saved(POSTER, collection.poster_path),
        saved(BACKDROP, collection.backdrop_path),
      );
      collectionId = get<{ id: number }>(ctx.db, 'SELECT id FROM collections WHERE tmdb_id = ?', collection.id)!.id;
    }
    const id = writeTitle(
      ctx.db,
      'movie',
      movie.id,
      {
        kind: 'movie',
        title: movie.title,
        originalTitle: movie.original_title,
        overview: movie.overview || null,
        year: yearOf(movie.release_date),
        runtimeMin: movie.runtime,
        rating: movie.vote_average,
        genres: movie.genres.map((g) => g.name),
        poster: saved(POSTER, movie.poster_path),
        backdrop: saved(BACKDROP, movie.backdrop_path),
        logo: saved(POSTER, logo),
        collectionId,
      },
      reuseId,
    );
    writeCredits(ctx.db, id, credits, saved);
    return id;
  });
}

function upsertSeason(db: DatabaseSync, titleId: number, number: number, name: string | null, overview: string | null, poster: string | null): number {
  run(
    db,
    `INSERT INTO seasons (title_id, number, name, overview, poster_path) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(title_id, number) DO UPDATE SET name = excluded.name,
       overview = COALESCE(excluded.overview, overview), poster_path = COALESCE(excluded.poster_path, poster_path)`,
    titleId,
    number,
    name,
    overview,
    poster,
  );
  return get<{ id: number }>(db, 'SELECT id FROM seasons WHERE title_id = ? AND number = ?', titleId, number)!.id;
}

function upsertEpisode(db: DatabaseSync, seasonId: number, number: number, e: TmdbEpisode, still: string | null): void {
  run(
    db,
    `INSERT INTO episodes (season_id, number, name, overview, runtime_min, still_path, air_date) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(season_id, number) DO UPDATE SET name = excluded.name, overview = excluded.overview,
       runtime_min = excluded.runtime_min, still_path = COALESCE(excluded.still_path, still_path), air_date = excluded.air_date`,
    seasonId,
    number,
    e.name || null,
    e.overview || null,
    e.runtime,
    still,
    e.air_date || null,
  );
}

// An alternative ordering becomes one season: its group order is the season number and
// the N-th episode of the group is episode N.
export async function importGroupSeason(
  ctx: IngestContext,
  titleId: number,
  episodeGroupId: string,
  seasonNumber: number,
  group: EpisodeSubGroup,
): Promise<void> {
  const saved = await saveImages(ctx.tmdb, ctx.dataDir, group.episodes.map((e): ImageWant => [STILL, e.still_path]));
  transaction(ctx.db, () => {
    const seasonId = upsertSeason(ctx.db, titleId, seasonNumber, group.name, null, null);
    group.episodes.forEach((e, i) => upsertEpisode(ctx.db, seasonId, i + 1, e, saved(STILL, e.still_path)));
    run(ctx.db, 'UPDATE titles SET episode_group_id = ? WHERE id = ?', episodeGroupId, titleId);
  });
}

// TMDB type 6 = "Seasons". It replaces the official seasons only when it splits the series into more of them
// (e.g. a 38-episode season 1 that is really 28 + 10).
const SEASONS_GROUP_TYPE = 6;

export async function findSeasonsGroup(ctx: IngestContext, tv: TvDetails): Promise<EpisodeGroupDetails | null> {
  const official = tv.seasons.filter((s) => s.season_number > 0).length;
  for (const ref of (tv.episode_groups?.results ?? []).filter((r) => r.type === SEASONS_GROUP_TYPE)) {
    const detail = await ctx.tmdb.episodeGroup(ref.id);
    if (detail.groups.filter((g) => g.order > 0).length > official) return detail;
  }
  return null;
}

export async function importSeasonsGroup(ctx: IngestContext, titleId: number, detail: EpisodeGroupDetails): Promise<void> {
  for (const g of detail.groups) {
    // TMDB names these "Season N" in English; the library shows Spanish names like the official seasons.
    const name = g.order === 0 ? 'Especiales' : /^season\s*\d+$/i.test(g.name) ? `Temporada ${g.order}` : g.name;
    await importGroupSeason(ctx, titleId, detail.id, g.order, { ...g, name });
  }
  run(ctx.db, 'UPDATE titles SET seasons_group_id = ? WHERE id = ?', detail.id, titleId);
}

export function markOfficialSeasons(db: DatabaseSync, titleId: number): void {
  run(db, "UPDATE titles SET seasons_group_id = '' WHERE id = ?", titleId);
}

export async function importTmdbSeason(ctx: IngestContext, titleId: number, season: SeasonDetails): Promise<void> {
  const saved = await saveImages(ctx.tmdb, ctx.dataDir, [
    [POSTER, season.poster_path],
    ...season.episodes.map((e): ImageWant => [STILL, e.still_path]),
  ]);
  transaction(ctx.db, () => {
    const seasonId = upsertSeason(ctx.db, titleId, season.season_number, season.name, season.overview || null, saved(POSTER, season.poster_path));
    for (const e of season.episodes) upsertEpisode(ctx.db, seasonId, e.episode_number!, e, saved(STILL, e.still_path));
  });
}

export function hasSeason(db: DatabaseSync, titleId: number, number: number): boolean {
  return !!get(db, 'SELECT 1 FROM seasons WHERE title_id = ? AND number = ?', titleId, number);
}

export function findEpisodeId(db: DatabaseSync, titleId: number, season: number, number: number): number | null {
  return (
    get<{ id: number }>(
      db,
      `SELECT e.id FROM episodes e JOIN seasons s ON s.id = e.season_id
       WHERE s.title_id = ? AND s.number = ? AND e.number = ?`,
      titleId,
      season,
      number,
    )?.id ?? null
  );
}

// Offline: episodes exist only as far as files were parsed.
export function ensureLocalEpisode(db: DatabaseSync, titleId: number, season: number, number: number): number {
  const seasonId = upsertSeason(db, titleId, season, null, null, null);
  run(db, 'INSERT OR IGNORE INTO episodes (season_id, number) VALUES (?, ?)', seasonId, number);
  return findEpisodeId(db, titleId, season, number)!;
}

export function createLocalTitle(db: DatabaseSync, kind: 'movie' | 'series', title: string, year: number | null = null): number {
  const id = run(db, "INSERT INTO titles (kind, title, year, metadata_status) VALUES (?, ?, ?, 'pending')", kind, title, year).lastInsertId;
  indexEntry(db, 'title', id, title);
  return id;
}

export function setSourceDir(db: DatabaseSync, path: string, titleId: number, seasonNumber: number | null): void {
  run(
    db,
    `INSERT INTO source_dirs (path, title_id, season_number) VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET title_id = excluded.title_id, season_number = excluded.season_number`,
    path,
    titleId,
    seasonNumber,
  );
}
