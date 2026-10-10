import { join, resolve } from 'node:path';
import { buildApp } from './app.ts';
import { autoScanAllowed, configStatus, resolveContentDir } from './config/config.ts';
import { openDb } from './db/connection.ts';
import { createIngestor, type Ingestor } from './modules/ingest/ingestor.ts';
import { createTmdbClient, unavailableTmdb } from './modules/ingest/tmdb.ts';
import { requeueErrors } from './modules/processing/queue.ts';
import { createWorker } from './modules/processing/worker.ts';
import { createShutdown } from './shutdown.ts';

const dataDir = process.env.DATA_DIR ?? './data';
const port = Number(process.env.PORT ?? 8080);
const scanIntervalMin = Number(process.env.INGEST_SCAN_INTERVAL_MIN ?? 5);

const db = openDb(join(dataDir, 'library.db'));

// T22: /api/config reports the status to the wizard. T28: `unset` (env/root .env/default folder) still scans;
// only a configured-but-gone folder (`missing`) blocks the ingestor.
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

// T33: files stuck in error from a transient pipeline bug get one bounded reprocess per server start.
// Only meaningful with a worker; with PROCESSING=off nothing would ever claim the requeued jobs.
if (worker) requeueErrors(db);

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
if (autoScanAllowed(libraryStatus)) ingestor?.start(scanIntervalMin);

// T34: on SIGTERM/SIGINT stop the worker first (its AbortSignal kills the ffmpeg child), then close
// the server; the handler is bounded, so a hung child cannot keep the watch restart waiting.
const shutdown = createShutdown({
  app,
  worker,
  ingestor,
  log: (message) => app.log.warn(message),
});
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
