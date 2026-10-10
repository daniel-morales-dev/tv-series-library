import { afterEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';
import { hlsReachable, resolveDataPaths, userStateDir } from '../src/config/paths.ts';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'paths-'));
  roots.push(root);
  const xdg = join(root, 'xdg');
  return { root, xdg, env: { XDG_DATA_HOME: xdg } as NodeJS.ProcessEnv, opts: { root, home: join(root, 'home') } };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const touch = (file: string) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '');
};

test('userStateDir: XDG_DATA_HOME or ~/.local/share on Linux, LOCALAPPDATA on Windows, relative XDG ignored', () => {
  expect(userStateDir({ XDG_DATA_HOME: '/x/share' }, { platform: 'linux', home: '/h' })).toBe('/x/share/sala');
  expect(userStateDir({}, { platform: 'linux', home: '/h' })).toBe('/h/.local/share/sala');
  expect(userStateDir({ XDG_DATA_HOME: 'relative' }, { platform: 'linux', home: '/h' })).toBe('/h/.local/share/sala');
  expect(userStateDir({ LOCALAPPDATA: 'C:\\L' }, { platform: 'win32', home: 'C:\\U' })).toBe(win32.join('C:\\L', 'sala', 'data'));
});

test('DATA_DIR is an explicit override: state and HLS share it, relative values anchor to the repo root', () => {
  const { root, env, opts } = fixture();
  const abs = resolveDataPaths({ ...env, DATA_DIR: '/srv/sala' }, opts);
  expect(abs).toMatchObject({ stateDir: '/srv/sala', hlsDir: '/srv/sala/hls', source: 'env' });
  const rel = resolveDataPaths({ ...env, DATA_DIR: './data' }, opts);
  expect(rel.stateDir).toBe(join(root, 'data'));
  expect(rel.hlsDir).toBe(join(root, 'data/hls'));
  expect(() => resolveDataPaths({ ...env, DATA_DIR: '' }, opts)).toThrow(/DATA_DIR/);
});

test('fresh install resolves to the per-user directory and is always absolute', () => {
  const { xdg, env, opts } = fixture();
  const paths = resolveDataPaths(env, opts);
  expect(paths).toMatchObject({ stateDir: join(xdg, 'sala'), hlsDir: join(xdg, 'sala/hls'), source: 'user' });
  expect(paths.notice).toBeUndefined();
  for (const p of [paths.stateDir, paths.hlsDir, paths.legacyDir, paths.userDir]) expect(isAbsolute(p)).toBe(true);
});

test('legacy layout without newer state keeps being used and points to sala migrate-state', () => {
  const { root, env, opts } = fixture();
  touch(join(root, 'data/library.db'));
  const paths = resolveDataPaths(env, opts);
  expect(paths).toMatchObject({ stateDir: join(root, 'data'), hlsDir: join(root, 'data/hls'), source: 'legacy' });
  expect(paths.notice).toContain('sala migrate-state');
});

test('once the user state exists it wins; HLS stays in the legacy folder while it exists', () => {
  const { root, xdg, env, opts } = fixture();
  touch(join(root, 'data/library.db'));
  mkdirSync(join(root, 'data/hls'));
  touch(join(xdg, 'sala/library.db'));
  const paths = resolveDataPaths(env, opts);
  expect(paths).toMatchObject({ stateDir: join(xdg, 'sala'), hlsDir: join(root, 'data/hls'), source: 'user' });
  expect(paths.notice).toBeUndefined();
});

test('user state without any legacy HLS keeps HLS beside it', () => {
  const { xdg, env, opts } = fixture();
  touch(join(xdg, 'sala/library.db'));
  expect(resolveDataPaths(env, opts).hlsDir).toBe(join(xdg, 'sala/hls'));
});

test('an empty user directory without library.db does not count as migrated state', () => {
  const { root, xdg, env, opts } = fixture();
  touch(join(root, 'data/library.db'));
  mkdirSync(join(xdg, 'sala'), { recursive: true });
  expect(resolveDataPaths(env, opts).source).toBe('legacy');
});

test('hlsReachable: same path or a link to hlsDir passes; a different or missing tree does not', () => {
  const { root } = fixture();
  const state = join(root, 'state');
  const real = join(root, 'legacy-hls');
  mkdirSync(state);
  mkdirSync(real);
  expect(hlsReachable({ stateDir: state, hlsDir: join(state, 'hls') })).toBe(true);
  expect(hlsReachable({ stateDir: state, hlsDir: real })).toBe(false);
  symlinkSync(real, join(state, 'hls'));
  expect(hlsReachable({ stateDir: state, hlsDir: real })).toBe(true);
  expect(hlsReachable({ stateDir: state, hlsDir: join(root, 'elsewhere') })).toBe(false);
});
