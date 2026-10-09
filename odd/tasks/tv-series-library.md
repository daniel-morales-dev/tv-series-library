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
  - [ ] T5e Navegación espacial TV y responsive fino
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
- `apps/server/data/library.db` está **vacía** (0 títulos): las verificaciones reales de T3/T4 usaron otra carpeta de datos. Para T6d hay que escanear `content/` de nuevo (fijar rutas de `data`/`content` sigue pendiente para T7).

- Revisión RDD de T6a+T6b (base `3b31963`, riesgo medio, `slice_budget_reached`): el dueño eligió **omitir esta vez**. Verificación: autoverificación del writer + re-ejecución del padre (163 tests server, 6 web, build y tsc). Commits 2eb9741, beac387; próxima base de revisión `beac387`.

- T6c: 16 tests web, typecheck y build en verde (sin evidencia RED: tests y lógica se escribieron juntos). Ruta `/watch/:mediaFileId?title=<titleId>`. Pantalla completa sobre el contenedor (no el `<video>`) para que el menú y "Siguiente" sigan visibles; botón nativo oculto con `controlslist`. Riesgos a probar en T6d: autoplay bloqueado en iOS/TV, iOS sin menú de audio (HLS nativo), subtítulos asociados por posición, chunk de hls.js de 581 kB.

- Revisión RDD de T6c (base `beac387`, riesgo medio, `slice_budget_reached`): omitida por el dueño. Commit 3bd8e9d; próxima base `3bd8e9d`.

- Prueba del dueño en PC: el player abre pero no arrancaba solo (`play()` antes de que hls.js leyera el manifiesto) → corregido en 06c20e4. El dueño rechazó las pantallas temporales: quiere la UI completa (T5) ya. Procesado: una sola vez por archivo (queda en `data/hls/<id>`).
- Correr local: `npm run build -w apps/web` y `CONTENT_DIR=../../content DATA_DIR=../../data npm start -w apps/server` → http://localhost:8080.

- T5c (bf3fe4c): 52 tests web, 164 server. Continuar viendo trae `episodeId` + `stillPath`. Monogatari real: audio `jpn` (FLAC), subtítulos `eng`. Revisión RDD omitida por el dueño; próxima base `bf3fe4c`.
- Decisión pendiente del dueño: "Marcar como no visto" solo limpia `title_state.finished`; el progreso `completed` de cada episodio queda y siguen apareciendo como "Visto".

## Siguiente paso
T5e en curso. Nota: el rechazo `invalid_request` al omitir la revisión de T5c coincidió con un agente editando el árbol; con el árbol limpio funcionó → consentimiento RDD antes de lanzar otro writer. T6d (dispositivos) al final.

## Hito mínimo (MVP Linux)
T2 → T3 → T4 → T6 (player básico) → T5 (UI completa) → T7. Primer hito verificable: ver un episodio desde el celular **y** la TV por WiFi, con el router sin internet.
