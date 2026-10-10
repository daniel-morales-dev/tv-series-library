import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error The root launcher is native JavaScript, outside the server TypeScript project.
import { needsWebBuild, webBuildNeeded, SERVER_COMMAND } from '../../../scripts/start.mjs';

test('needsWebBuild: missing build or newer sources rebuild; fresh build does not', () => {
  expect(needsWebBuild(0, 0)).toBe(true);
  expect(needsWebBuild(0, 500)).toBe(true);
  expect(needsWebBuild(1000, 2000)).toBe(true);
  expect(needsWebBuild(2000, 1000)).toBe(false);
  expect(needsWebBuild(1000, 1000)).toBe(false);
});

test('webBuildNeeded reads real mtimes of dist/index.html versus web sources', () => {
  const repo = mkdtempSync(join(tmpdir(), 'start-launcher-'));
  const web = join(repo, 'apps/web');
  mkdirSync(join(web, 'src'), { recursive: true });
  mkdirSync(join(web, 'dist'));
  writeFileSync(join(web, 'src/main.ts'), '');
  expect(webBuildNeeded(repo)).toBe(true);
  writeFileSync(join(web, 'dist/index.html'), '');
  utimesSync(join(web, 'src/main.ts'), 1000, 1000);
  utimesSync(join(web, 'dist/index.html'), 2000, 2000);
  expect(webBuildNeeded(repo)).toBe(false);
  utimesSync(join(web, 'src/main.ts'), 3000, 3000);
  expect(webBuildNeeded(repo)).toBe(true);
});

test('sala.service ExecStart runs the same server command and web dir as npm start', () => {
  const unit = readFileSync(join(import.meta.dirname, '../../../packaging/linux/sala.service'), 'utf8');
  const execStart = /^ExecStart=@NODE@ (.+)$/m.exec(unit)?.[1];
  expect(execStart).toBe(SERVER_COMMAND.slice(1).join(' ').replace('../../.env', '@REPO@/.env'));
  expect(unit).toContain('WorkingDirectory=@REPO@/apps/server');
  expect(unit).toContain('Environment=WEB_DIR=@REPO@/apps/web/dist');
  // T47a: DATA_DIR would pin the legacy repo folder forever; the server and backup.ts resolve it themselves.
  expect(unit).not.toMatch(/^Environment=DATA_DIR/m);
});
