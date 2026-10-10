import { afterEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUserConfig, writeMarker, writeUserConfig } from '../src/config/config.ts';
// @ts-expect-error The migration script is native JavaScript, outside the server TypeScript project.
import { migrateData } from '../../../scripts/migrate-data.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

/** A temp "repo" with legacy data/hls (two packages), a library folder with its marker, and an isolated config dir. */
function fixture(present = true) {
  const root = mkdtempSync(join(tmpdir(), 'migrate-data-'));
  roots.push(root);
  const content = join(root, 'lib');
  const cfg = join(root, 'cfg');
  const hls = join(root, 'data', 'hls');
  for (const [id, body] of [['1', 'aaaa'], ['2', 'bb']]) {
    mkdirSync(join(hls, id), { recursive: true });
    writeFileSync(join(hls, id, 'seg.m4s'), body);
  }
  writeFileSync(join(root, 'data', 'library.db'), '');
  if (present) {
    mkdirSync(content);
    writeMarker(content, 'lib-1');
  }
  writeUserConfig({ contentDir: content, libraryId: 'lib-1' }, cfg);
  const logs: string[] = [];
  const base = {
    root,
    env: { PORT: '8080', MIN_FREE_GB: '0', MIN_FREE_PCT: '0', SALA_CONFIG_DIR: cfg, XDG_DATA_HOME: join(root, 'xdg') },
    configDir: cfg,
    out: (s: string) => logs.push(s),
    err: (s: string) => logs.push(`ERR ${s}`),
    checkPort: async () => {},
    deps: { sameDevice: async () => true },
  };
  return { root, content, cfg, hls, base, text: () => logs.join('\n') };
}

test('--dry-run shows the plan and changes nothing', async () => {
  const f = fixture();
  expect(await migrateData({ ...f.base, dryRun: true })).toBe(0);
  expect(f.text()).toContain('por mover 2');
  expect(existsSync(join(f.content, '.sala'))).toBe(false);
  expect(readUserConfig({ dir: f.cfg })?.hlsDir).toBeUndefined();
});

test('refuses to touch an absent library disk', async () => {
  const f = fixture(false);
  expect(await migrateData({ ...f.base, yes: true })).toBe(1);
  expect(f.text()).toContain('no está disponible');
  expect(existsSync(f.content)).toBe(false);
});

test('without confirmation nothing moves', async () => {
  const f = fixture();
  expect(await migrateData({ ...f.base, confirm: async () => false })).toBe(1);
  expect(existsSync(join(f.content, '.sala'))).toBe(false);
});

test('moves, verifies and switches the pointer, then frees the origin only on --free-origin', async () => {
  const f = fixture();
  expect(await migrateData({ ...f.base, yes: true })).toBe(0);
  const dest = join(f.content, '.sala', 'hls');
  expect(readFileSync(join(dest, '1', 'seg.m4s'), 'utf8')).toBe('aaaa');
  expect(readUserConfig({ dir: f.cfg })?.hlsDir).toBe(dest);
  expect(readdirSync(f.hls).sort()).toEqual(['1', '2']); // origin intact

  // Declined: nothing is deleted.
  expect(await migrateData({ ...f.base, free: true, confirm: async () => false })).toBe(1);
  expect(readdirSync(f.hls).sort()).toEqual(['1', '2']);

  expect(await migrateData({ ...f.base, free: true, yes: true })).toBe(0);
  expect(existsSync(join(f.hls, '1'))).toBe(false);
  expect(readFileSync(join(dest, '2', 'seg.m4s'), 'utf8')).toBe('bb');
  expect(await migrateData({ ...f.base, free: true, yes: true })).toBe(1); // journal cleared: nothing pending
});

test('a busy port (Sala running) stops the move', async () => {
  const f = fixture();
  expect(await migrateData({ ...f.base, yes: true, checkPort: async () => { throw new Error('busy'); } })).toBe(1);
  expect(f.text()).toContain('sala stop');
  expect(existsSync(join(f.content, '.sala'))).toBe(false);
});
