/**
 * Wiring tests for the real server entry (src/index.ts). Each test boots the entry as a child process on an
 * ephemeral port with throwaway dirs, so what is exercised is the wiring index.ts performs — a hand-built
 * app in a test cannot catch a dependency that index.ts never passes.
 *
 * The fake tools are the ones the suite already uses: test/fake-ffmpeg.mjs (HLS package writer) and a
 * one-line ffprobe stand-in. The child inherits none of the dev shell's SALA_* / CONTENT_DIR / etc. variables.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/connection.ts';
import { get, run } from '../src/db/sql.ts';
import { writeMarker, writeUserConfig } from '../src/config/config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '../src/index.ts');
const fakeFfmpeg = resolve(here, 'fake-ffmpeg.mjs');

/** Everything a dev shell could have set that would change what index.ts resolves. */
const LEAKY_ENV = [
  'CONTENT_DIR',
  'DATA_DIR',
  'PORT',
  'SALA_CONFIG_DIR',
  'TMDB_READ_ACCESS_TOKEN',
  'TMDB_API_BASE',
  'INGEST',
  'PROCESSING',
  'INGEST_SCAN_INTERVAL_MIN',
  'FFMPEG_BIN',
  'FFPROBE_BIN',
  'WEB_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'WATCHDOG_STALL_S',
  'MIN_FREE_GB',
  'MIN_FREE_PCT',
  'CACHE_BUDGET_GB',
  'PROCESS_CONCURRENCY',
  'FFMPEG_THREADS',
];

/** One h264/aac file: the worker picks copy mode, exactly like a normal rip. */
const PROBE_JSON = {
  format: { duration: '90.5' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'spa' } },
  ],
};

const children = new Set<ChildProcess>();
const tmdbServers = new Set<Server>();
const roots: string[] = [];

function tempRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `sala-live-${name}-`));
  roots.push(root);
  return root;
}

/** Fake ffmpeg/ffprobe pair: the probe answers instantly and the encoder writes the package on its first tick. */
function fakeTools(root: string): { ffmpegBin: string; ffprobeBin: string; gate: string } {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const ffmpegBin = join(bin, 'ffmpeg');
  writeFileSync(ffmpegBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeFfmpeg}" "$@"\n`);
  chmodSync(ffmpegBin, 0o755);
  const ffprobeBin = join(bin, 'ffprobe');
  writeFileSync(ffprobeBin, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(PROBE_JSON))});\n`);
  chmodSync(ffprobeBin, 0o755);
  const gate = join(root, 'gate');
  writeFileSync(gate, 'go');
  return { ffmpegBin, ffprobeBin, gate };
}

async function startServer(overrides: Record<string, string>): Promise<{ base: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of LEAKY_ENV) delete env[key];
  Object.assign(env, overrides);
  const child = spawn(process.execPath, [serverEntry], {
    cwd: resolve(here, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  const base = await new Promise<string>((ready, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not listen:\n${output}`)), 30_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /Server listening at http:\/\/[^/]+:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        ready(`http://127.0.0.1:${match[1]}`);
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${code}):\n${output}`));
    });
  });
  return { base, logs: () => output };
}

interface Answer<T> {
  status: number;
  body: T;
}

async function api<T>(base: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Answer<T>> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function waitFor<T>(what: string, probe: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await new Promise((tick) => setTimeout(tick, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface JobView {
  id: number;
  mediaFileId: number;
  path: string;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: number;
  error: string | null;
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((tick) => setTimeout(tick, 5_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  children.clear();
  for (const server of tmdbServers) {
    server.closeAllConnections();
    await new Promise((done) => server.close(() => done(null)));
  }
  tmdbServers.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('content dir reconfigure on a running server', () => {
  it('processes a video dropped in the new folder to HLS, without a restart', async () => {
    const root = tempRoot('content');
    const cfg = join(root, 'cfg');
    const data = join(root, 'data');
    const oldDisk = join(root, 'old-disk');
    const newDisk = join(root, 'new-disk');
    // Boot configured on the old disk; the same library (same marker id) reappears on the new disk.
    mkdirSync(oldDisk, { recursive: true });
    mkdirSync(newDisk, { recursive: true });
    writeMarker(oldDisk, 'lib-a');
    writeMarker(newDisk, 'lib-a');
    writeUserConfig({ contentDir: oldDisk, libraryId: 'lib-a' }, cfg);
    const tools = fakeTools(root);

    const { base } = await startServer({
      SALA_CONFIG_DIR: cfg,
      DATA_DIR: data,
      PORT: '0',
      WATCHDOG_STALL_S: '0',
      WEB_DIR: join(root, 'no-web'),
      MIN_FREE_GB: '0',
      MIN_FREE_PCT: '0',
      INGEST_SCAN_INTERVAL_MIN: '0.05',
      FFMPEG_BIN: tools.ffmpegBin,
      FFPROBE_BIN: tools.ffprobeBin,
      FAKE_FFMPEG_GATE: tools.gate,
    });

    // The old disk is gone: only a refreshed root row can stay "present" from here on.
    rmSync(oldDisk, { recursive: true, force: true });

    const put = await api<{ status: string; contentDir: string }>(base, '/api/config/content-dir', {
      method: 'PUT',
      body: { path: newDisk, create: true },
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ status: 'ready', contentDir: newDisk });
    // The scanner only reads shows/ and films/: a fresh folder must have them.
    expect(existsSync(join(newDisk, 'shows'))).toBe(true);
    expect(existsSync(join(newDisk, 'films'))).toBe(true);

    // Root 1 follows the new folder, so availability does not point at the unmounted disk.
    const rootsAnswer = await api<{ roots: { id: number; path: string | null; lastKnownPath: string | null; present: boolean }[] }>(base, '/api/roots');
    expect(rootsAnswer.body.roots[0]).toMatchObject({ id: 1, path: newDisk, lastKnownPath: newDisk, present: true });

    // Drop a video (old enough for the ingestor's partial-copy guard) into the NEW folder.
    const showDir = join(newDisk, 'shows', 'Test Show');
    mkdirSync(showDir, { recursive: true });
    const video = join(showDir, 'S01E01.mkv');
    writeFileSync(video, 'video');
    const aged = new Date(Date.now() - 5 * 60_000);
    utimesSync(video, aged, aged);

    const job = await waitFor(
      'the dropped file to be ingested and processed',
      async () => {
        const jobs = (await api<JobView[]>(base, '/api/jobs')).body;
        const mine = jobs.find((j) => j.path.endsWith('S01E01.mkv'));
        if (!mine) return null;
        if (mine.status === 'error') throw new Error(`job failed: ${mine.error}`);
        return mine.status === 'done' ? mine : null;
      },
      60_000,
    );

    // Copy-mode packages are built lazily: the first play is what asks for the HLS tree.
    const play = await api<{ status: string; preparing: boolean }>(base, `/api/media-files/${job.mediaFileId}/play`, { method: 'POST' });
    expect(play.status).toBe(202);
    expect(play.body).toMatchObject({ status: 'processing', preparing: true });

    const packageDir = join(data, 'hls', String(job.mediaFileId));
    await waitFor('the HLS package', async () => (existsSync(join(packageDir, 'master.m3u8')) ? true : null), 30_000);
    expect(existsSync(join(packageDir, 'v', 'index.m3u8'))).toBe(true);
    expect(existsSync(join(packageDir, 'master.m3u8'))).toBe(true);
    expect(existsSync(`${packageDir}.tmp`)).toBe(false);
  }, 120_000);
});

describe('refresh-metadata through the server entry', () => {
  /** Pre-seeds a linked title so the endpoint has something to refresh. */
  function seedLinkedTitle(dataDir: string): void {
    mkdirSync(dataDir, { recursive: true });
    const db = openDb(join(dataDir, 'library.db'));
    run(db, "INSERT INTO titles (tmdb_type, tmdb_id, kind, title, metadata_status) VALUES ('tv', 46195, 'series', 'Pendiente', 'ready')");
    db.close();
  }

  it('reaches TMDB when a token is configured', async () => {
    const root = tempRoot('tmdb');
    const data = join(root, 'data');
    seedLinkedTitle(data);

    const seen: { url: string; authorization: string | undefined }[] = [];
    const tmdb = createServer((req, res) => {
      seen.push({ url: req.url ?? '', authorization: req.headers.authorization });
      if (req.url?.startsWith('/3/tv/46195')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 46195,
            name: 'Monogatari',
            original_name: 'Monogatari',
            overview: 'Una serie.',
            first_air_date: '2009-07-03',
            episode_run_time: [25],
            vote_average: 8.1,
            genres: [{ id: 16, name: 'Animación' }],
            poster_path: null,
            backdrop_path: null,
            origin_country: ['JP'],
            seasons: [],
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    tmdbServers.add(tmdb);
    await new Promise<void>((listening) => tmdb.listen(0, '127.0.0.1', listening));

    const { base } = await startServer({
      SALA_CONFIG_DIR: join(root, 'cfg'),
      DATA_DIR: data,
      PORT: '0',
      WATCHDOG_STALL_S: '0',
      WEB_DIR: join(root, 'no-web'),
      INGEST: 'off',
      PROCESSING: 'off',
      TMDB_READ_ACCESS_TOKEN: 'test-token',
      TMDB_API_BASE: `http://127.0.0.1:${(tmdb.address() as AddressInfo).port}/3`,
    });

    const res = await api<{ ok: boolean }>(base, '/api/titles/1/refresh-metadata', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(seen[0]?.url).toContain('/3/tv/46195');
    expect(seen[0]?.authorization).toBe('Bearer test-token');

    const check = openDb(join(data, 'library.db'));
    expect(get<{ title: string }>(check, 'SELECT title FROM titles WHERE id = 1')?.title).toBe('Monogatari');
    check.close();
  }, 60_000);

  it('keeps answering 503 without a token', async () => {
    const root = tempRoot('tmdb-off');
    const data = join(root, 'data');
    seedLinkedTitle(data);

    const { base } = await startServer({
      SALA_CONFIG_DIR: join(root, 'cfg'),
      DATA_DIR: data,
      PORT: '0',
      WATCHDOG_STALL_S: '0',
      WEB_DIR: join(root, 'no-web'),
      INGEST: 'off',
      PROCESSING: 'off',
    });

    const res = await api<{ error: string; message: string }>(base, '/api/titles/1/refresh-metadata', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'tmdb_unavailable', message: 'TMDB no está disponible.' });
  }, 60_000);
});
