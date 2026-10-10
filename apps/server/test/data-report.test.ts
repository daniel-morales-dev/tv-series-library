import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/connection.ts';
import { run } from '../src/db/sql.ts';
import { buildReport, dedupeStore, purgeOrphans, runCli } from '../src/cli/data-report.ts';
import { addTitle } from './helpers.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = Date.parse('2026-10-10T12:00:00Z');
const OLD = new Date(NOW - 3 * 3600_000);

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-report-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const contentDir = join(root, 'content');
  mkdirSync(join(contentDir, 'shows'), { recursive: true });
  writeFileSync(join(contentDir, 'shows', 'present.mkv'), 'orig');
  const db = openDb(join(dataDir, 'library.db'));
  const titleId = addTitle(db, 'T');

  // A package: `segs` segments of 10 s on disk, playlist lists `listed` of them.
  const pkg = (id: number, o: { segs?: number; listed?: number; duration?: number; missing?: boolean; status?: string; font?: string } = {}) => {
    const dir = join(dataDir, 'hls', String(id));
    for (const d of ['v', 'a0', 'subs', 'fonts']) mkdirSync(join(dir, d), { recursive: true });
    const segs = o.segs ?? 3;
    const listed = o.listed ?? segs;
    writeFileSync(join(dir, 'master.m3u8'), '#EXTM3U');
    writeFileSync(
      join(dir, 'v/index.m3u8'),
      `#EXTM3U\n${Array.from({ length: listed }, (_, i) => `#EXTINF:10.0,\nseg_${i}.m4s\n`).join('')}#EXT-X-ENDLIST\n`,
    );
    for (let i = 0; i < segs; i++) writeFileSync(join(dir, `v/seg_${i}.m4s`), 'v'.repeat(100));
    writeFileSync(join(dir, 'a0/seg_0.m4s'), 'a'.repeat(10));
    writeFileSync(join(dir, 'subs/0.vtt'), 'WEBVTT');
    if (o.font) writeFileSync(join(dir, 'fonts/f.ttf'), o.font);
    const rel = o.missing ? `shows/gone-${id}.mkv` : `shows/ep${id}.mkv`;
    if (!o.missing) writeFileSync(join(contentDir, rel), 'orig');
    const fileId = run(db, 'INSERT INTO media_files (id, path, title_id, status, duration_s) VALUES (?, ?, ?, ?, ?)', id, rel, titleId, o.status ?? 'ready', o.duration ?? 30).lastInsertId;
    return { dir, fileId };
  };
  const tmp = (id: number, ageMs: number) => {
    const dir = join(dataDir, 'hls', `${id}.tmp`);
    mkdirSync(join(dir, 'v'), { recursive: true });
    writeFileSync(join(dir, 'v/seg_0.m4s'), 'z'.repeat(50));
    const t = new Date(NOW - ageMs);
    for (const p of [join(dir, 'v/seg_0.m4s'), join(dir, 'v'), dir]) utimesSync(p, t, t);
    return dir;
  };
  const opts = () => ({ dataDir, contentDir, now: NOW, minAgeMs: 3600_000 });
  return { root, dataDir, contentDir, db, pkg, tmp, opts };
}

describe('buildReport', () => {
  it('reports size by category without double counting hardlinks', async () => {
    const e = setup();
    e.pkg(1, { font: 'FONT' });
    e.pkg(2, { font: 'FONT' });
    // second font is a hardlink of the first
    rmSync(join(e.dataDir, 'hls/2/fonts/f.ttf'));
    const { linkSync } = await import('node:fs');
    linkSync(join(e.dataDir, 'hls/1/fonts/f.ttf'), join(e.dataDir, 'hls/2/fonts/f.ttf'));
    const r = await buildReport(e.opts());
    expect(r.sizes.video).toBeGreaterThanOrEqual(600);
    expect(r.sizes.video).toBeLessThan(800);
    expect(r.sizes.audio).toBe(20);
    expect(r.sizes.fonts).toBe(4);
    expect(r.sizes.subtitles).toBe(12);
    expect(r.sizes.db).toBeGreaterThan(0);
  });

  it('flags a ready package that is short of its expected duration or missing segments', async () => {
    const e = setup();
    e.pkg(1); // good
    e.pkg(2, { duration: 300 }); // plays 30 s of 300 s
    e.pkg(3, { segs: 1, listed: 3 }); // two listed segments are gone
    const r = await buildReport(e.opts());
    expect(r.truncated.map((t) => [t.id, t.reason])).toEqual([[2, 'short'], [3, 'missing_segments']]);
    expect(r.truncated.every((t) => !t.originalMissing)).toBe(true);
  });

  it('marks a truncated package whose original is gone', async () => {
    const e = setup();
    e.pkg(2, { duration: 300, missing: true });
    e.pkg(1, { missing: true }); // valid package with a missing original is NOT truncated
    const r = await buildReport(e.opts());
    expect(r.truncated).toMatchObject([{ id: 2, originalMissing: true }]);
  });

  it('lists only stale .tmp folders of files that are not processing', async () => {
    const e = setup();
    const old = e.tmp(10, 3 * 3600_000);
    e.tmp(11, 60_000); // fresh: an active encode
    e.tmp(12, 3 * 3600_000); // stale but the file is still marked processing
    run(e.db, 'INSERT INTO media_files (id, path, title_id, status) VALUES (12, ?, ?, ?)', 'shows/ep12.mkv', 1, 'processing');
    const r = await buildReport(e.opts());
    expect(r.tmpOrphans.map((t) => t.dir)).toEqual([old]);
    expect(r.tmpOrphans[0]!.bytes).toBe(50);
  });

  it('works read-only without a database or with the content folder unmounted', async () => {
    const e = setup();
    e.pkg(2, { duration: 300, missing: true });
    e.db.close();
    const r = await buildReport({ ...e.opts(), contentDir: join(e.root, 'unmounted') });
    expect(r.truncated).toMatchObject([{ id: 2, originalMissing: false }]);
    const r2 = await buildReport({ ...e.opts(), dataDir: join(e.root, 'nodata') });
    expect(r2.total).toBe(0);
  });
});

describe('purgeOrphans', () => {
  it('dry-run deletes nothing; yes removes stale .tmp and truncated packages with a missing original only', async () => {
    const e = setup();
    const good = e.pkg(1);
    const reprocessable = e.pkg(2, { duration: 300 }); // truncated but the original exists
    const lost = e.pkg(3, { duration: 300, missing: true });
    const stale = e.tmp(10, 3 * 3600_000);
    const fresh = e.tmp(11, 1000);
    const report = await buildReport(e.opts());

    const dry = await purgeOrphans(e.dataDir, report, { yes: false });
    expect(dry.removed).toEqual([]);
    expect([good.dir, reprocessable.dir, lost.dir, stale, fresh].every(existsSync)).toBe(true);

    const done = await purgeOrphans(e.dataDir, report, { yes: true });
    expect(done.removed.sort()).toEqual([lost.dir, stale].sort());
    expect(existsSync(lost.dir) || existsSync(stale)).toBe(false);
    expect([good.dir, reprocessable.dir, fresh, join(e.contentDir, 'shows/present.mkv'), join(e.dataDir, 'library.db')].every(existsSync)).toBe(true);
  });

  it('refuses any path outside data/hls', async () => {
    const e = setup();
    const evil = { ...(await buildReport(e.opts())), tmpOrphans: [{ dir: e.contentDir, bytes: 1, ageMs: 9e9 }], truncated: [] };
    const r = await purgeOrphans(e.dataDir, evil, { yes: true });
    expect(r.removed).toEqual([]);
    expect(existsSync(join(e.contentDir, 'shows/present.mkv'))).toBe(true);
  });
});

describe('dedupeStore', () => {
  it('dry-run by default; yes links identical fonts across packages', async () => {
    const e = setup();
    const a = e.pkg(1, { font: 'FONTDATA' });
    const b = e.pkg(2, { font: 'FONTDATA' });
    const fa = join(a.dir, 'fonts/f.ttf');
    const fb = join(b.dir, 'fonts/f.ttf');
    const dry = await dedupeStore(e.dataDir, { yes: false });
    expect(dry).toMatchObject({ savedBytes: 8 });
    expect(statSync(fa).ino).not.toBe(statSync(fb).ino);
    await dedupeStore(e.dataDir, { yes: true });
    expect(statSync(fa).ino).toBe(statSync(fb).ino);
  });
});

describe('runCli', () => {
  const cli = async (e: ReturnType<typeof setup>, args: string[]) => {
    const out: string[] = [];
    const code = await runCli(['--data-dir', e.dataDir, '--content-dir', e.contentDir, ...args], { out: (s) => out.push(s), now: NOW });
    return { code, text: out.join('\n') };
  };

  it('report is read-only; --purge-orphans without --yes only previews', async () => {
    const e = setup();
    const lost = e.pkg(3, { duration: 300, missing: true });
    const stale = e.tmp(10, 3 * 3600_000);
    const r = await cli(e, []);
    expect(r.code).toBe(0);
    expect(r.text).toContain('video');
    const p = await cli(e, ['--purge-orphans']);
    expect(p.text).toMatch(/dry-run/i);
    expect(existsSync(lost.dir) && existsSync(stale)).toBe(true);
    const y = await cli(e, ['--purge-orphans', '--dry-run', '--yes']);
    expect(existsSync(lost.dir) && existsSync(stale)).toBe(true);
    expect(y.text).toMatch(/dry-run/i);
    await cli(e, ['--purge-orphans', '--yes']);
    expect(existsSync(lost.dir) || existsSync(stale)).toBe(false);
  });

  it('rejects unknown flags', async () => {
    const e = setup();
    expect((await cli(e, ['--nope'])).code).toBe(2);
  });
});
