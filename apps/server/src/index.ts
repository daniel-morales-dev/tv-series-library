import { join, relative, resolve, isAbsolute } from 'node:path';
import { buildApp } from './app.ts';
import { autoScanAllowed, configStatus, libraryDiskPresent, resolveContentDir } from './config/config.ts';
import { resolveDataPaths } from './config/paths.ts';
import { openDb } from './db/connection.ts';
import { createIngestor, type Ingestor } from './modules/ingest/ingestor.ts';
import { createTmdbClient, unavailableTmdb } from './modules/ingest/tmdb.ts';
import { networkRoutes } from './modules/network/routes.ts';
import { createMigrationService } from './modules/data-migration/service.ts';
import { GB } from './modules/processing/cache.ts';
import { requeueErrors } from './modules/processing/queue.ts';
import { createWorker } from './modules/processing/worker.ts';
import { createShutdown } from './shutdown.ts';
import { startWatchdog, watchdogStallMs } from './watchdog.ts';

// T47a/T47d: one resolver for state (database, images, recovery) and one for the HLS root (config.json `hlsDir`).
const dataPaths = resolveDataPaths();
const dataDir = dataPaths.stateDir;
const hlsDir = dataPaths.hlsDir;
if (dataPaths.notice) console.warn(dataPaths.notice);
const port = Number(process.env.PORT ?? 8080);
const scanIntervalMin = Number(process.env.INGEST_SCAN_INTERVAL_MIN ?? 5);

const db = openDb(join(dataDir, 'library.db'));

// T22: /api/config reports the status to the wizard. T28: `unset` (env/root .env/default folder) still scans;
// only a configured-but-gone folder (`missing`) blocks the ingestor.
const workerContentDir = resolveContentDir();
const libraryStatus = configStatus(workerContentDir);
// Folder missing (or the default does not exist): no scan, no requeue, no processing — the catalog stays untouched.
const contentAvailable = autoScanAllowed(libraryStatus);
if (!contentAvailable) console.warn(`Content folder not available (${workerContentDir}): ingest and processing wait until it is configured or the disk returns.`);
// T47d: polled by the worker, the ingestor and /api/stream; an unmounted disk never turns into errors or an empty `.sala/`.
const diskPresent = () => libraryDiskPresent(workerContentDir);
const rel = relative(workerContentDir, hlsDir);
const hlsOnLibrary = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);

let ingestor: Ingestor | undefined;
if (process.env.INGEST !== 'off') {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  ingestor = createIngestor({
    db,
    dataDir,
    contentDir: () => resolveContentDir(),
    diskPresent,
    tmdb: token ? createTmdbClient(token) : unavailableTmdb(),
    log: (level, message) => app.log[level](message),
  });
  if (!token) console.warn('TMDB_READ_ACCESS_TOKEN is not set: ingesting offline');
}

// T47c: non-negative number from the environment, else the default.
const envNumber = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) && n >= 0 ? n : fallback;
};

// T47e: "mover datos con la biblioteca"; the HLS root is fixed at boot, so a move needs a restart before the origin is freed.
const dataMigration = createMigrationService({
  stateDir: dataDir,
  hlsDir,
  contentDir: () => resolveContentDir(),
  diskPresent,
  minFreeBytes: envNumber('MIN_FREE_GB', 10) * GB,
  minFreePct: envNumber('MIN_FREE_PCT', 10),
});

const worker =
  process.env.PROCESSING === 'off'
    ? undefined
    : createWorker({
        db,
        dataDir,
        hlsDir,
        diskPresent,
        contentDir: workerContentDir,
        concurrency: Number(process.env.PROCESS_CONCURRENCY ?? 1),
        // T35: 8 threads measured ~1.24x over 4 while still leaving half of the 16 cores free for playback.
        threads: Number(process.env.FFMPEG_THREADS ?? 8),
        cacheBudgetBytes: envNumber('CACHE_BUDGET_GB', 20) * GB,
        minFreeBytes: envNumber('MIN_FREE_GB', 10) * GB,
        minFreePct: envNumber('MIN_FREE_PCT', 10),
        log: (level, message) => app.log[level](message),
      });

// T33: files stuck in error from a transient pipeline bug get one bounded reprocess per server start.
// Only meaningful with a worker; with PROCESSING=off nothing would ever claim the requeued jobs.
let workerStarted = false;
function startWorker() {
  if (!worker || workerStarted) return;
  workerStarted = true;
  requeueErrors(db);
  worker.start();
}

const app = buildApp({
  db,
  logger: true,
  dataDir,
  hlsDir,
  disk: { present: diskPresent, hlsOnLibrary },
  contentDir: () => resolveContentDir(),
  ingestor,
  worker,
  dataMigration,
  webDir: resolve(process.env.WEB_DIR ?? '../web/dist'),
  config: {
    currentContentDir: () => resolveContentDir(),
    // A successful PUT just chose the folder: start scanning there (start() stops the previous timers first).
    // The worker's folder is fixed at boot, so it only starts if the chosen folder is the one it was built with.
    onReady: (dir: string) => {
      ingestor?.start(scanIntervalMin);
      if (dir === workerContentDir) startWorker();
      else if (worker && !workerStarted) console.warn('Restart the service to process media from the newly chosen folder.');
    },
  },
});
await app.register(async (api) => networkRoutes(api, { port }), { prefix: '/api' });
await app.listen({ host: '0.0.0.0', port });
// T47d: both start even with the disk away; they idle until it returns instead of needing a restart.
startWorker();
ingestor?.start(scanIntervalMin);

// T34/T40d: on SIGTERM/SIGINT stop the worker first (the ffmpeg child keeps running for the next
// server to adopt), then close the server; the handler is bounded, so a hung child cannot keep the watch restart waiting.
const shutdown = createShutdown({
  app,
  worker,
  ingestor,
  log: (message) => app.log.warn(message),
});
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

// T38: SIGKILLs this process if the event loop stalls (WATCHDOG_STALL_S, default 30; 0 disables); off under tests/--inspect.
startWatchdog({ stallMs: watchdogStallMs() });
