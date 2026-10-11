import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { inFlightIds, listOrphans, purgeOrphans, referencedIds } from './orphans.ts';
import { reprocessSubtitles } from './subtitles.ts';

export function maintenanceRoutes(api: FastifyInstance, db: DatabaseSync, hlsDir: string): void {
  api.get('/maintenance/orphans', async () => listOrphans({ hlsDir, referenced: referencedIds(db), inFlight: inFlightIds(db) }));

  api.post<{ Body?: { mediaFileId?: unknown } }>('/maintenance/reprocess-subtitles', async (request, reply) => {
    const raw = request.body?.mediaFileId;
    if (raw !== undefined && (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0)) {
      return reply.code(400).send({ error: 'invalid_media_file_id', message: 'mediaFileId debe ser un número entero positivo.' });
    }
    const result = await reprocessSubtitles({ db, hlsDir, mediaFileId: raw });
    if (result === null) return reply.code(404).send({ error: 'not_found', message: 'No existe el archivo indicado.' });
    return result;
  });

  api.post<{ Body?: { confirm?: unknown } }>('/maintenance/purge-orphans', async (request, reply) => {
    if (request.body?.confirm !== true) {
      return reply.code(400).send({ error: 'confirm_required', message: 'Hace falta confirmar la eliminación de los paquetes huérfanos.' });
    }
    return purgeOrphans({ hlsDir, db });
  });
}
