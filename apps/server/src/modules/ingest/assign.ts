import { get } from '../../db/sql.ts';
import {
  type IngestContext,
  findEpisodeId,
  hasSeason,
  ensureLocalEpisode,
  importGroupSeason,
  importMovie,
  importTmdbSeason,
  importTv,
  setSourceDir,
} from './metadata.ts';
import type { EpisodeSubGroup, TvDetails } from './tmdb.ts';

const MAX_CANDIDATES = 5;
// TMDB episode group types: 1 = original air date, 3 = DVD; anything else comes after.
const GROUP_PREFERENCE = [1, 3];

export interface Candidate {
  tmdbType: 'tv' | 'movie';
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number | null;
  overview: string | null;
}

export type Matched = { status: 'matched'; titleId: number; seasonNumber: number | null };
export type Assignment = Matched | { status: 'no_match'; candidates: Candidate[] };

export interface GroupMatch {
  episodeGroupId: string;
  seasonNumber: number;
  group: EpisodeSubGroup;
}

export const normalize = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const yearOf = (date?: string | null) => (date ? Number(date.slice(0, 4)) || null : null);
const rank = (type: number) => {
  const i = GROUP_PREFERENCE.indexOf(type);
  return i < 0 ? GROUP_PREFERENCE.length : i;
};

// The group whose name equals the folder, looked up in the preferred ordering first.
export async function findGroup(ctx: IngestContext, tv: TvDetails, folder: string): Promise<GroupMatch | null> {
  const wanted = normalize(folder);
  if (!wanted) return null;
  const refs = [...(tv.episode_groups?.results ?? [])].sort((a, b) => rank(a.type) - rank(b.type));
  for (const ref of refs) {
    const detail = await ctx.tmdb.episodeGroup(ref.id);
    const index = detail.groups.findIndex((g) => normalize(g.name) === wanted);
    if (index >= 0) {
      const group = detail.groups[index]!;
      return { episodeGroupId: ref.id, seasonNumber: group.order > 0 ? group.order : index + 1, group };
    }
  }
  return null;
}

export async function matchSeries(
  ctx: IngestContext,
  folder: string,
): Promise<{ tv: TvDetails; group: GroupMatch | null } | { candidates: Candidate[] }> {
  const results = (await ctx.tmdb.searchTv(folder)).slice(0, MAX_CANDIDATES);
  const wanted = normalize(folder);
  for (const r of wanted ? results : []) {
    const tv = await ctx.tmdb.tv(r.id);
    const group = await findGroup(ctx, tv, folder);
    const names = [tv.name, tv.original_name, ...(tv.alternative_titles?.results ?? []).map((a) => a.title)];
    if (group || names.some((n) => normalize(n) === wanted)) return { tv, group };
  }
  return {
    candidates: results.map((r) => ({
      tmdbType: 'tv',
      tmdbId: r.id,
      title: r.name,
      originalTitle: r.original_name,
      year: yearOf(r.first_air_date),
      overview: r.overview || null,
    })),
  };
}

// Imports the series (and its group season) and records which folder it came from.
export async function adoptSeries(
  ctx: IngestContext,
  dirRel: string,
  tv: TvDetails,
  group: GroupMatch | null,
  reuseTitleId?: number,
): Promise<Matched> {
  const titleId = await importTv(ctx, tv, reuseTitleId);
  if (group) await importGroupSeason(ctx, titleId, group.episodeGroupId, group.seasonNumber, group.group);
  setSourceDir(ctx.db, dirRel, titleId, group?.seasonNumber ?? null);
  return { status: 'matched', titleId, seasonNumber: group?.seasonNumber ?? null };
}

// Throws when TMDB cannot be reached; the caller decides how to degrade.
export async function assignSeries(ctx: IngestContext, dirRel: string, folder: string): Promise<Assignment> {
  const known = get<{ title_id: number; season_number: number | null }>(
    ctx.db,
    'SELECT title_id, season_number FROM source_dirs WHERE path = ?',
    dirRel,
  );
  if (known) return { status: 'matched', titleId: known.title_id, seasonNumber: known.season_number };
  const found = await matchSeries(ctx, folder);
  if ('candidates' in found) return { status: 'no_match', candidates: found.candidates };
  return adoptSeries(ctx, dirRel, found.tv, found.group);
}

function locateAbsolute(tv: TvDetails, n: number): { season: number; episode: number } | null {
  let rest = n;
  const regular = tv.seasons.filter((s) => s.season_number > 0).sort((a, b) => a.season_number - b.season_number);
  for (const s of regular) {
    if (rest <= s.episode_count) return { season: s.season_number, episode: rest };
    rest -= s.episode_count;
  }
  return null;
}

// Episode id for a parsed file, importing the TMDB season on demand; null when it does not exist.
export async function placeEpisode(
  ctx: IngestContext,
  titleId: number,
  seasonNumber: number | null,
  parsed: { season: number | null; number: number },
): Promise<number | null> {
  const title = get<{ tmdb_id: number | null }>(ctx.db, 'SELECT tmdb_id FROM titles WHERE id = ?', titleId);
  if (!title) return null;
  if (title.tmdb_id === null) return ensureLocalEpisode(ctx.db, titleId, seasonNumber ?? parsed.season ?? 1, parsed.number);
  if (seasonNumber !== null) return findEpisodeId(ctx.db, titleId, seasonNumber, parsed.number);

  const target =
    parsed.season !== null
      ? { season: parsed.season, episode: parsed.number }
      : locateAbsolute(await ctx.tmdb.tv(title.tmdb_id), parsed.number);
  if (!target) return null;
  if (!hasSeason(ctx.db, titleId, target.season)) {
    const season = await ctx.tmdb.tvSeason(title.tmdb_id, target.season);
    if (!season) return null;
    await importTmdbSeason(ctx, titleId, season);
  }
  return findEpisodeId(ctx.db, titleId, target.season, target.episode);
}

export async function assignMovie(
  ctx: IngestContext,
  title: string,
  year: number | null,
  reuseTitleId?: number,
): Promise<Assignment> {
  const wanted = normalize(title);
  const search = (y?: number) => ctx.tmdb.searchMovie(title, y);
  let results = await search(year ?? undefined);
  const safe = (r: (typeof results)[number]) => {
    const released = yearOf(r.release_date);
    const sameName = [r.title, r.original_title].some((n) => normalize(n) === wanted);
    return !!wanted && sameName && (year === null || released === null || Math.abs(released - year) <= 1);
  };
  let hit = results.find(safe);
  if (!hit && year !== null) {
    results = await search();
    hit = results.find(safe);
  }
  if (hit) {
    const titleId = await importMovie(ctx, await ctx.tmdb.movie(hit.id), reuseTitleId);
    return { status: 'matched', titleId, seasonNumber: null };
  }
  return {
    status: 'no_match',
    candidates: results.slice(0, MAX_CANDIDATES).map((r) => ({
      tmdbType: 'movie',
      tmdbId: r.id,
      title: r.title,
      originalTitle: r.original_title,
      year: yearOf(r.release_date),
      overview: r.overview || null,
    })),
  };
}
