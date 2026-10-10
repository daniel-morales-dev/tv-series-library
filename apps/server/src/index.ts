import { join, resolve } from 'node:path';
import { buildApp } from './app.ts';
import { configStatus, resolveContentDir } from './config/config.ts';
import { openDb } from './db/connection.ts';
import { createIngestor, type Ingestor } from './modules/ingest/ingestor.ts';
import { createTmdbClient, unavailableTmdb } from './modules/ingest/tmdb.ts';
import { createWorker } from './modules/processing/worker.ts';

const dataDir = process.env.DATA_DIR ?? './data';
const port = Number(process.env.PORT ?? 8080);
const scanIntervalMin = Number(process.env.INGEST_SCAN_INTERVAL_MIN ?? 5);

const db = openDb(join(dataDir, 'library.db'));

// T22: without a configured content folder there is nothing to watch; /api/config reports the status to the wizard.
const libraryStatus = configStatus(resolveContentDir());

let ingestor: Ingestor | undefined;
if (process.env.INGEST !== 'off') {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  ingestor = createIngestor({
    db,
    dataDir,
    contentDir: () => resolveContentDir(),
    tmdb: token ? createTmdbClient(token) : unavailableTmdb(),
    log: (level, message) => app.log[level](message),
  });
  if (!token) console.warn('TMDB_READ_ACCESS_TOKEN is not set: ingesting offline');
}

const worker =
  process.env.PROCESSING === 'off'
    ? undefined
    : createWorker({
        db,
        dataDir,
        contentDir: resolveContentDir(),
        concurrency: Number(process.env.PROCESS_CONCURRENCY ?? 1),
        threads: Number(process.env.FFMPEG_THREADS ?? 4),
        log: (level, message) => app.log[level](message),
      });

const app = buildApp({
  db,
  logger: true,
  dataDir,
  ingestor,
  worker,
  webDir: resolve(process.env.WEB_DIR ?? '../web/dist'),
  config: {
    currentContentDir: () => resolveContentDir(),
    // A successful PUT just chose the folder: start scanning there (start() stops the previous timers first).
    onReady: () => ingestor?.start(scanIntervalMin),
  },
});
await app.listen({ host: '0.0.0.0', port });
worker?.start();
if (libraryStatus.status === 'ready') ingestor?.start(scanIntervalMin);
