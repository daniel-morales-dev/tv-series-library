import type { DatabaseSync } from 'node:sqlite';
import { all, get, run, transaction } from '../../db/sql.ts';

export interface ClaimedJob {
  id: number;
  mediaFileId: number;
  path: string;
  durationS: number | null;
}

export interface JobView {
  id: number;
  mediaFileId: number;
  path: string;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessResult {
  /** Relative to DATA_DIR. */
  hlsDir: string;
  audio: unknown[];
  subtitles: unknown[];
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const RECENT_FINISHED = 50;

// Queues one process job for a file; an active (queued or running) job is reused.
export function enqueue(db: DatabaseSync, mediaFileId: number): number {
  return transaction(db, () => {
    const active = get<{ id: number }>(
      db,
      "SELECT id FROM jobs WHERE type = 'process' AND media_file_id = ? AND status IN ('queued', 'running')",
      mediaFileId,
    );
    if (active) return active.id;
    run(db, "UPDATE media_files SET status = 'pending', error = NULL WHERE id = ?", mediaFileId);
    return run(db, "INSERT INTO jobs (type, media_file_id) VALUES ('process', ?)", mediaFileId).lastInsertId;
  });
}

// After a restart: interrupted work goes back to the queue and pending files without a job get one.
export function recover(db: DatabaseSync): void {
  transaction(db, () => {
    run(db, `UPDATE jobs SET status = 'queued', progress = 0, updated_at = ${NOW} WHERE type = 'process' AND status = 'running'`);
    run(db, "UPDATE media_files SET status = 'pending' WHERE status = 'processing'");
    run(
      db,
      `INSERT INTO jobs (type, media_file_id)
       SELECT 'process', id FROM media_files m WHERE status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.media_file_id = m.id AND j.type = 'process' AND j.status IN ('queued', 'running'))`,
    );
  });
}

// Episodes and movies before extras, then oldest first.
export function claimNext(db: DatabaseSync): ClaimedJob | undefined {
  return transaction(db, () => {
    const row = get<{ id: number; media_file_id: number; path: string; duration_s: number | null }>(
      db,
      `SELECT j.id, j.media_file_id, m.path, m.duration_s FROM jobs j JOIN media_files m ON m.id = j.media_file_id
       WHERE j.type = 'process' AND j.status = 'queued'
       ORDER BY (m.extra_label IS NOT NULL), j.id LIMIT 1`,
    );
    if (!row) return undefined;
    run(db, `UPDATE jobs SET status = 'running', progress = 0, error = NULL, updated_at = ${NOW} WHERE id = ?`, row.id);
    run(db, "UPDATE media_files SET status = 'processing', error = NULL WHERE id = ?", row.media_file_id);
    return { id: row.id, mediaFileId: row.media_file_id, path: row.path, durationS: row.duration_s };
  });
}

export function setProgress(db: DatabaseSync, jobId: number, progress: number): void {
  run(db, `UPDATE jobs SET progress = ?, updated_at = ${NOW} WHERE id = ?`, progress, jobId);
}

export function complete(db: DatabaseSync, job: ClaimedJob, result: ProcessResult): void {
  transaction(db, () => {
    run(db, `UPDATE jobs SET status = 'done', progress = 1, error = NULL, updated_at = ${NOW} WHERE id = ?`, job.id);
    run(
      db,
      "UPDATE media_files SET status = 'ready', hls_dir = ?, audio_tracks = ?, subtitle_tracks = ?, error = NULL WHERE id = ?",
      result.hlsDir,
      JSON.stringify(result.audio),
      JSON.stringify(result.subtitles),
      job.mediaFileId,
    );
  });
}

export function fail(db: DatabaseSync, job: ClaimedJob, message: string): void {
  transaction(db, () => {
    run(db, `UPDATE jobs SET status = 'error', error = ?, updated_at = ${NOW} WHERE id = ?`, message, job.id);
    run(db, "UPDATE media_files SET status = 'error', error = ? WHERE id = ?", message, job.mediaFileId);
  });
}

// Active jobs first (running, then queued in run order), then the most recent finished ones.
export function listJobs(db: DatabaseSync): JobView[] {
  const view = (j: Record<string, unknown>): JobView => ({
    id: j.id as number,
    mediaFileId: j.media_file_id as number,
    path: j.path as string,
    status: j.status as JobView['status'],
    progress: j.progress as number,
    error: j.error as string | null,
    createdAt: j.created_at as string,
    updatedAt: j.updated_at as string,
  });
  const cols = 'j.id, j.media_file_id, m.path, j.status, j.progress, j.error, j.created_at, j.updated_at';
  const active = all<Record<string, unknown>>(
    db,
    `SELECT ${cols} FROM jobs j JOIN media_files m ON m.id = j.media_file_id
     WHERE j.type = 'process' AND j.status IN ('running', 'queued')
     ORDER BY (j.status = 'queued'), (m.extra_label IS NOT NULL), j.id`,
  );
  const finished = all<Record<string, unknown>>(
    db,
    `SELECT ${cols} FROM jobs j JOIN media_files m ON m.id = j.media_file_id
     WHERE j.type = 'process' AND j.status IN ('done', 'error') ORDER BY j.updated_at DESC, j.id DESC LIMIT ?`,
    RECENT_FINISHED,
  );
  return [...active, ...finished].map(view);
}
