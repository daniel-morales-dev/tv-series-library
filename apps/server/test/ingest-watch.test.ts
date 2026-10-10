import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const watched: string[] = [];
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  watch: (path: string) => {
    watched.push(String(path));
    return { close() {}, on() {} };
  },
}));

const { createIngestor } = await import('../src/modules/ingest/ingestor.ts');
const { makeFakeTmdb } = await import('./fake-tmdb.ts');
const { setup } = await import('./helpers.ts');

const roots: string[] = [];
afterEach(() => {
  watched.length = 0;
  roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function ingestor(diskPresent?: () => boolean) {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-watch-'));
  roots.push(root);
  const contentDir = join(root, 'content');
  for (const d of ['shows', 'films', '.sala/hls', 'other']) mkdirSync(join(contentDir, d), { recursive: true });
  const { db } = setup();
  return { contentDir, ing: createIngestor({ db, tmdb: makeFakeTmdb(), dataDir: join(root, 'data'), contentDir, diskPresent }) };
}

it('watches only shows/ and films/, never .sala/ or the content root', async () => {
  const { contentDir, ing } = ingestor();
  ing.start(60);
  await ing.scan();
  ing.stop();
  expect(watched.sort()).toEqual([join(contentDir, 'films'), join(contentDir, 'shows')]);
});

it('does not scan or watch while the disk is absent, and arms the watchers once it is back', async () => {
  const state = { present: false };
  const { contentDir, ing } = ingestor(() => state.present);
  ing.start(60);
  expect(await ing.scan()).toEqual({ ingested: 0, pending: 0, waiting: 0, failed: 0 });
  expect(watched).toEqual([]);
  state.present = true;
  await ing.scan();
  ing.stop();
  expect(watched.sort()).toEqual([join(contentDir, 'films'), join(contentDir, 'shows')]);
});
