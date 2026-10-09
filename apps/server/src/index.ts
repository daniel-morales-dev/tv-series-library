import { join } from 'node:path';
import { buildApp } from './app.ts';
import { openDb } from './db/connection.ts';
import { createIngestor } from './modules/ingest/ingestor.ts';
import { createTmdbClient, unavailableTmdb } from './modules/ingest/tmdb.ts';

const dataDir = process.env.DATA_DIR ?? './data';
const contentDir = process.env.CONTENT_DIR ?? './content';
const port = Number(process.env.PORT ?? 8080);

const db = openDb(join(dataDir, 'library.db'));
const app = buildApp({ db, logger: true });

await app.listen({ host: '0.0.0.0', port });

if (process.env.INGEST !== 'off') {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  if (!token) app.log.warn('TMDB_READ_ACCESS_TOKEN is not set: ingesting offline');
  const ingestor = createIngestor({
    db,
    dataDir,
    contentDir,
    tmdb: token ? createTmdbClient(token) : unavailableTmdb(),
    log: (level, message) => app.log[level](message),
  });
  ingestor.start(Number(process.env.INGEST_SCAN_INTERVAL_MIN ?? 5));
}
