import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db/connection.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function webApp() {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-web-'));
  roots.push(root);
  const webDir = join(root, 'dist');
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<html>app</html>');
  writeFileSync(join(webDir, 'assets/app.js'), 'console.log(1)');
  writeFileSync(join(root, 'secret.js'), 'secret');
  return buildApp({ db: openDb(':memory:'), webDir });
}

describe('web app', () => {
  it('serves index.html at / and as the SPA fallback, never cached', async () => {
    const app = webApp();
    for (const url of ['/', '/watch/12']) {
      const res = await app.inject(url);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('<html>app</html>');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('serves hashed assets as immutable', async () => {
    const res = await webApp().inject('/assets/app.js');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['content-type']).toContain('javascript');
  });

  it('does not leave the web folder', async () => {
    const app = webApp();
    expect((await app.inject('/assets/../../secret.js')).statusCode).toBe(404);
    expect((await app.inject('/assets/%2e%2e/%2e%2e/secret.js')).statusCode).toBe(404);
    expect((await app.inject('/missing.js')).statusCode).toBe(404);
    // Fastify rejects malformed escapes before the handler, so decodeURIComponent never throws there.
    expect((await app.inject('/%E0%A4%A.js')).statusCode).toBe(400);
  });

  it('keeps unknown /api routes as JSON 404', async () => {
    const res = await webApp().inject('/api/nope');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json().statusCode).toBe(404);
  });

  it('answers 404 without a web folder, or when it does not exist', async () => {
    expect((await buildApp({ db: openDb(':memory:') }).inject('/')).statusCode).toBe(404);
    expect((await buildApp({ db: openDb(':memory:'), webDir: '/nonexistent/dist' }).inject('/')).statusCode).toBe(404);
  });
});
