CREATE TABLE profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  avatar TEXT,
  theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light')),
  preferred_audio_lang TEXT,
  preferred_subtitle_lang TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  overview TEXT,
  poster_path TEXT,
  backdrop_path TEXT
);

CREATE TABLE titles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_type TEXT CHECK (tmdb_type IN ('movie', 'tv')),
  tmdb_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('movie', 'series', 'anime')),
  title TEXT NOT NULL,
  original_title TEXT,
  overview TEXT,
  year INTEGER,
  runtime_min INTEGER,
  rating REAL,
  genres TEXT NOT NULL DEFAULT '[]',
  poster_path TEXT,
  backdrop_path TEXT,
  logo_path TEXT,
  collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  metadata_status TEXT NOT NULL DEFAULT 'pending' CHECK (metadata_status IN ('pending', 'ready', 'missing')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tmdb_type, tmdb_id)
);

CREATE TABLE seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  name TEXT,
  overview TEXT,
  poster_path TEXT,
  UNIQUE (title_id, number)
);

CREATE TABLE episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  name TEXT,
  overview TEXT,
  runtime_min INTEGER,
  still_path TEXT,
  air_date TEXT,
  UNIQUE (season_id, number)
);

CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  profile_path TEXT
);

CREATE TABLE credits (
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('cast', 'director')),
  character TEXT,
  ord INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (title_id, person_id, role)
);

CREATE TABLE media_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  size INTEGER,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
  extra_label TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'error')),
  hls_dir TEXT,
  duration_s REAL,
  audio_tracks TEXT NOT NULL DEFAULT '[]',
  subtitle_tracks TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'error')),
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE my_list (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (profile_id, title_id)
);

CREATE TABLE watch_progress (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  position_s REAL NOT NULL,
  duration_s REAL NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, media_file_id)
);

CREATE TABLE title_state (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  hidden_from_continue INTEGER NOT NULL DEFAULT 0,
  finished INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, title_id)
);

CREATE INDEX idx_titles_kind ON titles(kind);
CREATE INDEX idx_media_files_title ON media_files(title_id);

CREATE VIRTUAL TABLE search_index USING fts5(
  ref_type UNINDEXED,
  ref_id UNINDEXED,
  label,
  tokenize = 'unicode61 remove_diacritics 2'
);
