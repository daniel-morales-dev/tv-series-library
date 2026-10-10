import { describe, expect, it } from 'vitest';
import { all, get } from '../src/db/sql.ts';
import { claimNext, complete, enqueue, fail, listJobs, recover, requeue, requeueErrors, setProgress } from '../src/modules/processing/queue.ts';
import { addEpisode, addFile, addTitle, setup } from './helpers.ts';

const pendingFile = (db: ReturnType<typeof setup>['db'], titleId: number, o: { extraLabel?: string; episodeId?: number } = {}) =>
  addFile(db, titleId, { ...o, status: 'pending' });
const fileStatus = (db: ReturnType<typeof setup>['db'], id: number) =>
  get<{ status: string; error: string | null; hls_dir: string | null }>(db, 'SELECT status, error, hls_dir FROM media_files WHERE id = ?', id)!;

describe('enqueue', () => {
  it('creates one queued process job and does not duplicate an active one', () => {
    const { db } = setup();
    const f = pendingFile(db, addTitle(db, 'T'));
    const first = enqueue(db, f);
    expect(enqueue(db, f)).toBe(first);
    expect(all(db, 'SELECT type, status FROM jobs')).toEqual([{ type: 'process', status: 'queued' }]);
  });

  it('requeues a finished file, resetting it to pending', () => {
    const { db } = setup();
    const f = addFile(db, addTitle(db, 'T'), { status: 'error' });
    const job = enqueue(db, f);
    expect(job).toBeGreaterThan(0);
    expect(fileStatus(db, f).status).toBe('pending');
  });
});

describe('downloading files', () => {
  it('recover and claimNext leave them alone', () => {
    const { db } = setup();
    const f = addFile(db, addTitle(db, 'T'), { status: 'downloading' });
    recover(db);
    expect(claimNext(db)).toBeUndefined();
    expect(all(db, 'SELECT * FROM jobs')).toEqual([]);
    expect(fileStatus(db, f).status).toBe('downloading');
  });
});

describe('claimNext', () => {
  it('runs episodes before extras, then oldest first, and marks file and job as running', () => {
    const { db } = setup();
    const t = addTitle(db, 'S', { kind: 'anime' });
    const extra = pendingFile(db, t, { extraLabel: 'OP1' });
    const ep1 = pendingFile(db, t, { episodeId: addEpisodeRow(db, t, 1) });
    const ep2 = pendingFile(db, t, { episodeId: addEpisodeRow(db, t, 2) });
    for (const id of [extra, ep1, ep2]) enqueue(db, id);

    const order = [claimNext(db)!, claimNext(db)!, claimNext(db)!].map((j) => j.mediaFileId);
    expect(order).toEqual([ep1, ep2, extra]);
    expect(claimNext(db)).toBeUndefined();
    expect(fileStatus(db, ep1).status).toBe('processing');
    expect(get(db, "SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'")).toEqual({ n: 3 });
  });
});

describe('priority', () => {
  it('claims a prioritized job first and lets the latest request win', () => {
    const { db } = setup();
    const t = addTitle(db, 'T');
    const [a, b, c] = [pendingFile(db, t), pendingFile(db, t), pendingFile(db, t)];
    for (const id of [a, b, c]) enqueue(db, id);
    enqueue(db, b, true);
    enqueue(db, c, true);
    expect(listJobs(db).map((j) => j.mediaFileId)).toEqual([c, b, a]);
    expect([claimNext(db)!, claimNext(db)!, claimNext(db)!].map((j) => j.mediaFileId)).toEqual([c, b, a]);
  });

  it('requeue puts a running job back as queued from zero', () => {
    const { db } = setup();
    const f = pendingFile(db, addTitle(db, 'T'));
    enqueue(db, f);
    const job = claimNext(db)!;
    setProgress(db, job.id, 0.5);
    requeue(db, job);
    expect(get(db, 'SELECT status, progress FROM jobs WHERE id = ?', job.id)).toEqual({ status: 'queued', progress: 0 });
    expect(fileStatus(db, f).status).toBe('pending');
  });
});

describe('finish states', () => {
  it('complete marks the file ready with its HLS folder and tracks', () => {
    const { db } = setup();
    const f = pendingFile(db, addTitle(db, 'T'));
    enqueue(db, f);
    const job = claimNext(db)!;
    setProgress(db, job.id, 0.5);
    complete(db, job, { hlsDir: `hls/${f}`, audio: [{ playlist: 'a0/index.m3u8' }], subtitles: [{ vtt: 'subs/0.vtt' }] });

    expect(fileStatus(db, f)).toMatchObject({ status: 'ready', hls_dir: `hls/${f}`, error: null });
    expect(get(db, 'SELECT audio_tracks, subtitle_tracks FROM media_files WHERE id = ?', f)).toEqual({
      audio_tracks: '[{"playlist":"a0/index.m3u8"}]',
      subtitle_tracks: '[{"vtt":"subs/0.vtt"}]',
    });
    expect(get(db, 'SELECT status, progress, error FROM jobs WHERE id = ?', job.id)).toEqual({ status: 'done', progress: 1, error: null });
  });

  it('fail records the message on both rows and is not retried', () => {
    const { db } = setup();
    const f = pendingFile(db, addTitle(db, 'T'));
    enqueue(db, f);
    const job = claimNext(db)!;
    fail(db, job, 'boom');
    expect(fileStatus(db, f)).toMatchObject({ status: 'error', error: 'boom' });
    expect(get(db, 'SELECT status, error FROM jobs WHERE id = ?', job.id)).toEqual({ status: 'error', error: 'boom' });
    expect(claimNext(db)).toBeUndefined();
  });
});

describe('recover', () => {
  it('requeues running jobs and enqueues pending files that have no job', () => {
    const { db } = setup();
    const t = addTitle(db, 'T');
    const interrupted = pendingFile(db, t);
    enqueue(db, interrupted);
    claimNext(db);
    const orphan = pendingFile(db, t);
    const ready = addFile(db, t, { status: 'ready' });

    recover(db);

    expect(fileStatus(db, interrupted).status).toBe('pending');
    expect(get(db, 'SELECT status, progress FROM jobs WHERE media_file_id = ?', interrupted)).toEqual({ status: 'queued', progress: 0 });
    expect(get(db, 'SELECT status FROM jobs WHERE media_file_id = ?', orphan)).toEqual({ status: 'queued' });
    expect(get(db, 'SELECT COUNT(*) AS n FROM jobs WHERE media_file_id = ?', ready)).toEqual({ n: 0 });
    expect(get(db, 'SELECT COUNT(*) AS n FROM jobs')).toEqual({ n: 2 });
  });
});

describe('requeueErrors', () => {
  it('requeues error files with one job each and leaves other files untouched', () => {
    const { db } = setup();
    const t = addTitle(db, 'T');
    const failed = addFile(db, t, { status: 'error' });
    const ready = addFile(db, t, { status: 'ready' });

    requeueErrors(db);

    expect(fileStatus(db, failed).status).toBe('pending');
    expect(get(db, 'SELECT status FROM jobs WHERE media_file_id = ?', failed)).toEqual({ status: 'queued' });
    expect(fileStatus(db, ready).status).toBe('ready');
    expect(get(db, 'SELECT COUNT(*) AS n FROM jobs WHERE media_file_id = ?', ready)).toEqual({ n: 0 });

    requeueErrors(db); // next server start: nothing left in error, no duplicate job
    expect(get(db, 'SELECT COUNT(*) AS n FROM jobs WHERE media_file_id = ?', failed)).toEqual({ n: 1 });
  });
});

describe('listJobs', () => {
  it('lists active jobs first, with the file path, then recent finished ones', () => {
    const { db } = setup();
    const t = addTitle(db, 'T');
    const a = pendingFile(db, t);
    const b = pendingFile(db, t);
    enqueue(db, a);
    enqueue(db, b);
    fail(db, claimNext(db)!, 'x');
    const jobs = listJobs(db);
    expect(jobs.map((j) => [j.mediaFileId, j.status])).toEqual([[b, 'queued'], [a, 'error']]);
    expect(jobs[0]).toMatchObject({ progress: 0, error: null });
    expect(typeof jobs[0].path).toBe('string');
  });
});

function addEpisodeRow(db: ReturnType<typeof setup>['db'], titleId: number, number: number): number {
  const file = addEpisode(db, titleId, 1, number);
  // addEpisode also adds a ready file; reuse its episode and drop that file so tests control files.
  const { episode_id } = get<{ episode_id: number }>(db, 'SELECT episode_id FROM media_files WHERE id = ?', file)!;
  db.prepare('DELETE FROM media_files WHERE id = ?').run(file);
  return episode_id;
}
