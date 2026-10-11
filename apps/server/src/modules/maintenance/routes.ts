import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { inFlightIds, listOrphans, purgeOrphans, referencedIds } from './orphans.ts';

export function maintenanceRoutes(api: FastifyInstance, db: DatabaseSync, hlsDir: string): void {
  api.get('/maintenance/orphans', async () => listOrphans({ hlsDir, referenced: referencedIds(db), inFlight: inFlightIds(db) }));

  api.post<{ Body?: { confirm?: unknown } }>('/maintenance/purge-orphans', async (request, reply) => {
    if (request.body?.confirm !== true) {
      return reply.code(400).send({ error: 'confirm_required', message: 'Hace falta confirmar la eliminación de los paquetes huérfanos.' });
    }
    return purgeOrphans({ hlsDir, db });
  });
}
