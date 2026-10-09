import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { get } from '../src/db/sql.ts';
import { claimNext, enqueue, fail } from '../src/modules/processing/queue.ts';
import { addFile, addTitle, setup } from './helpers.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function env(worker?: { kick(): void }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tvlib-stream-'));
  roots.push(dataDir);
  const { db } = setup();
  const app = buildApp({ db, dataDir, worker: worker as never });
  const hls = join(dataDir, 'hls', '7');
  mkdirSync(join(hls, 'subs'), { recursive: true });
  mkdirSync(join(hls, 'fonts'), { recursive: true });
  for (const [rel, body] of [
    ['master.m3u8', '#EXTM3U'],
    ['seg_00000.m4s', 'seg'],
    ['init.mp4', 'init'],
    ['subs/0.vtt', 'WEBVTT'],
    ['subs/0.ass', '[Script Info]'],
    ['fonts/Arial.TTF', 'font'],
    ['notes.txt', 'nope'],
  ]) writeFileSync(join(hls, rel), body);
  writeFileSync(join(dataDir, 'secret.m3u8'), 'secret');
  symlinkSync(join(dataDir, 'secret.m3u8'), join(hls, 'link.m3u8'));
  return { db, app, dataDir };
}

describe('GET /api/stream', () => {
  it.each([
    ['master.m3u8', 'application/vnd.apple.mpegurl'],
    ['seg_00000.m4s', 'video/mp4'],
    ['init.mp4', 'video/mp4'],
    ['subs/0.vtt', 'text/vtt'],
    ['subs/0.ass', 'text/plain'],
    ['fonts/Arial.TTF', 'font/ttf'],
  ])('serves %s as %s', async (rel, type) => {
    const res = await env().app.inject(`/api/stream/7/${rel}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain(type);
  });

  it('serves playlists uncached', async () => {
    const res = await env().app.inject('/api/stream/7/master.m3u8');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it.each([
    ['unknown file', '/api/stream/7/missing.m3u8'],
    ['unknown media file', '/api/stream/8/master.m3u8'],
    ['unsupported extension', '/api/stream/7/notes.txt'],
    ['encoded dot-dot', '/api/stream/7/%2e%2e%2f%2e%2e%2fsecret.m3u8'],
    ['escape to data dir', '/api/stream/7/..%2Fsecret.m3u8'],
    ['symlink leaving the folder', '/api/stream/7/link.m3u8'],
    ['directory', '/api/stream/7/subs'],
  ])('answers 404 for %s', async (_name, url) => {
    expect((await env().app.inject(url)).statusCode).toBe(404);
  });
});

describe('streaming while processing', () => {
  it('serves from the .tmp folder until the final one exists', async () => {
    const { app, dataDir } = env();
    mkdirSync(join(dataDir, 'hls', '9.tmp'), { recursive: true });
    writeFileSync(join(dataDir, 'hls', '9.tmp', 'master.m3u8'), '#EXTM3U');
    expect((await app.inject('/api/stream/9/master.m3u8')).statusCode).toBe(200);
  });
});

describe('POST /api/media-files/:id/play', () => {
  it('answers ready for a processed file without queueing', async () => {
    const { db, app } = env();
    const f = addFile(db, addTitle(db, 'T'), { status: 'ready' });
    const res = await app.inject({ method: 'POST', url: `/api/media-files/${f}/play` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    expect(get(db, 'SELECT COUNT(*) AS n FROM jobs')).toEqual({ n: 0 });
  });

  it('queues a pending file with priority and asks the worker to run it now', async () => {
    const prioritized: number[] = [];
    const { db, app } = env({ kick() {}, prioritize: (id: number) => prioritized.push(id) } as never);
    const t = addTitle(db, 'T');
    const other = addFile(db, t, { status: 'pending' });
    enqueue(db, other);
    const f = addFile(db, t, { status: 'pending' });
    const res = await app.inject({ method: 'POST', url: `/api/media-files/${f}/play` });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'processing' });
    expect(prioritized).toEqual([f]);
    expect(claimNext(db)!.mediaFileId).toBe(f);
  });

  it('answers 404 for an unknown file', async () => {
    expect((await env().app.inject({ method: 'POST', url: '/api/media-files/99/play' })).statusCode).toBe(404);
  });
});

describe('GET /api/jobs and POST /api/media-files/:id/process', () => {
  it('lists the queue with progress and file', async () => {
    const { db, app } = env();
    const f = addFile(db, addTitle(db, 'T'), { status: 'pending' });
    enqueue(db, f);
    const res = await app.inject('/api/jobs');
    expect(res.json()).toMatchObject([{ mediaFileId: f, status: 'queued', progress: 0, error: null }]);
  });

  it('requeues a file, wakes the worker, and reuses an active job', async () => {
    let kicks = 0;
    const { db, app } = env({ kick: () => kicks++ });
    const f = addFile(db, addTitle(db, 'T'), { status: 'ready' });

    const first = await app.inject({ method: 'POST', url: `/api/media-files/${f}/process` });
    expect(first.statusCode).toBe(202);
    expect(get(db, 'SELECT status FROM media_files WHERE id = ?', f)).toEqual({ status: 'pending' });
    const again = await app.inject({ method: 'POST', url: `/api/media-files/${f}/process` });
    expect(again.json()).toEqual(first.json());
    expect(kicks).toBe(2);
  });

  it('reprocesses a file that failed', async () => {
    const { db, app } = env();
    const f = addFile(db, addTitle(db, 'T'), { status: 'pending' });
    enqueue(db, f);
    fail(db, claimNext(db)!, 'boom');
    expect((await app.inject({ method: 'POST', url: `/api/media-files/${f}/process` })).statusCode).toBe(202);
    expect(get(db, 'SELECT status, error FROM media_files WHERE id = ?', f)).toEqual({ status: 'pending', error: null });
  });

  it('answers 404 for an unknown file', async () => {
    expect((await env().app.inject({ method: 'POST', url: '/api/media-files/99/process' })).statusCode).toBe(404);
  });
});
