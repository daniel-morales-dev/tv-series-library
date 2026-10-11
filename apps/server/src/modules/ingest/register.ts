import type { DatabaseSync } from 'node:sqlite';
import { all, get, run } from '../../db/sql.ts';
import { type Candidate, placeEpisode } from './assign.ts';
import type { IngestContext } from './metadata.ts';
import { type Parsed, parsePath } from './parser.ts';
import type { ProbeResult } from './probe.ts';
import { showDirKey } from './scanner.ts';
import { saveChapters } from '../catalog/chapters.ts';
import { enqueue } from '../processing/queue.ts';

export type PendingReason = 'unparsed' | 'no_match' | 'unmapped_episode';

export interface FileFacts {
  rel: string;
  size: number;
  /** T70: file mtime in ms; null when unknown (a confirmed pending file) and backfilled by the next scan. */
  mtimeMs?: number | null;
  probe: ProbeResult;
  /** Content identity computed by the ingestor; null when the file could not be read. */
  fingerprint?: string | null;
}

// A registered file starts 'pending' with a queued process job that turns it into HLS.
export function registerFile(
  db: DatabaseSync,
  f: FileFacts,
  placement: Placement,
  rootId = 1,
): void {
  const { lastInsertId } = run(
    db,
    `INSERT INTO media_files (root_id, path, size, fingerprint, mtime_ms, title_id, episode_id, extra_label, status, duration_s,
       audio_tracks, subtitle_tracks, parsed_season, parsed_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    rootId,
    f.rel,
    f.size,
    f.fingerprint ?? null,
    f.mtimeMs ?? null,
    placement.titleId,
    placement.episodeId,
    placement.extraLabel,
    f.probe.durationS,
    JSON.stringify(f.probe.audio),
    JSON.stringify(f.probe.subtitles),
    placement.parsedSeason,
    placement.parsedNumber,
  );
  if (f.probe.chapters) saveChapters(db, lastInsertId, f.probe.chapters);
  enqueue(db, lastInsertId);
}

export interface Placement {
  titleId: number;
  episodeId: number | null;
  extraLabel: string | null;
  parsedSeason: number | null;
  parsedNumber: number | null;
}

// A placed file whose download is not finished: kept out of the queue until it can be probed.
export function registerDownloading(
  db: DatabaseSync,
  rel: string,
  size: number,
  placement: Placement,
  rootId = 1,
  fingerprint: string | null = null,
  mtimeMs: number | null = null,
): void {
  run(
    db,
    `INSERT INTO media_files (root_id, path, size, fingerprint, mtime_ms, title_id, episode_id, extra_label, status, parsed_season, parsed_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'downloading', ?, ?)`,
    rootId,
    rel,
    size,
    fingerprint,
    mtimeMs,
    placement.titleId,
    placement.episodeId,
    placement.extraLabel,
    placement.parsedSeason,
    placement.parsedNumber,
  );
}

// The status is set here (not only by `enqueue`): a stale queued job from before a replacement is reused by
// `enqueue` without touching the row, and a row left 'downloading' would never be claimed.
export function promoteDownload(db: DatabaseSync, id: number, size: number, probe: ProbeResult, mtimeMs: number | null = null): void {
  run(
    db,
    "UPDATE media_files SET status = 'pending', size = ?, mtime_ms = ?, duration_s = ?, audio_tracks = ?, subtitle_tracks = ? WHERE id = ?",
    size,
    mtimeMs,
    probe.durationS,
    JSON.stringify(probe.audio),
    JSON.stringify(probe.subtitles),
    id,
  );
  if (probe.chapters) saveChapters(db, id, probe.chapters);
  enqueue(db, id);
}

export function addPending(
  db: DatabaseSync,
  rel: string,
  size: number | null,
  parsed: Parsed,
  reason: PendingReason,
  candidates: Candidate[] = [],
  rootId = 1,
): void {
  run(
    db,
    'INSERT OR IGNORE INTO pending_files (root_id, path, size, parsed, reason, candidates) VALUES (?, ?, ?, ?, ?, ?)',
    rootId,
    rel,
    size,
    JSON.stringify(parsed),
    reason,
    JSON.stringify(candidates),
  );
}

// Re-places a title's episode files from the parsed numbers saved with them. Files whose episode does not
// exist (any more) leave the library and become pending. Throws on network errors, leaving the rest for later.
export async function relinkFiles(ctx: IngestContext, titleId: number): Promise<void> {
  const files = all<{ id: number; root_id: number; path: string; size: number | null; parsed_season: number | null; parsed_number: number }>(
    ctx.db,
    `SELECT id, root_id, path, size, parsed_season, parsed_number FROM media_files
     WHERE title_id = ? AND extra_label IS NULL AND parsed_number IS NOT NULL`,
    titleId,
  );
  for (const f of files) {
    const parsed = parsePath(f.path);
    const show = parsed.kind === 'episode' ? parsed.show : '';
    const dir = get<{ season_number: number | null }>(
      ctx.db,
      'SELECT season_number FROM source_dirs WHERE root_id = ? AND path = ? AND title_id = ?',
      f.root_id,
      showDirKey(f.path, show),
      titleId,
    );
    const episodeId = await placeEpisode(ctx, titleId, dir?.season_number ?? null, {
      season: f.parsed_season,
      number: f.parsed_number,
    });
    if (episodeId !== null) {
      run(ctx.db, 'UPDATE media_files SET episode_id = ? WHERE id = ?', episodeId, f.id);
    } else {
      run(ctx.db, 'DELETE FROM media_files WHERE id = ?', f.id);
      addPending(ctx.db, f.path, f.size, parsed, 'unmapped_episode', [], f.root_id);
    }
  }
}
