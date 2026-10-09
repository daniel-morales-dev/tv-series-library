import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { sendFile } from '../../http/static-file.ts';
import { get } from '../../db/sql.ts';
import { enqueue, listJobs } from './queue.ts';
import type { Worker } from './worker.ts';

const STREAM_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/mp4',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const idParams = (name: string) => ({ type: 'object', properties: { [name]: { type: 'integer' } }, required: [name] }) as const;

export function processingRoutes(api: FastifyInstance, db: DatabaseSync, dataDir: string, worker?: Worker): void {
  api.get('/jobs', async () => listJobs(db));

  api.post<{ Params: { id: number } }>('/media-files/:id/process', { schema: { params: idParams('id') } }, async (req, reply) => {
    const file = get<{ status: string }>(db, 'SELECT status FROM media_files WHERE id = ?', req.params.id);
    if (!file) return reply.code(404).send({ error: 'not_found' });
    if (file.status === 'downloading') return reply.code(409).send({ error: 'downloading' });
    const jobId = enqueue(db, req.params.id);
    worker?.kick();
    return reply.code(202).send({ jobId });
  });

  api.post<{ Params: { id: number } }>('/media-files/:id/play', { schema: { params: idParams('id') } }, async (req, reply) => {
    const file = get<{ status: string }>(db, 'SELECT status FROM media_files WHERE id = ?', req.params.id);
    if (!file) return reply.code(404).send({ error: 'not_found' });
    if (file.status === 'downloading') return reply.code(409).send({ error: 'downloading' });
    if (file.status === 'ready') return { status: 'ready' };
    const jobId = enqueue(db, req.params.id, true);
    worker?.prioritize(req.params.id);
    return reply.code(202).send({ status: 'processing', jobId });
  });

  // Playlists change when a file is reprocessed, so only the media itself may be cached.
  // While a file is being processed its package lives in `<id>.tmp`.
  api.get<{ Params: { mediaFileId: number; '*': string } }>(
    '/stream/:mediaFileId/*',
    { schema: { params: { ...idParams('mediaFileId'), properties: { mediaFileId: { type: 'integer' }, '*': { type: 'string' } } } } },
    async (req, reply) => {
      const dir = join(dataDir, 'hls', String(req.params.mediaFileId));
      const base = (await stat(dir).catch(() => null))?.isDirectory() ? dir : `${dir}.tmp`;
      return sendFile(reply, base, req.params['*'], STREAM_TYPES, (ext) => (ext === '.m3u8' ? 'no-cache' : 'public, max-age=3600'));
    },
  );
}
