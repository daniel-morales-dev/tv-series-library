import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { configDir, libraryDiskPresent, resolveContentDir } from '../apps/server/src/config/config.ts';
import { resolveDataPaths } from '../apps/server/src/config/paths.ts';
import {
  assertCanSwitchPointer, buildPlan, clearJournal, freeOrigin, MigrationError, readHlsPointer, readJournal, runMigration,
  switchPointer, writeJournal,
} from '../apps/server/src/modules/data-migration/migrate.ts';
import { checkPort, resolveEnvironment } from './dev.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Uso: sala migrate-data [--to <carpeta>] [--dry-run] [--yes] | sala migrate-data --free-origin [--yes]';
const GB = 1024 ** 3;
const gb = (bytes) => `${(bytes / GB).toFixed(1).replace('.', ',')} GB`;

/**
 * T47e: moves the HLS packages next to the library (`<content>/.sala/hls`), verifies them, switches `hlsDir` in
 * config.json and only then — in a separate, confirmed step — frees the origin. Resumable: rerun to continue.
 * @returns {Promise<number>} exit code
 */
export async function migrateData({
  root: repository = root,
  env: external = process.env,
  configDir: cfgOverride,
  to,
  dryRun = false,
  yes = false,
  free = false,
  out = console.log,
  err = console.error,
  confirm,
  checkPort: portCheck = checkPort,
  deps,
  minFreeBytes = Number(external.MIN_FREE_GB ?? 10) * GB,
  minFreePct = Number(external.MIN_FREE_PCT ?? 10),
} = {}) {
  const fail = (message) => {
    err(message);
    return 1;
  };
  const env = resolveEnvironment(repository, external);
  const cfgDir = cfgOverride ?? configDir(env);
  const paths = resolveDataPaths(env, { root: repository, configDir: cfgDir });
  const contentDir = resolveContentDir(env, { dir: cfgDir, root: repository });
  const diskPresent = () => libraryDiskPresent(contentDir, { dir: cfgDir });
  const journal = readJournal(paths.stateDir);

  try {
    assertCanSwitchPointer(env, cfgDir);
    if (!diskPresent()) return fail('El disco de la biblioteca no está disponible. Conéctalo y vuelve a intentar: no se creó nada.');

    if (free) {
      if (!journal) return fail('No hay un movimiento pendiente de confirmar. Primero ejecuta: sala migrate-data');
      const pointer = readHlsPointer(cfgDir);
      if (!pointer || resolve(pointer) !== resolve(journal.to)) return fail('Los datos aún no se movieron por completo. Ejecuta: sala migrate-data');
      out(`Se borrarán de ${journal.from} los paquetes ya verificados en ${journal.to}.`);
      if (!yes && !(await confirm?.('¿Ya reiniciaste Sala (sala restart) y comprobaste que la biblioteca se ve bien? ¿Liberar el origen?'))) {
        err('Cancelado: no se borró nada. Usa --yes para confirmar sin preguntar.');
        return 1;
      }
      const result = await freeOrigin(journal);
      if (!result.kept.length) await clearJournal(paths.stateDir);
      out(`Liberado: ${result.freedPackages} paquetes (${gb(result.freedBytes)}).`);
      if (result.kept.length) out(`Se conservaron ${result.kept.length} paquetes sin copia verificada (nuevos o incompletos): ejecuta 'sala migrate-data' otra vez para moverlos.`);
      return 0;
    }

    const from = journal?.from ?? paths.hlsDir;
    const target = journal?.to ?? resolve(to ?? join(contentDir, '.sala', 'hls'));
    const options = { from, to: target, minFreeBytes, minFreePct, deps };
    const plan = await buildPlan(options);
    out(`Origen:  ${plan.from}`);
    out(`Destino: ${plan.to}`);
    out(`Método: ${plan.method === 'link' ? 'enlaces duros (misma partición: no ocupa espacio extra)' : 'copia verificada (otra partición)'}.`);
    out(`Paquetes: ${plan.packages.length} (${gb(plan.totalBytes)}); ya movidos ${plan.movedCount}; por mover ${plan.pendingCount} (${gb(plan.pendingBytes)}).`);
    out(`Espacio libre en el destino: ${gb(plan.freeBytes)}; hace falta ${gb(plan.requiredBytes)} (incluye el margen de ${gb(plan.minFreeBytes)}).`);
    if (!plan.fits) return fail('No hay espacio suficiente en el destino. No se movió nada.');
    if (dryRun) {
      out('Simulación: no se movió ni se cambió nada.');
      return 0;
    }
    try {
      await portCheck(Number(env.PORT));
    } catch {
      return fail(`El puerto ${env.PORT} está ocupado: ¿sigue activo Sala? Ejecuta 'sala stop' y vuelve a intentar.`);
    }
    if (!yes && !(await confirm?.('¿Mover ahora? (el origen no se borra)'))) {
      err('Cancelado: no se cambió nada. Usa --yes para confirmar sin preguntar.');
      return 1;
    }
    await writeJournal(paths.stateDir, { from: plan.from, to: plan.to, startedAt: new Date().toISOString() });
    let last = -1;
    const result = await runMigration({
      ...options,
      diskPresent,
      switchPointer: async () => switchPointer(plan.to, cfgDir),
      onProgress: (p) => {
        if (p.done !== last) out(`  ${p.done}/${p.total} paquetes${p.current ? ` (último: ${p.current})` : ''}`);
        last = p.done;
      },
    });
    out(`Verificado: ${result.moved} paquetes movidos, ${result.skipped} ya estaban. config.json apunta a ${plan.to}.`);
    out('Siguiente:');
    out("  1. Reinicia ('sala restart') y comprueba tu biblioteca. El origen sigue intacto.");
    out("  2. Cuando lo confirmes, libera espacio: sala migrate-data --free-origin");
    return 0;
  } catch (error) {
    if (error instanceof MigrationError) return fail(`${error.message} (el origen sigue intacto)`);
    throw error;
  }
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

/** Parses `sala migrate-data` arguments and runs it; shared by the CLI dispatcher and direct execution. */
export async function runCli(args) {
  const flags = new Set(['--dry-run', '--yes', '--free-origin']);
  const rest = [...args];
  let to;
  const toAt = rest.indexOf('--to');
  if (toAt >= 0) {
    to = rest[toAt + 1];
    rest.splice(toAt, 2);
    if (!to || to.startsWith('--') || !to.startsWith('/')) {
      console.error(`--to necesita una ruta absoluta. ${USAGE}`);
      return 2;
    }
  }
  const unknown = rest.filter((arg) => !flags.has(arg));
  if (unknown.length) {
    console.error(`Opción desconocida: ${unknown.join(' ')}. ${USAGE}`);
    return 2;
  }
  try {
    return await migrateData({ to, dryRun: rest.includes('--dry-run'), yes: rest.includes('--yes'), free: rest.includes('--free-origin'), confirm: ask });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
