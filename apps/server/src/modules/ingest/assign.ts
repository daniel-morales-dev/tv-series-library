import { all, get } from '../../db/sql.ts';
import { normalize, splitSeasonMarker, yearOf } from './parser.ts';
import {
  type IngestContext,
  findEpisodeId,
  hasSeason,
  ensureLocalEpisode,
  findSeasonsGroup,
  importGroupSeason,
  importSeasonsGroup,
  markOfficialSeasons,
  importMovie,
  importTmdbSeason,
  importTv,
  setSourceDir,
} from './metadata.ts';
import type { EpisodeGroupDetails, EpisodeGroupRef, EpisodeSubGroup, MovieSearchResult, TvDetails, TvSearchResult } from './tmdb.ts';

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

// A TMDB search result, either kind, flattened to the candidate the confirm UI shows.
const toCandidate = (r: TvSearchResult | MovieSearchResult, tmdbType: 'tv' | 'movie'): Candidate => {
  const [title, originalTitle, date] = 'name' in r ? [r.name, r.original_name, r.first_air_date] : [r.title, r.original_title, r.release_date];
  return { tmdbType, tmdbId: r.id, title, originalTitle, year: yearOf(date), overview: r.overview || null };
};

export type Matched = { status: 'matched'; titleId: number; seasonNumber: number | null };
export type Assignment = Matched | { status: 'no_match'; candidates: Candidate[] };

export interface GroupMatch {
  episodeGroupId: string;
  seasonNumber: number;
  group: EpisodeSubGroup;
}

export { normalize };

// TMDB arc titles use the English color ("Nekomonogatari (Black)") while folders use the Japanese token
// ("nekomonogatari kuro"). Word-bounded, so "Kurosawa" is never rewritten.
const NAME_ALIASES: Record<string, string> = { kuro: 'black', shiro: 'white' };
const aliasNames = (s: string): string =>
  s.replace(/\b(?:kuro|shiro)\b/gi, (m) => NAME_ALIASES[m.toLowerCase()]!).replace(/\s+/g, ' ');

const rank = (type: number) => {
  const i = GROUP_PREFERENCE.indexOf(type);
  return i < 0 ? GROUP_PREFERENCE.length : i;
};

// The group whose name equals the folder, looked up in the preferred ordering first. A second pass retries
// with kuro/shiro translated, since the folder spells the arc the Japanese way and TMDB the English one.
export async function findGroup(ctx: IngestContext, tv: TvDetails, folder: string): Promise<GroupMatch | null> {
  const wanted = normalize(folder);
  if (!wanted) return null;
  const refs = [...(tv.episode_groups?.results ?? [])].sort((a, b) => rank(a.type) - rank(b.type));
  const pick = (ref: EpisodeGroupRef, detail: EpisodeGroupDetails, index: number): GroupMatch => {
    const group = detail.groups[index]!;
    return { episodeGroupId: ref.id, seasonNumber: group.order > 0 ? group.order : index + 1, group };
  };
  for (const ref of refs) {
    const detail = await ctx.tmdb.episodeGroup(ref.id);
    const index = detail.groups.findIndex((g) => normalize(g.name) === wanted);
    if (index >= 0) return pick(ref, detail, index);
  }
  const aliased = normalize(aliasNames(folder));
  if (aliased !== wanted) {
    for (const ref of refs) {
      const detail = await ctx.tmdb.episodeGroup(ref.id);
      const index = detail.groups.findIndex((g) => normalize(aliasNames(g.name)) === aliased);
      if (index >= 0) return pick(ref, detail, index);
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
  // "Show - Temporada 3" carries a season marker the title never has: retry the name without it.
  const bare = normalize(splitSeasonMarker(folder).show);
  const matches = (name: string) => normalize(name) === wanted || (bare !== wanted && normalize(name) === bare);
  for (const r of wanted ? results : []) {
    const tv = await ctx.tmdb.tv(r.id);
    const group = await findGroup(ctx, tv, folder);
    const names = [tv.name, tv.original_name, ...(tv.alternative_titles?.results ?? []).map((a) => a.title)];
    if (group || names.some(matches)) return { tv, group };
  }
  return { candidates: results.map((r) => toCandidate(r, 'tv')) };
}

// Imports the series (and its group season) and records which folder it came from.
export async function adoptSeries(
  ctx: IngestContext,
  dirRel: string,
  tv: TvDetails,
  group: GroupMatch | null,
  reuseTitleId?: number,
  rootId = 1,
): Promise<Matched> {
  const titleId = await importTv(ctx, tv, reuseTitleId);
  let seasonNumber: number | null = null;
  if (group) {
    // The real number may differ when the group's order collides with another season of the title.
    seasonNumber = await importGroupSeason(ctx, titleId, group.episodeGroupId, group.seasonNumber, group.group);
    markOfficialSeasons(ctx.db, titleId);
  } else if (get(ctx.db, 'SELECT 1 FROM titles WHERE id = ? AND seasons_group_id IS NULL', titleId)) {
    const seasons = await findSeasonsGroup(ctx, tv);
    if (seasons) await importSeasonsGroup(ctx, titleId, seasons);
    else markOfficialSeasons(ctx.db, titleId);
  }
  setSourceDir(ctx.db, dirRel, titleId, seasonNumber, rootId);
  return { status: 'matched', titleId, seasonNumber };
}

// Throws when TMDB cannot be reached; the caller decides how to degrade. T74: `force` skips the known-folder
// shortcut and matches again from scratch, so a mapping stored by an older resolver can be corrected.
export async function assignSeries(
  ctx: IngestContext,
  dirRel: string,
  folder: string,
  rootId = 1,
  opts: { force?: boolean } = {},
): Promise<Assignment> {
  const known = get<{ title_id: number; season_number: number | null }>(
    ctx.db,
    'SELECT title_id, season_number FROM source_dirs WHERE root_id = ? AND path = ?',
    rootId,
    dirRel,
  );
  if (known && !opts.force) return { status: 'matched', titleId: known.title_id, seasonNumber: known.season_number };
  const found = await matchSeries(ctx, folder);
  if ('candidates' in found) return { status: 'no_match', candidates: found.candidates };
  return adoptSeries(ctx, dirRel, found.tv, found.group, undefined, rootId);
}

function locateAbsolute(
  seasons: { season_number: number; episode_count: number }[],
  n: number,
): { season: number; episode: number } | null {
  let rest = n;
  const regular = seasons.filter((s) => s.season_number > 0).sort((a, b) => a.season_number - b.season_number);
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
  const title = get<{ tmdb_id: number | null; seasons_group_id: string | null }>(
    ctx.db,
    'SELECT tmdb_id, seasons_group_id FROM titles WHERE id = ?',
    titleId,
  );
  if (!title) return null;
  if (title.tmdb_id === null) return ensureLocalEpisode(ctx.db, titleId, seasonNumber ?? parsed.season ?? 1, parsed.number);
  if (seasonNumber !== null) return findEpisodeId(ctx.db, titleId, seasonNumber, parsed.number);

  if (title.seasons_group_id) {
    // All the group's seasons are already stored; nothing is imported on demand from the official ones.
    const stored = all<{ season_number: number; episode_count: number }>(
      ctx.db,
      `SELECT s.number AS season_number, COUNT(e.id) AS episode_count FROM seasons s
       LEFT JOIN episodes e ON e.season_id = s.id WHERE s.title_id = ? GROUP BY s.id`,
      titleId,
    );
    const at = parsed.season !== null ? { season: parsed.season, episode: parsed.number } : locateAbsolute(stored, parsed.number);
    return at ? findEpisodeId(ctx.db, titleId, at.season, at.episode) : null;
  }

  const target =
    parsed.season !== null
      ? { season: parsed.season, episode: parsed.number }
      : locateAbsolute((await ctx.tmdb.tv(title.tmdb_id)).seasons, parsed.number);
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
  return { status: 'no_match', candidates: results.slice(0, MAX_CANDIDATES).map((r) => toCandidate(r, 'movie')) };
}
