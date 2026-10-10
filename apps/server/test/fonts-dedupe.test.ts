import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dedupeFontsDir } from '../src/modules/processing/fonts.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-fonts-'));
  roots.push(root);
  const store = join(root, 'fonts', '_store');
  const pkg = (name: string, files: Record<string, string>) => {
    const dir = join(root, 'hls', name, 'fonts');
    mkdirSync(dir, { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
    return dir;
  };
  return { root, store, pkg };
}

const ino = (p: string) => statSync(p).ino;

describe('dedupeFontsDir', () => {
  it('stores each font once and links the per-file folders to it; content stays readable', async () => {
    const e = setup();
    const a = e.pkg('1', { 'Arial.ttf': 'AAAA', 'Other.otf': 'OOOO' });
    const b = e.pkg('2', { 'Arial_copy.ttf': 'AAAA' });
    const ra = await dedupeFontsDir(a, e.store);
    const rb = await dedupeFontsDir(b, e.store);
    expect(ra).toMatchObject({ files: 2, linked: 2, savedBytes: 0 });
    expect(rb).toMatchObject({ files: 1, linked: 1, savedBytes: 4 });
    expect(ino(join(a, 'Arial.ttf'))).toBe(ino(join(b, 'Arial_copy.ttf')));
    expect(readFileSync(join(b, 'Arial_copy.ttf'), 'utf8')).toBe('AAAA');
    expect(statSync(join(a, 'Arial.ttf')).nlink).toBe(3);
  });

  it('is idempotent', async () => {
    const e = setup();
    const a = e.pkg('1', { 'x.ttf': 'XX' });
    await dedupeFontsDir(a, e.store);
    expect(await dedupeFontsDir(a, e.store)).toMatchObject({ files: 1, linked: 0, savedBytes: 0 });
  });

  it('dry-run changes nothing and reports what it would save', async () => {
    const e = setup();
    const a = e.pkg('1', { 'x.ttf': 'XX' });
    const b = e.pkg('2', { 'y.ttf': 'XX' });
    await dedupeFontsDir(a, e.store);
    const before = ino(join(b, 'y.ttf'));
    const r = await dedupeFontsDir(b, e.store, { dryRun: true });
    expect(r).toMatchObject({ linked: 1, savedBytes: 2 });
    expect(ino(join(b, 'y.ttf'))).toBe(before);
  });

  it('dry-run does not even create the store', async () => {
    const e = setup();
    const a = e.pkg('1', { 'x.ttf': 'XX' });
    await dedupeFontsDir(a, e.store, { dryRun: true });
    expect(existsSync(e.store)).toBe(false);
  });

  it('leaves files untouched when the filesystem cannot hardlink', async () => {
    const e = setup();
    const a = e.pkg('1', { 'x.ttf': 'XX' });
    const r = await dedupeFontsDir(a, e.store, { link: () => Promise.reject(Object.assign(new Error('nope'), { code: 'EPERM' })) });
    expect(r).toMatchObject({ linked: 0, skipped: 1 });
    expect(readFileSync(join(a, 'x.ttf'), 'utf8')).toBe('XX');
  });

  it('ignores a missing folder', async () => {
    const e = setup();
    expect(await dedupeFontsDir(join(e.root, 'nope'), e.store)).toMatchObject({ files: 0, linked: 0 });
  });
});
