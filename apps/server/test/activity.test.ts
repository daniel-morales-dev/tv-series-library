import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { enqueue, claimNext, fail, setProgress } from '../src/modules/processing/queue.ts';
import { createWorker } from '../src/modules/processing/worker.ts';
import { addEpisode, addFile, addTitle, setup } from './helpers.ts';

interface Item {
  mediaFileId: number;
  jobId: number | null;
  status: string;
  progress: number;
  error: string | null;
  kind: string;
  title: string;
  extraLabel: string | null;
  season: number | null;
  episode: number | null;
  episodeName: string | null;
}
interface Activity {
  running: Item[];
  queued: Item[];
  queuedTotal: number;
  failed: Item[];
}

function env() {
  const { db } = setup();
  return { db, app: buildApp({ db }) };
}

async function activity(app: ReturnType<typeof env>['app']): Promise<Activity> {
  const res = await app.inject('/api/activity');
  expect(res.statusCode).toBe(200);
  return res.json() as Activity;
}

// A queued process job for an existing file, as the worker would see it.
function queue(db: ReturnType<typeof setup>['db'], fileId: number): number {
  db.prepare("UPDATE media_files SET status = 'pending' WHERE id = ?").run(fileId);
  return enqueue(db, fileId);
}

describe('GET /api/activity', () => {
  it('answers empty sections on an empty library', async () => {
    const { app } = env();
    expect((await app.inject('/api/activity')).json()).toEqual({ running: [], queued: [], queuedTotal: 0, failed: [], paused: false, lowDisk: false, lowDiskMessage: null, diskAbsent: false });
  });

  it('joins episode, film and extra files with their display names and kind', async () => {
    const { db, app } = env();
    const series = addTitle(db, 'Frieren', { kind: 'anime' });
    const episodeFile = addEpisode(db, series, 1, 3);
    const film = addTitle(db, 'Koe no Katachi');
    const filmFile = addFile(db, film);
    const extraFile = addFile(db, series, { extraLabel: 'OP1' });
    for (const id of [episodeFile, filmFile, extraFile]) queue(db, id);

    const { queued, queuedTotal } = await activity(app);

    expect(queuedTotal).toBe(3);
    expect(queued.map((i) => i.mediaFileId)).toEqual([episodeFile, filmFile, extraFile]);
    expect(queued[0]).toMatchObject({
      mediaFileId: episodeFile,
      status: 'queued',
      progress: 0,
      error: null,
      kind: 'episode',
      title: 'Frieren',
      season: 1,
      episode: 3,
      episodeName: 'E3',
      extraLabel: null,
    });
    expect(queued[0]!.jobId).toBeGreaterThan(0);
    expect(queued[1]).toMatchObject({
      mediaFileId: filmFile,
      kind: 'film',
      title: 'Koe no Katachi',
      season: null,
      episode: null,
      episodeName: null,
      extraLabel: null,
    });
    expect(queued[2]).toMatchObject({
      mediaFileId: extraFile,
      kind: 'extra',
      title: 'Frieren',
      extraLabel: 'OP1',
      episode: null,
    });
  });

  it('shows the running job with the raw progress stored for it', async () => {
    const { db, app } = env();
    const fileId = addEpisode(db, addTitle(db, 'T', { kind: 'series' }), 2, 7);
    const jobId = queue(db, fileId);
    expect(claimNext(db)!.id).toBe(jobId);
    setProgress(db, jobId, 0.495);

    const { running, queued, queuedTotal } = await activity(app);

    expect(queued).toEqual([]);
    expect(queuedTotal).toBe(0);
    expect(running).toMatchObject([
      { jobId, mediaFileId: fileId, status: 'running', progress: 0.495, kind: 'episode', season: 2, episode: 7 },
    ]);
  });

  it('caps the queue preview at ten and still reports the full total', async () => {
    const { db, app } = env();
    const t = addTitle(db, 'T');
    for (let n = 0; n < 12; n++) queue(db, addFile(db, t));

    const { queued, queuedTotal } = await activity(app);

    expect(queued).toHaveLength(10);
    expect(queuedTotal).toBe(12);
  });

  it('lists prioritized jobs first and extras last', async () => {
    const { db, app } = env();
    const t = addTitle(db, 'T');
    const plain = queue(db, addFile(db, t));
    const extra = queue(db, addFile(db, t, { extraLabel: 'PV' }));
    const prioritized = queue(db, addFile(db, t));
    db.prepare('UPDATE jobs SET priority = 1 WHERE id = ?').run(prioritized);

    const { queued } = await activity(app);

    expect(queued.map((i) => i.mediaFileId)).toEqual([prioritized, plain, extra]);
  });

  it('lists failed media rows and shows them queued again after the retry endpoint', async () => {
    const { db, app } = env();
    const fileId = addEpisode(db, addTitle(db, 'Frieren', { kind: 'anime' }), 1, 11);
    queue(db, fileId);
    fail(db, claimNext(db)!, 'ffmpeg exited with 1');

    const failed = await activity(app);
    expect(failed.running).toEqual([]);
    expect(failed.queued).toEqual([]);
    expect(failed.queuedTotal).toBe(0);
    expect(failed.failed).toMatchObject([
      {
        mediaFileId: fileId,
        jobId: null,
        status: 'error',
        progress: 0,
        error: 'ffmpeg exited with 1',
        kind: 'episode',
        title: 'Frieren',
        season: 1,
        episode: 11,
      },
    ]);

    const res = await app.inject({ method: 'POST', url: `/api/media-files/${fileId}/process` });
    expect(res.statusCode).toBe(202);

    const retried = await activity(app);
    expect(retried.failed).toEqual([]);
    expect(retried.queued).toMatchObject([{ mediaFileId: fileId, status: 'queued', error: null }]);
    expect(retried.queuedTotal).toBe(1);
  });
});

describe('processing pause and resume', () => {
  it('pauses and resumes idempotently and reports the state in activity', async () => {
    const { db } = setup();
    const worker = createWorker({ db, dataDir: 'data', contentDir: 'content' });
    const app = buildApp({ db, worker });

    const paused = await app.inject({ method: 'POST', url: '/api/processing/pause' });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toEqual({ paused: true });
    expect(worker.isPaused()).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/processing/pause' })).json()).toEqual({ paused: true });
    expect((await app.inject('/api/activity')).json()).toMatchObject({ paused: true });

    const resumed = await app.inject({ method: 'POST', url: '/api/processing/resume' });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toEqual({ paused: false });
    expect(worker.isPaused()).toBe(false);
    expect((await app.inject('/api/activity')).json()).toMatchObject({ paused: false });
  });

  it('answers 409 processing_disabled when the worker is off', async () => {
    const { app } = env();
    for (const action of ['pause', 'resume']) {
      const res = await app.inject({ method: 'POST', url: `/api/processing/${action}` });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'processing_disabled' });
    }
  });
});
