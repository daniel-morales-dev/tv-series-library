import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import {
  autoScanAllowed,
  configDir,
  configStatus,
  readMarker,
  REPO_ROOT,
  readUserConfig,
  resolveContentDir,
  resolveTmdbToken,
  setContentDir,
  setTmdbToken,
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
  it('resolves env override → config.json → default, always absolute', () => {
    const dir = join(tempRoot(), 'cfg');
    const media = tempRoot();
    const root = '/srv/repo';
    expect(resolveContentDir({}, { dir, root })).toBe('/srv/repo/content');
    writeUserConfig({ contentDir: media, libraryId: 'x' }, dir);
    expect(resolveContentDir({}, { dir, root })).toBe(media);
    expect(resolveContentDir({ CONTENT_DIR: '/env/media' }, { dir, root })).toBe('/env/media');
  });

  it('anchors a relative CONTENT_DIR to the repo root, not to the cwd', () => {
    const dir = join(tempRoot(), 'cfg');
    const cwd = process.cwd();
    try {
      process.chdir(tempRoot());
      expect(resolveContentDir({ CONTENT_DIR: './media' }, { dir, root: '/srv/repo' })).toBe('/srv/repo/media');
      expect(resolveContentDir({}, { dir, root: '/srv/repo' })).toBe('/srv/repo/content');
    } finally {
      process.chdir(cwd);
    }
  });

  it('defaults the root to the repository containing apps/server, whatever the cwd', () => {
    const dir = join(tempRoot(), 'cfg');
    expect(resolveContentDir({}, { dir })).toBe(join(REPO_ROOT, 'content'));
    expect(existsSync(join(REPO_ROOT, 'apps', 'server', 'src'))).toBe(true);
  });

  it('ignores an empty CONTENT_DIR instead of resolving to the repo root', () => {
    const dir = join(tempRoot(), 'cfg');
    expect(resolveContentDir({ CONTENT_DIR: '' }, { dir, root: '/srv/repo' })).toBe('/srv/repo/content');
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

  it('reports ready and adopts the marker libraryId when config.json carries none', () => {
    const dir = join(tempRoot(), 'cfg');
    const media = tempRoot();
    mkdirSync(dir);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ contentDir: media }));
    writeMarker(media, 'from-marker');
    expect(configStatus(media, { dir })).toEqual({ status: 'ready', contentDir: media, libraryId: 'from-marker', suggestedDefault: media });
    expect(readUserConfig({ dir })?.libraryId).toBe('from-marker');
  });

  it('reports ready when marker and config agree', () => {
    const dir = join(tempRoot(), 'cfg');
    const media = tempRoot();
    writeUserConfig({ contentDir: media, libraryId: 'lib-x' }, dir);
    writeMarker(media, 'lib-x');
    expect(configStatus(media, { dir })).toEqual({ status: 'ready', contentDir: media, libraryId: 'lib-x', suggestedDefault: media });
  });

  it('reports missing, without writing a marker, when the folder has none (T47d: only the wizard creates it)', () => {
    const dir = join(tempRoot(), 'cfg');
    const media = tempRoot();
    mkdirSync(dir);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ contentDir: media }));
    expect(configStatus(media, { dir })).toMatchObject({ status: 'missing', libraryId: null });
    expect(readMarker(media)).toBeNull();
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
    expect(autoScanAllowed({ status: 'unset', contentDir: null, libraryId: null, suggestedDefault: '/srv/repo/content' })).toBe(true);
    // Unset with a default folder that does not exist behaves like `missing`: never scan or touch the catalog.
    expect(autoScanAllowed({ status: 'unset', contentDir: null, libraryId: null, suggestedDefault: null })).toBe(false);
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

  it('creates the shows/ and films/ folders the scanner reads, and re-saving is idempotent', () => {
    const configDirectory = join(tempRoot(), 'cfg');
    const media = join(tempRoot(), 'new-library');
    expect(setContentDir(media, { dir: configDirectory, create: true }).ok).toBe(true);
    expect(existsSync(join(media, 'shows'))).toBe(true);
    expect(existsSync(join(media, 'films'))).toBe(true);
    // Saving the same folder again must not fail on the folders that already exist.
    expect(setContentDir(media, { dir: configDirectory }).ok).toBe(true);
    expect(existsSync(join(media, 'shows'))).toBe(true);
    expect(existsSync(join(media, 'films'))).toBe(true);
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
    // T58: GET /api/config reports tmdbConfigured from env → config.json; keep it deterministic for the exact-body assertions.
    delete process.env.TMDB_READ_ACCESS_TOKEN;
  });

  it('GET /api/config reports unset with the suggested default from the resolved dir', async () => {
    const media = tempRoot();
    const app = buildApp({ db: openDb(':memory:'), config: { currentContentDir: () => media } });
    expect((await app.inject('/api/config')).json()).toEqual({
      status: 'unset',
      contentDir: null,
      libraryId: null,
      suggestedDefault: media,
      tmdbConfigured: false,
    });
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
      tmdbConfigured: false,
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
    expect((await app.inject('/api/config')).json()).toEqual({ ...body, tmdbConfigured: false });
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

describe('setTmdbToken and resolveTmdbToken', () => {
  it('trims the token, keeps the rest of the config and clears it with an empty string', () => {
    const dir = join(tempRoot(), 'cfg');
    // Without config.json there is no library to merge into: the wizard picks the folder first.
    expect(setTmdbToken('abc', { dir })).toEqual({ ok: false, error: 'no_config' });

    writeUserConfig({ contentDir: '/media/library', libraryId: 'lib-x' }, dir);
    expect(setTmdbToken('  abc  ', { dir })).toEqual({ ok: true, tmdbConfigured: true });
    expect(readUserConfig({ dir })).toEqual({ contentDir: '/media/library', libraryId: 'lib-x', tmdbToken: 'abc' });

    expect(setTmdbToken('   ', { dir })).toEqual({ ok: true, tmdbConfigured: false });
    expect(readUserConfig({ dir })).toEqual({ contentDir: '/media/library', libraryId: 'lib-x' });
  });

  it('resolves env over config.json and ignores an empty stored token', () => {
    const dir = join(tempRoot(), 'cfg');
    writeUserConfig({ contentDir: '/media/library', tmdbToken: 'from-file' }, dir);
    expect(resolveTmdbToken({}, { dir })).toBe('from-file');
    expect(resolveTmdbToken({ TMDB_READ_ACCESS_TOKEN: 'from-env' }, { dir })).toBe('from-env');
    expect(resolveTmdbToken({ TMDB_READ_ACCESS_TOKEN: '   ' }, { dir })).toBe('from-file');
    expect(resolveTmdbToken({}, { dir: join(tempRoot(), 'empty') })).toBeNull();

    writeFileSync(join(dir, 'config.json'), JSON.stringify({ contentDir: '/media/library', tmdbToken: '   ' }));
    expect(readUserConfig({ dir })?.tmdbToken).toBeUndefined();
    expect(resolveTmdbToken({}, { dir })).toBeNull();
  });
});

describe('TMDB token API', () => {
  let cfg: string;
  let servers: Server[] = [];
  const savedBase = process.env.TMDB_API_BASE;
  const savedToken = process.env.TMDB_READ_ACCESS_TOKEN;

  beforeEach(() => {
    cfg = join(tempRoot(), 'cfg');
    process.env.SALA_CONFIG_DIR = cfg;
    delete process.env.TMDB_READ_ACCESS_TOKEN;
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((done) => server.close(() => done(null)));
    }
    if (savedBase === undefined) delete process.env.TMDB_API_BASE;
    else process.env.TMDB_API_BASE = savedBase;
    if (savedToken === undefined) delete process.env.TMDB_READ_ACCESS_TOKEN;
    else process.env.TMDB_READ_ACCESS_TOKEN = savedToken;
  });

  type Seen = { url: string; authorization: string | undefined };

  /** Fake TMDB on an ephemeral port; `null` from `respond` kills the socket (network failure). */
  async function startFakeTmdb(respond: (seen: Seen) => { status: number; body?: unknown } | null): Promise<Seen[]> {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
      const entry: Seen = { url: req.url ?? '', authorization: req.headers.authorization };
      seen.push(entry);
      const answer = respond(entry);
      if (!answer) {
        req.socket.destroy();
        return;
      }
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body ?? {}));
    });
    servers.push(server);
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    process.env.TMDB_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}/3`;
    return seen;
  }

  function readyConfig(media: string): void {
    writeUserConfig({ contentDir: media, libraryId: 'lib-x' }, cfg);
    writeMarker(media, 'lib-x');
  }

  it('PUT stores the token and GET /api/config only reports the boolean', async () => {
    const media = tempRoot();
    readyConfig(media);
    const app = buildApp({ db: openDb(':memory:'), config: { currentContentDir: () => media } });

    const put = await app.inject({ method: 'PUT', url: '/api/config/tmdb-token', payload: { token: '  secret-token  ' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ ok: true, tmdbConfigured: true });
    expect(readUserConfig({ dir: cfg })?.tmdbToken).toBe('secret-token');

    const get = await app.inject('/api/config');
    expect(get.json()).toEqual({ status: 'ready', contentDir: media, libraryId: 'lib-x', suggestedDefault: media, tmdbConfigured: true });
    expect(JSON.stringify(get.json())).not.toContain('secret-token');
  });

  it('a saved token triggers the retry hook; an empty token clears it without triggering', async () => {
    const media = tempRoot();
    readyConfig(media);
    const onTmdbTokenSaved = vi.fn();
    const app = buildApp({ db: openDb(':memory:'), config: { currentContentDir: () => media, onTmdbTokenSaved } });

    const saved = await app.inject({ method: 'PUT', url: '/api/config/tmdb-token', payload: { token: 'tok' } });
    expect(saved.statusCode).toBe(200);
    expect(onTmdbTokenSaved).toHaveBeenCalledTimes(1);

    const cleared = await app.inject({ method: 'PUT', url: '/api/config/tmdb-token', payload: { token: '' } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ ok: true, tmdbConfigured: false });
    expect(onTmdbTokenSaved).toHaveBeenCalledTimes(1);
    expect((await app.inject('/api/config')).json()).toMatchObject({ tmdbConfigured: false });
    expect(readUserConfig({ dir: cfg })?.tmdbToken).toBeUndefined();
  });

  it('documents the next-scan fallback when no retry hook is wired', async () => {
    const media = tempRoot();
    readyConfig(media);
    const app = buildApp({ db: openDb(':memory:'), config: { currentContentDir: () => media } });
    const res = await app.inject({ method: 'PUT', url: '/api/config/tmdb-token', payload: { token: 'tok' } });
    expect(res.json()).toMatchObject({ message: expect.stringContaining('hasta 5 minutos') });
  });

  it('answers 409 without config.json: the wizard must pick the folder first', async () => {
    const app = buildApp({ db: openDb(':memory:') });
    const res = await app.inject({ method: 'PUT', url: '/api/config/tmdb-token', payload: { token: 'tok' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'no_config', message: 'Configura primero la carpeta de la biblioteca.' });
    expect(existsSync(join(cfg, 'config.json'))).toBe(false);
  });

  it('POST /api/config/tmdb-token/test reports a valid token and sends it to TMDB', async () => {
    const media = tempRoot();
    readyConfig(media);
    const seen = await startFakeTmdb(() => ({ status: 200, body: { results: [] } }));
    const app = buildApp({ db: openDb(':memory:') });

    const res = await app.inject({ method: 'POST', url: '/api/config/tmdb-token/test', payload: { token: 'good-token' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, message: 'Token válido. TMDB respondió correctamente.' });
    expect(seen[0]?.url).toContain('/3/search/tv');
    expect(seen[0]?.authorization).toBe('Bearer good-token');
  });

  it('POST /api/config/tmdb-token/test maps 401 to invalid-token and a dead connection to offline', async () => {
    const app = buildApp({ db: openDb(':memory:') });

    await startFakeTmdb(() => ({ status: 401, body: { status_message: 'Invalid API key' } }));
    const invalid = await app.inject({ method: 'POST', url: '/api/config/tmdb-token/test', payload: { token: 'bad-token' } });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toEqual({ ok: false, error: 'invalid_token', message: 'Token inválido. Verifica que sea el «Read Access Token» de tu cuenta de TMDB.' });

    await startFakeTmdb(() => null);
    const offline = await app.inject({ method: 'POST', url: '/api/config/tmdb-token/test', payload: { token: 'bad-token' } });
    expect(offline.statusCode).toBe(502);
    expect(offline.json()).toEqual({ ok: false, error: 'tmdb_unreachable', message: 'No se pudo conectar con TMDB. Revisa tu conexión e inténtalo de nuevo.' });
  });

  it('POST /api/config/tmdb-token/test falls back to the saved token and requires one to test', async () => {
    const media = tempRoot();
    readyConfig(media);
    const seen = await startFakeTmdb(() => ({ status: 200, body: { results: [] } }));
    const app = buildApp({ db: openDb(':memory:') });

    const missing = await app.inject({ method: 'POST', url: '/api/config/tmdb-token/test', payload: { token: '' } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: 'token_required', message: 'Escribe un token antes de probarlo.' });

    await app.inject({ method: 'PUT', url: '/api/config/tmdb-token', payload: { token: 'saved-token' } });
    const saved = await app.inject({ method: 'POST', url: '/api/config/tmdb-token/test', payload: { token: '' } });
    expect(saved.statusCode).toBe(200);
    expect(seen.at(-1)?.authorization).toBe('Bearer saved-token');
  });
});
