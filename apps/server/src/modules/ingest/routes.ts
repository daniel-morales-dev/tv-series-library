import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { sendFile } from '../../http/static-file.ts';
import type { Ingestor } from './ingestor.ts';
import { type ConfirmBody, PendingError, ignorePending, listPending } from './pending.ts';

const idParams = { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } as const;
const confirmBody = {
  type: 'object',
  properties: {
    tmdbType: { enum: ['tv', 'movie'] },
    tmdbId: { type: 'integer', minimum: 1 },
    episodeGroupId: { type: 'string', minLength: 1 },
    season: { type: 'integer', minimum: 0 },
    episode: { type: 'integer', minimum: 1 },
    extraLabel: { type: 'string', minLength: 1 },
  },
  required: ['tmdbType', 'tmdbId'],
  additionalProperties: false,
} as const;

const IMAGE_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export function ingestRoutes(api: FastifyInstance, db: DatabaseSync, dataDir: string, ingestor?: Ingestor): void {
  const imagesDir = resolve(dataDir, 'images');

  api.get('/pending', async () => listPending(db));

  api.post<{ Params: { id: number } }>('/pending/:id/ignore', { schema: { params: idParams } }, async (req, reply) =>
    ignorePending(db, req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' }),
  );

  api.post<{ Params: { id: number }; Body: ConfirmBody }>(
    '/pending/:id/confirm',
    { schema: { params: idParams, body: confirmBody } },
    async (req, reply) => {
      if (!ingestor) return reply.code(503).send({ error: 'ingest_disabled' });
      try {
        return await ingestor.confirm(req.params.id, req.body);
      } catch (err) {
        if (err instanceof PendingError) return reply.code(err.status).send({ error: err.code });
        req.log.error(err);
        return reply.code(502).send({ error: 'tmdb_unavailable' });
      }
    },
  );

  api.post('/ingest/scan', async (_req, reply) =>
    ingestor ? ingestor.scan() : reply.code(503).send({ error: 'ingest_disabled' }),
  );

  api.get<{ Params: { '*': string } }>('/images/*', (req, reply) =>
    sendFile(reply, imagesDir, req.params['*'], IMAGE_TYPES, 'public, max-age=31536000, immutable'),
  );
}
