import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/connection.ts';
import { all, get, run } from '../src/db/sql.ts';
import { fixPersonNames, importTv, isLatinName, pickLatinName } from '../src/modules/ingest/metadata.ts';
import { createTmdbClient } from '../src/modules/ingest/tmdb.ts';
import { suggest } from '../src/modules/search/repository.ts';
import { makeFakeTmdb } from './fake-tmdb.ts';

const cast = (id: number, name: string, order: number) => ({ id, name, character: 'X', profile_path: null, order });
const people = {
  10: { es: null, en: 'Atsumi Tanezaki' },
  11: { es: 'Nikita Efremov', en: 'Nikita Yefremov' },
  12: { es: null, en: null },
};
const names = (db: ReturnType<typeof openDb>) =>
  Object.fromEntries(all<{ tmdb_id: number; name: string }>(db, 'SELECT tmdb_id, name FROM people').map((r) => [r.tmdb_id, r.name]));
const personCalls = (calls: string[]) => calls.filter((c) => c.startsWith('person:'));

async function tvWithCast(fake: ReturnType<typeof makeFakeTmdb>) {
  const tv = await fake.tv(46195);
  fake.calls.length = 0;
  return {
    ...tv,
    credits: {
      cast: [cast(10, '種﨑敦美', 0), cast(11, 'Никита Ефремов', 1), cast(12, '山田太郎', 2), cast(13, 'Plain Latin', 3)],
      crew: [],
    },
  };
}
const ctxOf = (fake: ReturnType<typeof makeFakeTmdb>) => ({ db: openDb(':memory:'), tmdb: fake, dataDir: mkdtempSync(join(tmpdir(), 'pn-')) });

describe('isLatinName / pickLatinName', () => {
  it('detects non-Latin scripts', () => {
    for (const n of ['Atsumi Tanezaki', 'José Ángel Ñandú', "Zoë O'Brien-Smith", 'Jean-Luc 2', ''])
      expect(isLatinName(n), n).toBe(true);
    for (const n of ['種﨑敦美', 'Никита Ефремов', 'Tom 田中', '김민수', 'أحمد'])
      expect(isLatinName(n), n).toBe(false);
  });
  it('prefers es, then en, then the original', () => {
    expect(pickLatinName('種﨑', { es: 'Es Name', en: 'En Name' })).toBe('Es Name');
    expect(pickLatinName('種﨑', { es: null, en: 'En Name' })).toBe('En Name');
    expect(pickLatinName('種﨑', { es: '種﨑', en: 'En Name' })).toBe('En Name');
    expect(pickLatinName('種﨑', { es: null, en: null })).toBe('種﨑');
  });
});

describe('import resolves cast names', () => {
  it('stores the Latin translation, queries once per non-Latin person, never repeats', async () => {
    const fake = makeFakeTmdb({ people });
    const ctx = ctxOf(fake);
    const tv = await tvWithCast(fake);
    await importTv(ctx, tv);
    expect(names(ctx.db)).toEqual({ 10: 'Atsumi Tanezaki', 11: 'Nikita Efremov', 12: '山田太郎', 13: 'Plain Latin' });
    expect(personCalls(fake.calls).sort()).toEqual(['person:10', 'person:11', 'person:12']);
    expect(suggest(ctx.db, 'Tanezaki').length).toBe(1);

    fake.calls.length = 0;
    await importTv(ctx, tv);
    expect(personCalls(fake.calls)).toEqual([]);
    expect(names(ctx.db)[10]).toBe('Atsumi Tanezaki');
  });

  it('offline: keeps the original, no error, and retries on a later import', async () => {
    const fake = makeFakeTmdb({ people });
    const ctx = ctxOf(fake);
    const real = fake.personNames;
    fake.personNames = (id) => (fake.calls.push(`person:${id}`), Promise.reject(new Error('network down')));
    const tv = await tvWithCast(fake);
    await importTv(ctx, tv);
    expect(names(ctx.db)[10]).toBe('種﨑敦美');
    expect(personCalls(fake.calls).length).toBe(1);

    fake.personNames = real;
    await importTv(ctx, tv);
    expect(names(ctx.db)[10]).toBe('Atsumi Tanezaki');
  });
});

describe('fixPersonNames', () => {
  const seed = (db: ReturnType<typeof openDb>) => {
    for (const [id, name] of [[10, '種﨑敦美'], [11, 'Никита Ефремов'], [13, 'Plain Latin']] as const)
      run(db, 'INSERT INTO people (tmdb_id, name) VALUES (?, ?)', id, name);
  };

  it('fixes already imported people once, only with internet', async () => {
    const fake = makeFakeTmdb({ people });
    const ctx = ctxOf(fake);
    seed(ctx.db);
    expect(await fixPersonNames(ctx)).toBe(2);
    expect(names(ctx.db)).toMatchObject({ 10: 'Atsumi Tanezaki', 11: 'Nikita Efremov', 13: 'Plain Latin' });
    expect(get(ctx.db, "SELECT 1 AS x FROM search_index WHERE search_index MATCH 'Atsumi'")).toBeTruthy();
    expect(personCalls(fake.calls).sort()).toEqual(['person:10', 'person:11']);

    fake.calls.length = 0;
    expect(await fixPersonNames(ctx)).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it('offline: no changes, no error, a single failed attempt', async () => {
    const fake = makeFakeTmdb({ people });
    const ctx = ctxOf(fake);
    seed(ctx.db);
    fake.personNames = (id) => (fake.calls.push(`person:${id}`), Promise.reject(new Error('network down')));
    expect(await fixPersonNames(ctx)).toBe(0);
    expect(names(ctx.db)[10]).toBe('種﨑敦美');
    expect(personCalls(fake.calls).length).toBe(1);
  });
});

describe('TMDB client person translations', () => {
  it('parses es/en names and retries a 429 with backoff', async () => {
    const waits: number[] = [];
    let n = 0;
    const fetchImpl = (async () =>
      ++n === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
        : new Response(
            JSON.stringify({
              translations: [
                { iso_639_1: 'en', data: { name: 'Atsumi Tanezaki' } },
                { iso_639_1: 'es', data: { name: '' } },
              ],
            }),
            { status: 200 },
          )) as typeof fetch;
    const client = createTmdbClient('t', fetchImpl, async (ms) => void waits.push(ms));
    expect(await client.personNames(10)).toEqual({ es: null, en: 'Atsumi Tanezaki' });
    expect(n).toBe(2);
    expect(waits).toEqual([2000]);
  });

  it('gives up after bounded retries', async () => {
    let n = 0;
    const fetchImpl = (async () => (n++, new Response('', { status: 429 }))) as typeof fetch;
    const client = createTmdbClient('t', fetchImpl, async () => {});
    await expect(client.personNames(1)).rejects.toThrow('429');
    expect(n).toBe(4);
  });
});
