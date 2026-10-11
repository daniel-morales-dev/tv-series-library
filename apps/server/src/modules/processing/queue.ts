import type { DatabaseSync } from 'node:sqlite';
import { all, get, run, transaction } from '../../db/sql.ts';

export interface ClaimedJob {
  id: number;
  mediaFileId: number;
  path: string;
  durationS: number | null;
  /** Imported/queued without a play request and without a package: a copy-mode file may stay unpackaged (T47c). */
  lazyEligible?: boolean;
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

export interface ProcessTracks {
  audio: unknown[];
  subtitles: unknown[];
}

export interface ProcessResult extends ProcessTracks {
  /** Relative to DATA_DIR; null when a copy-mode package was deferred until the first play. */
  hlsDir: string | null;
  mode?: 'copy' | 'x264';
  /** Size of the published package. */
  bytes?: number;
}

export interface SpawnedProcess {
  pid: number;
  /** Field 22 of /proc/<pid>/stat: tells the process apart from a later one that reuses the pid. */
  pidStart: number;
  planHash: string;
}

export interface RunningProcessJob extends ClaimedJob, Omit<SpawnedProcess, 'planHash'> {
  planHash: string | null;
}

const CLEAR_PROCESS = 'pid = NULL, pid_start = NULL, plan_hash = NULL';
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const RECENT_FINISHED = 50;

// Queues one process job for a file; an active (queued or running) job is reused.
// `prioritized` puts it ahead of every other active job (the latest request wins).
export function enqueue(db: DatabaseSync, mediaFileId: number, prioritized = false): number {
  return transaction(db, () => {
    const priority = prioritized
      ? get<{ p: number }>(db, "SELECT COALESCE(MAX(priority), 0) + 1 AS p FROM jobs WHERE status IN ('queued', 'running')")!.p
      : 0;
    const active = get<{ id: number }>(
      db,
      "SELECT id FROM jobs WHERE type = 'process' AND media_file_id = ? AND status IN ('queued', 'running')",
      mediaFileId,
    );
    if (active) {
      if (prioritized) run(db, 'UPDATE jobs SET priority = ? WHERE id = ?', priority, active.id);
      return active.id;
    }
    run(db, "UPDATE media_files SET status = 'pending', error = NULL WHERE id = ?", mediaFileId);
    return run(db, "INSERT INTO jobs (type, media_file_id, priority) VALUES ('process', ?, ?)", mediaFileId, priority).lastInsertId;
  });
}

// A preempted job goes back to the queue (not to error) and starts over later.
export function requeue(db: DatabaseSync, job: ClaimedJob): void {
  transaction(db, () => {
    run(db, `UPDATE jobs SET status = 'queued', progress = 0, ${CLEAR_PROCESS}, updated_at = ${NOW} WHERE id = ?`, job.id);
    run(db, "UPDATE media_files SET status = 'pending' WHERE id = ?", job.mediaFileId);
  });
}

// After a restart: interrupted work goes back to the queue and pending files without a job get one.
// `adopted` are running jobs whose ffmpeg survived: they keep their state and progress.
export function recover(db: DatabaseSync, adopted: ReadonlySet<number> = new Set()): void {
  transaction(db, () => {
    const ids = [...adopted];
    const marks = ids.map(() => '?').join(',');
    run(
      db,
      `UPDATE jobs SET status = 'queued', progress = 0, ${CLEAR_PROCESS}, updated_at = ${NOW}
       WHERE type = 'process' AND status = 'running' AND id NOT IN (${marks})`,
      ...ids,
    );
    run(
      db,
      `UPDATE media_files SET status = 'pending'
       WHERE status = 'processing' AND id NOT IN (SELECT media_file_id FROM jobs WHERE id IN (${marks}))`,
      ...ids,
    );
    run(
      db,
      `INSERT INTO jobs (type, media_file_id)
       SELECT 'process', id FROM media_files m WHERE status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.media_file_id = m.id AND j.type = 'process' AND j.status IN ('queued', 'running'))`,
    );
  });
}

// T33: a transient pipeline bug leaves files in error; each server start gives them one bounded retry.
// Same shape as recover: insert a job for every error row without an active one, then move it to pending.
export function requeueErrors(db: DatabaseSync): void {
  transaction(db, () => {
    run(
      db,
      `INSERT INTO jobs (type, media_file_id)
       SELECT 'process', id FROM media_files m WHERE status = 'error'
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.media_file_id = m.id AND j.type = 'process' AND j.status IN ('queued', 'running'))`,
    );
    run(db, "UPDATE media_files SET status = 'pending' WHERE status = 'error'");
  });
}

// Requested-to-play first, then episodes and movies before extras, then oldest first.
export function claimNext(db: DatabaseSync): ClaimedJob | undefined {
  return transaction(db, () => {
    const row = get<{ id: number; media_file_id: number; path: string; duration_s: number | null; priority: number; hls_dir: string | null }>(
      db,
      `SELECT j.id, j.media_file_id, m.path, m.duration_s, j.priority, m.hls_dir FROM jobs j JOIN media_files m ON m.id = j.media_file_id
       WHERE j.type = 'process' AND j.status = 'queued'
       ORDER BY j.priority DESC, (m.extra_label IS NOT NULL), j.id LIMIT 1`,
    );
    if (!row) return undefined;
    run(db, `UPDATE jobs SET status = 'running', progress = 0, error = NULL, ${CLEAR_PROCESS}, updated_at = ${NOW} WHERE id = ?`, row.id);
    run(db, "UPDATE media_files SET status = 'processing', error = NULL WHERE id = ?", row.media_file_id);
    return {
      id: row.id,
      mediaFileId: row.media_file_id,
      path: row.path,
      durationS: row.duration_s,
      lazyEligible: row.priority === 0 && row.hls_dir === null,
    };
  });
}

// T21: a play request waiting for a slot; only then is the extra play slot (jobs + 1) worth granting.
export function hasPrioritizedQueued(db: DatabaseSync): boolean {
  return get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM jobs WHERE type = 'process' AND status = 'queued' AND priority > 0")!.n > 0;
}

export function setSpawned(db: DatabaseSync, jobId: number, p: SpawnedProcess): void {
  run(db, 'UPDATE jobs SET pid = ?, pid_start = ?, plan_hash = ? WHERE id = ?', p.pid, p.pidStart, p.planHash, jobId);
}

export function runningWithProcess(db: DatabaseSync): RunningProcessJob[] {
  return all<Record<string, unknown>>(
    db,
    `SELECT j.id, j.media_file_id, m.path, m.duration_s, j.pid, j.pid_start, j.plan_hash FROM jobs j JOIN media_files m ON m.id = j.media_file_id
     WHERE j.type = 'process' AND j.status = 'running' AND j.pid IS NOT NULL AND j.pid_start IS NOT NULL ORDER BY j.id`,
  ).map((r) => ({
    id: r.id as number,
    mediaFileId: r.media_file_id as number,
    path: r.path as string,
    durationS: r.duration_s as number | null,
    pid: r.pid as number,
    pidStart: r.pid_start as number,
    planHash: r.plan_hash as string | null,
  }));
}

export function setProgress(db: DatabaseSync, jobId: number, progress: number): void {
  run(db, `UPDATE jobs SET progress = ?, updated_at = ${NOW} WHERE id = ?`, progress, jobId);
}

// Track outputs are known once subtitles are extracted, long before the video finishes.
export function setTracks(db: DatabaseSync, job: ClaimedJob, tracks: ProcessTracks): void {
  run(
    db,
    'UPDATE media_files SET audio_tracks = ?, subtitle_tracks = ? WHERE id = ?',
    JSON.stringify(tracks.audio),
    JSON.stringify(tracks.subtitles),
    job.mediaFileId,
  );
}

export function complete(db: DatabaseSync, job: ClaimedJob, result: ProcessResult): void {
  transaction(db, () => {
    run(db, `UPDATE jobs SET status = 'done', progress = 1, error = NULL, ${CLEAR_PROCESS}, updated_at = ${NOW} WHERE id = ?`, job.id);
    run(
      db,
      `UPDATE media_files SET status = 'ready', hls_dir = ?, audio_tracks = ?, subtitle_tracks = ?, error = NULL,
         pkg_mode = COALESCE(?, pkg_mode), pkg_bytes = ?,
         last_played_at = CASE WHEN ? IS NULL THEN last_played_at ELSE ${NOW} END WHERE id = ?`,
      result.hlsDir,
      JSON.stringify(result.audio),
      JSON.stringify(result.subtitles),
      result.mode ?? null,
      result.bytes ?? null,
      result.hlsDir,
      job.mediaFileId,
    );
  });
}

export function fail(db: DatabaseSync, job: ClaimedJob, message: string): void {
  transaction(db, () => {
    run(db, `UPDATE jobs SET status = 'error', error = ?, ${CLEAR_PROCESS}, updated_at = ${NOW} WHERE id = ?`, message, job.id);
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
     ORDER BY (j.status = 'queued'), j.priority DESC, (m.extra_label IS NOT NULL), j.id`,
  );
  const finished = all<Record<string, unknown>>(
    db,
    `SELECT ${cols} FROM jobs j JOIN media_files m ON m.id = j.media_file_id
     WHERE j.type = 'process' AND j.status IN ('done', 'error') ORDER BY j.updated_at DESC, j.id DESC LIMIT ?`,
    RECENT_FINISHED,
  );
  return [...active, ...finished].map(view);
}
