import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error The root launcher is native JavaScript, outside the server TypeScript project.
import { resolveEnvironment, prepare, backupLibrary, supervise } from '../../../scripts/dev.mjs';

const fixtures: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dev-launcher-'));
  fixtures.push(root);
  mkdirSync(join(root, 'data'));
  mkdirSync(join(root, 'content'));
  return root;
}
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Points the launcher at an empty temp config dir so tests never read the real user config. */
const noConfig = (root: string) => ({ SALA_CONFIG_DIR: join(root, 'user-config') });

function procState(pid: number | undefined): string {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] ?? 'gone';
  } catch {
    return 'gone';
  }
}

test('anchors relative paths to the repository, keeps absolutes, external env wins and loads .env privately', () => {
  const root = fixture();
  writeFileSync(join(root, '.env'), 'DATA_DIR=archive\nCONTENT_DIR=videos\nPORT=8080\nPRIVATE_TOKEN=fixture-secret');
  const env = resolveEnvironment(root, { CONTENT_DIR: '/external/videos', INGEST: 'off', PROCESSING: 'off', ...noConfig(root) });
  expect(env.DATA_DIR).toBe(join(root, 'archive'));
  expect(env.CONTENT_DIR).toBe('/external/videos');
  expect(env.INGEST).toBe('off');
  expect(env.PROCESSING).toBe('off');
  expect(env.PORT).toBe('8080');
  expect(process.env.PRIVATE_TOKEN).toBeUndefined();
  const fresh = fixture();
  const defaults = resolveEnvironment(fresh, noConfig(fresh));
  expect(defaults.DATA_DIR).toBe(join(fresh, 'data'));
  expect(defaults.CONTENT_DIR).toBe(join(fresh, 'content'));
  expect(isAbsolute(defaults.DATA_DIR ?? '')).toBe(true);
  expect(resolveEnvironment(root, { DATA_DIR: '/external/data', CONTENT_DIR: 'relative', ...noConfig(root) }).DATA_DIR).toBe('/external/data');
  expect(resolveEnvironment(root, { CONTENT_DIR: 'relative', ...noConfig(root) }).CONTENT_DIR).toBe(join(root, 'relative'));
  expect(() => resolveEnvironment(root, { PORT: '9000', ...noConfig(root) })).toThrow(/8080/);
  expect(() => resolveEnvironment(root, { DATA_DIR: '', ...noConfig(root) })).toThrow(/DATA_DIR/);
});

test('missing DATA_DIR still fails closed with the resolved path and creates nothing', async () => {
  const root = fixture();
  const data = prepare(root, { DATA_DIR: 'disconnected-data', ...noConfig(root) }, [0, 0]);
  await expect(data).rejects.toThrow(/no existe/);
  await expect(data).rejects.toThrow(join(root, 'disconnected-data'));
  expect(readdirSync(root).sort()).toEqual(['content', 'data']);
});

test('missing CONTENT_DIR no longer blocks the launcher; the server reports the status instead', async () => {
  const root = fixture();
  const prepared = await prepare(root, { CONTENT_DIR: 'disconnected-content', ...noConfig(root) }, [0, 0]);
  expect(prepared.env.CONTENT_DIR).toBe(join(root, 'disconnected-content'));
  expect(prepared.backup).toBeUndefined();
  expect(readdirSync(root).sort()).toEqual(['content', 'data']);
});

test('CONTENT_DIR precedence: external env → user config.json → root .env → default; corrupt config warns and falls back', () => {
  const root = fixture();
  const userConfig = join(root, 'user-config');
  mkdirSync(userConfig);
  writeFileSync(join(root, '.env'), 'CONTENT_DIR=from-env-file\n');
  writeFileSync(join(userConfig, 'config.json'), JSON.stringify({ contentDir: '/library/from-config', libraryId: 'lib-1' }));
  const external = { SALA_CONFIG_DIR: userConfig };
  expect(resolveEnvironment(root, external).CONTENT_DIR).toBe('/library/from-config');
  expect(resolveEnvironment(root, { ...external, CONTENT_DIR: '/external/videos' }).CONTENT_DIR).toBe('/external/videos');
  expect(resolveEnvironment(root, external).DATA_DIR).toBe(join(root, 'data'));
  writeFileSync(join(userConfig, 'config.json'), '{broken');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(resolveEnvironment(root, external).CONTENT_DIR).toBe(join(root, 'from-env-file'));
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
  rmSync(join(userConfig, 'config.json'));
  expect(resolveEnvironment(root, external).CONTENT_DIR).toBe(join(root, 'from-env-file'));
  expect(() => resolveEnvironment(root, { CONTENT_DIR: '', ...external })).toThrow(/CONTENT_DIR/);
});

test('occupied port fails before opening even an invalid database or making a backup', async () => {
  const root = fixture();
  writeFileSync(join(root, 'data/library.db'), 'not sqlite');
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
  const port = (occupied.address() as { port: number }).port;
  try {
    await expect(prepare(root, { ...noConfig(root) }, [port, 0])).rejects.toThrow(/ocupado/);
    expect(readdirSync(join(root, 'data'))).toEqual(['library.db']);
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

test('consistent unique backups include committed WAL data and leave the original intact', async () => {
  const root = fixture();
  const db = new DatabaseSync(join(root, 'data/library.db'));
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE preserved(value); INSERT INTO preserved VALUES (42)');
    const first = await backupLibrary(join(root, 'data'));
    const second = await backupLibrary(join(root, 'data'));
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
    for (const path of [first!, second!]) {
      expect(path.startsWith(join(root, 'data', 'recovery') + '/')).toBe(true);
      const copy = new DatabaseSync(path, { readOnly: true });
      try {
        expect(copy.prepare('SELECT value FROM preserved').get()).toEqual({ value: 42 });
        expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      } finally {
        copy.close();
      }
    }
    expect(db.prepare('SELECT value FROM preserved').all()).toEqual([{ value: 42 }]);
  } finally {
    db.close();
  }
});

test('no database skips the backup without creating recovery folders', async () => {
  const root = fixture();
  expect(await backupLibrary(join(root, 'data'))).toBeUndefined();
  expect(readdirSync(join(root, 'data'))).toEqual([]);
});

test('corrupt database fails closed with a Spanish error', async () => {
  const root = fixture();
  writeFileSync(join(root, 'data/library.db'), 'invalid');
  await expect(backupLibrary(join(root, 'data'))).rejects.toThrow(/copia/i);
});

test('a failed own child stops its sibling and reports the failure code', async () => {
  const commands = [
    [process.execPath, '-e', 'setTimeout(() => process.exit(7), 150)'],
    [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
  ];
  expect(await supervise(commands, process.env, { cwd: fixture(), graceMs: 200 })).toBe(7);
});

test('abort stops own process trees, including descendants that ignore graceful termination', async () => {
  const root = fixture();
  const controller = new AbortController();
  const pidFile = join(root, 'descendant');
  const code = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000)`;
  const result = supervise([[process.execPath, '-e', code]], process.env, { cwd: root, graceMs: 200, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  expect(pid).toBeGreaterThan(0);
  expect(procState(pid)).not.toBe('gone');
  controller.abort();
  expect(await result).toBe(0);
  // SIGKILL delivery is asynchronous; the descendant is dead once it is a zombie or has been reaped.
  await expect.poll(() => procState(pid)).toMatch(/Z|gone/);
});

test('stopping own trees never signals unrelated processes', async () => {
  const root = fixture();
  const { spawn } = await import('node:child_process');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const controller = new AbortController();
  try {
    await expect.poll(() => procState(unrelated.pid)).not.toBe('gone');
    const result = supervise([[process.execPath, '-e', 'setInterval(() => {}, 1000)']], process.env, {
      cwd: root,
      graceMs: 200,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    expect(await result).toBe(0);
    expect(procState(unrelated.pid)).not.toBe('Z');
    expect(procState(unrelated.pid)).not.toBe('gone');
  } finally {
    unrelated.kill('SIGKILL');
  }
});

test('spawn failure stops already-started own children', async () => {
  expect(
    await supervise(
      [
        [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        ['/nonexistent/dev-launcher-command'],
      ],
      process.env,
      { cwd: fixture(), graceMs: 200 },
    ),
  ).toBe(1);
});

test('successful preflight returns a verified backup and does not migrate or reseed the database', async () => {
  const root = fixture();
  const path = join(root, 'data/library.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=4; CREATE TABLE preserved(value); INSERT INTO preserved VALUES (1)');
  db.close();
  const prepared = await prepare(root, { INGEST: 'off', PROCESSING: 'off', ...noConfig(root) }, [0, 0]);
  expect(prepared.backup).toBeTruthy();
  expect(prepared.env.INGEST).toBe('off');
  const original = new DatabaseSync(path, { readOnly: true });
  try {
    expect(original.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });
    expect(original.prepare('SELECT value FROM preserved').all()).toEqual([{ value: 1 }]);
  } finally {
    original.close();
  }
});
