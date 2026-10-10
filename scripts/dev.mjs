import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { parseEnv } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Node 24 strips types on import; the same module resolves the config for the server, so both agree.
import { configDir, readUserConfig } from '../apps/server/src/config/config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Single path-resolution point for the launcher (T22: consumes the user's content-folder choice).
 * CONTENT_DIR: external env → user config.json → root .env → default; DATA_DIR keeps external env → .env → default.
 * Defaults are anchored to the repository, never to the caller's cwd.
 * @returns {NodeJS.ProcessEnv}
 */
export function resolveEnvironment(repository = root, external = process.env) {
  let local = {};
  try {
    local = parseEnv(readFileSync(join(repository, '.env'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`No se pudo leer ${join(repository, '.env')}: ${error instanceof Error ? error.message : error}`, { cause: error });
    }
  }
  const env = { ...local, ...external };
  if (env.PORT !== undefined && env.PORT !== '8080') {
    throw new Error(`PORT=${env.PORT} no es compatible: el proxy /api apunta a 8080. Usa PORT=8080 o quita la variable.`);
  }
  env.PORT = '8080';
  const configured = readUserConfig({ dir: configDir(env) })?.contentDir;
  const fallback = { DATA_DIR: 'data', CONTENT_DIR: 'content' };
  const chosen = {
    DATA_DIR: external.DATA_DIR ?? local.DATA_DIR,
    CONTENT_DIR: external.CONTENT_DIR ?? configured ?? local.CONTENT_DIR,
  };
  for (const key of ['DATA_DIR', 'CONTENT_DIR']) {
    const value = chosen[key];
    if (value === '') throw new Error(`${key} está vacío. Quita la variable para usar ${fallback[key]}/ o dale una ruta.`);
    env[key] = resolve(repository, value ?? fallback[key]);
  }
  return env;
}

async function checkPort(port) {
  for (const host of ['0.0.0.0', '::']) {
    await new Promise((accept, reject) => {
      const server = createServer();
      server.once('error', (error) => {
        if (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL') return accept();
        reject(new Error(`El puerto ${port} ya está ocupado. Identifica y detén solo tu propio proceso; el lanzador no terminó ningún proceso ajeno.`));
      });
      server.listen({ port, host, exclusive: true }, () => server.close(accept));
    });
  }
}

/**
 * Consistent SQLite snapshot of the library database before the backend opens it (WAL included).
 * Videos and HLS are NOT covered. Fails closed; unique destination, never overwrites an existing backup.
 * @returns {Promise<string | undefined>} backup path, or undefined when there is no database yet
 */
export async function backupLibrary(dataDir) {
  const source = join(dataDir, 'library.db');
  if (!existsSync(source)) return undefined;
  let original;
  let copy;
  try {
    const { DatabaseSync, backup } = await import('node:sqlite');
    original = new DatabaseSync(source, { readOnly: true });
    const recovery = join(dataDir, 'recovery');
    mkdirSync(recovery, { recursive: true, mode: 0o700 });
    const destination = join(mkdtempSync(join(recovery, 'before-start-')), 'library.db');
    await backup(original, destination);
    copy = new DatabaseSync(destination, { readOnly: true });
    const rows = copy.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error('la verificación de integridad no devolvió ok');
    return destination;
  } catch (error) {
    throw new Error(
      `No se pudo crear la copia de seguridad de SQLite (${error instanceof Error ? error.message : error}). El backend no se inició; revisa la base, los permisos y el espacio libre.`,
      { cause: error },
    );
  } finally {
    copy?.close();
    original?.close();
  }
}

/**
 * Preflight before spawning anything: resolve paths, verify DATA_DIR exists, verify ports are free,
 * back up SQLite. CONTENT_DIR is not validated here any more (T22): the server reports unset/missing
 * to the UI and never scans or creates an empty library. Never creates directories or a replacement
 * library, never migrates the database.
 * @returns {Promise<{env: NodeJS.ProcessEnv, backup: string | undefined}>}
 */
export async function prepare(repository = root, external = process.env, ports = [8080, 5174]) {
  const env = resolveEnvironment(repository, external);
  let dataValid = false;
  try {
    dataValid = statSync(env.DATA_DIR).isDirectory();
  } catch {
    // Storage must already exist: creating it here could build an empty library on a disconnected disk.
  }
  if (!dataValid) {
    throw new Error(
      `La carpeta configurada en DATA_DIR no existe: ${env.DATA_DIR}. Reconecta el disco o la unidad donde vive la biblioteca; ` +
        `en una instalación nueva, créala a propósito (por ejemplo: mkdir -p '${env.DATA_DIR}'). No se creó nada para no fabricar una biblioteca vacía.`,
    );
  }
  for (const port of ports) await checkPort(port);
  return { env, backup: await backupLibrary(env.DATA_DIR) };
}

/**
 * Supervises only its own children. Each child leads a dedicated process group so npm, node --watch
 * and ffmpeg descendants can be stopped without touching anyone else's processes.
 * @returns {Promise<number>} 0 when stopped by signal, the failing child's code otherwise
 */
export async function supervise(commands, env, { cwd = root, graceMs = 3000, signal } = {}) {
  if (signal?.aborted) return 0;
  const children = [];
  let stopping;
  let result = 0;
  function groupSignal(child, value) {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, value);
      return true;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      return false;
    }
  }
  function stop(code) {
    if (stopping) return;
    result = code;
    stopping = (async () => {
      for (const child of children) groupSignal(child, 'SIGTERM');
      const deadline = Date.now() + graceMs;
      while (children.some((child) => groupSignal(child, 0)) && Date.now() < deadline) {
        await new Promise((accept) => setTimeout(accept, 50));
      }
      // Leaders can exit before npm/watch/ffmpeg descendants; keep ownership of their groups only.
      for (const child of children) if (groupSignal(child, 0)) groupSignal(child, 'SIGKILL');
    })();
  }
  const abort = () => stop(0);
  signal?.addEventListener('abort', abort, { once: true });
  const exits = [];
  try {
    for (const [command, ...args] of commands) {
      const child = spawn(command, args, { cwd, env, stdio: 'inherit', detached: true });
      children.push(child);
      exits.push(
        new Promise((accept) => {
          child.once('error', () => {
            console.error('No se pudo iniciar un proceso de desarrollo. Revisa npm y las dependencias del workspace.');
            stop(1);
            accept();
          });
          child.once('exit', (code, exitSignal) => {
            if (!stopping) stop(code && code > 0 ? code : 1);
            if (code && !exitSignal) console.error(`Un proceso de desarrollo terminó con código ${code}.`);
            accept();
          });
        }),
      );
    }
    await Promise.all(exits);
    await stopping;
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const prepared = await prepare();
    if (prepared.backup) console.log(`Copia SQLite verificada (solo base de datos, no videos ni HLS): ${prepared.backup}`);
    if (!controller.signal.aborted) {
      console.log(`Datos: ${prepared.env.DATA_DIR} | Contenido: ${prepared.env.CONTENT_DIR}`);
      console.log('Iniciando backend (8080) y frontend (5174). Interfaz: http://localhost:5174 | Salud API: http://localhost:8080/api/health');
      console.log('Que el proceso haya arrancado no prueba que la app esté lista: verifica la salud HTTP. Ctrl+C detiene ambos procesos.');
      process.exitCode = await supervise(
        [
          ['npm', 'run', 'dev', '-w', 'apps/server'],
          ['npm', 'run', 'dev', '-w', 'apps/web', '--', '--port', '5174', '--strictPort'],
        ],
        prepared.env,
        { signal: controller.signal },
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
