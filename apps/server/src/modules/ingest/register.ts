import type { DatabaseSync } from 'node:sqlite';
import { all, get, run } from '../../db/sql.ts';
import { type Candidate, placeEpisode } from './assign.ts';
import type { IngestContext } from './metadata.ts';
import { type Parsed, parsePath } from './parser.ts';
import type { ProbeResult } from './probe.ts';
import { showDirKey } from './scanner.ts';
import { enqueue } from '../processing/queue.ts';

export type PendingReason = 'unparsed' | 'no_match' | 'unmapped_episode';

export interface FileFacts {
  rel: string;
  size: number;
  probe: ProbeResult;
}

// A registered file starts 'pending' with a queued process job that turns it into HLS.
export function registerFile(
  db: DatabaseSync,
  f: FileFacts,
  placement: { titleId: number; episodeId: number | null; extraLabel: string | null; parsedSeason: number | null; parsedNumber: number | null },
): void {
  const { lastInsertId } = run(
    db,
    `INSERT INTO media_files (path, size, title_id, episode_id, extra_label, status, duration_s, audio_tracks,
       subtitle_tracks, parsed_season, parsed_number)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    f.rel,
    f.size,
    placement.titleId,
    placement.episodeId,
    placement.extraLabel,
    f.probe.durationS,
    JSON.stringify(f.probe.audio),
    JSON.stringify(f.probe.subtitles),
    placement.parsedSeason,
    placement.parsedNumber,
  );
  enqueue(db, lastInsertId);
}

export function addPending(
  db: DatabaseSync,
  rel: string,
  size: number | null,
  parsed: Parsed,
  reason: PendingReason,
  candidates: Candidate[] = [],
): void {
  run(
    db,
    'INSERT OR IGNORE INTO pending_files (path, size, parsed, reason, candidates) VALUES (?, ?, ?, ?, ?)',
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
  const files = all<{ id: number; path: string; size: number | null; parsed_season: number | null; parsed_number: number }>(
    ctx.db,
    `SELECT id, path, size, parsed_season, parsed_number FROM media_files
     WHERE title_id = ? AND extra_label IS NULL AND parsed_number IS NOT NULL`,
    titleId,
  );
  for (const f of files) {
    const parsed = parsePath(f.path);
    const show = parsed.kind === 'episode' ? parsed.show : '';
    const dir = get<{ season_number: number | null }>(
      ctx.db,
      'SELECT season_number FROM source_dirs WHERE path = ? AND title_id = ?',
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
      addPending(ctx.db, f.path, f.size, parsed, 'unmapped_episode');
    }
  }
}
