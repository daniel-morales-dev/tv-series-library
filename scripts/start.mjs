import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, supervise } from './dev.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Same command as `sala.service` ExecStart (verified by a test), run from apps/server. */
export const SERVER_COMMAND = ['node', '--env-file-if-exists=../../.env', 'src/index.ts'];

/** Web inputs that change the build output. */
const WEB_SOURCES = ['src', 'public', 'index.html', 'vite.config.ts', 'package.json', 'tsconfig.json'];

/** Newest mtime (ms) of a file or of every file under a directory; 0 when absent. */
export function newestMtime(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(path).reduce((newest, name) => Math.max(newest, newestMtime(join(path, name))), 0);
}

/** Pure decision: rebuild when there is no build or any web source is newer than it. */
export function needsWebBuild(distMtimeMs, sourceMtimeMs) {
  return distMtimeMs === 0 || sourceMtimeMs > distMtimeMs;
}

export function webBuildNeeded(repository = root) {
  const web = join(repository, 'apps/web');
  const dist = join(web, 'dist');
  const distMtime = existsSync(join(dist, 'index.html')) ? newestMtime(join(dist, 'index.html')) : 0;
  const sources = Math.max(...WEB_SOURCES.map((name) => newestMtime(join(web, name))));
  return needsWebBuild(distMtime, sources);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, stop);
  try {
    // Only 8080: production has no Vite. Same data/port/backup guards as `npm run dev`.
    const prepared = await prepare(root, process.env, [8080]);
    if (prepared.backup) console.log(`Copia SQLite verificada (solo base de datos, no videos ni HLS): ${prepared.backup}`);
    if (webBuildNeeded(root)) {
      console.log('Construyendo la web (apps/web/dist falta o está desactualizado)...');
      const build = spawnSync('npm', ['run', 'build', '-w', 'apps/web'], { cwd: root, stdio: 'inherit' });
      if (build.status !== 0) throw new Error('No se pudo construir la web; el servidor no se inició.');
    }
    if (!controller.signal.aborted) {
      const env = { ...prepared.env, WEB_DIR: join(root, 'apps/web/dist') };
      console.log(`Datos: ${env.DATA_DIR} | Contenido: ${env.CONTENT_DIR}`);
      console.log('Producción: app en http://localhost:8080 (sin watch ni Vite). Ctrl+C detiene el servidor.');
      process.exitCode = await supervise([SERVER_COMMAND], env, { cwd: join(root, 'apps/server'), signal: controller.signal });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, stop);
  }
}
