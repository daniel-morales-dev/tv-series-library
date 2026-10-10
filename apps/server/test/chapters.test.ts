import { describe, expect, it } from 'vitest';
import { parseChapters } from '../src/modules/catalog/chapters.ts';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db/connection.ts';
import { addFile, addTitle } from './helpers.ts';

const FIXTURE = {
  chapters: [
    { id: 0, time_base: '1/1000000000', start: 0, start_time: '0.000000', end: 90000000000, end_time: '90.000000', tags: { title: 'Intro' } },
    { id: 1, start_time: '90.000000', end_time: '180.5', tags: { title: 'Opening' } },
    { id: 2, start_time: '180.5', end_time: '1300.000000', tags: {} },
    { id: 3, start_time: 'N/A', end_time: '1400', tags: { title: 'broken' } },
  ],
};

describe('parseChapters', () => {
  it('maps ffprobe chapters, tolerating missing titles and dropping unusable ranges', () => {
    expect(parseChapters(FIXTURE)).toEqual([
      { startS: 0, endS: 90, title: 'Intro' },
      { startS: 90, endS: 180.5, title: 'Opening' },
      { startS: 180.5, endS: 1300, title: null },
    ]);
  });
  it('returns [] when the file has no chapters', () => {
    expect(parseChapters({})).toEqual([]);
    expect(parseChapters({ chapters: [] })).toEqual([]);
  });
});

describe('GET /api/media-files/:id/chapters (lazy backfill)', () => {
  const make = (probeChapters: (p: string) => Promise<ReturnType<typeof parseChapters>>) => {
    const db = openDb(':memory:');
    const app = buildApp({ db, contentDir: () => '/lib', probeChapters });
    const titleId = addTitle(db, 'Frieren');
    const id = addFile(db, titleId, { durationS: 1400 });
    return { db, app, id, titleId, get: () => app.inject({ url: `/api/media-files/${id}/chapters` }) };
  };

  it('probes once, caches the result and exposes it on the title detail', async () => {
    let calls = 0;
    const e = make(async () => (calls++, parseChapters(FIXTURE)));
    expect((await e.get()).json().chapters).toHaveLength(3);
    expect((await e.get()).json().chapters).toHaveLength(3);
    expect(calls).toBe(1);
    const detail = (await e.app.inject({ url: `/api/titles/${e.titleId}` })).json();
    expect(detail.files[0].chaptersChecked).toBe(true);
    expect(detail.files[0].chapters[0]).toEqual({ startS: 0, endS: 90, title: 'Intro' });
  });

  it('caches "no chapters" so the file is not probed again', async () => {
    let calls = 0;
    const e = make(async () => (calls++, []));
    expect((await e.get()).json()).toEqual({ chapters: [] });
    await e.get();
    expect(calls).toBe(1);
  });

  it('does not cache a failed probe (disk away, file unreadable)', async () => {
    let calls = 0;
    const e = make(async () => {
      calls++;
      throw new Error('I/O');
    });
    expect((await e.get()).json()).toEqual({ chapters: [] });
    await e.get();
    expect(calls).toBe(2);
  });

  it('answers 404 for an unknown file', async () => {
    const e = make(async () => []);
    expect((await e.app.inject({ url: '/api/media-files/999/chapters' })).statusCode).toBe(404);
  });
});
