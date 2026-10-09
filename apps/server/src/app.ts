import Fastify from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { catalogRoutes } from './modules/catalog/routes.ts';
import { profileRoutes } from './modules/profiles/routes.ts';
import { myListRoutes } from './modules/my-list/routes.ts';
import { progressRoutes } from './modules/progress/routes.ts';
import { searchRoutes } from './modules/search/routes.ts';

export function buildApp({ db, logger = false }: { db: DatabaseSync; logger?: boolean }) {
  const app = Fastify({ logger });

  app.register(
    async (api) => {
      api.get('/health', async () => ({ ok: true }));
      profileRoutes(api, db);
      catalogRoutes(api, db);
      searchRoutes(api, db);
      myListRoutes(api, db);
      progressRoutes(api, db);
    },
    { prefix: '/api' },
  );

  return app;
}
