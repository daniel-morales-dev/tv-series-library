import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db/connection.ts';
import { listDirs } from '../src/modules/fs/dirs.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fs-test-'));
  mkdirSync(join(root, 'home', 'series'), { recursive: true });
  mkdirSync(join(root, 'home', 'Peliculas'), { recursive: true });
  mkdirSync(join(root, 'home', '.hidden'), { recursive: true });
  writeFileSync(join(root, 'home', 'notes.txt'), 'x');
  mkdirSync(join(root, 'mnt', 'disk1'), { recursive: true });
  mkdirSync(join(root, 'media', 'user', 'HDD'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const opts = () => ({ home: join(root, 'home'), mountBases: [join(root, 'mnt'), join(root, 'media'), join(root, 'run-media')] });

describe('listDirs', () => {
  it('without a path lists the home folder: only directories, sorted, hidden skipped', () => {
    const r = listDirs(undefined, opts());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.path).toBe(join(root, 'home'));
    expect(r.value.parent).toBe(root);
    expect(r.value.entries.map((e) => e.name)).toEqual(['Peliculas', 'series']);
    expect(r.value.entries[1]?.path).toBe(join(root, 'home', 'series'));
  });

  it('shows hidden folders only when asked', () => {
    const r = listDirs(join(root, 'home'), { ...opts(), showHidden: true });
    expect(r.ok && r.value.entries.map((e) => e.name)).toEqual(['.hidden', 'Peliculas', 'series']);
  });

  it('offers shortcuts: root, home and existing mounts', () => {
    const r = listDirs(undefined, opts());
    if (!r.ok) throw new Error('expected ok');
    const paths = r.value.shortcuts.map((s) => s.path);
    expect(paths).toContain('/');
    expect(paths).toContain(join(root, 'home'));
    expect(paths).toContain(join(root, 'mnt', 'disk1'));
    expect(paths).toContain(join(root, 'media', 'user', 'HDD'));
    expect(paths.some((p) => p.includes('run-media'))).toBe(false);
  });

  it('resolves .. and symlinks to the real path', () => {
    symlinkSync(join(root, 'home', 'series'), join(root, 'link'));
    const viaDots = listDirs(join(root, 'home', 'series', '..', 'Peliculas'), opts());
    expect(viaDots.ok && viaDots.value.path).toBe(join(root, 'home', 'Peliculas'));
    const viaLink = listDirs(join(root, 'link'), opts());
    expect(viaLink.ok && viaLink.value.path).toBe(join(root, 'home', 'series'));
  });

  it('the filesystem root has no parent', () => {
    const r = listDirs('/', opts());
    expect(r.ok && r.value.parent).toBeNull();
    expect(dirname('/')).toBe('/');
  });

  it('rejects relative paths, missing paths and files with clear codes', () => {
    expect(listDirs('home/series', opts())).toMatchObject({ ok: false, error: 'invalid_path' });
    expect(listDirs(join(root, 'nope'), opts())).toMatchObject({ ok: false, error: 'not_found' });
    expect(listDirs(join(root, 'home', 'notes.txt'), opts())).toMatchObject({ ok: false, error: 'not_directory' });
  });

  it.skipIf(process.getuid?.() === 0)('reports a folder without permission', () => {
    const locked = join(root, 'home', 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      expect(listDirs(locked, opts())).toMatchObject({ ok: false, error: 'forbidden' });
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

describe('GET /api/fs/dirs', () => {
  const app = () => buildApp({ db: openDb(':memory:'), fs: opts() });

  it('returns the listing', async () => {
    const res = await app().inject({ url: `/api/fs/dirs?path=${encodeURIComponent(join(root, 'home'))}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries.map((e: { name: string }) => e.name)).toEqual(['Peliculas', 'series']);
  });

  it('answers 400 with a code and a Spanish message', async () => {
    const res = await app().inject({ url: `/api/fs/dirs?path=${encodeURIComponent(join(root, 'nope'))}` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'not_found', message: expect.stringContaining('no existe') });
  });

  it('is read-only: no write verbs', async () => {
    const res = await app().inject({ method: 'PUT', url: '/api/fs/dirs' });
    expect(res.statusCode).toBe(404);
  });
});
