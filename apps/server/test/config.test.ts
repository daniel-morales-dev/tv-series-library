import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import {
  autoScanAllowed,
  configDir,
  configStatus,
  readMarker,
  readUserConfig,
  resolveContentDir,
  setContentDir,
  writeMarker,
  writeUserConfig,
} from '../src/config/config.ts';
import { openDb } from '../src/db/connection.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const roots: string[] = [];
const previousConfigDir = process.env.SALA_CONFIG_DIR;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sala-config-'));
  roots.push(root);
  return root;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.SALA_CONFIG_DIR;
  else process.env.SALA_CONFIG_DIR = previousConfigDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('configDir', () => {
  it('honors the SALA_CONFIG_DIR override, XDG_CONFIG_HOME and the Linux default', () => {
    expect(configDir({ SALA_CONFIG_DIR: '/custom/sala' })).toBe('/custom/sala');
    expect(configDir({ XDG_CONFIG_HOME: '/xdg' })).toBe(join('/xdg', 'sala'));
    expect(configDir({})).toBe(join(homedir(), '.config', 'sala'));
  });
});

describe('config.json and marker persistence', () => {
  it('writes atomically, reads back and leaves no partial files behind', () => {
    const dir = join(tempRoot(), 'cfg');
    writeUserConfig({ contentDir: '/media/library', libraryId: 'abc' }, dir);
    expect(readUserConfig({ dir })).toEqual({ contentDir: '/media/library', libraryId: 'abc' });
    expect(readdirSync(dir)).toEqual(['config.json']);
    writeUserConfig({ contentDir: '/media/other', libraryId: 'abc' }, dir);
    expect(readUserConfig({ dir })).toEqual({ contentDir: '/media/other', libraryId: 'abc' });
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('treats a corrupt or invalid config.json as no config, with a warning', () => {
    const dir = join(tempRoot(), 'cfg');
    mkdirSync(dir);
    const warn = vi.fn();
    expect(readUserConfig({ dir, warn })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    writeFileSync(join(dir, 'config.json'), '{not json');
    expect(readUserConfig({ dir, warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ contentDir: 'relative/path' }));
    expect(readUserConfig({ dir, warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reads and writes the library marker, treating corrupt files as absent', () => {
    const content = tempRoot();
    expect(readMarker(content)).toBeNull();
    writeMarker(content, 'lib-1');
    expect(readMarker(content)).toEqual({ libraryId: 'lib-1' });
    writeFileSync(join(content, '.sala-library.json'), 'nope');
    const warn = vi.fn();
    expect(readMarker(content, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('resolveContentDir', () => {
  it('resolves env override → config.json → default', () => {
    const dir = join(tempRoot(), 'cfg');
    const media = tempRoot();
    expect(resolveContentDir({}, { dir })).toBe('./content');
    writeUserConfig({ contentDir: media, libraryId: 'x' }, dir);
    expect(resolveContentDir({}, { dir })).toBe(media);
    expect(resolveContentDir({ CONTENT_DIR: '/env/media' }, { dir })).toBe('/env/media');
  });
});

describe('configStatus', () => {
  it('reports unset without config.json, never creating it, and suggests an existing default', () => {
    const dir = join(tempRoot(), 'cfg');
    const media = tempRoot();
    expect(configStatus(media, { dir })).toEqual({ status: 'unset', contentDir: null, libraryId: null, suggestedDefault: media });
    expect(configStatus(join(media, 'gone'), { dir }).suggestedDefault).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it('reports ready and adopts the marker libraryId into config.json', () => {
    const dir = join(tempRoot(), 'cfg');
    const media = tempRoot();
    writeUserConfig({ contentDir: media, libraryId: 'from-config' }, dir);
    writeMarker(media, 'from-marker');
    expect(configStatus(media, { dir })).toEqual({
      status: 'ready',
      contentDir: media,
      libraryId: 'from-marker',
      suggestedDefault: media,
    });
    expect(readUserConfig({ dir })?.libraryId).toBe('from-marker');
  });

  it('reports ready and writes the missing marker from config.json', () => {
    const dir = join(tempRoot(), 'cfg');
    const media = tempRoot();
    writeUserConfig({ contentDir: media, libraryId: 'lib-x' }, dir);
    expect(configStatus(media, { dir })).toEqual({ status: 'ready', contentDir: media, libraryId: 'lib-x', suggestedDefault: media });
    expect(readMarker(media)).toEqual({ libraryId: 'lib-x' });
  });

  it('reports ready and backfills a generated id when neither marker nor config carry one', () => {
    const dir = join(tempRoot(), 'cfg');
    const media = tempRoot();
    mkdirSync(dir);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ contentDir: media }));
    const status = configStatus(media, { dir });
    expect(status.status).toBe('ready');
    expect(status.libraryId).toMatch(UUID);
    expect(readMarker(media)).toEqual({ libraryId: status.libraryId });
    expect(readUserConfig({ dir })?.libraryId).toBe(status.libraryId);
  });

  it('reports missing without creating or modifying anything', () => {
    const dir = join(tempRoot(), 'cfg');
    const media = join(tempRoot(), 'unplugged');
    writeUserConfig({ contentDir: media, libraryId: 'lib-x' }, dir);
    const before = readFileSync(join(dir, 'config.json'), 'utf8');
    expect(configStatus(media, { dir })).toEqual({ status: 'missing', contentDir: media, libraryId: 'lib-x', suggestedDefault: null });
    expect(existsSync(media)).toBe(false);
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before);
  });
});

describe('autoScanAllowed', () => {
  it('allows scanning for unset and ready, and blocks it only for missing', () => {
    expect(autoScanAllowed({ status: 'unset', contentDir: null, libraryId: null, suggestedDefault: null })).toBe(true);
    expect(autoScanAllowed({ status: 'ready', contentDir: '/media/library', libraryId: 'lib-x', suggestedDefault: '/media/library' })).toBe(true);
    expect(autoScanAllowed({ status: 'missing', contentDir: '/media/unplugged', libraryId: null, suggestedDefault: null })).toBe(false);
  });
});

describe('setContentDir', () => {
  it('rejects relative paths, missing dirs without create and non-directories', () => {
    const dir = join(tempRoot(), 'cfg');
    expect(setContentDir('relative/media', { dir })).toEqual({ ok: false, error: 'invalid_path' });
    expect(setContentDir(join(tempRoot(), 'gone'), { dir })).toEqual({ ok: false, error: 'not_found' });
    const file = join(tempRoot(), 'afile');
    writeFileSync(file, 'x');
    expect(setContentDir(file, { dir })).toEqual({ ok: false, error: 'not_directory' });
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
  });

  it('creates the folder on demand, stores a fresh id in marker and config', () => {
    const configDirectory = join(tempRoot(), 'cfg');
    const media = join(tempRoot(), 'new-library');
    const result = setContentDir(media, { dir: configDirectory, create: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toEqual({ status: 'ready', contentDir: media, libraryId: expect.stringMatching(UUID), suggestedDefault: media });
    expect(readJson(join(media, '.sala-library.json'))).toEqual({ libraryId: result.status.libraryId });
    expect(readJson(join(configDirectory, 'config.json'))).toEqual({ contentDir: media, libraryId: result.status.libraryId });
  });

  it('adopts an existing marker id and keeps the marker untouched', () => {
    const configDirectory = join(tempRoot(), 'cfg');
    const media = tempRoot();
    writeMarker(media, 'lib-from-disk');
    const before = readFileSync(join(media, '.sala-library.json'), 'utf8');
    const result = setContentDir(media, { dir: configDirectory });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.libraryId).toBe('lib-from-disk');
    expect(readFileSync(join(media, '.sala-library.json'), 'utf8')).toBe(before);
    expect(readUserConfig({ dir: configDirectory })?.libraryId).toBe('lib-from-disk');
  });
});

describe('config API', () => {
  let cfg: string;

  beforeEach(() => {
    cfg = join(tempRoot(), 'cfg');
    process.env.SALA_CONFIG_DIR = cfg;
  });

  it('GET /api/config reports unset with the suggested default from the resolved dir', async () => {
    const media = tempRoot();
    const app = buildApp({ db: openDb(':memory:'), config: { currentContentDir: () => media } });
    expect((await app.inject('/api/config')).json()).toEqual({ status: 'unset', contentDir: null, libraryId: null, suggestedDefault: media });
    expect(existsSync(cfg)).toBe(false);
  });

  it('GET /api/config reports missing without touching the folder', async () => {
    const media = join(tempRoot(), 'unplugged');
    writeUserConfig({ contentDir: media, libraryId: 'lib-x' }, cfg);
    const app = buildApp({ db: openDb(':memory:'), config: { currentContentDir: () => media } });
    expect((await app.inject('/api/config')).json()).toEqual({
      status: 'missing',
      contentDir: media,
      libraryId: 'lib-x',
      suggestedDefault: null,
    });
    expect(existsSync(media)).toBe(false);
  });

  it('PUT /api/config/content-dir rejects invalid_path, not_found and not_directory', async () => {
    const app = buildApp({ db: openDb(':memory:') });
    const invalid = await app.inject({ method: 'PUT', url: '/api/config/content-dir', payload: { path: 'relative/media' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'invalid_path' });

    const missing = join(tempRoot(), 'gone');
    const notFound = await app.inject({ method: 'PUT', url: '/api/config/content-dir', payload: { path: missing } });
    expect(notFound.statusCode).toBe(400);
    expect(notFound.json()).toEqual({ error: 'not_found' });
    expect(existsSync(missing)).toBe(false);

    const file = join(tempRoot(), 'afile');
    writeFileSync(file, 'x');
    const notDirectory = await app.inject({ method: 'PUT', url: '/api/config/content-dir', payload: { path: file } });
    expect(notDirectory.statusCode).toBe(400);
    expect(notDirectory.json()).toEqual({ error: 'not_directory' });
    expect(existsSync(join(cfg, 'config.json'))).toBe(false);
  });

  it('PUT /api/config/content-dir creates, persists, answers like GET and triggers the scan callback', async () => {
    const media = join(tempRoot(), 'new-library');
    const onReady = vi.fn();
    const app = buildApp({ db: openDb(':memory:'), config: { onReady } });
    const created = await app.inject({ method: 'PUT', url: '/api/config/content-dir', payload: { path: media, create: true } });
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body).toEqual({ status: 'ready', contentDir: media, libraryId: expect.stringMatching(UUID), suggestedDefault: media });
    expect(onReady).toHaveBeenCalledExactlyOnceWith(media);
    expect(readJson(join(media, '.sala-library.json'))).toEqual({ libraryId: body.libraryId });
    expect(readJson(join(cfg, 'config.json'))).toEqual({ contentDir: media, libraryId: body.libraryId });
    expect((await app.inject('/api/config')).json()).toEqual(body);
  });

  it('PUT /api/config/content-dir adopts an existing marker on a second machine', async () => {
    const media = tempRoot();
    writeMarker(media, 'lib-from-disk');
    const app = buildApp({ db: openDb(':memory:') });
    const adopted = await app.inject({ method: 'PUT', url: '/api/config/content-dir', payload: { path: media } });
    expect(adopted.statusCode).toBe(200);
    expect(adopted.json()).toEqual({ status: 'ready', contentDir: media, libraryId: 'lib-from-disk', suggestedDefault: media });
    expect(readMarker(media)).toEqual({ libraryId: 'lib-from-disk' });
  });
});
