import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { MARKER_FILE, readMarker, setContentDir, writeMarker, writeUserConfig } from '../src/config/config.ts';
import { candidateRoots, findMovedLibrary } from '../src/config/relocate.ts';
import { openDb } from '../src/db/connection.ts';

const roots: string[] = [];
const previousConfigDir = process.env.SALA_CONFIG_DIR;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sala-relocate-'));
  roots.push(root);
  return root;
}
function library(path: string, libraryId: string): string {
  mkdirSync(path, { recursive: true });
  writeMarker(path, libraryId);
  return path;
}
afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.SALA_CONFIG_DIR;
  else process.env.SALA_CONFIG_DIR = previousConfigDir;
  for (const root of roots.splice(0)) {
    try {
      chmodSync(join(root, 'mnt', 'locked'), 0o755);
    } catch {
      // not every test creates it
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('findMovedLibrary', () => {
  it('finds the marker with the same libraryId one or two levels below a mount root', () => {
    const mnt = join(tempRoot(), 'mnt');
    const direct = library(join(mnt, 'DISK1'), 'lib-1');
    const nested = library(join(mnt, 'DISK2', 'series'), 'lib-1');
    expect(findMovedLibrary({ libraryId: 'lib-1', roots: [mnt] }).sort()).toEqual([direct, nested].sort());
  });

  it('only offers folders whose marker has the matching libraryId and never creates markers', () => {
    const mnt = join(tempRoot(), 'mnt');
    library(join(mnt, 'OTHER'), 'lib-2');
    const wanted = library(join(mnt, 'WANTED'), 'lib-1');
    mkdirSync(join(mnt, 'EMPTY'));
    expect(findMovedLibrary({ libraryId: 'lib-1', roots: [mnt] })).toEqual([wanted]);
    expect(findMovedLibrary({ libraryId: 'lib-9', roots: [mnt] })).toEqual([]);
    expect(readMarker(join(mnt, 'EMPTY'), () => {})).toBeNull();
  });

  it('skips unreadable dirs, missing roots and the excluded path, and respects the deadline', () => {
    const mnt = join(tempRoot(), 'mnt');
    const locked = join(mnt, 'locked');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    const good = library(join(mnt, 'GOOD'), 'lib-1');
    const old = library(join(mnt, 'OLD'), 'lib-1');
    expect(findMovedLibrary({ libraryId: 'lib-1', roots: [join(mnt, 'nope'), mnt], exclude: old })).toEqual([good]);
    expect(findMovedLibrary({ libraryId: 'lib-1', roots: [mnt], deadlineMs: -1 })).toEqual([]);
  });
});

describe('candidateRoots', () => {
  it('lists the Linux mount parents for the user plus siblings of the configured folder', () => {
    expect(candidateRoots('/media/ana/DISK/series', { USER: 'ana' }, 'linux')).toEqual([
      '/media/ana',
      '/run/media/ana',
      '/mnt',
      '/media/ana/DISK',
    ]);
  });
});

describe('GET /api/config/candidates', () => {
  it('offers the moved library when the configured folder is missing, and accepting is a normal PUT', async () => {
    const root = tempRoot();
    const mnt = join(root, 'mnt');
    writeUserConfig({ contentDir: join(root, 'gone', 'series'), libraryId: 'lib-1' }, join(root, 'cfg'));
    process.env.SALA_CONFIG_DIR = join(root, 'cfg');
    library(join(mnt, 'OTHER'), 'lib-2');
    const moved = library(join(mnt, 'DISK'), 'lib-1');
    const app = buildApp({ db: openDb(':memory:'), config: { mountRoots: () => [mnt] } });
    expect((await app.inject('/api/config')).json().status).toBe('missing');
    expect((await app.inject('/api/config/candidates')).json()).toEqual({ candidates: [{ path: moved, label: 'DISK' }] });
    const put = await app.inject({ method: 'PUT', url: '/api/config/content-dir', payload: { path: moved } });
    expect(put.json()).toMatchObject({ status: 'ready', contentDir: moved, libraryId: 'lib-1' });
  });

  it('offers nothing when unset or ready', async () => {
    const root = tempRoot();
    const mnt = join(root, 'mnt');
    library(join(mnt, 'DISK'), 'lib-1');
    process.env.SALA_CONFIG_DIR = join(root, 'cfg');
    const app = buildApp({ db: openDb(':memory:'), config: { mountRoots: () => [mnt] } });
    expect((await app.inject('/api/config/candidates')).json()).toEqual({ candidates: [] });
    setContentDir(library(join(root, 'ready'), 'lib-1'));
    expect((await app.inject('/api/config/candidates')).json()).toEqual({ candidates: [] });
    expect(MARKER_FILE).toBe('.sala-library.json');
  });
});
