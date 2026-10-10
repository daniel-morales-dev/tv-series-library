# T9 — Biblioteca en varias ubicaciones: análisis de brechas

Diseño (2026-10-10, solo lectura sobre código y docs; nada ejecutado). Estado: **propuesta para aprobar**. Objetivo del dueño: contenido y procesados repartidos entre el PC y uno o más HDD, mover archivos sin transcodificar de nuevo, y que un disco ausente muestre sus títulos como "no disponible" sin perder progreso ni metadata.

## Vocabulario propuesto (añadir a `CONTEXT.md`)
**Ubicación** (`LibraryRoot`): carpeta de contenido registrada, con su marcador `.sala-library.json`. El `libraryId` actual pasa a identificar la **ubicación** (compatible: la primera ubicación conserva el id existente). Evitar "biblioteca" para esto: el catálogo (SQLite) es único.

## Lo que ya está resuelto
| Pieza | Aporta | Límite para T9 |
|---|---|---|
| T22a (`config/config.ts`) | `config.json` con `contentDir`, `libraryId`, `hlsDir`, `contentDev`; marcador con adopción de identidad; `configStatus`/`libraryDiskPresent` (marcador + id + `stat.dev`); nunca crea un marcador en `missing` | **Una sola** carpeta. `UserConfig.contentDir` es escalar; contrato `GET/PUT /api/config` congelado |
| T47a (`config/paths.ts`) | `stateDir` (BD, imágenes) fuera del repo y del disco externo; HLS desacoplado | Ninguno: el catálogo ya sobrevive a un disco ausente |
| T47c (`processing/cache.ts`) | LRU solo de paquetes copy; no expulsa si el original no se puede leer (disco desmontado) | Comprueba `join(contentDir, path)` de una sola raíz |
| T47d | HLS bajo `<contenido>/.sala/hls`; `meta.json {path,size,planHash}`; 503 `disk_absent` en stream/play; worker reencola en vez de `error`; watcher solo `shows/`+`films/` | Guardián **global** (un `diskPresent`); un solo `hlsDir` |
| T47e (`data-migration/`) | Mover paquetes HLS a otra carpeta (hardlink/copia verificada, reanudable, origen intacto hasta confirmar) | Un origen → un destino |
| `watch_progress`/`jobs` | Colgados de `media_files.id`, no de la ruta: el progreso sobrevive a un cambio de ruta | — |

## Lo que falta (verificado en código)
1. **Modelo de datos con una sola raíz.** `media_files.path` es `UNIQUE` y relativo a *la* carpeta (`001_init.sql`); `source_dirs.path` es PK y `pending_files.path` `UNIQUE` (`002_ingest.sql`). No existe tabla de ubicaciones ni columna de raíz. Mismo `shows/Frieren/...` en dos discos colisionaría. El parser (`ingest/parser.ts`) exige `shows/` o `films/` como primer segmento.
2. **La raíz está cableada en ~10 sitios.** `join(contentDir, path)` en `process.ts:161`, `cache.ts:120,177`, `pending.ts:111`, `catalog/routes.ts:82`, `cli/data-report.ts:144`; `listVideos(contentDir())` y watchers en `ingestor.ts:98,339,363`; `workerContentDir` fijo al arrancar (`index.ts`). Falta un único resolvedor `sourcePath(rootId, rel)`.
3. **Identidad del archivo = ruta + heurística.** `relocateMoved` (`ingestor.ts`) reconoce un movimiento por `(basename, size)` solo dentro de una raíz, en memoria, y rechaza ambigüedades. Mover un archivo de un disco a otro hoy crea una fila nueva (se reprocesa) y deja la vieja huérfana. El `id` de fila ya es estable (HLS `hls/<id>`, progreso), así que basta con que el movimiento sea un `UPDATE root_id, path` y no un alta.
4. **"No disponible" no existe como estado.** Un archivo ausente con el disco presente cae en `SourceMissingError` → `error` (`worker.ts:198`), y hay dos `DELETE FROM media_files` (`ingestor.ts:220` reemplazo de release, `register.ts:127`). Con un disco ausente el escaneo ya sale sin tocar nada (`ingestor.ts:90`), pero es global: con dos raíces habría que escanear la presente y saltar solo la ausente. Hace falta además distinguir *ubicación ausente* (reversible) de *archivo reemplazado* (pendiente heredado de T23: filas Cifer viejas).
5. **Marcador por ubicación.** Hoy un marcador = la biblioteca. Con varias, cada raíz lleva el suyo (mismo formato `{libraryId}`) y el arranque resuelve cada una: ruta conocida → marcador → (T22c) escaneo de montajes. T22c sigue sin hacerse y debería nacer ya multi-raíz.
6. **Migración del catálogo.** Añadir `library_roots`, `root_id` en `media_files`/`source_dirs`/`pending_files` y cambiar sus claves únicas a `(root_id, path)`. SQLite no cambia `UNIQUE`/PK sin reconstruir la tabla (precedente: `004_downloading_status.sql` reconstruyó `media_files`), con hijos `ON DELETE CASCADE` (`jobs`, `watch_progress`): reconstruir con `foreign_keys=OFF` y respaldo previo. Se prueba solo sobre una **copia** de la BD, nunca la real.
7. **API y UI.** Sin `/api/roots`, sin lista de ubicaciones en Ajustes, sin insignia "no disponible" en tarjetas/ficha/Continuar viendo, y el player no distingue "disco ausente" por ubicación.
8. **HLS por ubicación.** `hls_dir` se guarda como `hls/<id>` y `cache.packageDir` usa `basename`: un único `hlsDir`. Observación útil: un paquete **x264** no necesita el original para reproducirse, así que si el HLS vive en el PC, ese archivo sigue disponible aunque el HDD del original no esté; solo los copy perezosos dependen del original.

## Modelo mínimo propuesto
- `library_roots(id TEXT PK /* = libraryId */, path TEXT, label TEXT, last_seen_at TEXT)`. La BD es la fuente de verdad del listado; la ruta es "última conocida" y se revalida con el marcador. `config.contentDir` queda como ubicación principal (compatibilidad con lanzador y `GET /api/config`).
- `media_files.root_id` (+ `fingerprint`), `source_dirs` y `pending_files` con `root_id`; únicos `(root_id, path)`.
- `fingerprint = size + sha1(3 bloques de 64 KB: inicio, medio, final)`: barato también en HDD. Un archivo cuyo fingerprint ya existe en otra ruta/raíz se **reubica** (mismo `id`, sin reprocesar). `meta.json` ganaría el fingerprint para readoptar paquetes tras perder la BD.
- Disponibilidad **derivada**, no almacenada: `rootStatus(rootId)` (marcador + id + `stat.dev`, la lógica de `configStatus` generalizada) y `available = raíz presente || paquete reproducible`. Un título es "no disponible" si todos sus archivos lo son; parcialmente disponible si faltan algunos.
- Regla dura: ninguna operación de borrado, `error` ni supersede sobre filas de una raíz ausente; el escaneo trabaja raíz por raíz.

## División incremental (≈ 14 pts; la estimación original de 8 queda corta)
1. **T9a (3) Esquema + resolvedor.** Migración 011 (`library_roots`, `root_id`, claves `(root_id, path)`, primera ubicación sembrada desde `config.json`), respaldo automático de la BD, `sourcePath()` y reemplazo de los `join` listados. Con una sola ubicación el comportamiento no cambia: los 400+ tests existentes siguen verdes y sirven de red de seguridad.
2. **T9b (3) Disponibilidad por ubicación.** `rootStatus`, escaneo por raíz, `available` en los DTO del catálogo, 503 `disk_absent` por ubicación, worker reencola si la raíz del archivo falta, caché consulta su raíz, y separar "ubicación ausente" de "reemplazado". Pruebas con carpetas simuladas.
3. **T9c (2) Identidad.** `fingerprint` perezoso en el escaneo, reubicación entre rutas y raíces conservando `id`, ambigüedad resuelta por fingerprint, `meta.json` con fingerprint.
4. **T9d (3) Ingesta y API multi-raíz.** `listVideos` y watchers por raíz, `GET/POST/DELETE /api/roots` (alta con marcador y adopción de id, "olvidar" sin borrar filas), `PUT /api/config/content-dir` intacto para la principal. Opcionalmente T22c aquí (escaneo de montajes por marcador, Linux primero).
5. **T9e (3) Web.** Ajustes → Ubicaciones (listar/añadir/olvidar, estado), insignia "no disponible", mensaje en el player, comportamiento de Continuar viendo.
Orden estricto a→b→c→d→e; T21 (presupuesto por volumen) puede usar `library_roots` para detectar el tipo de disco de cada raíz. Diferido: HLS por ubicación, réplicas, letras de unidad de Windows (con T8).

## Decisiones abiertas para el dueño
1. **Cómo distinguir archivos de dos raíces.** Recomendado: columna `root_id` con reconstrucción de tablas (limpio, verificable). Alternativa: prefijo virtual en la ruta (`<root>/shows/...`), sin reconstruir tablas pero ensucia el parser y las claves. Tradeoff: riesgo de migración sobre la BD real vs deuda permanente.
2. **Dónde vive la lista de ubicaciones.** Recomendado: SQLite (con la última ruta conocida; el marcador corrige rutas cambiadas). Alternativa: `config.json`, que viaja con el lanzador pero duplica el catálogo y no sobrevive a restaurar la BD en otra máquina.
3. **¿Cada ubicación exige `shows/` y `films/`?** Recomendado: sí (parser y watcher sin cambios). Tradeoff: no se puede registrar una carpeta suelta de series sin crear esa estructura.
4. **Huella del archivo.** Recomendado: tamaño + sha1 de 3 bloques de 64 KB. Alternativas: hash completo (lee GB por archivo, lento en HDD) o seguir con nombre+tamaño (ambiguo con releases idénticas y no cruza raíces).
5. **Dónde viven los HLS en v1.** Recomendado: un único `hlsDir` como hoy (T47d/e ya lo mueven), con disponibilidad = original presente **o** paquete presente. Tradeoff: los HLS no viajan con cada HDD; a cambio, los x264 ya procesados siguen reproduciéndose con el HDD desconectado. HLS por ubicación queda como T9f.
6. **Qué ver con una ubicación ausente.** Recomendado: tarjetas atenuadas con "No disponible · reconecta <etiqueta>", sin botón de reproducir, y Continuar viendo las muestra atenuadas. Alternativa: ocultarlas (menos ruido, pero el usuario cree que se borraron).
7. **Mismo archivo en dos ubicaciones.** Recomendado: gana el primero registrado y se avisa en el log/Actividad. Alternativa: soportar réplicas (elegir la presente), que añade modelo y UI.
8. **Quitar una ubicación.** Recomendado: "olvidar" la deja como no disponible con confirmación explícita separada para borrar sus filas (nunca automático). Tradeoff: un paso extra para quien realmente quiere limpiar.
9. **T22c dentro de T9d o aparte.** Recomendado: dentro, ya multi-raíz (evita hacerlo dos veces). Tradeoff: T9d crece a ~5 pts.
10. **Re-estimación.** Aceptar ~14 pts en 5 tareas en lugar de 8 pts, sin tocar datos reales hasta que T9a pase sobre una copia de la BD.
