import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { all, get, run } from '../../db/sql.ts';
import { ApiError } from '../../http/api-error.ts';
import { assignSeries, placeEpisode } from './assign.ts';
import { type IngestContext, MetadataError, findSeasonsGroup, importSeasonsGroup, refreshSeasonAirDates, refreshTitleMetadata } from './metadata.ts';
import { parsePath } from './parser.ts';
import { placePendingInDir } from './pending.ts';
import type { Probe } from './probe.ts';
import { showDirKey } from './scanner.ts';

/** T74: one reanalysis pass, in the shape the API returns it. */
export interface ReanalyzeSummary {
  scanned: number;
  reparsed: number;
  replaced: number;
  missing: number;
  promoted: number;
  placed: number;
  pending: number;
  reseasoned: number;
}

/** The subset of the summary the scan machinery fills while the pass runs. */
export type ScanCounts = Pick<ReanalyzeSummary, 'scanned' | 'missing' | 'replaced' | 'promoted' | 'pending'>;

export const emptyReanalyzeSummary = (): ReanalyzeSummary => ({
  scanned: 0,
  reparsed: 0,
  replaced: 0,
  missing: 0,
  promoted: 0,
  placed: 0,
  pending: 0,
  reseasoned: 0,
});

export class ReanalyzeError extends ApiError {}

export interface ReanalyzeDeps {
  db: DatabaseSync;
  ctx: IngestContext;
  /** Absolute folder of a root: live for root 1, last known path for the rest. */
  rootPath: (rootId: number) => string;
  log: (level: 'info' | 'warn', message: string) => void;
  /** Reads a pending file before it is registered; without it pending files are not retried. */
  probe?: Probe;
}

// T74: every folder mapping is resolved again from scratch. A folder that no longer matches anything keeps
// its old mapping: a wrong re-match would be worse than a stale one.
async function reparseFolders(deps: ReanalyzeDeps, summary: ReanalyzeSummary, titleId?: number): Promise<void> {
  const { db, ctx } = deps;
  const dirScope = titleId === undefined ? '' : ' WHERE title_id = ?';
  const fileScope = titleId === undefined ? '' : ' AND title_id = ?';
  const args = titleId === undefined ? [] : [titleId];
  const dirs = all<{ root_id: number; path: string; title_id: number; season_number: number | null }>(
    db,
    `SELECT root_id, path, title_id, season_number FROM source_dirs${dirScope}`,
    ...args,
  );
  // The stored key is the folder, not the show name used for the search: a file of the folder (or, failing
  // that, its last segment) supplies it back.
  const shows = new Map<string, string>();
  const files = all<{ root_id: number; path: string }>(db, `SELECT root_id, path FROM media_files WHERE parsed_number IS NOT NULL${fileScope}`, ...args);
  for (const f of files) {
    const parsed = parsePath(f.path);
    if (parsed.kind !== 'episode' && parsed.kind !== 'extra') continue;
    const key = `${f.root_id}:${showDirKey(f.path, parsed.show)}`;
    if (!shows.has(key)) shows.set(key, parsed.show);
  }
  for (const dir of dirs) {
    const folder = shows.get(`${dir.root_id}:${dir.path}`) ?? basename(dir.path);
    try {
      const found = await assignSeries(ctx, dir.path, folder, dir.root_id, { force: true });
      if (found.status !== 'matched') continue;
      if (found.titleId !== dir.title_id || found.seasonNumber !== dir.season_number) summary.reparsed++;
    } catch (err) {
      deps.log('warn', `reanalyze: folder not re-resolved, keeping its mapping (${dir.path}): ${(err as Error).message}`);
    }
  }
}

// T84: a title whose seasons come only from TMDB gets the best "Seasons" set recomputed. One with folders
// pinned to a season is left alone: those folders are the structure actually in use.
async function readoptSeasons(deps: ReanalyzeDeps, summary: ReanalyzeSummary, titleId?: number): Promise<void> {
  const { db, ctx } = deps;
  const scope = titleId === undefined ? '' : ' AND id = ?';
  const args = titleId === undefined ? [] : [titleId];
  const titles = all<{ id: number; tmdb_id: number; seasons_group_id: string | null }>(
    db,
    `SELECT id, tmdb_id, seasons_group_id FROM titles WHERE tmdb_type = 'tv' AND tmdb_id IS NOT NULL${scope}`,
    ...args,
  );
  for (const t of titles) {
    if (get(db, 'SELECT 1 AS x FROM source_dirs WHERE title_id = ? AND season_number IS NOT NULL', t.id)) continue;
    let detail;
    try {
      detail = await findSeasonsGroup(ctx, await ctx.tmdb.tv(t.tmdb_id));
    } catch (err) {
      deps.log('warn', `reanalyze: seasons not rechecked for title ${t.id}: ${(err as Error).message}`);
      continue;
    }
    if (!detail || detail.id === t.seasons_group_id) continue;
    // The episode rows are replaced wholesale: files keep their row (id, HLS, progress) and lose only the link.
    run(db, 'UPDATE media_files SET episode_id = NULL WHERE title_id = ?', t.id);
    run(db, 'DELETE FROM seasons WHERE title_id = ?', t.id);
    try {
      await importSeasonsGroup(ctx, t.id, detail);
    } catch (err) {
      deps.log('warn', `reanalyze: seasons not rebuilt for title ${t.id}: ${(err as Error).message}`);
      continue;
    }
    run(db, 'UPDATE titles SET episode_group_id = ? WHERE id = ?', detail.id, t.id);
    summary.reseasoned++;
    deps.log('info', `reanalyze: seasons rebuilt for title ${t.id} from group ${detail.id}`);
  }
}

// T74: every episode file is placed again from its stored parsed numbers and its folder's season. The row
// keeps its id, package and progress; only the episode link moves, and only when it actually changes.
async function replaceFiles(deps: ReanalyzeDeps, summary: ReanalyzeSummary, titleId?: number): Promise<void> {
  const { db, ctx } = deps;
  const scope = titleId === undefined ? '' : ' AND title_id = ?';
  const args = titleId === undefined ? [] : [titleId];
  const files = all<{
    id: number;
    root_id: number;
    path: string;
    title_id: number;
    episode_id: number | null;
    parsed_season: number | null;
    parsed_number: number;
  }>(
    db,
    `SELECT id, root_id, path, title_id, episode_id, parsed_season, parsed_number FROM media_files
     WHERE extra_label IS NULL AND status <> 'missing' AND parsed_number IS NOT NULL${scope}`,
    ...args,
  );
  for (const f of files) {
    const parsed = parsePath(f.path);
    if (parsed.kind !== 'episode') continue;
    const dir = get<{ title_id: number; season_number: number | null }>(
      db,
      'SELECT title_id, season_number FROM source_dirs WHERE root_id = ? AND path = ?',
      f.root_id,
      showDirKey(f.path, parsed.show),
    );
    // The folder is the source of truth for the file it holds.
    const ownerId = dir?.title_id ?? f.title_id;
    let episodeId: number | null;
    try {
      episodeId = await placeEpisode(ctx, ownerId, dir?.season_number ?? null, { season: f.parsed_season, number: f.parsed_number });
    } catch (err) {
      deps.log('warn', `reanalyze: file not re-placed, keeping its episode (${f.path}): ${(err as Error).message}`);
      continue;
    }
    if (episodeId === null) {
      summary.pending++;
      continue;
    }
    if (episodeId !== f.episode_id || ownerId !== f.title_id) {
      run(db, 'UPDATE media_files SET title_id = ?, episode_id = ? WHERE id = ?', ownerId, episodeId, f.id);
      if (episodeId !== f.episode_id) summary.placed++;
    }
  }
}

// Pending files are never retried by a scan, so a fix in the placement rules (or a refreshed season
// structure) only reaches them here: each mapped folder places its open pending files again.
async function retryPending(deps: ReanalyzeDeps, summary: ReanalyzeSummary, titleId?: number): Promise<void> {
  const { db, ctx, probe } = deps;
  if (!probe) return;
  const scope = titleId === undefined ? '' : ' WHERE title_id = ?';
  const dirs = all<{ root_id: number; path: string; title_id: number; season_number: number | null }>(
    db,
    `SELECT root_id, path, title_id, season_number FROM source_dirs${scope}`,
    ...(titleId === undefined ? [] : [titleId]),
  );
  const confirmDeps = { ctx, probe, contentDir: deps.rootPath };
  for (const d of dirs) {
    try {
      summary.placed += await placePendingInDir(confirmDeps, d.title_id, d.season_number, d.root_id, d.path);
    } catch (err) {
      deps.log('warn', `reanalyze: pending files of ${d.path} not retried: ${(err as Error).message}`);
    }
  }
}

/** Steps 2-4 of the full reanalysis: folders, seasons group and placement, for the whole library. */
export async function reanalyzeTitles(deps: ReanalyzeDeps, summary: ReanalyzeSummary): Promise<void> {
  await reparseFolders(deps, summary);
  await readoptSeasons(deps, summary);
  await replaceFiles(deps, summary);
  await retryPending(deps, summary);
}

// T84: one title: its TMDB data is refreshed first (the season structure may have changed), then the same
// three passes as the full reanalysis, scoped to it. A missing link or an unreachable TMDB only logs.
export async function reanalyzeTitle(deps: ReanalyzeDeps, summary: ReanalyzeSummary, titleId: number): Promise<void> {
  if (!get(deps.db, 'SELECT 1 AS x FROM titles WHERE id = ?', titleId)) throw new ReanalyzeError(404, 'not_found');
  try {
    await refreshTitleMetadata(deps.ctx, titleId);
  } catch (err) {
    const reason = err instanceof MetadataError ? err.code : (err as Error).message;
    deps.log('warn', `reanalyze: metadata not refreshed for title ${titleId}: ${reason}`);
  }
  // T86: the button also backfills season air dates on its own, so a failed metadata refresh does not lose them.
  try {
    await refreshSeasonAirDates(deps.ctx, titleId);
  } catch (err) {
    deps.log('warn', `reanalyze: season air dates not refreshed for title ${titleId}: ${(err as Error).message}`);
  }
  summary.scanned = await countFilesOnDisk(deps, titleId);
  await reparseFolders(deps, summary, titleId);
  await readoptSeasons(deps, summary, titleId);
  await replaceFiles(deps, summary, titleId);
  await retryPending(deps, summary, titleId);
}

async function countFilesOnDisk(deps: ReanalyzeDeps, titleId: number): Promise<number> {
  const files = all<{ root_id: number; path: string }>(deps.db, 'SELECT root_id, path FROM media_files WHERE title_id = ?', titleId);
  let onDisk = 0;
  for (const f of files) {
    if (await stat(join(deps.rootPath(f.root_id), f.path)).then(
      () => true,
      () => false,
    ))
      onDisk++;
  }
  return onDisk;
}
