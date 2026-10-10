# T38: server colgado con el event loop atascado (análisis por lectura de código)

Alcance: lectura de código; no se reprodujo el cuelgue ni se tocó ningún proceso real. Repo analizado: `main` + T40d–f.

## Síntoma (T38 en `odd/tasks/tv-series-library.md`)
Puerto 8080 en LISTEN sin responder; hilo principal en `futex_do_wait`, workers idle; el ffmpeg hijo bloqueado escribiendo a un **socket** lleno (`sock_alloc_send_pskb`); SIGTERM/SIGUSR2 consumidos a nivel C sin que corriera el handler JS (`SigPnd=0`).

## Qué dice el código hoy

1. **Pipes de ffmpeg (hipótesis "hijo bloqueado por pipe lleno").**
   - Encode principal (`detached`): `stdio: ['ignore', logFd, logFd]` (`ffmpeg.ts:53`). stdout y stderr van a un **archivo**, no a un pipe: no puede bloquearse por un lector lento. El progreso va por `-progress <archivo>` (`ffmpeg.ts:182`) y se lee solo en sus últimos 8 KB (`proc.ts:80-99`).
   - Extracción de subtítulos/fuentes (no detached): `stdio: ['ignore', 'ignore', 'pipe']`; stdout a `/dev/null`, stderr drenado con `on('data')` y recortado a 4000 (`ffmpeg.ts:55-58`). Siempre drenado.
   - `ffprobe`: `execFile` con `maxBuffer` y `timeout` 60 s (`ffmpeg.ts:116-119`, `ingest/probe.ts:36`, `catalog/chapters.ts:32`): Node drena y acota.
   - Conclusión: **con el código actual ningún pipe de ffmpeg puede llenarse sin ser leído.** Un `sock_alloc_send_pskb` (socket) indica que ese ffmpeg tenía stdout como socketpair de Node (`stdio: 'pipe'`): una versión anterior al encode detached (T40a–c) o un hijo sin lector. Un socket solo se llena si el padre **dejó de leer**, así que el hijo bloqueado es muy probablemente **consecuencia** del event loop parado, no la causa.

2. **Bloqueos síncronos en el event loop.** Ninguno explica un `futex`:
   - `node:sqlite` es síncrono (`db/sql.ts`, `progress/repository.ts`, transacciones `BEGIN…COMMIT`), pero cada una es corta; SQLite espera con `nanosleep`/locks de archivo, no con `futex`, y `busy_timeout` 0 lanza `SQLITE_BUSY` en vez de colgar.
   - `statSync` en `diskPresent()` (`config/config.ts:151,181,209`), llamado en cada `kick()` (cada 5 s, `worker.ts:226`), en el ingestor (`ingestor.ts:90`) y en cada request de `/api/stream` (`routes.ts:111,155,170`). Sobre un montaje USB colgado queda en estado D (no `futex`) pero congelaría todo el loop: **riesgo real, no demostrado como causa**.
   - `readFileSync` de `/proc/<pid>/stat|cmdline` (`proc.ts:9,19`): archivos diminutos; `findWriters` recorre `/proc` solo en `start()` (`proc.ts:35`).
   - `readFileSync(ffmpeg.log)` completo para sacar la cola del error (`ffmpeg.ts`, función `tail`, antes del cambio): el log crece sin límite; con un origen corrupto ffmpeg puede registrar un error por paquete (cientos de MB). Cargarlo entero bloquea el loop y, pasado ~512 MB, lanza `ERR_STRING_TOO_LONG` (el error quedaba sin cola). **Demostrado y corregido** (abajo); no es el `futex` del incidente.
   - No hay `execSync`, `spawnSync` ni `Atomics.wait` en `apps/server/src`.

3. **Orden del shutdown** (`index.ts:123-132`, `shutdown.ts:47-66`): `worker.stop({killChildren:false})` (síncrono, aborta con `KeepChildren`), `ingestor.stop()` y `app.close()` en paralelo, en carrera contra un timeout de 3 s (`exit(1)` si vence, `exit(0)` si no). La DB nunca se cierra explícitamente (el WAL se recupera solo; inocuo). `app.close()` de Fastify espera conexiones activas (un stream HLS abierto), por eso el timeout es la red de seguridad. **Limitación estructural:** el timeout es un `setTimeout` de JS; con el event loop atascado (el caso del incidente) no corren ni el handler de SIGTERM ni el timeout. Ninguna lógica de shutdown en JS arregla ese caso.

## Hipótesis ordenadas
1. **(Más probable, no verificable aquí)** Cuelgue del hilo principal en un lock nativo (`futex`) por un bug de Node/V8/libuv/`node:sqlite` fuera de nuestro código; el ffmpeg bloqueado y el shutdown que nunca corre son consecuencias. A favor: workers idle, `SigPnd=0`, sin E/S pendiente.
2. E/S síncrona (`statSync`) sobre el disco de la biblioteca colgado (T47d): congela el loop, pero el estado esperado sería D, no `futex`. Plausible para *otros* cuelgues.
3. ffmpeg bloqueado por pipe lleno como causa: **descartada** para el código actual; solo explicaría una versión antigua y siempre como consecuencia.

## No se pudo verificar
- Qué versión del server corría (el historial de commits no estuvo disponible en esta sesión; no se pudo comprobar cuándo cambió `stdio`).
- La causa del `futex`: requiere el proceso vivo. En la próxima ocurrencia, **antes** de matar: `cat /proc/<pid>/wchan`, `cat /proc/<pid>/task/*/stack` (root) o `gdb -p <pid> -batch -ex "thread apply all bt"`; y arrancar el server con `--report-on-signal --report-signal=SIGUSR2` (no probado que escriba con el loop parado).
- Reproducción matando `dev.mjs` con job activo y stream abierto (no se hizo: no se tocan procesos reales).

## Cambios hechos (solo con causa demostrada por lectura + test determinista)
- `ffmpeg.ts`: `tail()` lee solo los últimos 4000 bytes con lectura posicional en vez de `readFileSync` del log completo.
- `ffmpeg.ts`: opción `killAfterMs` en `createRunFfmpeg` (por defecto 5000, sin cambio de comportamiento) para probar que un hijo que ignora SIGTERM recibe SIGKILL y la corrida rechaza.
- `test/ffmpeg-pipes.test.ts`: hijos falsos que inundan stdout/stderr sin ser leídos (no se bloquean; la cola de stderr queda acotada; estos dos ya pasaban: son guardas de regresión), log disperso de 600 MB (RED antes del fix: cola vacía) y SIGTERM ignorado (RED antes: sin `killAfterMs`).

## Recomendaciones sin implementar (requieren decisión)
- Watchdog fuera del event loop (worker thread que haga SIGKILL al proceso si el latido del hilo principal se detiene): único mecanismo que cubriría el caso del incidente; es una función nueva, no un fix demostrado.
- Pasar `diskPresent()` a una comprobación asíncrona con caché si se confirma un cuelgue por montaje.
