# T21 — Procesamiento paralelo con presupuesto de recursos

Diseño (2026-10-10, solo lectura; nada medido todavía, no se ejecutó ningún encode). Estado: **propuesta para aprobar**. Reutiliza la cola de T4/T40 y el guardián de disco de T47c/d.

## Cómo funciona hoy
- `createWorker` (`processing/worker.ts`): `concurrency = max(1, opts.concurrency ?? 1)`; `kick()` reclama con `claimNext` mientras `active < concurrency`. `index.ts:76-78` lee `PROCESS_CONCURRENCY` (default **1**) y `FFMPEG_THREADS` (default **8** desde T35; el 4 original ya no existe).
- `threads` solo llega a `-threads` en la rama `libx264` (`ffmpeg.ts:172`). Copy, AAC y la extracción de subtítulos no lo usan.
- Con copy perezoso (ADR 0006) el trabajo pesado de la cola es solo **x264** (3–6 min, CPU). Los jobs copy son sondeo + pistas (barato); el remux real (~4 s, 1,5 GB) ocurre en el primer play y es **I/O puro**.
- Prioridad: `setPriority(pid, 19)` en cada ffmpeg (`ffmpeg.ts:60-65`). `prioritize()` aborta `jobs[0]` (arbitrario) y lo **reencola desde 0**; `pause()` congela con SIGSTOP (T40e).
- Entorno del dueño: Ryzen 7 8840HS, 16 CPU lógicas = **8 núcleos × 2 hilos SMT**, 15 GB RAM (hoy solo ~4 GB disponibles), NVMe (`rotational=0`). T35 midió 4→8→12 hilos = 1,0×/1,24×/1,40×: rendimiento decreciente, coherente con SMT. Dos jobs de 4 hilos podrían rendir más que uno de 8; **no está medido**.

## Presupuesto derivado del hardware
Módulo nuevo y puro `processing/budget.ts`: `computeBudget(hw, config) → { jobs, threadsPerJob, reasons[] }`, con `hw` inyectable (tests con una Pi falsa y un PC grande). Sin números mágicos por máquina.

1. **CPU.** `cores = os.availableParallelism()` (respeta afinidad; no la cuota de cgroup: si la unit usa `CPUQuota`, leer `/sys/fs/cgroup/cpu.max`). `cpuBudget = max(1, floor(cores × CPU_SHARE))`, share default 0,5 (misma lógica de T35: dejar la mitad para reproducir).
2. **Jobs vs hilos.** `jobs = clamp(floor(cpuBudget / MIN_THREADS), 1, MAX_JOBS)` con `MIN_THREADS = 4`; `threadsPerJob = floor(cpuBudget / jobs)`. Ejemplos: Pi 4 (4 núcleos) → 1×2; laptop dueño (16) → 2×4; PC 32 hilos → 4×4 (tope `MAX_JOBS`). El valor 4 es hipótesis a validar con la medición.
3. **RAM.** `jobsRam = floor((MemAvailable − RESERVE) / RAM_PER_JOB)`. `MemAvailable` se lee **al reclamar** (`os.freemem()` en Linux; verificar que libuv lo mapea a `MemAvailable`, si no leer `/proc/meminfo`), no solo al arrancar: hoy hay 4 GB libres y 11 usados por otras apps. Defaults conservadores hasta medir: `RAM_PER_JOB = 1200 MB`, `RESERVE = 1536 MB`. `jobs = min(jobsCpu, jobsRam, jobsIo)`, siempre ≥ 1. Nunca se mata un job en curso por falta de RAM; solo se deja de reclamar.
4. **Disco.** Tipo por volumen: `stat(path).dev` → `major:minor` (fórmula glibc) → `/sys/dev/block/<maj>:<min>/queue/rotational`; las particiones no tienen `queue/`, se sube a `../queue/rotational`. Se evalúan **dos volúmenes**: origen (contenido) y destino (HLS). `rotational=1`, dispositivo desconocido (dm-crypt/LVM/btrfs sin resolver) o `PROCESS_IO=hdd` → **1 job pesado por volumen rotacional** (dos lectores/escritores en un HDD hacen seek). Si origen y HLS comparten HDD, `jobsIo = 1`. SSD/NVMe → sin límite de I/O. Caveat: una tarjeta SD o un pendrive reportan `rotational=0` y son lentos; en ARM con `mmcblk`/`sd*` removible, tratar como `hdd`.
5. **El HDD rara vez limita al x264.** Un encode lee ~5 MB/s (1,5 GB en 5 min) y escribe algo similar: dos o tres jobs caben en un HDD de ~100 MB/s. Lo que sí lo satura es el remux copy (~375 MB/s teóricos) y la migración de T47e. Por eso la restricción por volumen rotacional aplica a *jobs de la cola*, y los remux por play (prioritarios, cortos) quedan exentos.

## Mantener la reproducción fluida
- Ya existe: nice 19 (en CFS pesa ~1/68 frente a nice 0), `prioritize()` y `pause()`. Pendiente de verificar: que nice 19 también baje la prioridad de I/O depende del planificador (`mq-deadline`/`none` la ignoran; `bfq` la respeta). Medirlo con la latencia, no suponerlo.
- Con N > 1, `prioritize()` debe elegir la víctima de **menor progreso** y, mejor, congelarla (SIGSTOP, mejora ya anotada en T40e) en vez de reencolarla desde 0.
- **Reserva para play:** un job con prioridad > 0 (play) puede usar un slot extra (`jobs + 1`) si el presupuesto de RAM lo permite; si no, congela la víctima. Evita abortar trabajo de minutos por ver un episodio.
- Opcional, barato: si hubo `/api/stream` en los últimos 60 s, no reclamar jobs nuevos por encima de 1 (los activos siguen a nice 19).

## Plan de medición (no ejecutar sin aprobación del dueño)
Script `scripts/bench-parallel.mjs` (solo lectura sobre `content/`; escribe en un directorio temporal propio, nunca en `data/`, la BD ni el servicio en marcha):
1. **Muestra:** 3 cortes de 60 s (`-ss`/`-t` con `-c copy` a scratch) de fuentes representativas: H.264 10 bits (Bakemonogatari), HEVC 8/10 bits (Danmachi), H.264 8 bits 1080p. Mismas muestras para todas las corridas.
2. **Matriz:** `jobs ∈ {1,2,3,4}` × `threads ∈ {2,4,8}` con `jobs×threads ≤ cores`. Cada celda 3 repeticiones en orden aleatorio, 30 s de enfriamiento, abortar si `loadavg1 > 0,3 × cores` (el laptop está en uso). Registrar governor y temperatura.
3. **Argumentos reales:** importar `mainArgs`/`buildPlan` del código (mismo perfil CRF 23/tune/maxrate) y aplicar `setPriority(pid, 19)` como en producción.
4. **Throughput:** `sum(segundos de video) / pared` (× tiempo real) y velocidad por job de `-progress` (`speed=`). Referencia: 1×8 (default actual).
5. **Memoria:** pico por job = `VmHWM` de `/proc/<pid>/status` leído cada 500 ms hasta que muera; reportar máx. y p95 por job y total del sistema (`MemAvailable` mínimo).
6. **Latencia de reproducción:** el propio script levanta un servidor HTTP efímero (puerto libre) que sirve un `.m4s` de ~2 MB y lo pide 20 veces/s durante la corrida: p50/p95/p99 + `monitorEventLoopDelay`. Se compara contra la línea base sin carga.
7. **I/O:** `iostat -x 1` (o `/proc/diskstats`) por volumen; repetir 1×N sobre un HDD si el dueño lo conecta, más 2 remuxes copy simultáneos.
8. **Salida:** CSV + tabla. **Criterio de elegir default:** mayor throughput que 1×8 con ≥ 10 % de mejora, p95 de latencia +≤ 50 ms sobre línea base y RSS total < presupuesto de RAM; si ninguna configuración gana, queda 1×8 y el mecanismo solo aporta seguridad en máquinas chicas.

## Configuración (defaults propuestos)
| Variable | Default | Nota |
|---|---|---|
| `PROCESS_CONCURRENCY` | `auto` | número fijo manda sobre el cálculo (compatible con hoy) |
| `FFMPEG_THREADS` | `auto` | por job; número fijo manda |
| `PROCESS_CPU_SHARE` | `0.5` | fracción de CPU lógicas para procesar |
| `PROCESS_MAX_JOBS` | `4` | tope duro |
| `PROCESS_RAM_PER_JOB_MB` / `PROCESS_RAM_RESERVE_MB` | `1200` / `1536` | calibrar con la medición |
| `PROCESS_IO` | `auto` | `auto` \| `ssd` \| `hdd` (anula la detección) |
| `PROCESS_NICE` | `19` | |
`/api/activity` expone `{ jobs, threadsPerJob, limitedBy: 'cpu'|'ram'|'io'|'env' }` y Actividad lo muestra en una línea.

## Tareas propuestas (5 pts)
- T21a (2) `budget.ts` puro + detección (`/sys`, `os`) + tests con hardware falso (Pi, laptop, PC, HDD, RAM baja).
- T21b (2) worker: `concurrency` dinámico por claim, víctima por menor progreso con SIGSTOP, slot de play, `/api/activity`.
- T21c (1) `bench-parallel.mjs`, corrida aprobada por el dueño y fijar defaults (T21a/b pueden ir antes con los defaults actuales de 1×8 como `auto` provisional).

## Decisiones abiertas para el dueño
1. **Fracción de CPU para procesar.** Recomendado 0,5. Más (0,75) acelera la cola pero la TV/celular compiten; menos protege la reproducción a costa de tiempo.
2. **¿Cambiar 1×8 por varios jobs (p. ej. 2×4)?** Recomendado: decidir solo con la medición (criterio del punto 8). Tradeoff: más RAM y más archivos a medias si hay un corte; T40 ya reanuda, pero cada job adoptado cuenta.
3. **Almacenamiento desconocido o lento (SD, USB, cifrado).** Recomendado: tratarlo como HDD (1 job por volumen). Tradeoff: una Pi con un SSD USB bueno quedaría subutilizada hasta forzar `PROCESS_IO=ssd`.
4. **Play mientras la cola está llena.** Recomendado: slot extra si hay RAM, si no congelar la víctima de menor progreso. Tradeoff: slot extra sube el pico de CPU/RAM justo cuando alguien ve algo; congelar es más seguro pero detiene un job.
5. **Valores de RAM por job y reserva.** Recomendado 1200/1536 MB hasta medir. Tradeoff: muy alto desperdicia núcleos; muy bajo arriesga OOM con el navegador del dueño abierto.
6. **Re-evaluar el límite en cada claim (dinámico) o solo al arrancar.** Recomendado dinámico, sin matar jobs en curso. Tradeoff: el throughput varía según lo que abra el dueño; es lo deseado pero hace menos reproducibles las mediciones.
7. **¿Es la Raspberry Pi un objetivo real?** Recomendado: sí como requisito de no romperse (1×2 y limitar por RAM), no de rendimiento; en una Pi 4 el x264 1080p probablemente no llega a tiempo real (sin medir). Tradeoff: si es objetivo, T21 debería incluir un modo "solo copy, sin re-encode" y avisar qué archivos no se pueden preparar.
8. **Ejecutar la medición.** Pide el laptop casi inactivo ~1 h y escribir ~1 GB de muestras en un directorio temporal. Recomendado: autorizarla en una ventana acordada; alternativa, aceptar los defaults provisionales sin medir (riesgo: defaults sin evidencia).
