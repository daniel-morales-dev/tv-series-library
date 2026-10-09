import { join } from 'node:path';
import { indexEntry } from '../modules/search/repository.ts';
import { openDb } from './connection.ts';
import { get, run } from './sql.ts';

const db = openDb(join(process.env.DATA_DIR ?? './data', 'library.db'));

if (get(db, 'SELECT 1 AS x FROM titles LIMIT 1')) {
  console.log('Database already has titles; seed skipped.');
  process.exit(0);
}

function addTitle(kind: string, title: string, year: number, genres: string[], overview: string): number {
  const id = run(
    db,
    `INSERT INTO titles (kind, title, year, genres, overview, runtime_min, rating, metadata_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ready')`,
    kind,
    title,
    year,
    JSON.stringify(genres),
    overview,
    kind === 'movie' ? 118 : 45,
    7.8,
  ).lastInsertId;
  indexEntry(db, 'title', id, title);
  return id;
}

function addFile(titleId: number, path: string, episodeId: number | null = null): void {
  run(
    db,
    `INSERT INTO media_files (path, title_id, episode_id, status, hls_dir, duration_s)
     VALUES (?, ?, ?, 'ready', ?, 2700)`,
    path,
    titleId,
    episodeId,
    `seed/${path}`,
  );
}

function addSeason(titleId: number, number: number, episodes: number, label: string): void {
  const seasonId = run(db, 'INSERT INTO seasons (title_id, number, name) VALUES (?, ?, ?)', titleId, number, `Temporada ${number}`)
    .lastInsertId;
  for (let n = 1; n <= episodes; n++) {
    const episodeId = run(
      db,
      'INSERT INTO episodes (season_id, number, name, runtime_min) VALUES (?, ?, ?, 45)',
      seasonId,
      n,
      `Episodio ${n}`,
    ).lastInsertId;
    addFile(titleId, `${label}/S${number}E${n}.mkv`, episodeId);
  }
}

db.exec('BEGIN');
for (const name of ['Ana', 'Luis']) run(db, 'INSERT INTO profiles (name) VALUES (?)', name);

const movie = addTitle('movie', 'Más allá del final', 2021, ['Drama', 'Ciencia ficción'], 'Una película de ejemplo para desarrollo.');
addFile(movie, 'seed-movie/film.mkv');

const series = addTitle('series', 'Ciudad Subterránea', 2019, ['Drama', 'Misterio'], 'Una serie de ejemplo con dos temporadas.');
addSeason(series, 1, 4, 'seed-series');
addSeason(series, 2, 4, 'seed-series');

const anime = addTitle('anime', 'Espíritu del Bosque', 2023, ['Animación', 'Fantasía'], 'Un anime de ejemplo.');
addSeason(anime, 1, 6, 'seed-anime');

const person = run(db, "INSERT INTO people (tmdb_id, name) VALUES (1, 'Marta Quiroga')").lastInsertId;
indexEntry(db, 'person', person, 'Marta Quiroga');
run(db, "INSERT INTO credits (title_id, person_id, role, character, ord) VALUES (?, ?, 'cast', 'Protagonista', 0)", series, person);
db.exec('COMMIT');

console.log('Seeded 2 profiles and 3 titles.');
