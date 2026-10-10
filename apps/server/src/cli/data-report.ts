// Read-only report of DATA_DIR plus an explicit, dry-run-by-default cleanup. Never touches the content folder.
import { lstat, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { dedupeFontsDir } from '../modules/processing/fonts.ts';

export interface ReportOptions {
  dataDir: string;
  contentDir: string;
  now?: number;
  /** A `.tmp` folder untouched for less than this is assumed to be a live encode. */
  minAgeMs?: number;
}

export interface Truncated {
  id: number;
  dir: string;
  bytes: number;
  reason: 'no_playlist' | 'missing_segments' | 'short';
  /** true only when the content folder is readable and the original is not in it. */
  originalMissing: boolean;
}

export interface Report {
  sizes: Record<string, number>;
  total: number;
  truncated: Truncated[];
  tmpOrphans: { dir: string; bytes: number; ageMs: number }[];
  /** Package folders no database row points at: reported only, never purged. */
  unreferenced: { dir: string; bytes: number }[];
}

interface Row {
  id: number;
  path: string;
  status: string;
  duration_s: number | null;
}

async function* walk(dir: string): AsyncGenerator<{ path: string; size: number; mtimeMs: number; key: string }> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) {
      const s = await lstat(p).catch(() => null);
      if (s) yield { path: p, size: s.size, mtimeMs: s.mtimeMs, key: `${s.dev}:${s.ino}` };
    }
  }
}

function category(rel: string[]): string {
  const [a, b, c] = rel;
  if (a === 'hls') {
    if (b?.endsWith('.tmp')) return 'tmp';
    if (c === 'v') return 'video';
    if (c && /^a\d+$/.test(c)) return 'audio';
    if (c === 'subs') return 'subtitles';
    if (c === 'fonts') return 'fonts';
    return 'other';
  }
  if (a === 'fonts') return 'fonts';
  if (a === 'images') return 'images';
  if (a?.startsWith('library.db')) return 'db';
  return 'other';
}

async function dirStats(dir: string) {
  const seen = new Set<string>();
  let bytes = 0;
  let newest = 0;
  for await (const f of walk(dir)) {
    newest = Math.max(newest, f.mtimeMs);
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    bytes += f.size;
  }
  const own = await stat(dir).catch(() => null);
  return { bytes, newest: Math.max(newest, own?.mtimeMs ?? 0) };
}

function readRows(dataDir: string): Map<number, Row> | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(dataDir, 'library.db'), { readOnly: true });
    const rows = db.prepare('SELECT id, path, status, duration_s FROM media_files').all() as unknown as Row[];
    return new Map(rows.map((r) => [r.id, r]));
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

// Why a package is truncated, judged from its own files and the duration the database expects.
async function truncation(dir: string, durationS: number | null): Promise<Truncated['reason'] | null> {
  const playlist = await readFile(join(dir, 'v/index.m3u8'), 'utf8').catch(() => null);
  if (playlist === null) return 'no_playlist';
  const listed = [...playlist.matchAll(/^#EXTINF:([\d.]+)[^\n]*\n(\S+)/gm)];
  let missing = 0;
  for (const m of listed) if (!(await stat(join(dir, 'v', m[2]!)).catch(() => null))?.isFile()) missing++;
  if (missing > 0 || listed.length === 0) return 'missing_segments';
  const playS = listed.reduce((sum, m) => sum + Number(m[1]), 0);
  return durationS && playS < durationS * 0.9 ? 'short' : null;
}

export async function buildReport(opts: ReportOptions): Promise<Report> {
  const { dataDir, contentDir } = opts;
  const now = opts.now ?? Date.now();
  const minAge = opts.minAgeMs ?? 3600_000;
  const root = resolve(dataDir);
  const report: Report = { sizes: {}, total: 0, truncated: [], tmpOrphans: [], unreferenced: [] };

  const seen = new Set<string>();
  for await (const f of walk(root)) {
    if (seen.has(f.key)) continue; // a hardlinked file weighs once
    seen.add(f.key);
    const c = category(f.path.slice(root.length + 1).split(sep));
    report.sizes[c] = (report.sizes[c] ?? 0) + f.size;
    report.total += f.size;
  }

  const rows = readRows(root);
  const contentOk = await readdir(contentDir).then((l) => l.length > 0, () => false);
  for (const e of await readdir(join(root, 'hls'), { withFileTypes: true }).catch(() => [])) {
    const m = e.isDirectory() ? /^(\d+)(\.tmp)?$/.exec(e.name) : null;
    if (!m) continue;
    const id = Number(m[1]);
    const dir = join(root, 'hls', e.name);
    const row = rows?.get(id);
    const { bytes, newest } = await dirStats(dir);
    if (m[2]) {
      const ageMs = now - newest;
      if (ageMs >= minAge && row?.status !== 'processing') report.tmpOrphans.push({ dir, bytes, ageMs });
      continue;
    }
    if (rows && !row) {
      report.unreferenced.push({ dir, bytes });
      continue;
    }
    if (row && row.status !== 'ready') continue;
    const reason = await truncation(dir, row?.duration_s ?? null);
    if (!reason) continue;
    const originalMissing = Boolean(row) && contentOk && !(await stat(join(contentDir, row!.path)).catch(() => null))?.isFile();
    report.truncated.push({ id, dir, bytes, reason, originalMissing });
  }
  report.truncated.sort((a, b) => a.id - b.id);
  return report;
}

// Only stale `.tmp` folders and truncated packages whose original is gone (they cannot be rebuilt) are removable.
export async function purgeOrphans(dataDir: string, report: Report, o: { yes: boolean }) {
  const hls = join(resolve(dataDir), 'hls');
  const targets = [...report.tmpOrphans.map((t) => t.dir), ...report.truncated.filter((t) => t.originalMissing).map((t) => t.dir)]
    .map((d) => resolve(d))
    .filter((d) => dirname(d) === hls && /^\d+(\.tmp)?$/.test(basename(d)));
  const removed: string[] = [];
  if (o.yes) for (const d of targets) await rm(d, { recursive: true, force: true }).then(() => removed.push(d));
  return { planned: targets, removed };
}

export async function dedupeStore(dataDir: string, o: { yes: boolean }) {
  const root = resolve(dataDir);
  const planned = new Set<string>();
  const total = { files: 0, linked: 0, skipped: 0, savedBytes: 0 };
  for (const e of await readdir(join(root, 'hls'), { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
    const r = await dedupeFontsDir(join(root, 'hls', e.name, 'fonts'), join(root, 'fonts', '_store'), { dryRun: !o.yes, planned });
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += r[k];
  }
  return total;
}

const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(1)} kB`);

export async function runCli(argv: string[], io: { out: (s: string) => void; now?: number }): Promise<number> {
  let v;
  try {
    v = parseArgs({
      args: argv,
      options: {
        'data-dir': { type: 'string' },
        'content-dir': { type: 'string' },
        'min-age-min': { type: 'string' },
        'purge-orphans': { type: 'boolean' },
        'dedupe-fonts': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean' },
      },
    }).values;
  } catch (err) {
    io.out(`${(err as Error).message}\nUso: data-report [--purge-orphans] [--dedupe-fonts] [--dry-run] [--yes] [--data-dir D] [--content-dir C] [--min-age-min N]`);
    return 2;
  }
  const dataDir = v['data-dir'] ?? process.env.DATA_DIR ?? './data';
  const contentDir = v['content-dir'] ?? process.env.CONTENT_DIR ?? './content';
  const yes = Boolean(v.yes) && !v['dry-run']; // --dry-run always wins
  const report = await buildReport({ dataDir, contentDir, now: io.now, minAgeMs: v['min-age-min'] ? Number(v['min-age-min']) * 60_000 : undefined });

  io.out(`Datos: ${resolve(dataDir)} (${fmt(report.total)})`);
  for (const [k, n] of Object.entries(report.sizes).sort((a, b) => b[1] - a[1])) io.out(`  ${k.padEnd(10)} ${fmt(n)}`);
  io.out(`Paquetes ready truncados: ${report.truncated.length}`);
  for (const t of report.truncated) io.out(`  #${t.id} ${t.reason} ${fmt(t.bytes)} ${t.originalMissing ? 'original ausente (purgable)' : 'se puede reprocesar'}`);
  io.out(`.tmp huerfanos: ${report.tmpOrphans.length}`);
  for (const t of report.tmpOrphans) io.out(`  ${t.dir} ${fmt(t.bytes)} (${Math.round(t.ageMs / 60_000)} min sin cambios)`);
  if (report.unreferenced.length > 0) io.out(`Paquetes sin fila en la BD (solo informativo): ${report.unreferenced.length}`);

  if (v['purge-orphans']) {
    const plan = await purgeOrphans(dataDir, report, { yes: false });
    io.out(`Purga (${yes ? 'se aplicara' : 'dry-run'}): ${plan.planned.length} carpetas`);
    for (const d of plan.planned) io.out(`  - ${d}`);
    if (yes) io.out(`Eliminadas: ${(await purgeOrphans(dataDir, report, { yes })).removed.length}`);
    else io.out('Nada se borro. Repite con --yes para aplicar.');
  }
  if (v['dedupe-fonts']) {
    const r = await dedupeStore(dataDir, { yes });
    io.out(`Fuentes (${yes ? 'aplicado' : 'dry-run'}): ${r.linked} enlaces, ${fmt(r.savedBytes)} liberables, ${r.skipped} sin hardlink`);
    if (!yes) io.out('Nada se modifico. Repite con --yes para aplicar.');
  }
  return 0;
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2), { out: (s) => console.log(s) });
