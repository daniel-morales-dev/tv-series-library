import { join } from 'node:path';
import { buildApp } from './app.ts';
import { openDb } from './db/connection.ts';
import { createIngestor } from './modules/ingest/ingestor.ts';
import { createTmdbClient, unavailableTmdb } from './modules/ingest/tmdb.ts';
import { createWorker } from './modules/processing/worker.ts';

const dataDir = process.env.DATA_DIR ?? './data';
const contentDir = process.env.CONTENT_DIR ?? './content';
const port = Number(process.env.PORT ?? 8080);

const db = openDb(join(dataDir, 'library.db'));

let ingestor;
if (process.env.INGEST !== 'off') {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  ingestor = createIngestor({
    db,
    dataDir,
    contentDir,
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
        contentDir,
        concurrency: Number(process.env.PROCESS_CONCURRENCY ?? 1),
        threads: Number(process.env.FFMPEG_THREADS ?? 4),
        log: (level, message) => app.log[level](message),
      });

const app = buildApp({ db, logger: true, dataDir, ingestor, worker });
await app.listen({ host: '0.0.0.0', port });
worker?.start();
ingestor?.start(Number(process.env.INGEST_SCAN_INTERVAL_MIN ?? 5));
