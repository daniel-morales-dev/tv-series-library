# Guía para retomar el proyecto (agentes y personas)

## Empieza aquí
1. Lee `odd/tasks/tv-series-library.md`: estado, siguiente tarea y hallazgos.
2. Lee `CONTEXT.md` (glosario) y `docs/adr/` (decisiones). No reabras una decisión sin una razón nueva.
3. Revisa `git log --oneline` y la rama actual.

## Prioridad actual
**Objetivo #1:** que corra en Linux (laptop del dueño), arranque solo al encender el PC y se pueda ver desde el celular y la TV por WiFi.
Windows (instalador `.exe`, ADR 0003) queda **diferido**: no invertir en él hasta que el objetivo #1 funcione.

## Convenciones
- Código, identificadores y commits en inglés (Conventional Commits). Documentación y textos de la UI en español.
- Comentarios solo cuando explican un *porqué* no obvio.
- Sin módulos nativos de Node: usar `node:sqlite`.
- Cambio pequeño y probado por tarea; tests con vitest.
- Nunca subir `.env`, `content/`, `data/` ni `*.torrent` (ya están en `.gitignore`).
- **Offline-first:** internet solo se usa al importar (TMDB). Metadata e imágenes se guardan en SQLite y `data/`. El frontend no carga nada de CDNs (fuentes, iconos y scripts van empaquetados). Sin internet en la importación, el archivo queda reproducible con el título del nombre del archivo y la metadata se reintenta luego.
- Nunca imprimir ni copiar el token de TMDB en logs, commits o chat.

## Datos del entorno
- Node 24.14 (`node:sqlite` con FTS5 verificado), ffmpeg/ffprobe en `/usr/bin`, Docker disponible.
- Contenido real en `content/shows/` y `content/films/`; puede haber descargas incompletas (ver hallazgos en el archivo de tareas).
- Token TMDB en `.env` → `TMDB_READ_ACCESS_TOKEN` (Bearer, API v3).
