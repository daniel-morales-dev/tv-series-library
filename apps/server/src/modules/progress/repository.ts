import type { DatabaseSync } from 'node:sqlite';
import { all, get, run } from '../../db/sql.ts';
import { SUMMARY_COLUMNS, toSummary } from '../catalog/repository.ts';
import { isCompleted, resolveContinueTarget, type PlayableFile } from './rules.ts';

const now = () => new Date().toISOString();

export function mediaFileExists(db: DatabaseSync, id: number): boolean {
  return get(db, 'SELECT 1 AS x FROM media_files WHERE id = ?', id) !== undefined;
}

export function saveProgress(db: DatabaseSync, profileId: number, mediaFileId: number, positionS: number, durationS: number) {
  const at = now();
  const file = get<{ title_id: number }>(db, 'SELECT title_id FROM media_files WHERE id = ?', mediaFileId)!;
  db.exec('BEGIN');
  try {
    run(
      db,
      `INSERT INTO watch_progress (profile_id, media_file_id, position_s, duration_s, completed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (profile_id, media_file_id) DO UPDATE SET
         position_s = excluded.position_s, duration_s = excluded.duration_s,
         completed = excluded.completed, updated_at = excluded.updated_at`,
      profileId,
      mediaFileId,
      positionS,
      durationS,
      isCompleted(positionS, durationS) ? 1 : 0,
      at,
    );
    // New progress brings a hidden title back into "continue watching".
    run(
      db,
      `INSERT INTO title_state (profile_id, title_id, hidden_from_continue, finished, updated_at) VALUES (?, ?, 0, 0, ?)
       ON CONFLICT (profile_id, title_id) DO UPDATE SET hidden_from_continue = 0, updated_at = excluded.updated_at`,
      profileId,
      file.title_id,
      at,
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function hideFromContinue(db: DatabaseSync, profileId: number, titleId: number): void {
  run(
    db,
    `INSERT INTO title_state (profile_id, title_id, hidden_from_continue, finished, updated_at) VALUES (?, ?, 1, 0, ?)
     ON CONFLICT (profile_id, title_id) DO UPDATE SET hidden_from_continue = 1, updated_at = excluded.updated_at`,
    profileId,
    titleId,
    now(),
  );
}

export function setFinished(db: DatabaseSync, profileId: number, titleId: number, finished: boolean): void {
  const at = now();
  db.exec('BEGIN');
  try {
    run(
      db,
      `INSERT INTO title_state (profile_id, title_id, hidden_from_continue, finished, updated_at) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT (profile_id, title_id) DO UPDATE SET finished = excluded.finished, updated_at = excluded.updated_at`,
      profileId,
      titleId,
      finished ? 1 : 0,
      at,
    );
    if (finished) {
      run(
        db,
        `INSERT INTO watch_progress (profile_id, media_file_id, position_s, duration_s, completed, updated_at)
         SELECT ?, id, COALESCE(duration_s, 0), COALESCE(duration_s, 0), 1, ? FROM media_files WHERE title_id = ?
         ON CONFLICT (profile_id, media_file_id) DO UPDATE SET completed = 1, updated_at = excluded.updated_at`,
        profileId,
        at,
        titleId,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

interface FileRow {
  id: number;
  extra_label: string | null;
  duration_s: number | null;
  season_number: number | null;
  episode_number: number | null;
  episode_name: string | null;
  completed: number | null;
  position_s: number | null;
}

export function listContinueWatching(db: DatabaseSync, profileId: number) {
  const latest = all<Record<string, any>>(
    db,
    `SELECT * FROM (
       SELECT mf.title_id, wp.media_file_id, wp.position_s, wp.completed, wp.updated_at,
         ROW_NUMBER() OVER (PARTITION BY mf.title_id ORDER BY wp.updated_at DESC, wp.rowid DESC) AS rn
       FROM watch_progress wp
       JOIN media_files mf ON mf.id = wp.media_file_id
       LEFT JOIN title_state ts ON ts.profile_id = wp.profile_id AND ts.title_id = mf.title_id
       WHERE wp.profile_id = ? AND COALESCE(ts.hidden_from_continue, 0) = 0 AND COALESCE(ts.finished, 0) = 0
     ) WHERE rn = 1`,
    profileId,
  );

  const items = [];
  for (const l of latest) {
    const files = all<FileRow>(
      db,
      `SELECT mf.id, mf.extra_label, mf.duration_s, s.number AS season_number, e.number AS episode_number,
         e.name AS episode_name, wp.completed, wp.position_s
       FROM media_files mf
       LEFT JOIN episodes e ON e.id = mf.episode_id
       LEFT JOIN seasons s ON s.id = e.season_id
       LEFT JOIN watch_progress wp ON wp.media_file_id = mf.id AND wp.profile_id = ?
       WHERE mf.title_id = ? AND mf.status = 'ready'
       ORDER BY s.number, e.number, mf.id`,
      profileId,
      l.title_id,
    );
    const ordered: PlayableFile[] = files
      .filter((f) => f.extra_label === null)
      .map((f) => ({ mediaFileId: f.id, completed: f.completed === 1, positionS: f.position_s ?? 0 }));
    const target = resolveContinueTarget(
      { mediaFileId: l.media_file_id, positionS: l.position_s, completed: l.completed === 1 },
      ordered,
    );
    const file = target && files.find((f) => f.id === target.mediaFileId);
    if (!target || !file) continue;
    const title = get<Record<string, any>>(db, `SELECT ${SUMMARY_COLUMNS} FROM titles t WHERE t.id = ?`, l.title_id)!;
    items.push({
      title: toSummary(title),
      mediaFileId: target.mediaFileId,
      positionS: target.positionS,
      durationS: file.duration_s,
      season: file.season_number,
      episode: file.episode_number,
      episodeName: file.episode_name,
      updatedAt: l.updated_at as string,
    });
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
