// One-off: re-download episode stills saved at w300 in full size (`npm run upgrade-stills -w apps/server`).
import { join } from 'node:path';
import { saveImages } from '../modules/ingest/images.ts';
import { createTmdbClient } from '../modules/ingest/tmdb.ts';
import { openDb } from './connection.ts';
import { all, run } from './sql.ts';

const dataDir = process.env.DATA_DIR ?? './data';
const token = process.env.TMDB_READ_ACCESS_TOKEN;
if (!token) throw new Error('TMDB_READ_ACCESS_TOKEN is not set');

const db = openDb(join(dataDir, 'library.db'));
const rows = all<{ id: number; still_path: string }>(db, "SELECT id, still_path FROM episodes WHERE still_path LIKE 'w300/%'");
const path = (r: { still_path: string }) => r.still_path.slice('w300'.length);
const saved = await saveImages(createTmdbClient(token), dataDir, rows.map((r) => ['original', path(r)] as const));
let upgraded = 0;
for (const r of rows) {
  const rel = saved('original', path(r));
  if (rel) upgraded += Number(run(db, 'UPDATE episodes SET still_path = ? WHERE id = ?', rel, r.id).changes);
}
console.log(`Stills upgraded: ${upgraded} of ${rows.length}`);
