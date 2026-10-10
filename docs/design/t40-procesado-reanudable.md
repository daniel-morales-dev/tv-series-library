# T40 — Procesado que sobrevive a reinicios (diseño)

Solo diseño. Evidencia con un clip sintético de 62 s (H.264 + 2 AAC, ffmpeg 6.1.1 del host) en el scratchpad; no se tocó `data/` ni `content/`.

## 1. Cómo se procesa hoy (ruta:línea en `apps/server/src/`)
1. `modules/processing/queue.ts:90` `claimNext`: job `queued`→`running`, **`progress=0`** (`:99`); `media_files.status='processing'`.
2. `process.ts:122-124` borra `hls/<id>.tmp` y crea `v/ a<n>/ subs/ fonts/`.
3. `process.ts:127` ffmpeg de extracción (subs `.vtt/.ass`, fuentes): segundos. `:129` `onTracks` guarda pistas en `media_files`.
4. `process.ts:134` **un solo ffmpeg** video+todos los audios (`ffmpeg.ts:89-120`: fMP4, `-hls_time 6`, `playlist_type event`, `independent_segments`, keyframe cada 2 s). Progreso por `-progress pipe:1` (`ffmpeg.ts:33-41`); `worker.ts:77` lo guarda ≤1/s en `jobs.progress`.
5. `process.ts:145-148` `buildMaster` → `validatePackage` (T27) → `rm final` + `rename .tmp→final`. `queue.ts:120` `complete` marca `ready`.
- En disco: `hls/<id>.tmp/` (segmentos `seg_NNNNN.m4s`, `init_<k>.mp4`, `index.m3u8` de cada rendición, `subs/`, `fonts/`). Se sirve ya con `routes.ts:131-138`.
- En SQLite solo: `jobs.status/progress/priority` (`001_init.sql:96`, `003`) y `media_files.status/audio_tracks/subtitle_tracks`. **No hay checkpoint** (último segmento, tiempo, hash del plan).
- Qué aborta y reinicia de 0: shutdown (`shutdown.ts:55` → `worker.stop` → `AbortSignal` mata ffmpeg; `recover` `queue.ts:62-64` pone `progress=0`), pausa (`worker.ts:144-151` + `requeue` `queue.ts:54`), y **`/play` de otro archivo** (`routes.ts:126` → `prioritize` `worker.ts:133-140` expulsa el job en curso). Todos hacen `rm .tmp` al reintentar (`process.ts:122`).
- Solo se re-codifica video si no es H.264 8 bit (`plan.ts`); si es `copy`, el job tarda minutos y no vale la pena reanudarlo.

## 2. Opciones y evidencia
Cadena de prueba: `-ss T` antes de `-i` + `-output_ts_offset` + `-start_number N` sobre los mismos args de `mainArgs`; corte tras 5 segmentos (T=30.03 s), comparado con el encode completo.

**Hechos medidos**
- Línea de tiempo cruda (init+seg, sin demuxer HLS): **video empalma con hueco 0.0000 s** (el `.m4s` previo termina en 30.1130, el nuevo empieza en 30.1130). **Audio +13 ms** (30.0778 → 30.0910; <1 trama AAC de 21 ms). Offset A/V idéntico al encode completo (0.021 s). Duración total 62.020 vs 62.020.
- El offset correcto es `T + 0.083 s`: el encode original desplaza toda la línea 83 ms (retardo B-frames, `start=0.083`). Con `T` a secas el empalme retrocede 83 ms. Hay que leer ese desplazamiento del primer segmento.
- `-hls_flags append_list` **no es seguro**: reescribe el único `#EXT-X-MAP` por el init nuevo (con *edit list* vacía de 30.1 s) para **todos** los segmentos, y añade `DISCONTINUITY`. Hay que componer la playlist nosotros (como ya hace `buildMaster`): entradas viejas + `#EXT-X-DISCONTINUITY` + `#EXT-X-MAP` nuevo + entradas nuevas.
- **Chrome real + hls.js 1.7.3** (headless, `seek=26`, atraviesa el empalme): reproduce completo, sin errores fatales, 0 frames descartados, pero **hueco de ~0.18 s en el buffer** (`[…,30.02] [30.2,…]`) → `bufferStalledError`+`bufferSeekOverHole` (no fatales; el vídeo salta ~0.3 s una vez). Idéntico con offsets 30.113 y 30.03 y con `use_editlist=0`: lo causa cómo hls.js rebasa tras la discontinuidad, no el offset. **Control** (encode completo): buffer continuo, sin errores.
- Sin la etiqueta `DISCONTINUITY` (o con un solo MAP) hls.js **descarta ~24 s de segmentos** (`bufferAppendNoProgress`, buffer `[24.1,30.0][54.1,…]`): peor, silencioso.
- ffmpeg standalone (demuxer HLS) imprime `timestamp discontinuity -30030000` en el empalme; es artefacto del demuxer, no se usa para decidir.
- ffmpeg **desacoplado** (`setsid`, stdin `/dev/null`, `-progress archivo`, stderr a archivo): al terminar el padre **sigue vivo** (ppid 1) y termina el paquete (`ENDLIST`). `SIGSTOP` congela `out_time_us` (3795458 → 3795458 en 2 s) y `SIGCONT` reanuda hasta `progress=end`.

| Opción | Continuidad / A-V | Playlist EVENT | Multi-audio | Costo | Cubre |
|---|---|---|---|---|---|
| **D** ffmpeg desacoplado + adopción | perfecta (un solo run) | intacta | intacta | medio | reinicio/actualización del server, crash del server, pausa (STOP/CONT), `/play` |
| **B** `-ss`+offset, playlist compuesta | video exacto, audio +13 ms, **hueco ~0.18 s** en Chrome | `DISCONTINUITY`+2º MAP | requiere empalmar cada rendición al mismo T | alto | además: reinicio del PC, corte de luz, OOM de ffmpeg |
| **A** tramos de N min con checkpoint | un empalme por tramo (mismo hueco c/u) | idem, N cortes | idem | más alto que B | igual que B, granularidad fija |
| **C** reiniciar solo video y conservar subs/fuentes/audio | — | — | — | bajo | **nada útil**: subs/fuentes tardan segundos y el audio va en el mismo run del video; ahorro ≈ 0 |

## 3. Recomendación
**Fase 1 = D (adopción), fase 2 = B solo si el dueño lo pide.** D elimina la frustración declarada (reinicio por desarrollo/actualización, pausa, `/play`) sin riesgo A/V, porque no hay empalme. B cubre lo que D no (apagón/reinicio del PC) pero deja un glitch verificado de ~0.2–0.3 s por empalme y exige validar contigüidad; no merece el riesgo si el PC permanece encendido.
Reglas comunes: un único escritor sobre `.tmp` (T34): se adopta el ffmpeg vivo o se mata y se reinicia, nunca dos; ante cualquier duda (pid ajeno, `.tmp` sin `progress` válido, plan distinto) → reiniciar solo ese archivo.

## 4. Plan en tareas pequeñas (RED esperado en `vitest`)
- **T40a** Migración 006: `jobs.pid`, `jobs.pid_start` (clave `/proc/<pid>/stat` starttime), `jobs.plan_hash`. RED: `recover` hoy pone `progress=0` y `status=queued` aunque haya pid. Check: migración aplica sobre BD copia.
- **T40b** `runFfmpeg` desacoplado: `spawn(detached)`, `stdio: ['ignore', fd, fd]`, `-progress <tmp>/progress.txt`; el worker lee el archivo (poll 1 s) en vez de `stdout`. RED: test con `runFfmpeg` inyectado que simula salida por archivo; `ffmpeg.ts:33` ya no recibe datos. Check: ffmpeg real sobrevive a `kill` del padre.
- **T40c** Adopción: al `start()`, por cada job `running` con `pid` vivo y `/proc/<pid>/cmdline` que contenga `hls/<id>.tmp` y `starttime` igual → adoptar (sin `recover` a 0, sin `rm .tmp`); si no → comportamiento actual. RED: `recover` reencola un job con pid vivo. Check: matar el server a mitad de un job real de prueba y comprobar mismo ffmpeg, progreso continúa.
- **T40d** `createShutdown`/`worker.stop` ya no matan el ffmpeg (excepto `PROCESSING=off` o plan inválido); `launcher` T37 (`ffmpegChildren` SIGKILL) solo escala si el server cuelga. RED: `shutdown.test.ts` espera `kill`; cambia a "no mata". Check: `systemd` `KillMode=process` en `packaging/linux/sala.service` (hoy el cgroup entero muere al parar la unidad).
- **T40e** Pausa = `SIGSTOP`/`SIGCONT` (conserva `.tmp` y progreso) en vez de abortar (`worker.ts:144-151`); `/play` preempta igual con STOP + reanudar luego (el job pausado conserva su `progress`). RED: `pause()` hoy reencola con `progress=0`. Check: `ps` estado `T`, `out_time_us` quieto, reanuda.
- **T40f** Validación al terminar adopción: `validatePackage` + comparar duración (`out_time` final vs `durationS`). RED: paquete corrupto adoptado → reinicia solo ese archivo.
- **T40g** (fase 2, solo con visto bueno) `resumeArgs` con `-ss T -output_ts_offset T+delay -start_number N`, compositor de playlist con `DISCONTINUITY`+MAP nuevo, checkpoint (`jobs.checkpoint_s`, último seg completo verificado con ffprobe), test de contigüidad (gap video ≤ 1 trama, audio ≤ 1 trama AAC). Solo `transcode`; `copy` reinicia.
- Medición final: tiempo ahorrado = fracción de progreso al reiniciar × duración total (hoy 0).

## 5. Recargar el navegador no afecta el job (evidencia)
- El worker se crea en el proceso del server (`index.ts:35-46`, `start()` `:67`), sin referencia a sockets de clientes.
- Ninguna ruta de `processing/` observa `req.raw`/`close`/`aborted` (búsqueda `rg "req.raw|close'|aborted"` sin coincidencias en rutas); los únicos aborts son explícitos: `pause` (`routes.ts:99`), `play`→`prioritize` (`:126`), shutdown.
- El front solo hace `fetch` (`api.ts:49-52`); `/stream` es lectura de archivos (`routes.ts:131-138`).
- Matiz: abrir el reproductor de un archivo no listo **sí** llama a `/play` y expulsa el job en curso (hoy reinicia de 0); si se llama de nuevo para el archivo que ya corre, `prioritize` retorna sin abortar (`worker.ts:135`); no verifiqué si la web llama `/play` al montar.

## 6. Ambigüedades para el dueño
1. ¿Basta con sobrevivir a reinicios del **server** (D), o también al **reinicio/apagón del PC** (B)? Recomiendo D ahora; B solo si el PC se apaga seguido durante lotes.
2. ¿Aceptas un micro-corte de ~0.2–0.3 s en el punto de empalme si hubiera que usar B? Recomiendo no, hasta probar con un archivo real (1080p, B-frames) y Chrome/TV.
3. Pausa: ¿congelar (STOP, retiene RAM ~0.7 GB y `.tmp`) o abortar liberando memoria (como hoy)? Recomiendo congelar por defecto y abortar si la pausa dura >N h.
