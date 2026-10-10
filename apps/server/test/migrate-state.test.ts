import { afterEach, expect, test } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDataPaths } from '../src/config/paths.ts';
// @ts-expect-error The migration script is native JavaScript, outside the server TypeScript project.
import { migrateState } from '../../../scripts/migrate-state.mjs';

const roots: string[] = [];
const open: DatabaseSync[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fake repo with a legacy `data/` (WAL database kept open, images, recovery, HLS) plus an isolated user dir. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'migrate-state-'));
  roots.push(root);
  const data = join(root, 'data');
  mkdirSync(join(data, 'images/w300'), { recursive: true });
  mkdirSync(join(data, 'recovery/before-start-a'), { recursive: true });
  mkdirSync(join(data, 'hls/1'), { recursive: true });
  writeFileSync(join(data, 'images/w300/a.jpg'), 'image-bytes');
  writeFileSync(join(data, 'recovery/before-start-a/library.db'), 'old backup');
  writeFileSync(join(data, 'hls/1/seg0.ts'), 'video');
  const db = new DatabaseSync(join(data, 'library.db'));
  open.push(db);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA wal_autocheckpoint = 0');
  db.exec('CREATE TABLE titles (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE profiles (id INTEGER PRIMARY KEY)');
  db.exec("INSERT INTO titles (name) VALUES ('Frieren'), ('Monogatari'); INSERT INTO profiles DEFAULT VALUES");
  const env = { SALA_CONFIG_DIR: join(root, 'cfg'), XDG_DATA_HOME: join(root, 'xdg') };
  const dest = join(root, 'xdg/sala');
  const logs: string[] = [];
  const base = {
    root,
    env,
    out: (s: string) => logs.push(s),
    err: (s: string) => logs.push(`ERR ${s}`),
    checkPort: async () => {},
    freeBytes: () => 1e12,
  };
  const text = () => logs.join('\n');
  return { root, data, dest, env, base, text };
}

test('--dry-run reports the plan and writes nothing', async () => {
  const f = fixture();
  expect(await migrateState({ ...f.base, dryRun: true })).toBe(0);
  expect(f.text()).toContain(f.dest);
  expect(f.text()).toMatch(/simulaci/i);
  expect(existsSync(join(f.root, 'xdg'))).toBe(false);
});

test('copies the WAL-consistent database, images and recovery, links HLS, verifies and keeps the origin', async () => {
  const f = fixture();
  expect(await migrateState({ ...f.base, yes: true })).toBe(0);
  const copy = new DatabaseSync(join(f.dest, 'library.db'), { readOnly: true });
  open.push(copy);
  expect(copy.prepare('SELECT COUNT(*) AS c FROM titles').get()).toEqual({ c: 2 });
  expect(copy.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
  expect(readFileSync(join(f.dest, 'images/w300/a.jpg'), 'utf8')).toBe('image-bytes');
  expect(readFileSync(join(f.dest, 'recovery/before-start-a/library.db'), 'utf8')).toBe('old backup');
  expect(lstatSync(join(f.dest, 'hls')).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(f.dest, 'hls'))).toBe(join(f.data, 'hls'));
  // Origin untouched; nothing half-written left beside the destination.
  expect(existsSync(join(f.data, 'library.db'))).toBe(true);
  expect(existsSync(join(f.data, 'images/w300/a.jpg'))).toBe(true);
  expect(readdirSync(join(f.root, 'xdg'))).toEqual(['sala']);
  expect(f.text()).toContain('NO se borró');
  expect(f.text()).toContain('rm ');
  // The resolver now picks the new state and keeps HLS where it is.
  const paths = resolveDataPaths(f.env, { root: f.root });
  expect(paths).toMatchObject({ source: 'user', stateDir: f.dest, hlsDir: join(f.data, 'hls') });
});

test('running it again says there is nothing to do', async () => {
  const f = fixture();
  await migrateState({ ...f.base, yes: true });
  expect(await migrateState({ ...f.base, yes: true })).toBe(0);
  expect(f.text()).toMatch(/Ya usas el estado nuevo/);
});

test('without --yes it asks and cancelling changes nothing', async () => {
  const f = fixture();
  let asked = 0;
  const code = await migrateState({ ...f.base, confirm: async () => (asked++, false) });
  expect(asked).toBe(1);
  expect(code).toBe(1);
  expect(existsSync(join(f.root, 'xdg'))).toBe(false);
  expect(await migrateState({ ...f.base })).toBe(1); // no confirm available → refuses
});

test('fails closed: non-empty destination, stale temp folder, busy port, not enough space', async () => {
  const f = fixture();
  mkdirSync(f.dest, { recursive: true });
  writeFileSync(join(f.dest, 'something'), 'x');
  expect(await migrateState({ ...f.base, yes: true })).toBe(1);
  expect(f.text()).toMatch(/no está vacío/);
  rmSync(f.dest, { recursive: true });

  mkdirSync(`${f.dest}.migrating`, { recursive: true });
  expect(await migrateState({ ...f.base, yes: true })).toBe(1);
  expect(f.text()).toContain('.migrating');
  rmSync(`${f.dest}.migrating`, { recursive: true });

  expect(await migrateState({ ...f.base, yes: true, checkPort: async () => Promise.reject(new Error('busy')) })).toBe(1);
  expect(f.text()).toMatch(/sala stop/);

  expect(await migrateState({ ...f.base, yes: true, freeBytes: () => 10 })).toBe(1);
  expect(f.text()).toMatch(/espacio/i);

  expect(existsSync(f.dest)).toBe(false);
  expect(existsSync(`${f.dest}.migrating`)).toBe(false);
});

test('an explicit DATA_DIR is never migrated', async () => {
  const f = fixture();
  expect(await migrateState({ ...f.base, env: { ...f.env, DATA_DIR: join(f.root, 'data') }, yes: true })).toBe(1);
  expect(f.text()).toContain('DATA_DIR');
  expect(existsSync(join(f.root, 'xdg'))).toBe(false);
});

test('a corrupt origin database fails without leaving temporary files or touching the origin', async () => {
  const f = fixture();
  for (const db of open.splice(0)) db.close();
  rmSync(join(f.data, 'library.db-wal'), { force: true });
  rmSync(join(f.data, 'library.db-shm'), { force: true });
  writeFileSync(join(f.data, 'library.db'), 'not sqlite at all, long enough to look like a file');
  expect(await migrateState({ ...f.base, yes: true })).toBe(1);
  expect(f.text()).toMatch(/No se migró/);
  expect(existsSync(`${f.dest}.migrating`)).toBe(false);
  expect(existsSync(f.dest)).toBe(false);
  expect(readFileSync(join(f.data, 'library.db'), 'utf8')).toContain('not sqlite');
});

test('nothing to migrate on a fresh install', async () => {
  const f = fixture();
  rmSync(join(f.data, 'library.db'), { force: true });
  expect(await migrateState({ ...f.base, yes: true })).toBe(0);
  expect(f.text()).toMatch(/Nada que migrar/);
});
