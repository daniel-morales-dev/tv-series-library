import { join } from 'node:path';
import { buildApp } from './app.ts';
import { openDb } from './db/connection.ts';

const dataDir = process.env.DATA_DIR ?? './data';
const port = Number(process.env.PORT ?? 8080);

const db = openDb(join(dataDir, 'library.db'));
const app = buildApp({ db, logger: true });

await app.listen({ host: '0.0.0.0', port });
