import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { FranchiseError, type FranchiseRelation, linkFranchise, unlinkFranchise } from './franchise.ts';
import { getTitleDetail, listTitles, type TitleFilters } from './repository.ts';

export function catalogRoutes(api: FastifyInstance, db: DatabaseSync): void {
  api.get<{ Querystring: Partial<TitleFilters> }>(
    '/titles',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            kind: { enum: ['movie', 'series', 'anime'] },
            year: { type: 'integer' },
            genre: { type: 'string', maxLength: 50 },
            sort: { enum: ['recent', 'title', 'year'] },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (req) => listTitles(db, { limit: 50, offset: 0, ...req.query }),
  );

  api.get<{ Params: { id: number }; Querystring: { profileId?: number } }>(
    '/titles/:id',
    {
      schema: {
        params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        querystring: { type: 'object', properties: { profileId: { type: 'integer' } } },
      },
    },
    async (req, reply) =>
      getTitleDetail(db, req.params.id, req.query.profileId) ?? reply.code(404).send({ error: 'not_found' }),
  );

  const idParams = { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } as const;

  api.post<{ Params: { id: number }; Body: { ofTitleId: number; relation?: FranchiseRelation } }>(
    '/titles/:id/franchise',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          properties: { ofTitleId: { type: 'integer', minimum: 1 }, relation: { enum: ['sequel', 'prequel'] } },
          required: ['ofTitleId'],
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        return { franchiseId: linkFranchise(db, req.params.id, req.body.ofTitleId, req.body.relation) };
      } catch (err) {
        if (err instanceof FranchiseError) return reply.code(err.status).send({ error: err.code });
        throw err;
      }
    },
  );

  api.delete<{ Params: { id: number } }>('/titles/:id/franchise', { schema: { params: idParams } }, async (req, reply) =>
    unlinkFranchise(db, req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' }),
  );
}
