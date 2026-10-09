import { openDb } from '../src/db/connection.ts';
import { buildApp } from '../src/app.ts';

export function setup() {
  const db = openDb(':memory:');
  const app = buildApp({ db });
  return { db, app };
}
