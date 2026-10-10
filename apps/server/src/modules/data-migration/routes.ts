import type { FastifyInstance, FastifyReply } from 'fastify';
import { MigrationError } from './migrate.ts';
import type { MigrationService } from './service.ts';

// Expected failures (no space, absent disk, restart pending...) carry a code the UI turns into a message.
async function guard(reply: FastifyReply, fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof MigrationError)) throw err;
    return reply.code(err.code === 'invalid_path' ? 400 : 409).send({ error: err.code, message: err.message });
  }
}

export function dataMigrationRoutes(api: FastifyInstance, service: MigrationService): void {
  api.get<{ Querystring: { to?: string } }>('/data-migration/plan', (req, reply) => guard(reply, () => service.plan(req.query.to)));

  api.get('/data-migration/status', async () => service.status());

  api.post<{ Body?: { to?: unknown } }>('/data-migration/start', (req, reply) =>
    guard(reply, async () => {
      const to = req.body?.to;
      if (to !== undefined && typeof to !== 'string') throw new MigrationError('invalid_path', 'El destino debe ser una ruta.');
      const status = await service.start(to);
      return reply.code(202).send(status);
    }),
  );

  api.post('/data-migration/confirm-free-origin', (_req, reply) => guard(reply, () => service.confirmFreeOrigin()));
}
