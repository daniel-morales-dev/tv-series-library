import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { get } from '../src/db/sql.ts';
import { createIngestor } from '../src/modules/ingest/ingestor.ts';
import type { Probe } from '../src/modules/ingest/probe.ts';
import type { TmdbClient } from '../src/modules/ingest/tmdb.ts';
import { type FakeTmdb, makeFakeTmdb } from './fake-tmdb.ts';
import { setup } from './helpers.ts';

// T20: TMDB is consulted to fill in missing data, never to re-read what is already stored.
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = Date.parse('2026-01-01T12:00:00Z');
const bake = (tag: string) => `shows/bakemonogatari/[Coalgirls]_Bakemonogatari_${tag}_(1920x1080_Blu-ray_FLAC)_[ABCD1234].mkv`;

// Bakemonogatari's lead is credited in kanji so the person-name pass has something to resolve.
function kanjiCast(fake: FakeTmdb): FakeTmdb {
  return {
    ...fake,
    tv: async (id) => {
      const tv = await fake.tv(id);
      return id === 46195 ? { ...tv, credits: { cast: [{ id: 7, name: '神谷浩史', character: 'Araragi', profile_path: null, order: 0 }], crew: [] } } : tv;
    },
  };
}

function env() {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-t20-'));
  roots.push(root);
  const contentDir = join(root, 'content');
  const dataDir = join(root, 'data');
  const { db } = setup();
  const probe: Probe = async () => ({ durationS: 1440.5, audio: [], subtitles: [] });
  const fake = makeFakeTmdb({ people: { 7: { en: 'Hiroshi Kamiya' } } });
  const make = (client: TmdbClient = kanjiCast(fake)) => createIngestor({ db, tmdb: client, dataDir, contentDir, probe, now: () => NOW });
  const addFile = (rel: string) => {
    const abs = join(contentDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
    utimesSync(abs, (NOW - 3_600_000) / 1000, (NOW - 3_600_000) / 1000);
  };
  return { db, dataDir, fake, make, addFile };
}

const calls = (fake: FakeTmdb) => fake.calls.splice(0);

describe('T20 TMDB call budget', () => {
  it('first import fetches everything; an unchanged rescan makes 0 calls', async () => {
    const e = env();
    for (const t of ['01', '02', '15']) e.addFile(bake(t));
    const ingestor = e.make();
    await ingestor.scan();
    const first = calls(e.fake);
    expect(first.length).toBeGreaterThan(0);
    expect(first.filter((c) => c.startsWith('person:'))).toEqual(['person:7']);

    await ingestor.scan();
    await e.make().scan(); // a fresh ingestor is a server restart
    expect(calls(e.fake)).toEqual([]);
    console.log(`T20 calls: first import=${first.length} (${first.join(' ')}), repeat=0`);
  });

  it('keeps persisted metadata and images when the network drops, and fetches nothing it already has', async () => {
    const e = env();
    e.addFile(bake('01'));
    await e.make().scan();
    calls(e.fake);
    const before = get<any>(e.db, 'SELECT title, overview, poster_path, metadata_status FROM titles');
    expect(before).toMatchObject({ title: 'Monogatari', metadata_status: 'ready' });
    expect(existsSync(join(e.dataDir, 'images', before.poster_path))).toBe(true);

    const down = makeFakeTmdb({ offline: true });
    e.addFile(bake('02'));
    await e.make(down).scan();
    expect(get<any>(e.db, 'SELECT title, overview, poster_path, metadata_status FROM titles')).toEqual(before);
    expect(get<any>(e.db, 'SELECT COUNT(*) AS n FROM media_files')?.n).toBe(2);
  });

  it('a placeholder created offline is retried once, then waits instead of searching on every scan', async () => {
    const e = env();
    e.addFile('shows/zzz/zzz 01.mkv');
    await e.make(makeFakeTmdb({ offline: true })).scan();
    expect(get<any>(e.db, "SELECT COUNT(*) AS n FROM titles WHERE metadata_status = 'pending'")?.n).toBe(1);
    calls(e.fake);

    const ingestor = e.make(); // online, but TMDB only offers candidates, no safe match
    await ingestor.scan();
    expect(calls(e.fake).length).toBeGreaterThan(0);
    await ingestor.scan();
    await ingestor.scan();
    expect(calls(e.fake)).toEqual([]);
    expect(get<any>(e.db, "SELECT COUNT(*) AS n FROM titles WHERE metadata_status = 'pending'")?.n).toBe(1);
  });

  it('a movie placeholder with no TMDB match is not searched again on every scan', async () => {
    const e = env();
    e.addFile('films/Unknown Thing (2001).mkv');
    await e.make(makeFakeTmdb({ offline: true })).scan();
    calls(e.fake);
    const ingestor = e.make();
    await ingestor.scan();
    expect(calls(e.fake).length).toBeGreaterThan(0);
    await ingestor.scan();
    expect(calls(e.fake)).toEqual([]);
  });

  it('a second folder of a title already imported reuses its TMDB details', async () => {
    const e = env();
    e.addFile(bake('01'));
    const ingestor = e.make();
    await ingestor.scan();
    calls(e.fake);
    e.addFile('shows/nisemonogatari/[Coalgirls]_Nisemonogatari_01_(1920x1080)_[AAAA1111].mkv');
    await ingestor.scan();
    const second = calls(e.fake);
    expect(second.filter((c) => c.startsWith('tv:') || c.startsWith('group:'))).toEqual([]);
  });

  it('after a network failure TMDB is not hammered on every scan', async () => {
    const e = env();
    e.addFile('shows/zzz/zzz 01.mkv');
    const down = makeFakeTmdb({ offline: true });
    const ingestor = e.make(down);
    await ingestor.scan();
    const first = calls(down).length;
    expect(first).toBeGreaterThan(0);
    await ingestor.scan();
    await ingestor.scan();
    expect(calls(down)).toEqual([]);
  });
});
