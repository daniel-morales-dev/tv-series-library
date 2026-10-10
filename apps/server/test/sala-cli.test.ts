import { describe, expect, test } from 'vitest';
// @ts-expect-error The CLI is native JavaScript, outside the server TypeScript project.
import { run, apiBase, HELP } from '../../../scripts/sala-cli.mjs';

interface Fake {
  code: number;
  out: string;
  err: string;
  calls: string[];
  opened: string[];
}

type Reply = { ok: boolean; status: number; body: unknown } | 'down';

function setup(opts: { active?: boolean; api?: Record<string, Reply>; systemctlFails?: boolean; hasXdg?: boolean; env?: Record<string, string> } = {}) {
  const f: Fake = { code: -1, out: '', err: '', calls: [], opened: [] };
  const deps = {
    env: opts.env ?? {},
    out: (s: string) => (f.out += s + '\n'),
    err: (s: string) => (f.err += s + '\n'),
    systemctl: async (args: string[]) => {
      f.calls.push('systemctl --user ' + args.join(' '));
      if (args[0] === 'is-active') return { status: opts.active ? 0 : 3, stdout: opts.active ? 'active' : 'inactive' };
      return { status: opts.systemctlFails ? 1 : 0, stdout: '' };
    },
    journal: async (args: string[]) => {
      f.calls.push('journalctl ' + args.join(' '));
      return 0;
    },
    http: async (method: string, path: string) => {
      f.calls.push(`${method} ${path}`);
      const r = opts.api?.[`${method} ${path}`] ?? 'down';
      if (r === 'down') throw new Error('ECONNREFUSED');
      return r;
    },
    openUrl: async (url: string) => {
      f.opened.push(url);
      return opts.hasXdg ?? true;
    },
    migrateState: async (args: string[]) => {
      f.calls.push('migrate-state ' + args.join(' '));
      return 0;
    },
    migrateData: async (args: string[]) => {
      f.calls.push('migrate-data ' + args.join(' '));
      return 0;
    },
  };
  const exec = async (...argv: string[]) => {
    f.code = await run(argv, deps);
    return f;
  };
  return { exec, f };
}

const ok = (body: unknown): Reply => ({ ok: true, status: 200, body });
const activity = (extra: object = {}) => ok({ running: [], queued: [], queuedTotal: 0, failed: [], paused: false, ...extra });

describe('sala CLI', () => {
  test('apiBase uses PORT or 8080 on 127.0.0.1', () => {
    expect(apiBase({})).toBe('http://127.0.0.1:8080');
    expect(apiBase({ PORT: '9090' })).toBe('http://127.0.0.1:9090');
    expect(apiBase({ PORT: 'abc' })).toBe('http://127.0.0.1:8080');
  });

  test('help is Spanish and lists every subcommand; no args and unknown command', async () => {
    for (const a of [['--help'], [], ['-h']]) {
      const { exec } = setup();
      const f = await exec(...a);
      expect(f.code).toBe(0);
      for (const c of ['start', 'stop', 'restart', 'status', 'pause', 'resume', 'open', 'logs', 'url']) expect(f.out).toContain(`sala ${c}`);
    }
    expect(HELP).toContain('Uso');
    const { exec } = setup();
    const f = await exec('bailar');
    expect(f.code).toBe(2);
    expect(f.err).toContain('bailar');
    expect(f.err).toContain('sala --help');
  });

  test('start/stop/restart wrap systemctl --user', async () => {
    const s = setup();
    expect((await s.exec('start')).calls).toContain('systemctl --user start sala');
    expect(s.f.code).toBe(0);
    const t = setup({ active: true });
    await t.exec('stop');
    expect(t.f.calls).toContain('systemctl --user stop sala');
    const r = setup({ active: true });
    await r.exec('restart');
    expect(r.f.calls).toContain('systemctl --user restart sala');
  });

  test('start: already active does nothing; port busy by dev server refuses; systemctl failure is actionable', async () => {
    const a = setup({ active: true });
    await a.exec('start');
    expect(a.f.out).toContain('ya está en marcha');
    expect(a.f.calls.some((c) => c.endsWith('start sala'))).toBe(false);

    const dev = setup({ active: false, api: { 'GET /api/network': ok({ urls: [] }) } });
    await dev.exec('start');
    expect(dev.f.code).toBe(1);
    expect(dev.f.err).toContain('npm run dev');
    expect(dev.f.calls.some((c) => c.endsWith('start sala'))).toBe(false);

    const bad = setup({ systemctlFails: true });
    await bad.exec('start');
    expect(bad.f.code).toBe(1);
    expect(bad.f.err).toContain('sala logs');
  });

  test('status: stopped service, dev server on the port, and processing summary', async () => {
    const stopped = setup();
    await stopped.exec('status');
    expect(stopped.f.out).toContain('detenida');
    expect(stopped.f.out).toContain('sala start');

    const dev = setup({ api: { 'GET /api/activity': activity() } });
    await dev.exec('status');
    expect(dev.f.out).toContain('npm run dev');

    const live = setup({
      active: true,
      api: { 'GET /api/activity': activity({ running: [{}], queuedTotal: 4, failed: [{}, {}], paused: true }) },
    });
    await live.exec('status');
    expect(live.f.out).toContain('en marcha');
    expect(live.f.out).toContain('en pausa');
    expect(live.f.out).toContain('4 en cola');
    expect(live.f.out).toContain('2 con error');

    const idle = setup({ active: true, api: { 'GET /api/activity': activity() } });
    await idle.exec('status');
    expect(idle.f.out).toContain('Sin trabajo pendiente');
  });

  test('status: active but API not answering says it is starting', async () => {
    const s = setup({ active: true });
    await s.exec('status');
    expect(s.f.out).toContain('no responde');
    expect(s.f.out).toContain('sala logs');
  });

  test('pause/resume call the API; unreachable and processing_disabled are explained', async () => {
    const p = setup({ api: { 'POST /api/processing/pause': ok({ paused: true }), 'POST /api/processing/resume': ok({ paused: false }) } });
    await p.exec('pause');
    expect(p.f.calls).toContain('POST /api/processing/pause');
    expect(p.f.out).toContain('en pausa');
    await p.exec('resume');
    expect(p.f.out).toContain('reanudado');
    expect(p.f.code).toBe(0);

    const down = setup();
    await down.exec('pause');
    expect(down.f.code).toBe(1);
    expect(down.f.err).toContain('sala start');

    const off = setup({ api: { 'POST /api/processing/pause': { ok: false, status: 409, body: { error: 'processing_disabled' } } } });
    await off.exec('pause');
    expect(off.f.code).toBe(1);
    expect(off.f.err).toContain('desactivado');
  });

  test('url prints LAN urls; none and unreachable are explained', async () => {
    const u = setup({ api: { 'GET /api/network': ok({ port: 8080, urls: ['http://192.168.1.5:8080', 'http://10.0.0.2:8080'] }) } });
    await u.exec('url');
    expect(u.f.out).toContain('http://192.168.1.5:8080');
    expect(u.f.out).toContain('http://10.0.0.2:8080');

    const none = setup({ api: { 'GET /api/network': ok({ port: 8080, urls: [] }) } });
    await none.exec('url');
    expect(none.f.out).toContain('WiFi');

    const down = setup();
    await down.exec('url');
    expect(down.f.code).toBe(1);
  });

  test('open uses xdg-open on the first LAN url or localhost; without xdg-open prints the url', async () => {
    const o = setup({ api: { 'GET /api/network': ok({ port: 8080, urls: ['http://192.168.1.5:8080'] }) } });
    await o.exec('open');
    expect(o.f.opened).toEqual(['http://127.0.0.1:8080']);

    const noXdg = setup({ hasXdg: false, api: { 'GET /api/network': ok({ port: 8080, urls: [] }) } });
    await noXdg.exec('open');
    expect(noXdg.f.out).toContain('http://127.0.0.1:8080');
    expect(noXdg.f.code).toBe(0);

    const down = setup();
    await down.exec('open');
    expect(down.f.code).toBe(1);
    expect(down.f.opened).toEqual([]);
  });

  test('migrate-state delegates to the migration script with its flags and is in the help', async () => {
    const m = setup();
    expect((await m.exec('migrate-state', '--dry-run')).calls).toContain('migrate-state --dry-run');
    expect(m.f.code).toBe(0);
    expect(HELP).toContain('sala migrate-state');
  });

  test('migrate-data delegates with its flags and is in the help', async () => {
    const m = setup();
    expect((await m.exec('migrate-data', '--free-origin', '--yes')).calls).toContain('migrate-data --free-origin --yes');
    expect(HELP).toContain('sala migrate-data');
    expect(HELP).toContain('--free-origin');
  });

  test('logs follows the user journal of the sala unit', async () => {
    const l = setup();
    await l.exec('logs');
    expect(l.f.calls).toContain('journalctl --user -u sala -n 50 -f');
  });
});
