import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/connection.ts';
import { all, get, run } from '../src/db/sql.ts';
import { claimNext, complete, enqueue, recover, requeue, runningWithProcess, setSpawned } from '../src/modules/processing/queue.ts';
import { addFile, addTitle, setup } from './helpers.ts';

describe('migration 006', () => {
  it('adds the process columns to a v5 database copy and keeps its jobs', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const dir = join(import.meta.dirname, '../src/db/migrations');
    for (const f of ['001_init.sql', '002_ingest.sql', '003_job_priority.sql', '004_downloading_status.sql', '005_seasons_group.sql']) {
      db.exec(readFileSync(join(dir, f), 'utf8'));
    }
    db.exec('PRAGMA user_version = 5');
    const title = run(db, "INSERT INTO titles (kind, title) VALUES ('movie', 'x')").lastInsertId;
    const file = run(db, "INSERT INTO media_files (path, title_id, status) VALUES ('a.mkv', ?, 'processing')", title).lastInsertId;
    run(db, "INSERT INTO jobs (type, media_file_id, status, progress) VALUES ('process', ?, 'running', 0.4)", file);

    migrate(db);

    expect(get(db, 'PRAGMA user_version')).toEqual({ user_version: 11 });
    expect(get(db, 'SELECT status, progress, pid, pid_start, plan_hash FROM jobs')).toEqual({
      status: 'running', progress: 0.4, pid: null, pid_start: null, plan_hash: null,
    });
  });
});

describe('process bookkeeping in the queue', () => {
  const running = () => {
    const { db } = setup();
    const f = addFile(db, addTitle(db, 'T'), { status: 'pending' });
    enqueue(db, f);
    const job = claimNext(db)!;
    return { db, f, job };
  };

  it('stores the spawned process and lists running jobs that have one', () => {
    const { db, f, job } = running();
    expect(runningWithProcess(db)).toEqual([]);
    setSpawned(db, job.id, { pid: 4242, pidStart: 99, planHash: 'abc' });
    expect(runningWithProcess(db)).toEqual([
      { id: job.id, mediaFileId: f, path: job.path, durationS: job.durationS, pid: 4242, pidStart: 99, planHash: 'abc' },
    ]);
  });

  it('recover leaves an adopted job running and resets the others', () => {
    const { db, f, job } = running();
    setSpawned(db, job.id, { pid: 1, pidStart: 2, planHash: 'h' });
    const g = addFile(db, addTitle(db, 'U'), { status: 'pending' });
    enqueue(db, g);
    const other = claimNext(db)!;
    db.exec('UPDATE jobs SET progress = 0.4');

    recover(db, new Set([job.id]));

    expect(get(db, 'SELECT status, progress, pid FROM jobs WHERE id = ?', job.id)).toEqual({ status: 'running', progress: 0.4, pid: 1 });
    expect(get(db, 'SELECT status FROM media_files WHERE id = ?', f)).toEqual({ status: 'processing' });
    expect(get(db, 'SELECT status, progress, pid FROM jobs WHERE id = ?', other.id)).toEqual({ status: 'queued', progress: 0, pid: null });
    expect(get(db, 'SELECT status FROM media_files WHERE id = ?', g)).toEqual({ status: 'pending' });
  });

  it('clears the process when the job is requeued or completed', () => {
    const { db, job } = running();
    setSpawned(db, job.id, { pid: 1, pidStart: 2, planHash: 'h' });
    requeue(db, job);
    expect(all(db, 'SELECT pid, pid_start, plan_hash FROM jobs')).toEqual([{ pid: null, pid_start: null, plan_hash: null }]);
    const again = claimNext(db)!;
    setSpawned(db, again.id, { pid: 1, pidStart: 2, planHash: 'h' });
    complete(db, again, { hlsDir: 'hls/1', audio: [], subtitles: [] });
    expect(all(db, 'SELECT pid FROM jobs')).toEqual([{ pid: null }]);
  });
});
