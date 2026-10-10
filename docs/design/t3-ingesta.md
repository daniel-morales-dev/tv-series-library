# T3 — Diseño de la ingesta

Convierte lo que hay en `content/` en títulos, temporadas, episodios y archivos del catálogo. Internet (TMDB) solo se usa aquí.

## Flujo
1. **Escaneo** recursivo de `content/shows/` y `content/films/` (`CONTENT_DIR`, default `./content`). Solo videos: `.mkv .mp4 .m4v .avi .webm .mov .ts`. Todo lo demás (`.xdelta`, `.nfo`, `.torrent`, imágenes) se ignora.
2. **¿Descarga completa?** Un archivo se ingiere solo si su `mtime` tiene más de 60 s **y** `ffprobe` lo lee sin error. Los clientes torrent preasignan el tamaño final, así que el tamaño no basta. Si falla, se reintenta en el siguiente escaneo (sin guardar nada en la base).
3. **Parser** de nombres (función pura) → serie/película, temporada, episodio o extra.
4. **Metadata** de TMDB (`es-MX`, imágenes descargadas a `DATA_DIR/images/`).
5. **Registro** del archivo en `media_files` con duración y pistas de audio/subtítulos (de `ffprobe`), `status = 'pending'` (T4 lo procesa).
6. Lo que no se puede asignar con seguridad → **Pendientes**.

Se dispara al arrancar, con `fs.watch` recursivo (debounce de 5 s) y con un reescaneo periódico (`INGEST_SCAN_INTERVAL_MIN`, default 5). Un solo escaneo a la vez. `INGEST=off` lo desactiva (tests y desarrollo de UI).

## Parser
Entrada: ruta relativa a `content/`. Limpia `[grupo]`, `(…)`, `[CRC]`, resolución, códecs y separadores (`_ . -`).

| Caso | Ejemplo | Resultado |
|---|---|---|
| Carpeta de serie | `shows/bakemonogatari/…` | nombre de serie = primera carpeta bajo `shows/` |
| `SxxEyy` / `1x02` | `Show S02E05.mkv` | temporada 2, episodio 5 |
| Absoluto | `…_Bakemonogatari_15_…` | episodio absoluto 15 |
| Extra | `OP4a`, `ED3`, `NCOP1`, `NCED`, `PV05`, `SP`, `Preview`, `Menu` | extra con etiqueta (`OP4a`) |
| Película | `films/Inception (2010).mkv`, `films/Inception.2010.1080p/…` | título + año |

## Asignación de una serie a TMDB
1. Buscar la serie por el nombre de carpeta (`/search/tv`).
2. El resultado es **seguro** si el nombre de la carpeta coincide (normalizado: minúsculas, sin acentos ni signos) con `name`, `original_name`, un título alternativo o el **nombre de un grupo** de un ordenamiento alternativo.
3. **Ordenamientos alternativos (episode groups):** si un grupo se llama como la carpeta, se usa ese ordenamiento (preferencia: *Original air date*, luego *DVD*, luego el resto). El grupo se vuelve la temporada (número = orden del grupo, nombre = nombre del grupo) y el episodio absoluto N es el N-ésimo del grupo.
   - Ej.: `bakemonogatari` → título **Monogatari** (46195), temporada **"Bakemonogatari"** con 15 episodios (13–15 = Tsubasa Cat 3–5).
4. Sin grupo: `SxxEyy` se usa tal cual; un absoluto N se reparte sobre las temporadas normales (sin la 0) en orden.
5. Episodio que no existe en TMDB, búsqueda vacía o resultado no seguro → Pendiente (con hasta 5 candidatos).
6. Anime = género Animación (16) y origen `JP`.

Las películas buscan con `/search/movie` y el año. Si tienen saga, se crea la colección.

## Sin internet
Si TMDB falla, el título se crea con el nombre de la carpeta/archivo, `metadata_status = 'pending'`, temporada 1 y episodios por número parseado. El archivo es reproducible igual. Cada escaneo reintenta los títulos `pending`, pero con espera acotada (T20): tras un fallo de red el cliente no vuelve a llamar a TMDB durante 1 min, 2 min… hasta 30 min (lo ya guardado y en caché se sigue sirviendo); una búsqueda sin resultado se repite a los 15 min, 30 min… hasta 6 h. Las respuestas exitosas (`tv`, grupos, temporadas, película, personas) se guardan en memoria mientras el servidor corre y se reutilizan entre escaneos y carpetas del mismo título; no hay refresco periódico. Un reescaneo sin cambios y las lecturas de la UI hacen 0 llamadas (`apps/server/test/tmdb-calls.test.ts`). Al obtener metadata se reconstruyen temporadas/episodios y se reasignan los archivos con lo parseado guardado en `media_files`.

## Esquema (migración 002)
- `titles.episode_group_id TEXT` — ordenamiento elegido.
- `media_files.parsed_season INTEGER`, `media_files.parsed_number INTEGER` — lo que dijo el parser, para reasignar.
- `source_dirs (path PK, title_id, season_number)` — carpeta → título y temporada (varias carpetas pueden ir al mismo título: Bakemonogatari, Nisemonogatari…).
- `pending_files (id, path UNIQUE, size, parsed JSON, reason, candidates JSON, status 'open'|'ignored', created_at)`. `reason`: `unparsed`, `no_match`, `unmapped_episode`.

## API
| Método y ruta | Comportamiento |
|---|---|
| `GET /api/pending` | Pendientes abiertos con candidatos |
| `POST /api/pending/:id/confirm` `{ tmdbType, tmdbId, episodeGroupId?, season?, episode?, extraLabel? }` | Asigna; si `confirm` cubre la carpeta, aplica a sus hermanos pendientes |
| `POST /api/pending/:id/ignore` | No vuelve a aparecer |
| `POST /api/ingest/scan` | Fuerza un escaneo |
| `GET /api/images/*` | Sirve imágenes de `DATA_DIR/images/` (ruta validada, sin `..`) |

## Pruebas
- Parser: tabla de casos con los nombres reales de `content/`.
- Asignación y episode groups: cliente TMDB falso con respuestas grabadas (sin red).
- Completitud: `ffprobe` inyectado (falla → no se ingiere).
- Verificación real: escanear `content/` con TMDB y comprobar Monogatari → temporada "Bakemonogatari" con 15 episodios y los OP/ED/PV como extras.
