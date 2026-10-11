-- T69/T70: a file that vanishes from a present root becomes 'missing' (the row keeps progress and HLS, it only
-- leaves the queue), and mtime_ms tells a touched file from one replaced in place. SQLite cannot alter a CHECK:
-- rebuild media_files. The migration runner disables foreign keys for this, so children keep their rows.
CREATE TABLE media_files_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id INTEGER NOT NULL DEFAULT 1 REFERENCES library_roots(id),
  path TEXT NOT NULL,
  size INTEGER,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
  extra_label TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('downloading', 'pending', 'processing', 'ready', 'error', 'missing')),
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
  fingerprint TEXT,
  mtime_ms INTEGER,
  UNIQUE (root_id, path)
);

INSERT INTO media_files_new (id, root_id, path, size, title_id, episode_id, extra_label, status, hls_dir, duration_s,
  audio_tracks, subtitle_tracks, error, created_at, parsed_season, parsed_number, last_played_at, pkg_mode, pkg_bytes,
  chapters_checked, fingerprint)
SELECT id, root_id, path, size, title_id, episode_id, extra_label, status, hls_dir, duration_s,
  audio_tracks, subtitle_tracks, error, created_at, parsed_season, parsed_number, last_played_at, pkg_mode, pkg_bytes,
  chapters_checked, fingerprint
FROM media_files;

-- A deleted id must never come back (HLS folders are named by id), so the rebuilt table adopts the old counter.
DELETE FROM sqlite_sequence WHERE name = 'media_files_new';
INSERT INTO sqlite_sequence (name, seq) SELECT 'media_files_new', seq FROM sqlite_sequence WHERE name = 'media_files';

DROP TABLE media_files;
ALTER TABLE media_files_new RENAME TO media_files;
CREATE INDEX idx_media_files_title ON media_files(title_id);
CREATE INDEX idx_media_files_fingerprint ON media_files(fingerprint);
