import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db/connection.ts';
import { run } from '../src/db/sql.ts';
import { addTitle } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup(opts: { hls?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-maint-'));
  dirs.push(root);
  const hlsDir = join(root, 'hls');
  if (opts.hls !== false) mkdirSync(hlsDir, { recursive: true });
  const db = openDb(':memory:');
  const app = buildApp({ db, dataDir: join(root, 'data'), hlsDir });
  const titleId = addTitle(db, 'T');
  return { root, hlsDir, db, app, titleId };
}

function pkg(hlsDir: string, name: string, bytes = 100): string {
  const dir = join(hlsDir, name);
  mkdirSync(join(dir, 'v'), { recursive: true });
  writeFileSync(join(dir, 'v', 'seg.m4s'), 'x'.repeat(bytes));
  return dir;
}

function referenced(db: DatabaseSync, id: number, titleId: number): void {
  run(db, 'INSERT INTO media_files (id, path, title_id, status) VALUES (?, ?, ?, ?)', id, `shows/ep${id}.mkv`, titleId, 'ready');
}

const getOrphans = { method: 'GET' as const, url: '/api/maintenance/orphans' };
const purgeUrl = '/api/maintenance/purge-orphans';

describe('GET /api/maintenance/orphans', () => {
  it('lists only packages no media_files row points at, ignoring .tmp and non-numeric dirs', async () => {
    const { hlsDir, db, app, titleId } = setup();
    pkg(hlsDir, '1', 100);
    referenced(db, 1, titleId);
    pkg(hlsDir, '2', 300);
    mkdirSync(join(hlsDir, '3.tmp'), { recursive: true });
    mkdirSync(join(hlsDir, 'fonts'), { recursive: true });

    const res = await app.inject(getOrphans);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ count: 1, bytes: 300, dirs: [{ id: 2, bytes: 300 }] });
  });

  it('answers an empty result when the HLS folder does not exist', async () => {
    const { app } = setup({ hls: false });
    const res = await app.inject(getOrphans);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ count: 0, bytes: 0, dirs: [] });
  });

  it('excludes ids with a queued or running job even without a row (data written with foreign keys off)', async () => {
    const { hlsDir, db, app } = setup();
    pkg(hlsDir, '5', 50);
    db.exec('PRAGMA foreign_keys = OFF');
    run(db, "INSERT INTO jobs (type, media_file_id, status) VALUES ('process', 5, 'running')");
    db.exec('PRAGMA foreign_keys = ON');

    const res = await app.inject(getOrphans);
    expect(res.json()).toEqual({ count: 0, bytes: 0, dirs: [] });
  });
});

describe('POST /api/maintenance/purge-orphans', () => {
  it('requires explicit confirmation and deletes nothing without it', async () => {
    const { hlsDir, app } = setup();
    pkg(hlsDir, '2');
    for (const payload of [{}, { confirm: false }]) {
      const res = await app.inject({ method: 'POST', url: purgeUrl, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('confirm_required');
      expect(res.json().message).toMatch(/confirmar/);
      expect(existsSync(join(hlsDir, '2'))).toBe(true);
    }
  });

  it('removes only orphan packages and reports the freed bytes', async () => {
    const { hlsDir, db, app, titleId } = setup();
    pkg(hlsDir, '1', 100);
    referenced(db, 1, titleId);
    const orphan = pkg(hlsDir, '2', 300);
    pkg(hlsDir, '3', 20);
    referenced(db, 3, titleId);
    mkdirSync(join(hlsDir, '4.tmp'), { recursive: true });

    const res = await app.inject({ method: 'POST', url: purgeUrl, payload: { confirm: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: 1, bytesFreed: 300 });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(hlsDir, '1'))).toBe(true);
    expect(existsSync(join(hlsDir, '3'))).toBe(true);
    expect(existsSync(join(hlsDir, '4.tmp'))).toBe(true);
    expect((await app.inject(getOrphans)).json()).toEqual({ count: 0, bytes: 0, dirs: [] });
  });

  it('is a no-op when the HLS folder does not exist', async () => {
    const { app } = setup({ hls: false });
    const res = await app.inject({ method: 'POST', url: purgeUrl, payload: { confirm: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: 0, bytesFreed: 0 });
  });
});

const reprocessUrl = '/api/maintenance/reprocess-subtitles';
const dirtyVtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n{=22}Escena Oscura\n';
const cleanVtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhola\n';

function subPackage(hlsDir: string, db: DatabaseSync, id: number, titleId: number, files: Record<string, string>): string {
  const dir = pkg(hlsDir, String(id));
  mkdirSync(join(dir, 'subs'), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, 'subs', name), content);
  referenced(db, id, titleId);
  run(db, 'UPDATE media_files SET hls_dir = ? WHERE id = ?', `hls/${id}`, id);
  return dir;
}

describe('POST /api/maintenance/reprocess-subtitles', () => {
  it('sanitizes the vtt files of one package in place, leaving clean files and ass untouched', async () => {
    const { hlsDir, db, app, titleId } = setup();
    const ass = 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\pos(1,2)}hola';
    const dir = subPackage(hlsDir, db, 1, titleId, { '0.vtt': dirtyVtt, '1.vtt': cleanVtt, '0.ass': ass });

    const res = await app.inject({ method: 'POST', url: reprocessUrl, payload: { mediaFileId: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ checked: 2, fixed: 1 });
    expect(readFileSync(join(dir, 'subs/0.vtt'), 'utf8')).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nEscena Oscura\n');
    expect(readFileSync(join(dir, 'subs/1.vtt'), 'utf8')).toBe(cleanVtt);
    expect(readFileSync(join(dir, 'subs/0.ass'), 'utf8')).toBe(ass);
  });

  it('walks every ready package with a folder and skips the rest', async () => {
    const { hlsDir, db, app, titleId } = setup();
    subPackage(hlsDir, db, 1, titleId, { '0.vtt': dirtyVtt });
    subPackage(hlsDir, db, 2, titleId, { '0.vtt': cleanVtt });
    subPackage(hlsDir, db, 3, titleId, { '0.ass': 'ass only' }); // no vtts
    referenced(db, 4, titleId); // ready without hls_dir (lazy copy)
    mkdirSync(join(hlsDir, '5'), { recursive: true }); // hls_dir but no subs folder
    referenced(db, 5, titleId);
    run(db, 'UPDATE media_files SET hls_dir = ? WHERE id = ?', 'hls/5', 5);
    subPackage(hlsDir, db, 6, titleId, { '0.vtt': dirtyVtt });
    run(db, "UPDATE media_files SET status = 'error' WHERE id = 6");

    const res = await app.inject({ method: 'POST', url: reprocessUrl, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ checked: 2, fixed: 1 });
    expect(readFileSync(join(hlsDir, '6/subs/0.vtt'), 'utf8')).toBe(dirtyVtt);
  });

  it('answers 404 for an unknown mediaFileId and 400 for a non-numeric one', async () => {
    const { app } = setup();
    const missing = await app.inject({ method: 'POST', url: reprocessUrl, payload: { mediaFileId: 999 } });
    expect(missing.statusCode).toBe(404);
    const invalid = await app.inject({ method: 'POST', url: reprocessUrl, payload: { mediaFileId: 'x' } });
    expect(invalid.statusCode).toBe(400);
  });

  it('skips a package that is not ready', async () => {
    const { hlsDir, db, app, titleId } = setup();
    subPackage(hlsDir, db, 1, titleId, { '0.vtt': dirtyVtt });
    run(db, "UPDATE media_files SET status = 'processing' WHERE id = 1");
    const res = await app.inject({ method: 'POST', url: reprocessUrl, payload: { mediaFileId: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ checked: 0, fixed: 0 });
    expect(readFileSync(join(hlsDir, '1/subs/0.vtt'), 'utf8')).toBe(dirtyVtt);
  });
});
