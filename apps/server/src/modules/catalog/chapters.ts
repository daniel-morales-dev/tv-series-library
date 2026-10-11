import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { all, run, transaction } from '../../db/sql.ts';
import { ffprobeBin } from '../processing/ffmpeg.ts';

const execFileAsync = promisify(execFile);

export interface Chapter {
  startS: number;
  endS: number;
  title: string | null;
}

export type ProbeChapters = (absPath: string) => Promise<Chapter[]>;

interface FfprobeChapter {
  start_time?: string;
  end_time?: string;
  tags?: { title?: string };
}

// Takes the parsed `ffprobe -show_chapters` JSON; ranges that are not finite or not forward are dropped.
export function parseChapters(data: { chapters?: FfprobeChapter[] }): Chapter[] {
  return (data.chapters ?? []).flatMap((c) => {
    const startS = Number(c.start_time);
    const endS = Number(c.end_time);
    return Number.isFinite(startS) && Number.isFinite(endS) && endS > startS ? [{ startS, endS, title: c.tags?.title ?? null }] : [];
  });
}

export const probeChapters: ProbeChapters = async (absPath) => {
  const { stdout } = await execFileAsync(ffprobeBin(), ['-v', 'error', '-print_format', 'json', '-show_chapters', absPath], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
  });
  return parseChapters(JSON.parse(stdout));
};

export function saveChapters(db: DatabaseSync, mediaFileId: number, chapters: Chapter[]): void {
  transaction(db, () => {
    run(db, 'DELETE FROM media_chapters WHERE media_file_id = ?', mediaFileId);
    chapters.forEach((c, i) =>
      run(db, 'INSERT INTO media_chapters (media_file_id, idx, start_s, end_s, title) VALUES (?, ?, ?, ?, ?)', mediaFileId, i, c.startS, c.endS, c.title),
    );
    run(db, 'UPDATE media_files SET chapters_checked = 1 WHERE id = ?', mediaFileId);
  });
}

export const loadChapters = (db: DatabaseSync, mediaFileId: number): Chapter[] =>
  all<{ start_s: number; end_s: number; title: string | null }>(
    db,
    'SELECT start_s, end_s, title FROM media_chapters WHERE media_file_id = ? ORDER BY idx',
    mediaFileId,
  ).map((c) => ({ startS: c.start_s, endS: c.end_s, title: c.title }));
