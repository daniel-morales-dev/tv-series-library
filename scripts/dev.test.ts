import { expect, test } from 'vitest';
import { isSalaServiceCgroup, prepare } from './dev.mjs';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('detects the sala.service cgroup (user and system units)', () => {
  expect(isSalaServiceCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/sala.service\n')).toBe(true);
  expect(isSalaServiceCgroup('0::/system.slice/sala.service')).toBe(true);
  expect(isSalaServiceCgroup('0::/user.slice/user@1000.service/app.slice/sala.service/ffmpeg')).toBe(true);
});

test('does not match terminals, lookalikes or empty input', () => {
  expect(isSalaServiceCgroup('0::/user.slice/user@1000.service/app.slice/app-gnome-terminal.scope')).toBe(false);
  expect(isSalaServiceCgroup('0::/user.slice/not-sala.service')).toBe(false);
  expect(isSalaServiceCgroup('0::/user.slice/sala.service.d')).toBe(false);
  expect(isSalaServiceCgroup(undefined)).toBe(false);
});

test('prepare refuses to kill a holder that belongs to sala.service', async () => {
  const { createServer } = await import('node:net');
  const repo = mkdtempSync(join(tmpdir(), 'dev-guard-'));
  mkdirSync(join(repo, 'data'));
  const server = createServer();
  await new Promise<void>((ok) => server.listen({ port: 0, host: '0.0.0.0' }, ok));
  const port = (server.address() as { port: number }).port;
  let killed = false;
  try {
    await expect(
      prepare(repo, {}, [port], {
        findHolder: () => ({ pid: 1, parentPid: null, own: false, service: true }),
        killHolder: () => void (killed = true),
      }),
    ).rejects.toThrow(/systemctl --user stop sala/);
    expect(killed).toBe(false);
  } finally {
    server.close();
  }
});
