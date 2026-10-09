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
- [ ] T3 Ingesta (diseño: `docs/design/t3-ingesta.md`): escaneo + watcher, descarga completa (mtime > 60 s + ffprobe), parser de nombres, TMDB con ordenamientos alternativos (episode groups), caché de imágenes, Pendientes — ruta: delegada (sonnet)
  - [ ] T3a Parser de nombres + tests
  - [ ] T3b Migración 002 + cliente TMDB + asignación (episode groups) + imágenes
  - [ ] T3c Escaneo, completitud, watcher y modo sin internet
  - [ ] T3d API Pendientes, escaneo manual e imágenes + verificación real
- [ ] T4 Procesamiento: ffprobe → plan (copy/transcode video, FLAC/DTS → AAC) → HLS multi-audio + WebVTT; cola de jobs con progreso
- [ ] T5 Frontend: perfiles, header, hero, filas vertical/horizontal, detalle con temporadas, Mi lista en grilla, búsqueda, filtros, tema claro/oscuro, responsive, navegación espacial
- [ ] T6 Player: hls.js, audio/subs, guardar progreso, reanudar, siguiente episodio
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

## Siguiente paso
T3a Parser de nombres. Usar `indexEntry` (search) al crear títulos y personas.

## Hito mínimo (MVP Linux)
T2 → T3 → T4 → T6 (player básico) → T5 (UI completa) → T7. Primer hito verificable: ver un episodio desde el celular **y** la TV por WiFi, con el router sin internet.
