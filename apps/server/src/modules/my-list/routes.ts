import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { titleExists } from '../catalog/repository.ts';
import { profileExists } from '../profiles/repository.ts';
import { addToMyList, listMyList, removeFromMyList } from './repository.ts';

const params = {
  type: 'object',
  properties: { pid: { type: 'integer' }, titleId: { type: 'integer' } },
  required: ['pid', 'titleId'],
} as const;

export function myListRoutes(api: FastifyInstance, db: DatabaseSync): void {
  api.get<{ Params: { pid: number } }>(
    '/profiles/:pid/my-list',
    { schema: { params: { type: 'object', properties: { pid: { type: 'integer' } }, required: ['pid'] } } },
    async (req, reply) =>
      profileExists(db, req.params.pid) ? listMyList(db, req.params.pid) : reply.code(404).send({ error: 'not_found' }),
  );

  api.put<{ Params: { pid: number; titleId: number } }>(
    '/profiles/:pid/my-list/:titleId',
    { schema: { params } },
    async (req, reply) => {
      const { pid, titleId } = req.params;
      if (!profileExists(db, pid) || !titleExists(db, titleId)) return reply.code(404).send({ error: 'not_found' });
      addToMyList(db, pid, titleId);
      return reply.code(204).send();
    },
  );

  api.delete<{ Params: { pid: number; titleId: number } }>(
    '/profiles/:pid/my-list/:titleId',
    { schema: { params } },
    async (req, reply) => {
      if (!profileExists(db, req.params.pid)) return reply.code(404).send({ error: 'not_found' });
      removeFromMyList(db, req.params.pid, req.params.titleId);
      return reply.code(204).send();
    },
  );
}
