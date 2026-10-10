import Fastify from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Ingestor } from './modules/ingest/ingestor.ts';
import { processingRoutes } from './modules/processing/routes.ts';
import type { Worker } from './modules/processing/worker.ts';
import { ingestRoutes } from './modules/ingest/routes.ts';
import { catalogRoutes } from './modules/catalog/routes.ts';
import { profileRoutes } from './modules/profiles/routes.ts';
import { myListRoutes } from './modules/my-list/routes.ts';
import { progressRoutes } from './modules/progress/routes.ts';
import { searchRoutes } from './modules/search/routes.ts';
import { webRoutes } from './http/web.ts';
import { configRoutes, type ConfigRoutesDeps } from './modules/config/routes.ts';

export interface AppOptions {
  db: DatabaseSync;
  logger?: boolean;
  dataDir?: string;
  /** Absent when ingestion is off: scan and confirm answer 503. */
  ingestor?: Ingestor;
  /** Absent when PROCESSING=off: files stay queued. */
  worker?: Worker;
  /** Built web app to serve; absent in tests and API-only runs. */
  webDir?: string;
  /** T22: user config endpoints; defaults read the real user config dir. */
  config?: ConfigRoutesDeps;
}

export function buildApp({ db, logger = false, dataDir = './data', ingestor, worker, webDir, config }: AppOptions) {
  const app = Fastify({ logger });

  app.register(
    async (api) => {
      api.get('/health', async () => ({ ok: true }));
      configRoutes(api, config);
      profileRoutes(api, db);
      catalogRoutes(api, db);
      searchRoutes(api, db);
      myListRoutes(api, db);
      progressRoutes(api, db);
      ingestRoutes(api, db, dataDir, ingestor);
      processingRoutes(api, db, dataDir, worker);
    },
    { prefix: '/api' },
  );

  if (webDir) webRoutes(app, webDir);

  app.addHook('onClose', async () => worker?.stop());

  return app;
}
