import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { resolveDataPaths } from '../apps/server/src/config/paths.ts';
import { checkPort, resolveEnvironment } from './dev.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Uso: sala migrate-state [--dry-run] [--yes]';
const MARGIN = 1.1;

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Files and bytes under `path` (symlinks are counted, never followed); zeros when absent. */
function dirSize(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { files: 0, bytes: 0 };
  }
  if (!stat.isDirectory()) return { files: 1, bytes: stat.size };
  return readdirSync(path).reduce(
    (sum, name) => {
      const inner = dirSize(join(path, name));
      return { files: sum.files + inner.files, bytes: sum.bytes + inner.bytes };
    },
    { files: 0, bytes: 0 },
  );
}

function tableCounts(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(names.map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS c FROM "${name.replaceAll('"', '""')}"`).get().c]));
}

const nearestExisting = (path) => (existsSync(path) ? path : nearestExisting(dirname(path)));

const defaultFreeBytes = (path) => {
  const stats = statfsSync(nearestExisting(path));
  return stats.bavail * stats.bsize;
};

/** Copies the database through SQLite's backup API (WAL-consistent) and proves the copy equals the origin. */
async function copyDatabase(source, destination) {
  const { DatabaseSync, backup } = await import('node:sqlite');
  const original = new DatabaseSync(source, { readOnly: true });
  let copy;
  try {
    await backup(original, destination);
    copy = new DatabaseSync(destination, { readOnly: true });
    const rows = copy.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error('la verificación de integridad de la copia no devolvió ok');
    const before = tableCounts(original);
    const after = tableCounts(copy);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('los conteos de tablas de la copia no coinciden con el origen');
    return Object.values(after).reduce((a, b) => a + b, 0);
  } finally {
    copy?.close();
    original.close();
  }
}

function copyTree(from, to, label) {
  if (!existsSync(from)) return { files: 0, bytes: 0 };
  const expected = dirSize(from);
  cpSync(from, to, { recursive: true, errorOnExist: true });
  const got = dirSize(to);
  if (got.files !== expected.files || got.bytes !== expected.bytes) throw new Error(`${label}: la copia (${got.files} archivos, ${got.bytes} B) no coincide con el origen`);
  return got;
}

/**
 * Copies the local state (database, images, recovery) from the legacy `<repo>/data` to the per-user directory.
 * Builds everything in `<dest>.migrating` and renames it only after verification, so a crash never leaves a
 * half-state that the resolver would pick up. The origin is never modified or deleted.
 * HLS is not copied (T47d/e): the new directory gets a link to the legacy `hls/`.
 * @returns {Promise<number>} exit code
 */
export async function migrateState({
  root: repository = root,
  env: external = process.env,
  dryRun = false,
  yes = false,
  out = console.log,
  err = console.error,
  confirm,
  checkPort: portCheck = checkPort,
  freeBytes = defaultFreeBytes,
} = {}) {
  const fail = (message) => {
    err(message);
    return 1;
  };
  const env = resolveEnvironment(repository, external);
  const paths = resolveDataPaths(env, { root: repository });
  const dest = paths.userDir;
  const source = paths.legacyDir;
  const staging = `${dest}.migrating`;

  if (paths.source === 'env') {
    return fail(`DATA_DIR está definido (${paths.stateDir}): es un override explícito y no se migra. Quítalo del entorno o de .env para usar ${dest}.`);
  }
  if (paths.source === 'user') {
    out(existsSync(join(dest, 'library.db')) ? `Ya usas el estado nuevo en ${dest}. Nada que migrar.` : `No hay estado en ${source}. Nada que migrar.`);
    return 0;
  }

  if (existsSync(dest) && (!lstatSync(dest).isDirectory() || readdirSync(dest).length > 0)) {
    return fail(`El destino ${dest} no está vacío: no se mezcla ni se sobrescribe. Revísalo o muévelo a mano y vuelve a intentar.`);
  }
  if (existsSync(staging)) {
    return fail(`Hay una migración a medias en ${staging}. Bórrala a mano (es solo una copia temporal) y vuelve a intentar.`);
  }

  const port = Number(env.PORT);
  try {
    await portCheck(port);
  } catch {
    return fail(`El puerto ${port} está ocupado: ¿sigue activo Sala? Ejecuta 'sala stop' (o detén 'npm run dev') y vuelve a intentar.`);
  }

  const db = ['library.db', 'library.db-wal'].reduce((sum, name) => sum + dirSize(join(source, name)).bytes, 0);
  const images = dirSize(join(source, 'images'));
  const recovery = dirSize(join(source, 'recovery'));
  const total = db + images.bytes + recovery.bytes;
  const free = freeBytes(dest);
  if (free < total * MARGIN) {
    return fail(`No hay espacio suficiente en ${dirname(dest)}: se necesitan ~${mb(total * MARGIN)} y hay ${mb(free)} libres.`);
  }

  out(`Origen:  ${source}`);
  out(`Destino: ${dest}`);
  out(`Se copiará: base de datos ${mb(db)}, imágenes ${images.files} archivos (${mb(images.bytes)}), copias de recuperación ${recovery.files} archivos (${mb(recovery.bytes)}).`);
  out(`El HLS no se mueve: ${join(dest, 'hls')} será un enlace a ${join(source, 'hls')}.`);
  if (dryRun) {
    out('Simulación: no se copió ni se cambió nada.');
    return 0;
  }
  if (!yes && !(await confirm?.(`¿Copiar ahora? (el origen no se borra)`))) {
    err('Cancelado: no se cambió nada. Usa --yes para confirmar sin preguntar.');
    return 1;
  }

  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    copyTree(join(source, 'images'), join(staging, 'images'), 'imágenes');
    copyTree(join(source, 'recovery'), join(staging, 'recovery'), 'recuperación');
    const rows = await copyDatabase(join(source, 'library.db'), join(staging, 'library.db'));
    if (existsSync(join(source, 'hls'))) symlinkSync(join(source, 'hls'), join(staging, 'hls'), 'junction');
    writeFileSync(join(staging, '.migrated-from.json'), `${JSON.stringify({ from: source, at: new Date().toISOString() }, null, 2)}\n`);
    if (existsSync(dest)) rmdirSync(dest); // empty (checked above); Windows cannot rename onto it
    renameSync(staging, dest);
    out(`Verificado: integrity_check ok, ${rows} filas en las tablas, imágenes y recuperación con los mismos tamaños.`);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return fail(`No se migró nada (el origen sigue intacto): ${error instanceof Error ? error.message : error}`);
  }

  out(`Listo: el estado nuevo está en ${dest}. El origen NO se borró.`);
  out('Siguiente:');
  out("  1. Reinicia ('sala restart' o 'npm run dev') y comprueba tu biblioteca. Si instalaste la unit antes de T47a, vuelve a ejecutar scripts/linux-install.sh y 'systemctl --user daemon-reload': la unit antigua fija DATA_DIR al repo.");
  out(`  2. Cuando lo hayas confirmado, libera espacio: rm -r -- '${join(source, 'library.db')}'* '${join(source, 'images')}' '${join(source, 'recovery')}'`);
  out(`     (no borres ${join(source, 'hls')}: el video sigue allí.)`);
  return 0;
}

async function ask(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(s|si|sí|y|yes)$/i.test((await rl.question(`${question} [s/N] `)).trim());
  } finally {
    rl.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--dry-run' && arg !== '--yes');
  if (unknown.length) {
    console.error(`Opción desconocida: ${unknown.join(' ')}. ${USAGE}`);
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = await migrateState({ dryRun: args.includes('--dry-run'), yes: args.includes('--yes'), confirm: ask });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
