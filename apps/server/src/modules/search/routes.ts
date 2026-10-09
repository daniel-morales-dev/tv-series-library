import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { suggest } from './repository.ts';

export function searchRoutes(api: FastifyInstance, db: DatabaseSync): void {
  api.get<{ Querystring: { q: string } }>(
    '/search/suggest',
    {
      schema: {
        querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 100 } }, required: ['q'] },
      },
    },
    async (req) => suggest(db, req.query.q),
  );
}
