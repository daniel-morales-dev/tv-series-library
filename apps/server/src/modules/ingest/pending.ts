import type { DatabaseSync } from 'node:sqlite';
import { all, get, run } from '../../db/sql.ts';
import { ApiError } from '../../http/api-error.ts';
import { type RootDir, sourcePath } from '../../library/roots.ts';
import { FranchiseError, type FranchiseRelation, assertTitleExists, linkFranchise } from '../catalog/franchise.ts';
import { type GroupMatch, adoptSeries, normalize, placeEpisode } from './assign.ts';
import { type IngestContext, importMovie } from './metadata.ts';
import type { Parsed } from './parser.ts';
import type { Probe } from './probe.ts';
import { registerFile } from './register.ts';
import { showDirKey } from './scanner.ts';
import type { EpisodeGroupDetails } from './tmdb.ts';

export class PendingError extends ApiError {}

interface PendingRow {
  id: number;
  root_id: number;
  path: string;
  size: number | null;
  parsed: string;
  reason: string;
  candidates: string;
  created_at: string;
}

export function listPending(db: DatabaseSync) {
  return all<PendingRow>(db, "SELECT * FROM pending_files WHERE status = 'open' ORDER BY created_at, id").map((r) => ({
    id: r.id,
    path: r.path,
    size: r.size,
    parsed: JSON.parse(r.parsed) as Parsed,
    reason: r.reason,
    candidates: JSON.parse(r.candidates) as unknown[],
    createdAt: r.created_at,
  }));
}

export function ignorePending(db: DatabaseSync, id: number): boolean {
  return run(db, "UPDATE pending_files SET status = 'ignored' WHERE id = ? AND status = 'open'", id).changes > 0;
}

export interface ConfirmBody {
  tmdbType: 'tv' | 'movie';
  tmdbId: number;
  episodeGroupId?: string;
  season?: number;
  episode?: number;
  extraLabel?: string;
  franchiseOfTitleId?: number;
  franchiseRelation?: FranchiseRelation;
}

export interface ConfirmDeps {
  ctx: IngestContext;
  probe: Probe;
  contentDir: RootDir;
}

interface Placement {
  episodeId: number | null;
  extraLabel: string | null;
  parsedSeason: number | null;
  parsedNumber: number | null;
}

// The folder a pending file belongs to (the key used in source_dirs).
function dirOf(path: string, parsed: Parsed): string {
  if (parsed.kind === 'episode' || parsed.kind === 'extra') return showDirKey(path, parsed.show);
  const parts = path.split('/');
  return parts.length >= 3 ? parts.slice(0, 2).join('/') : path;
}

function pickGroup(detail: EpisodeGroupDetails, folder: string, season?: number): GroupMatch {
  const wanted = normalize(folder);
  let index = detail.groups.findIndex((g) => normalize(g.name) === wanted);
  if (index < 0 && season !== undefined) index = detail.groups.findIndex((g) => g.order === season);
  if (index < 0 && detail.groups.length === 1) index = 0;
  if (index < 0) throw new PendingError(400, 'group_ambiguous');
  const group = detail.groups[index]!;
  return { episodeGroupId: detail.id, seasonNumber: group.order > 0 ? group.order : index + 1, group };
}

async function place(
  ctx: IngestContext,
  titleId: number,
  seasonNumber: number | null,
  parsed: Parsed,
  o: { season?: number; episode?: number; extraLabel?: string },
): Promise<Placement | null> {
  const none = { episodeId: null, parsedSeason: null, parsedNumber: null };
  if (o.extraLabel) return { ...none, extraLabel: o.extraLabel };
  if (parsed.kind === 'extra' && o.episode === undefined) return { ...none, extraLabel: parsed.label };
  const number = o.episode ?? (parsed.kind === 'episode' ? parsed.number : undefined);
  if (number === undefined) return null;
  const season = o.season ?? (parsed.kind === 'episode' ? parsed.season : null);
  const episodeId =
    o.season !== undefined
      ? await placeEpisode(ctx, titleId, null, { season: o.season, number })
      : await placeEpisode(ctx, titleId, seasonNumber, { season, number });
  return episodeId === null ? null : { episodeId, extraLabel: null, parsedSeason: season, parsedNumber: number };
}

async function registerPending(deps: ConfirmDeps, row: PendingRow, titleId: number, placement: Placement): Promise<void> {
  const probe = await deps.probe(sourcePath(deps.contentDir, row.root_id, row.path)).catch(() => null);
  if (!probe) throw new PendingError(409, 'file_unreadable');
  registerFile(deps.ctx.db, { rel: row.path, size: row.size ?? 0, probe }, { titleId, ...placement }, row.root_id);
  run(deps.ctx.db, 'DELETE FROM pending_files WHERE id = ?', row.id);
}

function joinFranchise(deps: ConfirmDeps, titleId: number, body: ConfirmBody): void {
  if (body.franchiseOfTitleId === undefined || body.franchiseOfTitleId === titleId) return;
  try {
    linkFranchise(deps.ctx.db, titleId, body.franchiseOfTitleId, body.franchiseRelation);
  } catch (err) {
    if (err instanceof FranchiseError) throw new PendingError(err.status, err.code);
    throw err;
  }
}

// Assigns a pending file to the title the user picked. For a series, the folder is adopted, so its
// other pending files are placed too. Returns how many files left the pending list.
export async function confirmPending(deps: ConfirmDeps, id: number, body: ConfirmBody): Promise<{ titleId: number; placed: number }> {
  const { ctx } = deps;
  const row = get<PendingRow>(ctx.db, "SELECT * FROM pending_files WHERE id = ? AND status = 'open'", id);
  if (!row) throw new PendingError(404, 'not_found');
  const parsed = JSON.parse(row.parsed) as Parsed;
  if (body.franchiseOfTitleId !== undefined) {
    try {
      assertTitleExists(ctx.db, body.franchiseOfTitleId);
    } catch (err) {
      if (err instanceof FranchiseError) throw new PendingError(err.status, err.code);
      throw err;
    }
  }

  if (body.tmdbType === 'movie') {
    const titleId = await importMovie(ctx, await ctx.tmdb.movie(body.tmdbId));
    const extra = body.extraLabel ?? null;
    await registerPending(deps, row, titleId, { episodeId: null, extraLabel: extra, parsedSeason: null, parsedNumber: null });
    joinFranchise(deps, titleId, body);
    return { titleId, placed: 1 };
  }

  const dirRel = dirOf(row.path, parsed);
  const folder = parsed.kind === 'episode' || parsed.kind === 'extra' ? parsed.show : dirRel.split('/').at(-1)!;
  const tv = await ctx.tmdb.tv(body.tmdbId);
  const group = body.episodeGroupId ? pickGroup(await ctx.tmdb.episodeGroup(body.episodeGroupId), folder, body.season) : null;
  const known = get<{ title_id: number; season_number: number | null }>(ctx.db, 'SELECT title_id, season_number FROM source_dirs WHERE root_id = ? AND path = ?', row.root_id, dirRel);
  const sameTitle = known && get(ctx.db, 'SELECT 1 FROM titles WHERE id = ? AND tmdb_type = ? AND tmdb_id = ?', known.title_id, 'tv', body.tmdbId);
  const target =
    sameTitle && !group
      ? { titleId: known.title_id, seasonNumber: known.season_number }
      : await adoptSeries(ctx, dirRel, tv, group, undefined, row.root_id);

  const placement = await place(ctx, target.titleId, target.seasonNumber, parsed, {
    season: group ? undefined : body.season,
    episode: body.episode,
    extraLabel: body.extraLabel,
  });
  if (!placement) throw new PendingError(422, parsed.kind === 'episode' ? 'unmapped_episode' : 'missing_target');
  await registerPending(deps, row, target.titleId, placement);
  joinFranchise(deps, target.titleId, body);

  const placed = 1 + (await placePendingInDir(deps, target.titleId, target.seasonNumber, row.root_id, dirRel));
  return { titleId: target.titleId, placed };
}

// The open pending files of a folder already mapped to a series are placed again; the ones that still do
// not fit stay pending as unmapped. Returns how many left the list. Also run by the title reanalysis.
export async function placePendingInDir(
  deps: ConfirmDeps,
  titleId: number,
  seasonNumber: number | null,
  rootId: number,
  dirRel: string,
): Promise<number> {
  const { ctx } = deps;
  let placed = 0;
  const rows = all<PendingRow>(ctx.db, "SELECT * FROM pending_files WHERE status = 'open' AND root_id = ?", rootId);
  for (const s of rows) {
    const p = JSON.parse(s.parsed) as Parsed;
    if ((p.kind !== 'episode' && p.kind !== 'extra') || dirOf(s.path, p) !== dirRel) continue;
    const sp = await place(ctx, titleId, seasonNumber, p, {});
    if (!sp) {
      run(ctx.db, "UPDATE pending_files SET reason = 'unmapped_episode', candidates = '[]' WHERE id = ?", s.id);
      continue;
    }
    try {
      await registerPending(deps, s, titleId, sp);
      placed++;
    } catch (err) {
      if (!(err instanceof PendingError)) throw err; // unreadable file: stays pending
    }
  }
  return placed;
}
