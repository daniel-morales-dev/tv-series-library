// Lógica de la CLI `sala`. Todo lo externo (systemctl, HTTP, xdg-open, journalctl) entra por `deps`.
const UNIT = 'sala';

export const HELP = `sala - controla tu biblioteca de series sin usar systemctl.

Uso: sala <comando>

  sala start      Inicia el servicio (la app queda disponible en la red).
  sala stop       Detiene el servicio (celular y TV dejan de verla).
  sala restart    Reinicia el servicio.
  sala status     Muestra si está en marcha y qué está procesando.
  sala pause      Pausa el procesado de videos (no se pierde nada).
  sala resume     Reanuda el procesado.
  sala open       Abre la biblioteca en el navegador de este equipo.
  sala url        Muestra la dirección para celular y TV (misma red WiFi).
  sala logs       Muestra el registro del servicio en vivo (Ctrl+C para salir).
  sala --help     Muestra esta ayuda.
`;

export function apiBase(env) {
  const port = Number(env.PORT);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : 8080}`;
}

const fail = (deps, message) => {
  deps.err(message);
  return 1;
};

/** Sala server answer, or null when nothing answers on the port. */
async function api(deps, method, path) {
  try {
    return await deps.http(method, path);
  } catch {
    return null;
  }
}

const isActive = async (deps) => (await deps.systemctl(['is-active', UNIT])).status === 0;
const notRunning = (deps) => fail(deps, 'Sala no responde. ¿Está iniciada? Prueba: sala start (o mira: sala logs).');

async function start(deps) {
  if (await isActive(deps)) {
    deps.out('Sala ya está en marcha.');
    return 0;
  }
  if (await api(deps, 'GET', '/api/network')) {
    return fail(deps, `Algo más está usando el puerto (¿'npm run dev'?). Deténlo con Ctrl+C y vuelve a ejecutar: sala start.`);
  }
  if ((await deps.systemctl(['start', UNIT])).status !== 0) {
    return fail(deps, 'No se pudo iniciar Sala. Mira el motivo con: sala logs');
  }
  deps.out('Sala iniciada. Mira la dirección con: sala url');
  return 0;
}

async function simple(deps, verb, doneMessage) {
  if ((await deps.systemctl([verb, UNIT])).status !== 0) {
    return fail(deps, `No se pudo ejecutar '${verb}'. Mira el motivo con: sala logs`);
  }
  deps.out(doneMessage);
  return 0;
}

async function status(deps) {
  const active = await isActive(deps);
  const res = await api(deps, 'GET', '/api/activity');
  if (!active) {
    if (res) deps.out(`El servicio está detenido, pero algo responde en el puerto (¿'npm run dev'?).`);
    else deps.out('Sala está detenida. Inícialo con: sala start');
    return 0;
  }
  if (!res?.ok) {
    deps.out('El servicio está activo pero la app no responde (puede estar arrancando). Mira: sala logs');
    return 0;
  }
  deps.out('Sala está en marcha.');
  const { running = [], queuedTotal = 0, failed = [], paused = false } = res.body;
  if (paused) deps.out('Procesado en pausa. Reanúdalo con: sala resume');
  const parts = [];
  if (running.length) parts.push(`${running.length} procesando`);
  if (queuedTotal) parts.push(`${queuedTotal} en cola`);
  if (failed.length) parts.push(`${failed.length} con error`);
  deps.out(parts.length ? `Procesado: ${parts.join(', ')}.` : 'Sin trabajo pendiente.');
  return 0;
}

async function setPaused(deps, verb, message) {
  const res = await api(deps, 'POST', `/api/processing/${verb}`);
  if (!res) return notRunning(deps);
  if (res.status === 409) return fail(deps, 'El procesado está desactivado en este servidor.');
  if (!res.ok) return fail(deps, `Sala respondió con un error (${res.status}). Mira: sala logs`);
  deps.out(message);
  return 0;
}

async function networkInfo(deps) {
  const res = await api(deps, 'GET', '/api/network');
  return res?.ok ? res.body : null;
}

async function url(deps) {
  const info = await networkInfo(deps);
  if (!info) return notRunning(deps);
  if (!info.urls?.length) deps.out('No encontré una dirección de red. ¿Estás conectado al WiFi o al cable?');
  else {
    deps.out('Desde el celular o la TV (misma red WiFi), abre:');
    for (const u of info.urls) deps.out(`  ${u}`);
  }
  return 0;
}

async function open(deps) {
  if (!(await networkInfo(deps))) return notRunning(deps);
  const target = apiBase(deps.env);
  if (!(await deps.openUrl(target))) deps.out(`No encontré xdg-open. Abre esta dirección en tu navegador: ${target}`);
  return 0;
}

export async function run(argv, deps) {
  switch (argv[0]) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      deps.out(HELP.trimEnd());
      return 0;
    case 'start':
      return start(deps);
    case 'stop':
      return simple(deps, 'stop', 'Sala detenida. Para volver a iniciarla: sala start');
    case 'restart':
      return simple(deps, 'restart', 'Sala reiniciada.');
    case 'status':
      return status(deps);
    case 'pause':
      return setPaused(deps, 'pause', 'Procesado en pausa. Reanúdalo con: sala resume');
    case 'resume':
      return setPaused(deps, 'resume', 'Procesado reanudado.');
    case 'url':
      return url(deps);
    case 'open':
      return open(deps);
    case 'logs':
      return deps.journal(['--user', '-u', UNIT, '-n', '50', '-f']);
    default:
      deps.err(`Comando desconocido: '${argv[0]}'. Mira los comandos con: sala --help`);
      return 2;
  }
}
