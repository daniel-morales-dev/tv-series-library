# T2 — Diseño del backend core

## Decisiones técnicas
- **Monorepo** con npm workspaces: `apps/server`, `apps/web` (web se crea en T5).
- **TypeScript sin build**: Node 24 ejecuta `.ts` directamente (type stripping). Solo sintaxis borrable: nada de `enum`, `namespace` ni parameter properties. Imports con extensión `.ts`. `tsconfig` con `noEmit`, `strict`, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `verbatimModuleSyntax`.
- **Fastify 5**, ESM. Factory `buildApp({ db })` para testear con `app.inject()`.
- **`node:sqlite`** (`DatabaseSync`): `PRAGMA journal_mode=WAL`, `foreign_keys=ON`. Migraciones SQL en `src/db/migrations/NNN_name.sql`, versión en `PRAGMA user_version`, cada migración en transacción.
- **Estructura por módulo** (screaming): `src/modules/<module>/{routes.ts, repository.ts}`. Sin capas extra para CRUD; la lógica con reglas (continuar viendo, progreso) va en funciones puras testeables.
- **Validación** con JSON Schema de Fastify en cada ruta.
- **Tests** con vitest + SQLite `:memory:`.

## Esquema (migración 001)
| Tabla | Columnas clave |
|---|---|
| `profiles` | id, name (único), avatar, theme (`dark`/`light`), preferred_audio_lang, preferred_subtitle_lang, created_at |
| `collections` | id, tmdb_id (único), name, overview, poster_path, backdrop_path |
| `titles` | id, tmdb_type (`movie`/`tv`, nullable), tmdb_id (nullable), kind (`movie`/`series`/`anime`), title, original_title, overview, year, runtime_min, rating, genres (JSON array), poster_path, backdrop_path, logo_path, collection_id, metadata_status (`pending`/`ready`/`missing`), created_at, updated_at. Único (tmdb_type, tmdb_id) |
| `seasons` | id, title_id (cascade), number, name, overview, poster_path. Único (title_id, number) |
| `episodes` | id, season_id (cascade), number, name, overview, runtime_min, still_path, air_date. Único (season_id, number) |
| `people` | id, tmdb_id (único), name, profile_path |
| `credits` | title_id, person_id, role (`cast`/`director`), character, ord. PK (title_id, person_id, role) |
| `media_files` | id, path (único), size, title_id, episode_id (nullable), extra_label (nullable), status (`pending`/`processing`/`ready`/`error`), hls_dir, duration_s, audio_tracks (JSON), subtitle_tracks (JSON), error, created_at |
| `jobs` | id, type, media_file_id, status (`queued`/`running`/`done`/`error`), progress, error, created_at, updated_at |
| `my_list` | profile_id, title_id, added_at. PK compuesta |
| `watch_progress` | profile_id, media_file_id, position_s, duration_s, completed, updated_at. PK compuesta |
| `title_state` | profile_id, title_id, hidden_from_continue, finished, updated_at. PK compuesta |
| `search_index` | FTS5 (`ref_type` y `ref_id` UNINDEXED, `label`), `tokenize='unicode61 remove_diacritics 2'` |

Todas las FK de perfil y título borran en cascada.

## API (`/api`)
| Método y ruta | Comportamiento |
|---|---|
| `GET /health` | `{ ok: true }` |
| `GET/POST /profiles`, `PATCH/DELETE /profiles/:id` | CRUD de perfiles |
| `GET /titles?kind&year&genre&sort&limit&offset` | Catálogo filtrado. `sort`: `recent` (default), `title`, `year` |
| `GET /titles/:id?profileId` | Detalle con temporadas, episodios, créditos, saga y archivos listos; si hay `profileId`, incluye en Mi lista, terminado y progreso por archivo |
| `GET /search/suggest?q` | Hasta 10 resultados FTS5 por prefijo de cada palabra (títulos y personas) |
| `GET /profiles/:pid/my-list` · `PUT/DELETE /profiles/:pid/my-list/:titleId` | Mi lista (PUT idempotente) |
| `PUT /profiles/:pid/progress` `{ mediaFileId, positionS, durationS }` | Guarda progreso; `completed = positionS / durationS >= 0.9` |
| `GET /profiles/:pid/continue-watching` | Ver reglas abajo |
| `DELETE /profiles/:pid/continue-watching/:titleId` | Oculta el título (`hidden_from_continue = 1`) |
| `PUT /profiles/:pid/titles/:titleId/finished` `{ finished }` | `true`: marca terminado y todos sus archivos como completados. `false`: solo desmarca |

## Reglas de "Continuar viendo"
Por perfil, para cada título con progreso que no esté oculto ni terminado:
1. Toma el último progreso actualizado del título.
2. Si no está completo → reanudar ese archivo en `position_s`.
3. Si está completo → siguiente episodio (orden temporada, episodio; sin extras) sin completar. Si no hay → el título no aparece.
4. Ordenar por `updated_at` descendente.
- Guardar progreso nuevo en un título oculto lo vuelve a mostrar (`hidden_from_continue = 0`).

## Datos de desarrollo
`npm run seed -w apps/server`: perfiles y títulos de ejemplo (película, serie con 2 temporadas, anime) para trabajar la UI antes de la ingesta real.
