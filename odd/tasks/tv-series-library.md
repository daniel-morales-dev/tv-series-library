# tv-series-library — media server local

**Objetivo:** plataforma propia tipo Netflix/Crunchyroll/HBO en LAN, sin login, con perfiles, Mi lista, Continuar viendo, tracking por episodio, búsqueda con autocompletado, cambio de audio/subtítulos.
**Plan completo:** decisiones en `docs/adr/`, glosario en `CONTEXT.md`.
**Estrategia de entrega:** `ask-on-risk` (rama por fase).

## Restricciones
- Código en inglés, documentación en español, comentarios solo cuando aportan.
- Sin módulos nativos de Node (instalador Windows): `node:sqlite`.
- `content/`, `data/`, `.env` y `*.torrent` fuera de git.
- No exigir renombrar archivos (rompe el seeding).

## Tareas
- [x] T1 Fundación: rama, `.gitignore`, `.env.example`, glosario, ADRs 0001–0004, README — ruta: inline
- [ ] T2 Backend core: esquema + migraciones, API perfiles, catálogo con filtros, Mi lista, progreso, continuar viendo
- [ ] T3 Ingesta: escaneo recursivo + watcher, detección de descarga incompleta (tamaño estable + ffprobe válido), parser de nombres (SxxEyy, absoluto, extras OP/ED/Commentary), cliente TMDB, caché de imágenes, Pendientes
- [ ] T4 Procesamiento: ffprobe → plan (copy/transcode video, FLAC/DTS → AAC) → HLS multi-audio + WebVTT; cola de jobs con progreso
- [ ] T5 Frontend: perfiles, header, hero, filas vertical/horizontal, detalle con temporadas, Mi lista en grilla, búsqueda, filtros, tema claro/oscuro, responsive, navegación espacial
- [ ] T6 Player: hls.js, audio/subs, guardar progreso, reanudar, siguiente episodio
- [ ] T7 Empaquetado: Docker Compose (Linux), Inno Setup (Windows) con firewall y autoarranque

## Hallazgos
- Releases BD de anime traen audio FLAC → transcodificar a AAC (ADR 0002).
- Los clientes torrent preasignan el tamaño final: un archivo incompleto ya tiene tamaño total pero ffprobe falla ("EBML header parsing failed"). La ingesta debe validar con ffprobe y reintentar.

## Evidencia
- T1: `node:sqlite` + FTS5 verificado en Node 24.14 (`mas*` → "Más allá del final").

## Siguiente paso
T2 Backend core.
