import type { FastifyInstance } from 'fastify';
import { fsErrorMessage, listDirs, type ListOptions } from './dirs.ts';

export type FsRoutesDeps = Pick<ListOptions, 'home' | 'mountBases'>;

export function fsRoutes(api: FastifyInstance, deps: FsRoutesDeps = {}): void {
  api.get<{ Querystring: { path?: string; hidden?: string } }>('/fs/dirs', async (req, reply) => {
    const result = listDirs(req.query.path, { ...deps, showHidden: req.query.hidden === '1' });
    if (!result.ok) return reply.code(400).send({ error: result.error, message: fsErrorMessage[result.error] });
    return result.value;
  });
}
