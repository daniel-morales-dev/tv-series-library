import Fastify from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

export function buildApp({ db, logger = false }: { db: DatabaseSync; logger?: boolean }) {
  const app = Fastify({ logger });

  app.register(
    async (api) => {
      api.get('/health', async () => ({ ok: true }));
    },
    { prefix: '/api' },
  );

  return app;
}
