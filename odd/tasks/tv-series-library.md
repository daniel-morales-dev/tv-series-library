# tv-series-library — media server local

**Objetivo:** plataforma propia tipo Netflix/Crunchyroll/HBO en LAN, sin login, con perfiles, Mi lista, Continuar viendo, tracking por episodio, búsqueda con autocompletado, cambio de audio/subtítulos.
**Plan completo:** decisiones en `docs/adr/`, glosario en `CONTEXT.md`.
**Estrategia de entrega:** `ask-on-risk` (rama por fase).
**Prioridad:** Linux + LAN primero (encender PC → ver desde celular y TV). Windows diferido.
**Retomar:** leer `CLAUDE.md` primero.

## Restricciones
- Código en inglés, documentación en español, comentarios solo cuando aportan.
- Sin módulos nativos de Node (instalador Windows): `node:sqlite`.
- `content/`, `data/`, `.env` y `*.torrent` fuera de git.
- No exigir renombrar archivos (rompe el seeding).
- Offline-first: TMDB solo al importar; todo (metadata, imágenes, fuentes, JS) servido localmente.

## Tareas
- [x] T1 Fundación: rama, `.gitignore`, `.env.example`, glosario, ADRs 0001–0004, README — ruta: inline
- [x] T2 Backend core: esquema + migraciones, API perfiles, catálogo con filtros, Mi lista, progreso, continuar viendo — ruta: delegada (sonnet)
- [x] T3 Ingesta (diseño: `docs/design/t3-ingesta.md`): escaneo + watcher, descarga completa (mtime > 60 s + ffprobe), parser de nombres, TMDB con ordenamientos alternativos (episode groups), caché de imágenes, Pendientes — ruta: delegada (sonnet)
  - [x] T3a Parser de nombres + tests
  - [x] T3b Migración 002 + cliente TMDB + asignación (episode groups) + imágenes
  - [x] T3c Escaneo, completitud, watcher y modo sin internet
  - [x] T3d API Pendientes, escaneo manual e imágenes + verificación real
- [x] T4 Procesamiento (diseño: `docs/design/t4-procesamiento.md`): plan ffprobe → HLS fMP4 multi-audio + WebVTT (+ `.ass` y fuentes guardados), cola de jobs con progreso, API de stream — ruta: delegada (sonnet)
  - [x] T4a Plan de procesamiento + tests
  - [x] T4b Ejecución ffmpeg (HLS, subs, fuentes) + cola de jobs
  - [x] T4c API jobs/stream + verificación real (ep 01 + un OP)
- [x] T4d Ver mientras procesa + bajo consumo (pedido del dueño 2026-10-09):
  - Al dar play a un archivo no listo: pasa al frente de la cola y se reproduce en cuanto haya los primeros segmentos (playlist HLS tipo `EVENT` que crece; adelantar solo hasta lo ya procesado).
  - Límite de recursos: `nice 19` + `ionice` idle, hilos de x264 limitados (configurable), un job a la vez. Medir RAM/CPU y confirmar que sigue más rápido que tiempo real (si no, el video se detiene).
  - Recordatorio: la cola ya procesa todo al importar, así que lo descargado con anticipación no tiene espera.
  - Ruta: delegada (sonnet). Diseño:
    - [x] T4d1 HLS `event` (crece, `ENDLIST` al final); subtítulos/fuentes extraídos **antes** del video (disponibles al empezar); nombres de pistas en `master.m3u8` apenas ffmpeg lo escribe; `/api/stream` sirve `hls/<id>.tmp` mientras no exista el definitivo.
    - [x] T4d2 Migración 003 `jobs.priority`; `POST /api/media-files/:id/play`: si está listo responde `ready`; si no, encola con prioridad y **interrumpe** el job en curso (vuelve a la cola, reinicia de 0) para procesar este ya.
    - [x] T4d3 Bajo consumo: `os.setPriority(pid, 19)` al ffmpeg (sin `ionice`: con nice 19 el I/O baja a la menor prioridad best-effort), `-threads` de x264 por `FFMPEG_THREADS` (default 4), un job a la vez.
    - [x] T4d4 Verificación real: medir CPU/RAM y velocidad vs tiempo real con 4 hilos; reproducir mientras procesa.
- [ ] T5 Frontend (diseño: `docs/design/t5-frontend.md`): perfiles, header, hero, filas vertical/horizontal, detalle con temporadas, Mi lista en grilla, búsqueda, filtros, tema claro/oscuro, responsive, navegación espacial — ruta: delegada (sonnet). Pedido del dueño 2026-10-09: ver la UI/UX antes de las pruebas en dispositivos (T6d va al final).
  - [x] T5a Base: tokens, tema, layout, header con búsqueda, perfiles, rutas
  - [x] T5b Inicio: hero, filas, tarjetas, Continuar viendo con quitar (1d49875; 31 tests web; acento violeta `#8f7bff`, nombre provisional "sala"; revisión RDD omitida por el dueño, próxima base `1d49875`)
  - [x] T5c Página de título + panel de info del episodio (nombre, T·E, sinopsis, fecha de emisión, duración, progreso; pedido del dueño)
    - Pedidos del dueño tras ver T5b: menú ⋮ de Continuar viendo se recorta dentro de la fila (obliga a scroll horizontal y tapa el nombre del episodio) → sacarlo de la fila; más detalle en los episodios; mostrar **idioma** de audio y subtítulos por título y por episodio (p. ej. Monogatari descargado en inglés).
  - [x] T5d Mi lista, Series/Películas/Anime con filtros, Búsqueda (4fa861b; 73 tests web; revisión omitida, próxima base `4fa861b`)
  - [x] T5e Navegación espacial TV y responsive fino (97f01ca)
  - [x] T5f Pulido pedido por el dueño (2026-10-09):
    - Chips de estado (en cola / procesando / listo): texto no centrado en el óvalo.
    - Móvil: carátulas estiradas e iconos apretados en las tarjetas.
    - Favicon.
    - Clic en la miniatura de Continuar viendo (fuera del ▶) no hace nada.
    - Panel de episodio: scroll vertical aunque el contenido cabe; solo debe haber scroll si la sinopsis es larga.
  - [x] T5g Player (97f01ca; 87 tests web; revisión omitida, próxima base `97f01ca`):
    - Clic sobre el video pausa/reanuda.
    - Iconos en vez de texto para audio/subtítulos y pantalla completa.
    - Velocidad de reproducción (0.5×–2×).
- [ ] T9 Biblioteca en varias ubicaciones (pedido del dueño): contenido en el PC **y** en un HDD externo que se conecta y desconecta. Varias carpetas de contenido; si el disco no está, sus títulos aparecen como "no disponible" sin borrar progreso ni metadata, y vuelven al reconectar. Decidir dónde viven los HLS procesados (en el mismo disco o en `data/`).
- [x] T12 "Marcar como no visto" borra el progreso de cada episodio del título para ese perfil (decisión del dueño 2026-10-09) — ruta: delegada (haiku); 9c30ede, RED observado, 165 tests
- [ ] T11 **Próximamente** (pedido del dueño 2026-10-09): listar series cuya carpeta existe pero sus videos aún se descargan (ffprobe falla / mtime reciente), con insignia "Próximamente" en vez de esconderlas. Caso real: `content/shows/[Cifer] Sousou no Frieren S1 [BD 1080p Opus]` descargando. El dueño renombrará la carpeta a "frieren" → el reescaneo debe reasociar sin duplicar el título ni perder progreso. Ruta: delegada (sonnet). Diseño:
  - Archivo en descarga = fila en `media_files` con estado nuevo `downloading` (sin datos de ffprobe; episodio asignado desde el nombre). Migración 004 reconstruye `media_files` para ampliar el `CHECK`. Al ingerir, un archivo reciente o ilegible para ffprobe que se pueda asignar (carpeta → TMDB, número de episodio) se registra como `downloading` en vez de solo esperar. Sin asignación (no parseable / sin match) sigue como hoy: esperar.
  - Cada escaneo revisa las filas `downloading`: si ya pasan mtime + ffprobe → se completan (duración, pistas), pasan a `pending` y se encolan. Nunca se encola un `downloading`; `POST /play` sobre uno responde 409.
  - **Mover/renombrar:** un archivo nuevo cuyo nombre base y tamaño coinciden con una fila cuya ruta ya no existe en disco **es esa fila**: se actualiza `path` (conserva id, HLS, progreso). La carpeta nueva hereda `source_dirs` (título y temporada) de la vieja, sin consultar TMDB. Vale para cualquier estado, no solo `downloading` (los clientes torrent preasignan el tamaño final, así que coincide).
  - Catálogo: `comingSoon: true` cuando el título no tiene archivos fuera de `downloading`. Web: insignia "Próximamente" en tarjetas y página de título; sin Reproducir; episodios en descarga con chip "descargando".
  - Fuera de alcance: fila propia "Próximamente" en Inicio; limpiar filas cuyo archivo desapareció sin reemplazo (es T9).
  - [x] T11a Backend: migración 004, registro `downloading`, promoción, mover/renombrar, `comingSoon`, 409 en play + tests (2d5afba; 176 tests, RED observado; migración probada en copia de la BD real: 34 archivos, progreso y jobs intactos, `foreign_key_check` vacío). Desvíos: `POST /process` también responde 409; `comingSoon` opcional en el tipo web (T11b lo vuelve obligatorio y ajusta fixtures); archivos no asignables y recientes consultan TMDB en cada reescaneo (~61 s) mientras sigan recientes. `migrate()` ahora apaga `foreign_keys` y verifica `foreign_key_check` antes del COMMIT. Revisión RDD (base `97f01ca`, riesgo medio, `slice_budget_reached`): omitida por el dueño; próxima base `2d5afba`.
  - [x] T11b Web: insignia, sin Reproducir, chip "descargando" + tests (9b74a4d; 95 tests web, RED observado, build ok; sin probar en navegador; el 409 se muestra en el estado de error del player, no en toast)
  - [ ] T11c Verificación real con Frieren (antes y después de renombrar a `frieren`)
    - [x] Antes de renombrar (2026-10-09): migración 004 sobre `data/library.db` real (v4, 34 archivos, 2 progresos intactos; backup en scratchpad de la sesión). Bug hallado: el parser dejaba "S1" en el nombre de la serie → TMDB sin match → Pendientes. Corregido en 11fdf41 (marcador de temporada al final del nombre → `season`; 183 tests, RED observado). Tras reescanear: título "Frieren: Más allá del final del viaje" (TMDB 209867), 28 archivos `downloading`, 5 completos encolados, 0 sin asignar, `POST /play` sobre uno en descarga → 409.
    - [ ] Después de renombrar la carpeta a `frieren` (lo hace el dueño **cuando termine la descarga**, para no dañar el torrent): mismos ids de `media_files`, sin título nuevo. El nombre del **archivo** (`Sousou no Frieren S1 - NN`) ya basta para el match; `matchSeries("frieren")` solo da candidatos, pero no se usa gracias a la reubicación.
    - [ ] Ver la UI en el navegador (insignia, chip "descargando").
- [x] T13 (2ed83f5; 189 tests; RED observado desactivando `findSeasonsGroup`; copia de BD real con TMDB real: Frieren → T1 28, Especiales 26, T2 10, 33 archivos conservados, 0 episodios sin asignar; migración 005 `titles.seasons_group_id` — NULL = sin decidir, '' = oficiales/grupo de carpeta; la mejora corre una vez por título en `retryMetadata`. Ojo: usar la API de backup de SQLite para una copia consistente; copiar solo la BD abierta omite datos recientes del WAL, y copiar BD/WAL por separado no garantiza una instantánea) Temporadas reales con episode groups de TMDB (pedido del dueño 2026-10-09). Frieren (209867): la temporada oficial 1 tiene 38 episodios, pero el grupo tipo 6 "Seasons" la parte en 28 + 10 (también hay "Absolute Order" tipo 2 con lo mismo). Regla: al importar una serie, si TMDB tiene un grupo de tipo 6 ("Seasons") **y** ese grupo tiene más temporadas (sin contar la 0) que las oficiales, usar ese grupo como estructura de temporadas; si no, las oficiales. El grupo por nombre de carpeta (Bakemonogatari) sigue teniendo prioridad. Títulos ya importados (Frieren id 2): reimportar y reasignar archivos sin perder ids de `media_files` ni progreso. Ruta: delegada (sonnet).
- [ ] T14 Marcar una temporada como vista / no vista (pedido del dueño 2026-10-09): mismo comportamiento que el título (vista = `completed` en sus episodios; no vista = borra su progreso), solo para los archivos de esa temporada. Botón en la página del título junto al selector de temporada. Ruta: delegada (sonnet), después de T13.
- [ ] T15 Bugs de extras (dueño 2026-10-09, captura de Frieren): (a) el parser pierde el número del extra (`NCED 01`, `NCED 02`, `NCED Special`, `NCOP 01` → todos "NCED"/"NCOP"): la etiqueta debe conservarlo, y las filas ya guardadas se reetiquetan al reescanear; (b) tarjeta de extra en descarga muestra ▶ y el chip "descargando" se sale de la tarjeta. Ruta: delegada (sonnet), después de T13.
- [ ] T16 Reparto con nombres latinos (dueño 2026-10-09): TMDB da el nombre japonés en kanji (`種﨑敦美`); `/person/{id}/translations` trae `es`/`en` ("Atsumi Tanezaki"). Si el nombre no está en alfabeto latino, usar la traducción `es`, si no `en`; si no hay, el original. Personas ya importadas se corrigen en el siguiente escaneo (con internet). Ruta: delegada (sonnet), después de T13.
- [x] T17 Guía de arranque local y diagnóstico de biblioteca vacía (pedido del dueño 2026-10-09). Alcance: README y `docs/local-development.md` en español; corregir instrucciones obsoletas en este documento. Ruta: delegada (documentación). Estimación: 2 puntos, Schnauzer; previsión: 180 líneas añadidas/eliminadas, estrategia `ask-on-risk`. Aceptación: dos terminales, rutas absolutas de contenido/datos, puerto frontend real, comprobaciones HTTP, copia SQLite consistente antes de abrir la BD conservada y aviso de migraciones automáticas. RED no aplica a documentación pasiva. No autoriza reiniciar procesos, migrar, reimportar ni alterar `.env`, `data/` o `content/`. Restaurar el arranque queda pendiente de aprobación; T14 continúa después de resolver este incidente.
  - Verificación: `git diff --check` → salida vacía, código 0. `python3 - <<'PY'` (comprobación estructural de los tres documentos) → PASS: enlaces, scripts, variables, proxy, migración y estados ajenos conservados; sin secretos ni consejos de borrado/sobrescritura. Lectura final de README y guía realizada.
  - Backup: `python3 - <<'PY'` (extraer bloque documentado, `bash -n`/`ast.parse` y ejecutarlo solo sobre SQLite desechable en `/tmp/opencode`) → PASS: 10 bloques shell válidos, filas WAL y esquema 4 conservados, dos destinos distintos y fallo seguro si falta el origen. Primer intento falló por esperar 11 bloques; corregida solo esa expectativa a 10. No se abrió la BD del dueño.
  - Runtime/HTTP/build/instalación: N/A, documentación pasiva y ejecución no autorizada. Unidad de documentación: estos tres archivos; reversión limitada a la guía, su enlace y las correcciones de T17, sin tocar otras tareas. Sin commit del writer; integración a cargo del padre. Espejo completo Engram `odd/tv-series-library/tasks`, localizador `odd/tasks/tv-series-library.md`, con lectura de retorno antes y después de editar.
- [ ] T10 Aleatorio (pedido del dueño): botón para reproducir un anime/episodio al azar de lo que hay guardado.
- [ ] T6 Player (diseño: `docs/design/t6-player.md`): hls.js, audio/subs, guardar progreso, reanudar, siguiente episodio — ruta: delegada (sonnet)
  - [x] T6a Backend: archivos de cualquier estado en el detalle + servir `apps/web/dist` con fallback SPA + tests (pistas se guardan al terminar la extracción de subs, antes del video)
  - [x] T6b `apps/web` (Vue 3 + Vite + hls.js): andamiaje, cliente API, pantallas mínimas temporales (perfil, títulos, detalle)
  - [x] T6c Player: play/espera, audio/subs, progreso, reanudar, siguiente episodio
  - [ ] T6d Verificación real: celular y TV por WiFi (archivo listo y en proceso)
- [ ] T7 Empaquetado Linux: Docker Compose `restart: unless-stopped`, Docker habilitado en systemd, puerto abierto en firewall (ufw si aplica), URL + QR en Ajustes, **guía en español en el README: cómo correrlo en la laptop Linux y cómo entrar desde celular y TV** (decisión del dueño: la guía se escribe aquí, no antes)
- [ ] T8 (diferido) Instalador Windows: Inno Setup con firewall y autoarranque

## Hallazgos
- Releases BD de anime traen audio FLAC → transcodificar a AAC (ADR 0002).
- Los clientes torrent preasignan el tamaño final: un archivo incompleto ya tiene tamaño total pero ffprobe falla ("EBML header parsing failed"). La ingesta debe validar con ffprobe y reintentar.

- TMDB no tiene "Bakemonogatari": es la temporada 1 de **Monogatari** (46195) con 12 episodios; los 13–15 están en Especiales. Los ordenamientos alternativos de TMDB (*Original air date*, *DVD*) sí traen el grupo "Bakemonogatari" con 15. Decisión del dueño: usar el grupo cuyo nombre coincide con la carpeta.
- La carpeta `Commentary` de Bakemonogatari son parches `.xdelta`, no videos: se ignoran.
- IMDb no sirve como fuente: bloquea acceso automático y su API es de pago.

## Evidencia
- T17: commit `75dc09d`, 177 líneas añadidas/eliminadas; `git diff --check` y lectura estructural correctos, bloques de shell validados y backup SQLite probado solo en datos desechables por el writer. Evaluación nativa: `passive` (`non_executable_only`), sin revisión requerida. No se ejecutaron arranque, migración, ingesta ni pruebas HTTP sobre la biblioteca real. Rollback documental: README, guía local y actualización T17, sin cambios de código ni datos.
- T1: `node:sqlite` + FTS5 verificado en Node 24.14 (`mas*` → "Más allá del final").
- T2: 30 tests vitest en verde, `tsc --noEmit` limpio, health/seed/titles/suggest verificados en servidor real. Commits f69b1ed, 8b1ff42, df8e511.

- T3: 84 tests vitest en verde, `tsc` limpio. Escaneo real de `content/` con TMDB: Monogatari (46195, anime), temporada "Bakemonogatari" con 15 episodios, 34 archivos (15 episodios + 19 extras OP/ED/PV), 0 pendientes; reescaneo sin cambios. Commits 18770c7, fb60f80, 32ff3a1, 9d73436.

- Los videos son H.264 **High 10** (10 bits): Chrome y TV no los reproducen → se recodifican. Dueño eligió 1080p nativo (`veryfast`, CRF 20): ~3 min/episodio, ~45 min todo Bakemonogatari, ~320 MB/episodio. Subtítulos: WebVTT ahora, guardando `.ass` + fuentes para un renderizador ASS futuro (ADR 0002 actualizado).
- T4: 147 tests en verde, `tsc` limpio. Real: ep 01 en 181 s → 549 MB (H.264 High 8 bits 1080p, AAC jpn, duración idéntica 1466 s), OP2 en 15 s; VTT, `.ass` y 26 fuentes; `/api/stream` 200 con content-types correctos y 404 ante `..`. Commits 40c75d3, 2226579, 09e95f2.

- TV del dueño: **TCL C635** (Google TV / Android TV, nueva). Player con hls.js (MSE). Pendiente elegir navegador en la TV (Google TV no trae Chrome) o alternativa (app WebView / Cast) en T6.

- T4d: 157 tests en verde, `tsc` limpio. Real (ep 02, 1441 s, 4 hilos, nice 19): **3,9× tiempo real** (368 s), primer segmento reproducible a los **6,3 s**, CPU ≈4,8 núcleos de 16, RAM máx. ≈670 MB; `ENDLIST` al terminar, pistas renombradas, subtítulos listos antes del video. Bug hallado en la verificación: ffmpeg termina el master con `\n\n` y el renombrado temprano no se aplicaba (corregido con test). Commits b201888 + el de esta corrección. Revisión RDD: riesgo medio, `under_budget` (queda en el tramo; base = `HEAD~1` porque no existe `main`).

## Pendientes conocidos (T4)
- Una caída puede dejar `hls/<id>.tmp`; se borra al reprocesar ese archivo (no hay barrido al arrancar).
- Primer cue del VTT puede ser un cartel de una letra (typesetting de ASS): esperado con WebVTT.

## Pendientes conocidos (T3)
- Buscar "bakemonogatari" no encuentra "Monogatari": el índice solo guarda el título localizado. Indexar nombres de temporada y título original.
- Rutas de `media_files` son relativas a `CONTENT_DIR`; T4 debe unirlas. Pistas: `{index, codec, language, title, channels?}`, `index` sirve para `-map 0:index`.
- Si un archivo creado sin internet no cabe luego en TMDB, pasa a Pendientes y se pierde su progreso (caso raro).
- `./content` y `./data` son relativos al cwd (`apps/server` con `npm start -w`): fijar en T7.

- T6a: 163 tests en verde, `tsc` limpio (usar `../../node_modules/.bin/tsc`; `npx tsc` toma una versión vieja). URL mal escapada → 400 de Fastify antes del handler. Variable nueva `WEB_DIR` (default `../web/dist`), falta documentarla en `.env.example`.

- T6b: build, 6 tests web y typecheck en verde; servidor sirve `index.html` en `/` y `/titles/1`. vue 3.5, vue-router 5, hls.js 1.7, vite 8. `vue-tsc` no funciona con TypeScript 7 → TypeScript 5.9 como devDependency en la raíz; el servidor conserva su 7.0.2.
- Diagnóstico 2026-10-09: `apps/server/data/library.db` tiene esquema 5, 0 títulos, 0 archivos y 1 perfil; la BD conservada en `data/library.db` de la raíz tiene esquema 4, 2 títulos, 67 archivos, 3 perfiles y 2 progresos. No recomendar reescaneo para recuperar perfiles: primero copia SQLite consistente y aprobación del arranque/migración 005, incluso con trabajadores desactivados. Ver `docs/local-development.md`.
- Recuperar catálogo no equivale a recuperar reproducción: Monogatari conserva 34 videos; las 33 rutas antiguas de Frieren faltan y ahora hay lotes SubsPlease S01 (28) y S02 (10); Danmachi tiene 1 video nuevo sin indexar. Reconciliación de archivos/progreso pendiente de aprobación; no borrar ni renombrar como remedio.

- Revisión RDD de T6a+T6b (base `3b31963`, riesgo medio, `slice_budget_reached`): el dueño eligió **omitir esta vez**. Verificación: autoverificación del writer + re-ejecución del padre (163 tests server, 6 web, build y tsc). Commits 2eb9741, beac387; próxima base de revisión `beac387`.

- T6c: 16 tests web, typecheck y build en verde (sin evidencia RED: tests y lógica se escribieron juntos). Ruta `/watch/:mediaFileId?title=<titleId>`. Pantalla completa sobre el contenedor (no el `<video>`) para que el menú y "Siguiente" sigan visibles; botón nativo oculto con `controlslist`. Riesgos a probar en T6d: autoplay bloqueado en iOS/TV, iOS sin menú de audio (HLS nativo), subtítulos asociados por posición, chunk de hls.js de 581 kB.

- Revisión RDD de T6c (base `beac387`, riesgo medio, `slice_budget_reached`): omitida por el dueño. Commit 3bd8e9d; próxima base `3bd8e9d`.

- Prueba del dueño en PC: el player abre pero no arrancaba solo (`play()` antes de que hls.js leyera el manifiesto) → corregido en 06c20e4. El dueño rechazó las pantallas temporales: quiere la UI completa (T5) ya. Procesado: una sola vez por archivo (queda en `data/hls/<id>`).
- Correr local: seguir `docs/local-development.md` (dos terminales, rutas absolutas desde la raíz, frontend 5174; copia y aprobación antes de abrir la BD conservada).

- T5c (bf3fe4c): 52 tests web, 164 server. Continuar viendo trae `episodeId` + `stillPath`. Monogatari real: audio `jpn` (FLAC), subtítulos `eng`. Revisión RDD omitida por el dueño; próxima base `bf3fe4c`.
- Decisión pendiente del dueño: "Marcar como no visto" solo limpia `title_state.finished`; el progreso `completed` de cada episodio queda y siguen apareciendo como "Visto".

## Siguiente paso (punto de entrada para una sesión nueva)
Prioridad del dueño: documentación **antes** de continuar la funcionalidad pendiente. Orden actual, **sin iniciar procesos ni otras tareas**:
1. **T17 completada:** guía local y diagnóstico; solo documentación, sin restauración ejecutada.
2. **Recuperación controlada:** copia consistente y aprobación explícita antes de abrir/migrar la BD raíz; reconciliar Frieren en un paso separado. T14 sigue pendiente de esa aprobación y de resolver el incidente.
3. **T14** marcar temporada vista/no vista; no cerrar T15 solo por sus commits, falta la verificación correspondiente. T16 sigue pendiente.
4. **T11c, T9 y T10** pendientes; luego **T6d** en celular/TV y **T7** empaquetado/autoarranque Linux.
Cómo trabajar (orden del dueño): el padre (Opus) solo diseña, coordina, revisa y hace commits; implementación delegada a **Sonnet 5.5**, tareas mecánicas a **Haiku 5.5**. Commits como Daniel Morales <mralejo99@gmail.com>, **sin** `Co-Authored-By`. Cada tramo: el dueño ha elegido omitir la revisión RDD; preguntar igual con el sobre de consentimiento antes de lanzar el siguiente writer. Writers sin comandos git.
Nombre de la app: queda "sala" por ahora (dueño 2026-10-09). Por confirmar: clic en miniatura de Continuar viendo (no se reprodujo en CDP; cambio defensivo aplicado).
Correr local: [`docs/local-development.md`](../../docs/local-development.md). El puerto 5173 era de otro proyecto; desarrollo usa 5174 y API 8080. No detener procesos ajenos.

## Hito mínimo (MVP Linux)
T2 → T3 → T4 → T6 (player básico) → T5 (UI completa) → T7. Primer hito verificable: ver un episodio desde el celular **y** la TV por WiFi, con el router sin internet.
