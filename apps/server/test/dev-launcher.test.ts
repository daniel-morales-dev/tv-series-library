import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { spawn as spawnProcess, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error The root launcher is native JavaScript, outside the server TypeScript project.
import { resolveEnvironment, prepare, backupLibrary, supervise, forceHolder, PORT_MARKERS } from '../../../scripts/dev.mjs';

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
const noConfig = (root: string) => ({ SALA_CONFIG_DIR: join(root, 'user-config'), XDG_DATA_HOME: join(root, 'user-data') });

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
  expect(defaults.DATA_DIR).toBeUndefined(); // not exported: the server resolves state and HLS itself (T47a)
  expect(defaults.CONTENT_DIR).toBe(join(fresh, 'content'));
  expect(isAbsolute(defaults.CONTENT_DIR ?? '')).toBe(true);
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

test('prepare resolves the data location: legacy stays and is backed up, fresh uses the user dir without creating it', async () => {
  const legacy = fixture();
  seedDb(legacy);
  const prepared = await prepare(legacy, noConfig(legacy), [0, 0]);
  expect(prepared.paths).toMatchObject({ source: 'legacy', stateDir: join(legacy, 'data') });
  expect(prepared.paths.notice).toContain('sala migrate-state');
  expect(prepared.backup).toContain(join(legacy, 'data/recovery'));

  const fresh = fixture();
  const first = await prepare(fresh, noConfig(fresh), [0, 0]);
  expect(first.paths).toMatchObject({ source: 'user', stateDir: join(fresh, 'user-data/sala') });
  expect(first.backup).toBeUndefined();
  expect(readdirSync(fresh).sort()).toEqual(['content', 'data']);

  writeFileSync(join(fresh, '.env'), 'DATA_DIR=archive\n');
  mkdirSync(join(fresh, 'archive'));
  expect((await prepare(fresh, noConfig(fresh), [0, 0])).paths).toMatchObject({ source: 'env', stateDir: join(fresh, 'archive') });
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
  expect(resolveEnvironment(root, external).DATA_DIR).toBeUndefined();
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

test('reclaims the port when the holder is this repository own orphaned dev server', async () => {
  const root = fixture();
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
  const port = (occupied.address() as { port: number }).port;
  const holder = { pid: 4242, parentPid: 4241, own: true };
  const kill = vi.fn(async () => {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });
  const force = vi.fn();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const prepared = await prepare(root, { ...noConfig(root) }, [port, 0], { findHolder: () => holder, killHolder: kill, forceHolder: force });
    expect(prepared.env.PORT).toBe('8080');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(holder);
    expect(force).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain(`Puerto ${port} liberado`);
  } finally {
    log.mockRestore();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

test('maps each preflight port to the command-line marker of its owner', () => {
  expect(PORT_MARKERS).toEqual({ 8080: 'src/index.ts', 5174: 'vite' });
});

test('reclaims the backend and the vite ports when both orphaned holders belong to this repository', async () => {
  const root = fixture();
  const backend = createServer();
  const vite = createServer();
  await new Promise<void>((resolve) => backend.listen(0, '0.0.0.0', resolve));
  await new Promise<void>((resolve) => vite.listen(0, '0.0.0.0', resolve));
  const backendPort = (backend.address() as { port: number }).port;
  const vitePort = (vite.address() as { port: number }).port;
  const holders: Record<number, { pid: number; parentPid: number | null; own: true }> = {
    [backendPort]: { pid: 4242, parentPid: 4241, own: true },
    [vitePort]: { pid: 4343, parentPid: null, own: true },
  };
  const kill = vi.fn(async (holder: { pid: number }) => {
    const occupied = holder.pid === holders[backendPort]!.pid ? backend : vite;
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const prepared = await prepare(root, { ...noConfig(root) }, [backendPort, vitePort], {
      findHolder: (port: number) => holders[port],
      killHolder: kill,
    });
    expect(prepared.env.PORT).toBe('8080');
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(holders[backendPort]);
    expect(kill).toHaveBeenCalledWith(holders[vitePort]);
    const lines = log.mock.calls.flat().join('\n');
    expect(lines).toContain(`Puerto ${backendPort} liberado`);
    expect(lines).toContain(`Puerto ${vitePort} liberado`);
  } finally {
    log.mockRestore();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await new Promise<void>((resolve) => vite.close(() => resolve()));
  }
});

test('a foreign vite holder on the frontend port is never signalled and the original error stands', async () => {
  const root = fixture();
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
  const port = (occupied.address() as { port: number }).port;
  const kill = vi.fn();
  const asked: number[] = [];
  try {
    await expect(
      prepare(root, { ...noConfig(root) }, [port, 0], {
        findHolder: (askedPort: number) => {
          asked.push(askedPort);
          return undefined; // a foreign vite runs outside the repository: never ours
        },
        killHolder: kill,
      }),
    ).rejects.toThrow(/ocupado/);
    expect(asked).toEqual([port]);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

test('a foreign port holder is never killed and the original error stands', async () => {
  const root = fixture();
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
  const port = (occupied.address() as { port: number }).port;
  const kill = vi.fn();
  try {
    await expect(
      prepare(root, { ...noConfig(root) }, [port, 0], { findHolder: () => ({ pid: 4242, parentPid: null, own: false }), killHolder: kill }),
    ).rejects.toThrow(/ocupado/);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

test('an unidentified port holder is never killed and the original error stands', async () => {
  const root = fixture();
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
  const port = (occupied.address() as { port: number }).port;
  const kill = vi.fn();
  try {
    await expect(
      prepare(root, { ...noConfig(root) }, [port, 0], { findHolder: () => undefined, killHolder: kill }),
    ).rejects.toThrow(/ocupado/);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

test('the original error stands when the identified holder does not release the port in time', async () => {
  const root = fixture();
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
  const port = (occupied.address() as { port: number }).port;
  const kill = vi.fn();
  const force = vi.fn();
  try {
    await expect(
      prepare(root, { ...noConfig(root) }, [port, 0], {
        findHolder: () => ({ pid: 4242, parentPid: null, own: true }),
        killHolder: kill,
        forceHolder: force,
        releaseMs: 0,
        forceMs: 0,
      }),
    ).rejects.toThrow(/ocupado/);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(force).toHaveBeenCalledTimes(1);
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

test('escalates to SIGKILL when the hung holder ignores SIGTERM', async () => {
  const root = fixture();
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
  const port = (occupied.address() as { port: number }).port;
  const holder = { pid: 4242, parentPid: 4241, own: true };
  const kill = vi.fn();
  const force = vi.fn(async () => {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const prepared = await prepare(root, { ...noConfig(root) }, [port, 0], {
      findHolder: () => holder,
      killHolder: kill,
      forceHolder: force,
      releaseMs: 0,
    });
    expect(prepared.env.PORT).toBe('8080');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(force).toHaveBeenCalledTimes(1);
    expect(force).toHaveBeenCalledWith(holder);
    expect(log.mock.calls.flat().join('\n')).toContain('SIGKILL');
  } finally {
    log.mockRestore();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

test('the original error stands when escalation does not free the port either', async () => {
  const root = fixture();
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
  const port = (occupied.address() as { port: number }).port;
  const kill = vi.fn();
  const force = vi.fn();
  try {
    await expect(
      prepare(root, { ...noConfig(root) }, [port, 0], {
        findHolder: () => ({ pid: 4242, parentPid: null, own: true }),
        killHolder: kill,
        forceHolder: force,
        releaseMs: 0,
        forceMs: 0,
      }),
    ).rejects.toThrow(/ocupado/);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(force).toHaveBeenCalledTimes(1);
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

function seedDb(root: string) {
  const db = new DatabaseSync(join(root, 'data/library.db'));
  db.exec('CREATE TABLE t(v)');
  db.close();
}
const startBackups = (root: string) => readdirSync(join(root, 'data/recovery')).filter((n) => n.startsWith('before-start-')).sort();

test('keeps only the newest N before-start backups and never touches other recovery folders', async () => {
  const root = fixture();
  seedDb(root);
  const recovery = join(root, 'data/recovery');
  mkdirSync(join(recovery, 'manual-keep'), { recursive: true });
  mkdirSync(join(recovery, 'before-star-not-ours'), { recursive: true });
  for (let i = 0; i < 7; i++) {
    const dir = join(recovery, `before-start-old${i}`);
    mkdirSync(dir);
    const t = new Date(Date.now() - (100 - i) * 3_600_000);
    utimesSync(dir, t, t);
  }
  const fresh = await backupLibrary(join(root, 'data'), { keep: 5 });
  const names = startBackups(root);
  expect(names).toHaveLength(5);
  expect(names).toContain(fresh.split('/').at(-2));
  expect(names).not.toContain('before-start-old0');
  expect(names).toContain('before-start-old6');
  expect(readdirSync(recovery)).toEqual(expect.arrayContaining(['manual-keep', 'before-star-not-ours']));
});

test('reuses a backup younger than minAgeMs instead of copying again', async () => {
  const root = fixture();
  seedDb(root);
  const first = await backupLibrary(join(root, 'data'), { minAgeMs: 600_000 });
  const second = await backupLibrary(join(root, 'data'), { minAgeMs: 600_000 });
  expect(second).toBe(first);
  expect(startBackups(root)).toHaveLength(1);
  const old = join(root, 'data/recovery', startBackups(root)[0]);
  const t = new Date(Date.now() - 3_600_000);
  utimesSync(old, t, t);
  expect(await backupLibrary(join(root, 'data'), { minAgeMs: 600_000 })).not.toBe(first);
  expect(startBackups(root)).toHaveLength(2);
});

test('backup CLI exits without copying when the port is already taken', async () => {
  const root = fixture();
  seedDb(root);
  const occupied = createServer();
  await new Promise<void>((accept) => occupied.listen({ port: 0, host: '0.0.0.0' }, accept));
  const port = (occupied.address() as { port: number }).port;
  try {
    const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli/backup.ts');
    const run = spawnSync(process.execPath, [cli], { encoding: 'utf8', env: { ...process.env, DATA_DIR: join(root, 'data'), PORT: String(port) } });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/ocupado/);
    expect(readdirSync(join(root, 'data'))).not.toContain('recovery');
  } finally {
    await new Promise<void>((accept) => occupied.close(() => accept()));
  }
});

test.skipIf(process.platform !== 'linux')('forced holder cleanup leaves its ffmpeg child alive for the next server to adopt', async () => {
  // The holder spawns a child whose command line mentions ffmpeg, like an adoptable encode.
  const holder = spawnProcess(
    process.execPath,
    ['-e', "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'ffmpeg-stand-in'], { stdio: 'inherit' }); setInterval(()=>{},1000)"],
    { stdio: 'ignore' },
  );
  let child: number | undefined;
  try {
    for (let i = 0; i < 100 && child === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      child = readdirSync('/proc')
        .filter((e) => /^\d+$/.test(e))
        .map(Number)
        .find((pid) => {
          try {
            return /^PPid:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] === String(holder.pid) && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('ffmpeg');
          } catch {
            return false;
          }
        });
    }
    expect(child).toBeDefined();
    forceHolder({ pid: holder.pid!, parentPid: null });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(procState(holder.pid)).toMatch(/gone|Z/);
    expect(procState(child)).not.toBe('gone');
  } finally {
    if (child) try { process.kill(child, 'SIGKILL'); } catch {}
    try { holder.kill('SIGKILL'); } catch {}
  }
});
