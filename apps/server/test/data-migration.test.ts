import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { readUserConfig, writeUserConfig } from '../src/config/config.ts';
import {
  buildPlan,
  freeOrigin,
  MigrationError,
  readJournal,
  runMigration,
  type MigrationDeps,
} from '../src/modules/data-migration/migrate.ts';
import { createMigrationService } from '../src/modules/data-migration/service.ts';
import { setup } from './helpers.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tvlib-migdata-'));
  roots.push(d);
  return d;
};

// A fake HLS root: package 1 has 2 files (8 B), package 2 has a nested folder (6 B); `3.tmp` and `notes.txt` are not packages.
function hls(root = tmp()) {
  const from = join(root, 'old', 'hls');
  mkdirSync(join(from, '1'), { recursive: true });
  mkdirSync(join(from, '2', 'sub'), { recursive: true });
  mkdirSync(join(from, '3.tmp'), { recursive: true });
  writeFileSync(join(from, '1', 'index.m3u8'), 'abcd');
  writeFileSync(join(from, '1', 'meta.json'), 'efgh');
  writeFileSync(join(from, '2', 'seg.m4s'), 'abc');
  writeFileSync(join(from, '2', 'sub', 'a.vtt'), 'def');
  writeFileSync(join(from, '3.tmp', 'x'), 'x');
  writeFileSync(join(from, 'notes.txt'), 'n');
  return { root, from, to: join(root, 'lib', '.sala', 'hls') };
}

const roomy = { statfs: async () => ({ bsize: 1, blocks: 1000, bavail: 900 }) };
const limits = { minFreeBytes: 0, minFreePct: 0 };
const same = (deps: MigrationDeps = {}): MigrationDeps => ({ ...roomy, sameDevice: async () => true, ...deps });
const other = (deps: MigrationDeps = {}): MigrationDeps => ({ ...roomy, sameDevice: async () => false, ...deps });
const base = { ...limits, diskPresent: () => true, switchPointer: async () => {} };

describe('buildPlan', () => {
  it('lists numeric packages with sizes, ignores .tmp and loose files, and picks link on the same filesystem', async () => {
    const f = hls();
    const plan = await buildPlan({ from: f.from, to: f.to, ...limits, deps: same() });
    expect(plan.packages.map((p) => [p.name, p.bytes, p.files, p.moved])).toEqual([
      ['1', 8, 2, false],
      ['2', 6, 2, false],
    ]);
    expect(plan).toMatchObject({ method: 'link', pendingCount: 2, movedCount: 0, pendingBytes: 14, requiredBytes: 0, fits: true });
    expect(existsSync(f.to)).toBe(false);
  });

  it('needs bytes plus the T47d threshold across filesystems and reports when it does not fit', async () => {
    const f = hls();
    // 1000 B volume, 900 B free: threshold = max(minFreeBytes 5, 10 % of 1000 = 100) = 100 -> needs 14 + 100.
    const ok = await buildPlan({ from: f.from, to: f.to, minFreeBytes: 5, minFreePct: 10, deps: other() });
    expect(ok).toMatchObject({ method: 'copy', requiredBytes: 114, freeBytes: 900, fits: true });
    const tight = await buildPlan({ from: f.from, to: f.to, minFreeBytes: 5, minFreePct: 10, deps: other({ statfs: async () => ({ bsize: 1, blocks: 1000, bavail: 110 }) }) });
    expect(tight.fits).toBe(false);
  });

  it('marks packages already complete at the destination as moved', async () => {
    const f = hls();
    mkdirSync(join(f.to, '1'), { recursive: true });
    writeFileSync(join(f.to, '1', 'index.m3u8'), 'abcd');
    writeFileSync(join(f.to, '1', 'meta.json'), 'efgh');
    mkdirSync(join(f.to, '2'), { recursive: true });
    writeFileSync(join(f.to, '2', 'seg.m4s'), 'ab'); // truncated: not moved
    const plan = await buildPlan({ from: f.from, to: f.to, ...limits, deps: other() });
    expect(plan.packages.map((p) => [p.name, p.moved])).toEqual([['1', true], ['2', false]]);
    expect(plan).toMatchObject({ pendingCount: 1, movedCount: 1, pendingBytes: 6 });
  });

  it('refuses the same folder, nested folders and a missing origin', async () => {
    const f = hls();
    const code = (from: string, to: string) => buildPlan({ from, to, ...limits, deps: same() }).catch((e: MigrationError) => e.code);
    expect(await code(f.from, f.from)).toBe('same_dir');
    expect(await code(f.from, join(f.from, 'inner'))).toBe('nested');
    expect(await code(join(f.from, '1'), f.from)).toBe('nested');
    expect(await code(join(f.root, 'nope'), f.to)).toBe('no_source');
  });
});

describe('runMigration', () => {
  it('hard-links on the same filesystem: origin intact, same inodes, verified, pointer switched last', async () => {
    const f = hls();
    const order: string[] = [];
    const progress: number[] = [];
    const result = await runMigration({
      from: f.from, to: f.to, ...base, deps: same(),
      onProgress: (p) => progress.push(p.done),
      switchPointer: async () => {
        order.push(`switch:${readdirSync(f.to).sort().join(',')}`);
      },
    });
    expect(result).toEqual({ moved: 2, skipped: 0 });
    expect(readFileSync(join(f.to, '2', 'sub', 'a.vtt'), 'utf8')).toBe('def');
    expect(readFileSync(join(f.to, '1', 'meta.json'), 'utf8')).toBe('efgh');
    expect(statSync(join(f.to, '1', 'index.m3u8')).ino).toBe(statSync(join(f.from, '1', 'index.m3u8')).ino);
    expect(readdirSync(f.from).sort()).toEqual(['1', '2', '3.tmp', 'notes.txt']);
    expect(order).toEqual(['switch:1,2']); // no .tmp left when the pointer moves
    expect(progress.at(-1)).toBe(2);
  });

  it('copies across filesystems through .tmp and leaves the origin untouched', async () => {
    const f = hls();
    const seen: string[] = [];
    await runMigration({
      from: f.from, to: f.to, ...base,
      deps: other({
        copyDir: async (a, b) => {
          seen.push(b);
          mkdirSync(join(b, 'sub'), { recursive: true });
          for (const rel of ['index.m3u8', 'meta.json', 'seg.m4s', 'sub/a.vtt']) if (existsSync(join(a, rel))) writeFileSync(join(b, rel), readFileSync(join(a, rel)));
        },
      }),
    });
    expect(seen.every((s) => s.endsWith('.tmp'))).toBe(true);
    expect(readdirSync(f.to).sort()).toEqual(['1', '2']);
    expect(statSync(join(f.to, '1', 'index.m3u8')).ino).not.toBe(statSync(join(f.from, '1', 'index.m3u8')).ino);
    expect(readdirSync(f.from)).toContain('1');
  });

  it('falls back to copying when hard links are not supported', async () => {
    const f = hls();
    const result = await runMigration({
      from: f.from, to: f.to, ...base,
      deps: same({ linkFile: async () => { throw Object.assign(new Error('x'), { code: 'EXDEV' }); } }),
    });
    expect(result.moved).toBe(2);
    expect(readFileSync(join(f.to, '2', 'seg.m4s'), 'utf8')).toBe('abc');
    expect(statSync(join(f.to, '2', 'seg.m4s')).ino).not.toBe(statSync(join(f.from, '2', 'seg.m4s')).ino);
  });

  it('refuses with no_space before creating anything at the destination', async () => {
    const f = hls();
    const err = await runMigration({ from: f.from, to: f.to, ...base, minFreePct: 99, deps: other() }).catch((e) => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.code).toBe('no_space');
    expect(existsSync(join(f.root, 'lib'))).toBe(false);
  });

  it('never creates the destination while the library disk is absent', async () => {
    const f = hls();
    const err = await runMigration({ from: f.from, to: f.to, ...base, diskPresent: () => false, deps: same() }).catch((e) => e);
    expect(err.code).toBe('disk_absent');
    expect(existsSync(join(f.root, 'lib'))).toBe(false);
  });

  it('stops when the disk disappears mid-run and resumes skipping what is already moved', async () => {
    const f = hls();
    let calls = 0;
    const first = await runMigration({ from: f.from, to: f.to, ...base, diskPresent: () => ++calls <= 2, deps: same() }).catch((e) => e);
    expect(first.code).toBe('disk_absent');
    expect(readdirSync(f.to)).toEqual(['1']);
    let switched = 0;
    const second = await runMigration({ from: f.from, to: f.to, ...base, switchPointer: async () => { switched++; }, deps: same() });
    expect(second).toEqual({ moved: 1, skipped: 1 });
    expect(switched).toBe(1);
  });

  it('cleans the .tmp of a failed package, keeps finished ones and switches nothing; a rerun finishes', async () => {
    const f = hls();
    let n = 0;
    let switched = 0;
    const failing = same({ linkFile: async (a, b) => { if (a.includes(`${sep}2${sep}`) && ++n) throw new Error('disk exploded'); const { link } = await import('node:fs/promises'); await link(a, b); } });
    await expect(runMigration({ from: f.from, to: f.to, ...base, switchPointer: async () => { switched++; }, deps: failing })).rejects.toThrow('disk exploded');
    expect(readdirSync(f.to)).toEqual(['1']);
    expect(switched).toBe(0);
    expect(await runMigration({ from: f.from, to: f.to, ...base, switchPointer: async () => { switched++; }, deps: same() })).toEqual({ moved: 1, skipped: 1 });
    expect(switched).toBe(1);
  });

  it('detects a corrupt copy (size mismatch), removes it and does not switch', async () => {
    const f = hls();
    let switched = 0;
    const err = await runMigration({
      from: f.from, to: f.to, ...base, switchPointer: async () => { switched++; },
      deps: other({ copyDir: async (_a, b) => { mkdirSync(b, { recursive: true }); writeFileSync(join(b, 'index.m3u8'), 'ab'); } }),
    }).catch((e) => e);
    expect(err.code).toBe('not_verified');
    expect(readdirSync(f.to)).toEqual([]);
    expect(switched).toBe(0);
  });
});

describe('freeOrigin', () => {
  it('removes only the origin packages that are verified at the destination', async () => {
    const f = hls();
    await runMigration({ from: f.from, to: f.to, ...base, deps: same() });
    mkdirSync(join(f.from, '9'));
    writeFileSync(join(f.from, '9', 'new.m4s'), 'fresh'); // created after the migration: must survive
    const result = await freeOrigin({ from: f.from, to: f.to });
    expect(result).toMatchObject({ freedPackages: 2, freedBytes: 14, kept: ['9'] });
    expect(readdirSync(f.from).sort()).toEqual(['3.tmp', '9', 'notes.txt']);
    expect(readFileSync(join(f.to, '1', 'index.m3u8'), 'utf8')).toBe('abcd');
  });

  it('keeps an origin package whose destination copy is incomplete', async () => {
    const f = hls();
    mkdirSync(join(f.to, '1'), { recursive: true });
    writeFileSync(join(f.to, '1', 'index.m3u8'), 'ab');
    expect((await freeOrigin({ from: f.from, to: f.to })).freedPackages).toBe(0);
    expect(existsSync(join(f.from, '1', 'index.m3u8'))).toBe(true);
  });
});

describe('migration service and routes', () => {
  function world(env: NodeJS.ProcessEnv = {}) {
    const root = tmp();
    const content = join(root, 'lib');
    const cfg = join(root, 'cfg');
    const state = join(root, 'state');
    mkdirSync(content, { recursive: true });
    mkdirSync(state, { recursive: true });
    const f = hls(root);
    writeUserConfig({ contentDir: content, libraryId: 'lib-1' }, cfg);
    const service = (hlsDir: string) =>
      createMigrationService({ stateDir: state, hlsDir, contentDir: () => content, diskPresent: () => true, ...limits, configDir: cfg, env, deps: same() });
    return { ...f, content, cfg, state, service, dest: join(content, '.sala', 'hls') };
  }

  it('runs the whole guided flow: start, switch the pointer, require a restart, then free the origin', async () => {
    const w = world();
    const booted = w.service(w.from);
    const plan = await booted.plan();
    expect(plan).toMatchObject({ from: w.from, to: w.dest, pendingCount: 2 });

    await booted.start();
    await booted.idle();
    expect(booted.status().job).toMatchObject({ state: 'completed', done: 2, total: 2 });
    expect(readUserConfig({ dir: w.cfg })?.hlsDir).toBe(w.dest);
    expect(readJournal(w.state)).toMatchObject({ from: w.from, to: w.dest });
    expect(booted.status()).toMatchObject({ pointerSwitched: true, restartRequired: true, canFreeOrigin: false });
    await expect(booted.confirmFreeOrigin()).rejects.toMatchObject({ code: 'restart_required' });
    expect(existsSync(join(w.from, '1'))).toBe(true);

    // After the restart the server boots with the new hlsDir; the journal still remembers the origin.
    const restarted = w.service(w.dest);
    expect(restarted.status()).toMatchObject({ pointerSwitched: true, restartRequired: false, canFreeOrigin: true });
    expect(await restarted.confirmFreeOrigin()).toMatchObject({ freedPackages: 2 });
    expect(existsSync(join(w.from, '1'))).toBe(false);
    expect(readJournal(w.state)).toBeNull();
    expect(restarted.status()).toMatchObject({ alreadyThere: true, canFreeOrigin: false });
  });

  it('keeps the pointer untouched on failure and reports it in the job', async () => {
    const w = world();
    const failing = createMigrationService({
      stateDir: w.state, hlsDir: w.from, contentDir: () => w.content, diskPresent: () => true, ...limits, configDir: w.cfg, env: {},
      deps: same({ linkFile: async () => { throw new Error('boom'); }, copyDir: async () => { throw new Error('boom'); } }),
    });
    await failing.start();
    await failing.idle();
    expect(failing.status().job).toMatchObject({ state: 'failed', error: 'boom' });
    expect(readUserConfig({ dir: w.cfg })?.hlsDir).toBeUndefined();
    const again = w.service(w.from); // resumable
    await again.start();
    await again.idle();
    expect(again.status().job.state).toBe('completed');
  });

  it('refuses a second start while running, and without config.json or with a DATA_DIR override', async () => {
    const w = world();
    const s = w.service(w.from);
    await s.start();
    await expect(s.start()).rejects.toMatchObject({ code: 'running' });
    await s.idle();
    const bare = createMigrationService({ stateDir: w.state, hlsDir: w.from, contentDir: () => w.content, diskPresent: () => true, ...limits, configDir: join(w.root, 'none'), env: {}, deps: same() });
    await expect(bare.start()).rejects.toMatchObject({ code: 'no_config' });
    const pinned = createMigrationService({ stateDir: w.state, hlsDir: w.from, contentDir: () => w.content, diskPresent: () => true, ...limits, configDir: w.cfg, env: { DATA_DIR: '/x' }, deps: same() });
    await expect(pinned.start()).rejects.toMatchObject({ code: 'env_override' });
  });

  it('exposes plan, start, status and confirm-free-origin over HTTP', async () => {
    const w = world();
    const { db } = setup();
    const service = w.service(w.from);
    const app = buildApp({ db, dataMigration: service });
    const plan = await app.inject('/api/data-migration/plan');
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toMatchObject({ method: 'link', pendingCount: 2, to: w.dest });
    expect((await app.inject({ method: 'POST', url: '/api/data-migration/start', payload: {} })).statusCode).toBe(202);
    await service.idle();
    const status = await app.inject('/api/data-migration/status');
    expect(status.json()).toMatchObject({ job: { state: 'completed' }, pointerSwitched: true, restartRequired: true });
    const early = await app.inject({ method: 'POST', url: '/api/data-migration/confirm-free-origin' });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe('restart_required');
    const relative = await app.inject({ method: 'POST', url: '/api/data-migration/start', payload: { to: 'relative/dir' } });
    expect(relative.statusCode).toBe(400);
  });
});
