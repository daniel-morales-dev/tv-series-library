#!/usr/bin/env node
// Thin launcher: `node scripts/data-report.mjs [--purge-orphans] [--dedupe-fonts] [--yes] ...`
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../apps/server/src/cli/data-report.ts', import.meta.url));
spawn(process.execPath, ['--env-file-if-exists=.env', cli, ...process.argv.slice(2)], { stdio: 'inherit' }).on('close', (code) => process.exit(code ?? 1));
