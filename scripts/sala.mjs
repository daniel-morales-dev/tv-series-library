#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, apiBase } from './sala-cli.mjs';

const stdio = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

const deps = {
  env: process.env,
  out: (s) => console.log(s),
  err: (s) => console.error(s),
  systemctl: async (args) => {
    const r = stdio('systemctl', ['--user', ...args]);
    if (r.error) return { status: 1, stdout: '' };
    return { status: r.status ?? 1, stdout: r.stdout ?? '' };
  },
  journal: (args) =>
    new Promise((resolve) => {
      const child = spawn('journalctl', args, { stdio: 'inherit' });
      child.on('error', () => {
        console.error('No pude ejecutar journalctl.');
        resolve(1);
      });
      child.on('close', (code) => resolve(code ?? 0));
    }),
  migrateState: (args) =>
    new Promise((resolve) => {
      const script = join(dirname(fileURLToPath(import.meta.url)), 'migrate-state.mjs');
      const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
      child.on('error', () => resolve(1));
      child.on('close', (code) => resolve(code ?? 1));
    }),
  http: async (method, path) => {
    const res = await fetch(apiBase(process.env) + path, { method, signal: AbortSignal.timeout(3000) });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  },
  openUrl: async (url) => {
    const r = stdio('xdg-open', [url]);
    return !r.error && r.status === 0;
  },
};

process.exitCode = await run(process.argv.slice(2), deps);
