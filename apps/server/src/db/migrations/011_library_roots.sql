-- T9a: a library may span several content folders (PC + external HDDs). `library_roots` lists them; every
-- file/folder/pending row carries its root, so the same relative path can exist in two roots without colliding.
-- Row 1 is the current single folder: boot links it to config.json's libraryId and last known path.
CREATE TABLE library_roots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id TEXT UNIQUE,
  last_known_path TEXT,
  label TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
INSERT INTO library_roots (id, library_id, last_known_path, label, position) VALUES (1, NULL, NULL, NULL, 0);

-- SQLite cannot change UNIQUE(path) into UNIQUE(root_id, path): rebuild media_files keeping every v10 column.
-- The runner disables foreign keys for this, so children (jobs, watch_progress, media_chapters) keep their rows.
CREATE TABLE media_files_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id INTEGER NOT NULL DEFAULT 1 REFERENCES library_roots(id),
  path TEXT NOT NULL,
  size INTEGER,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
  extra_label TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('downloading', 'pending', 'processing', 'ready', 'error')),
  hls_dir TEXT,
  duration_s REAL,
  audio_tracks TEXT NOT NULL DEFAULT '[]',
  subtitle_tracks TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  parsed_season INTEGER,
  parsed_number INTEGER,
  last_played_at TEXT,
  pkg_mode TEXT CHECK (pkg_mode IN ('copy', 'x264')),
  pkg_bytes INTEGER,
  chapters_checked INTEGER NOT NULL DEFAULT 0,
  UNIQUE (root_id, path)
);

INSERT INTO media_files_new (id, root_id, path, size, title_id, episode_id, extra_label, status, hls_dir, duration_s,
  audio_tracks, subtitle_tracks, error, created_at, parsed_season, parsed_number, last_played_at, pkg_mode, pkg_bytes,
  chapters_checked)
SELECT id, 1, path, size, title_id, episode_id, extra_label, status, hls_dir, duration_s,
  audio_tracks, subtitle_tracks, error, created_at, parsed_season, parsed_number, last_played_at, pkg_mode, pkg_bytes,
  chapters_checked
FROM media_files;

-- A deleted id must never come back (HLS folders are named by id), so the rebuilt table adopts the old
-- AUTOINCREMENT counter before the old table is dropped.
DELETE FROM sqlite_sequence WHERE name = 'media_files_new';
INSERT INTO sqlite_sequence (name, seq) SELECT 'media_files_new', seq FROM sqlite_sequence WHERE name = 'media_files';

DROP TABLE media_files;
ALTER TABLE media_files_new RENAME TO media_files;
CREATE INDEX idx_media_files_title ON media_files(title_id);

-- source_dirs: the folder key becomes (root_id, path).
CREATE TABLE source_dirs_new (
  root_id INTEGER NOT NULL DEFAULT 1 REFERENCES library_roots(id),
  path TEXT NOT NULL,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season_number INTEGER,
  PRIMARY KEY (root_id, path)
);
INSERT INTO source_dirs_new (root_id, path, title_id, season_number)
SELECT 1, path, title_id, season_number FROM source_dirs;
DROP TABLE source_dirs;
ALTER TABLE source_dirs_new RENAME TO source_dirs;

-- pending_files: same composite key; ids are copied explicitly.
CREATE TABLE pending_files_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id INTEGER NOT NULL DEFAULT 1 REFERENCES library_roots(id),
  path TEXT NOT NULL,
  size INTEGER,
  parsed TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('unparsed', 'no_match', 'unmapped_episode')),
  candidates TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ignored')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (root_id, path)
);
INSERT INTO pending_files_new (id, root_id, path, size, parsed, reason, candidates, status, created_at)
SELECT id, 1, path, size, parsed, reason, candidates, status, created_at FROM pending_files;
DROP TABLE pending_files;
ALTER TABLE pending_files_new RENAME TO pending_files;
