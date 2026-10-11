import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { all, get } from '../../db/sql.ts';
import { sanitizeVttFile } from '../processing/vtt.ts';

export interface ReprocessSubtitlesInput {
  db: DatabaseSync;
  hlsDir: string;
  /** Only this media file; omitted = every ready package. */
  mediaFileId?: number;
}

/** Rewrites every `subs/*.vtt` of the selected ready packages in place; packages without vtts are skipped. */
export async function reprocessSubtitles({ db, hlsDir, mediaFileId }: ReprocessSubtitlesInput): Promise<{ checked: number; fixed: number } | null> {
  let dirs: string[];
  if (mediaFileId === undefined) {
    dirs = all<{ hls_dir: string }>(db, "SELECT hls_dir FROM media_files WHERE status = 'ready' AND hls_dir IS NOT NULL").map((r) => r.hls_dir);
  } else {
    const row = get<{ status: string; hls_dir: string | null }>(db, 'SELECT status, hls_dir FROM media_files WHERE id = ?', mediaFileId);
    if (!row) return null; // the route answers 404
    dirs = row.status === 'ready' && row.hls_dir !== null ? [row.hls_dir] : [];
  }

  const root = resolve(hlsDir);
  let checked = 0;
  let fixed = 0;
  for (const dir of dirs) {
    // `media_files.hls_dir` is always `hls/<id>`; only its last segment locates the folder (same rule as the cache).
    const subs = join(root, basename(dir), 'subs');
    for (const entry of await readdir(subs, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith('.vtt')) continue;
      checked++;
      if (await sanitizeVttFile(join(subs, entry.name))) fixed++;
    }
  }
  return { checked, fixed };
}
