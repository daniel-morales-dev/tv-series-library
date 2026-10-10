import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { parseEnv } from 'node:util';
import { dirname, join, resolve, sep } from 'node:path';
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

export async function checkPort(port) {
  for (const host of ['0.0.0.0', '::']) {
    await new Promise((accept, reject) => {
      const server = createServer();
      server.once('error', (error) => {
        if (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL') return accept();
        const busy = new Error(
          `El puerto ${port} ya está ocupado. Identifica y detén solo tu propio proceso; el lanzador no terminó ningún proceso ajeno.`,
        );
        busy.code = error.code;
        reject(busy);
      });
      server.listen({ port, host, exclusive: true }, () => server.close(accept));
    });
  }
}

const RELEASE_POLL_MS = 250;
const RELEASE_TIMEOUT_MS = 5000;
const FORCE_TIMEOUT_MS = 2000;

function readProc(pid, file) {
  try {
    return readFileSync(`/proc/${pid}/${file}`, 'utf8');
  } catch {
    return undefined;
  }
}

/** True when the process runs inside the repository and its command line carries the marker. */
function isOwnDevProcess(pid, repository, marker) {
  let cwd;
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return false;
  }
  if (cwd !== repository && !cwd.startsWith(repository + sep)) return false;
  return readProc(pid, 'cmdline')?.includes(marker) ?? false;
}

/** True when a /proc/<pid>/cgroup dump places the process inside the systemd unit `sala.service`. */
export function isSalaServiceCgroup(cgroup) {
  return /(^|\/)sala\.service(\/|$)/m.test(cgroup ?? '');
}

/** Command-line marker identifying the owner of each preflight port: the backend server and vite. */
export const PORT_MARKERS = { 8080: 'src/index.ts', 5174: 'vite' };

/**
 * Linux only (Windows cleanup is deferred per the project ADR): identifies the process listening
 * on `port` when it is this repository's own dev process — the backend (`src/index.ts`) on 8080
 * or vite on 5174 — with its cwd inside the repository. `parentPid` is the backend's
 * `node --watch` parent when that parent also belongs to the repository, so the watcher cannot
 * respawn the server; vite has no watcher, so the lookup finds none.
 * Undefined for foreign, unmapped or unreadable holders: the caller must never signal those.
 * A holder inside `sala.service` is reported as `{service: true, own: false}` so the caller refuses to kill it.
 * @returns {{pid: number, parentPid: number | null, own: boolean, service?: true} | undefined}
 */
export function findOwnServerHolder(port, repository = root) {
  if (process.platform !== 'linux') return undefined;
  const marker = PORT_MARKERS[port];
  if (!marker) return undefined;
  const ss = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
  const pid = Number(/pid=(\d+)/.exec(ss.stdout ?? '')?.[1]);
  if (ss.error || !pid) return undefined;
  if (isSalaServiceCgroup(readProc(pid, 'cgroup'))) return { pid, parentPid: null, own: false, service: true };
  if (!isOwnDevProcess(pid, repository, marker)) return undefined;
  const parentPid = Number(/^PPid:\s*(\d+)/m.exec(readProc(pid, 'status') ?? '')?.[1]) || null;
  return { pid, parentPid: parentPid && isOwnDevProcess(parentPid, repository, '--watch') ? parentPid : null, own: true };
}

/** Sends a signal to a process that may already be gone; the port poll decides if cleanup worked. */
function signalQuietly(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone or not signalable.
  }
}

/** SIGTERM to a verified holder and, when present, its watcher parent. */
export function stopHolder({ pid, parentPid }) {
  for (const target of [pid, parentPid]) if (target) signalQuietly(target, 'SIGTERM');
}

/**
 * Escalation for a holder that ignored SIGTERM (linux only): SIGKILL the holder and its watcher parent.
 * Its ffmpeg is left alone (T40d): the next server adopts a verified one or terminates an orphan at
 * start(), so no second writer reaches data/hls/*.tmp (T34).
 */
export function forceHolder({ pid, parentPid }) {
  if (process.platform !== 'linux') return;
  for (const target of [pid, parentPid]) if (target) signalQuietly(target, 'SIGKILL');
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await checkPort(port);
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((accept) => setTimeout(accept, RELEASE_POLL_MS));
    }
  }
}

/**
 * Stops an orphaned dev process (backend or vite) from this repository still holding `port`:
 * SIGTERM first; when the port is still held (a hung event loop ignores SIGTERM), escalates to
 * SIGKILL of the holder and its watcher parent; its ffmpeg survives to be adopted (T40d). Never throws and never signals a foreign process.
 * @returns {Promise<boolean>} true when the port was reclaimed
 */
async function reclaimPort(port, repository, { findHolder, killHolder, forceHolder, releaseMs, forceMs }) {
  const holder = findHolder(port, repository);
  if (holder?.service) {
    throw new Error(`El puerto ${port} lo ocupa el servicio sala.service (pid ${holder.pid}). Detén el servicio: \`systemctl --user stop sala\`.`);
  }
  if (!holder?.own) return false;
  killHolder(holder);
  if (await waitForPort(port, releaseMs)) {
    console.log(`Puerto ${port} liberado: se detuvo un server de desarrollo huérfano de este repo.`);
    return true;
  }
  forceHolder(holder);
  if (await waitForPort(port, forceMs)) {
    console.log(
      `Puerto ${port} liberado: el server huérfano no respondió al SIGTERM (colgado); se forzó SIGKILL (su ffmpeg sigue vivo para ser adoptado).`,
    );
    return true;
  }
  return false;
}

const BACKUP_PREFIX = 'before-start-';

/** `before-start-*` directories in `recovery`, newest first. Exact prefix only: other folders are never listed. */
function listStartBackups(recovery) {
  return readdirSync(recovery, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(BACKUP_PREFIX))
    .map((entry) => ({ path: join(recovery, entry.name), mtimeMs: statSync(join(recovery, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Consistent SQLite snapshot of the library database before the backend opens it (WAL included).
 * Videos and HLS are NOT covered. Fails closed; unique destination, never overwrites an existing backup.
 * Retention: after a new copy only the `keep` newest `before-start-*` folders survive (nothing else is deleted).
 * With `minAgeMs`, a newest copy younger than that is reused instead of copying again (restart loops).
 * @returns {Promise<string | undefined>} backup path, or undefined when there is no database yet
 */
export async function backupLibrary(dataDir, { keep = 5, minAgeMs = 0 } = {}) {
  const source = join(dataDir, 'library.db');
  if (!existsSync(source)) return undefined;
  let original;
  let copy;
  try {
    const { DatabaseSync, backup } = await import('node:sqlite');
    original = new DatabaseSync(source, { readOnly: true });
    const recovery = join(dataDir, 'recovery');
    mkdirSync(recovery, { recursive: true, mode: 0o700 });
    const [latest] = minAgeMs > 0 ? listStartBackups(recovery) : [];
    if (latest && existsSync(join(latest.path, 'library.db')) && Date.now() - latest.mtimeMs < minAgeMs) {
      console.log(`Copia reciente (menos de ${Math.round(minAgeMs / 60000)} min): se reutiliza ${latest.path}`);
      return join(latest.path, 'library.db');
    }
    const destination = join(mkdtempSync(join(recovery, BACKUP_PREFIX)), 'library.db');
    await backup(original, destination);
    copy = new DatabaseSync(destination, { readOnly: true });
    const rows = copy.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error('la verificación de integridad no devolvió ok');
    for (const old of listStartBackups(recovery).slice(keep)) rmSync(old.path, { recursive: true, force: true });
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
 * back up SQLite. A port held by this repository's own orphaned dev process (backend or vite) is
 * reclaimed first (linux only): only a verified holder is signalled, never a foreign process; a
 * hung holder that ignores SIGTERM is escalated to SIGKILL (its ffmpeg is left for adoption).
 * CONTENT_DIR is not validated here any more (T22): the server reports unset/missing
 * to the UI and never scans or creates an empty library. Never creates directories or a replacement
 * library, never migrates the database.
 * @returns {Promise<{env: NodeJS.ProcessEnv, backup: string | undefined}>}
 */
export async function prepare(
  repository = root,
  external = process.env,
  ports = [8080, 5174],
  {
    findHolder = findOwnServerHolder,
    killHolder = stopHolder,
    forceHolder: force = forceHolder,
    releaseMs = RELEASE_TIMEOUT_MS,
    forceMs = FORCE_TIMEOUT_MS,
  } = {},
) {
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
  for (const port of ports) {
    try {
      await checkPort(port);
    } catch (error) {
      if (
        error.code !== 'EADDRINUSE' ||
        !(await reclaimPort(port, repository, { findHolder, killHolder, forceHolder: force, releaseMs, forceMs }))
      ) {
        throw error;
      }
      await checkPort(port);
    }
  }
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
  process.on('SIGHUP', stop); // closing the terminal must not orphan the children
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
    process.off('SIGHUP', stop);
  }
}
