import { join } from 'node:path';
import Fastify from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Ingestor } from './modules/ingest/ingestor.ts';
import { type DiskGuard, processingRoutes } from './modules/processing/routes.ts';
import type { Worker } from './modules/processing/worker.ts';
import { ingestRoutes } from './modules/ingest/routes.ts';
import type { TmdbClient } from './modules/ingest/tmdb.ts';
import { catalogRoutes } from './modules/catalog/routes.ts';
import { type ProbeChapters, probeChapters as realProbeChapters } from './modules/catalog/chapters.ts';
import { randomRoutes } from './modules/random/routes.ts';
import { profileRoutes } from './modules/profiles/routes.ts';
import { myListRoutes } from './modules/my-list/routes.ts';
import { progressRoutes } from './modules/progress/routes.ts';
import { searchRoutes } from './modules/search/routes.ts';
import { webRoutes } from './http/web.ts';
import { configRoutes, type ConfigRoutesDeps } from './modules/config/routes.ts';
import { fsRoutes, type FsRoutesDeps } from './modules/fs/routes.ts';
import { dataMigrationRoutes } from './modules/data-migration/routes.ts';
import type { MigrationService } from './modules/data-migration/service.ts';
import { maintenanceRoutes } from './modules/maintenance/routes.ts';
import { rootsRoutes, type RootsRoutesDeps } from './modules/roots/routes.ts';

export interface AppOptions {
  db: DatabaseSync;
  logger?: boolean;
  dataDir?: string;
  /** T47d: HLS root; defaults to `<dataDir>/hls`. */
  hlsDir?: string;
  /** T47d: library disk guard for streaming; defaults to always present. */
  disk?: DiskGuard;
  /** Absent when ingestion is off: scan and confirm answer 503. */
  ingestor?: Ingestor;
  /** Absent when PROCESSING=off: files stay queued. */
  worker?: Worker;
  /** Built web app to serve; absent in tests and API-only runs. */
  webDir?: string;
  /** T22: user config endpoints; defaults read the real user config dir. */
  config?: ConfigRoutesDeps;
  /** T46: read-only folder browser; defaults read the real filesystem. */
  fs?: FsRoutesDeps;
  /** T26: library folder for the lazy chapter backfill; absent = no backfill (cached chapters still served). */
  contentDir?: () => string;
  probeChapters?: ProbeChapters;
  /** T47e: guided move of the HLS data to the library folder; absent = endpoints not registered. */
  dataMigration?: MigrationService;
  /** T52/T58: explicit on-demand TMDB refresh; a client or a resolver re-evaluated per refresh. Absent = the refresh endpoint answers 503. */
  tmdb?: TmdbClient | (() => TmdbClient | undefined);
  /** T9d: locations API; defaults read the real filesystem. */
  roots?: RootsRoutesDeps;
}

export function buildApp({ db, logger = false, dataDir = './data', hlsDir, disk, ingestor, worker, webDir, config, fs, contentDir, probeChapters, dataMigration, tmdb, roots }: AppOptions) {
  const app = Fastify({ logger });
  const hls = hlsDir ?? join(dataDir, 'hls');

  app.register(
    async (api) => {
      api.get('/health', async () => ({ ok: true }));
      configRoutes(api, config);
      fsRoutes(api, fs);
      rootsRoutes(api, db, roots);
      if (dataMigration) dataMigrationRoutes(api, dataMigration);
      profileRoutes(api, db);
      catalogRoutes(api, db, contentDir && { contentDir, probe: probeChapters ?? realProbeChapters }, tmdb && { tmdb, dataDir }, hls);
      randomRoutes(api, db);
      searchRoutes(api, db);
      myListRoutes(api, db);
      progressRoutes(api, db);
      ingestRoutes(api, db, dataDir, ingestor);
      processingRoutes(api, db, hls, worker, disk);
      maintenanceRoutes(api, db, hls);
    },
    { prefix: '/api' },
  );

  if (webDir) webRoutes(app, webDir);

  app.addHook('onClose', async () => worker?.stop());

  return app;
}
