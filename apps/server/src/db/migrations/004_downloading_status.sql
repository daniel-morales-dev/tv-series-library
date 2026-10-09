-- SQLite cannot alter a CHECK: rebuild media_files to allow the 'downloading' status.
-- The migration runner disables foreign keys for this, so children keep their rows.
CREATE TABLE media_files_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
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
  parsed_number INTEGER
);

INSERT INTO media_files_new (id, path, size, title_id, episode_id, extra_label, status, hls_dir, duration_s,
  audio_tracks, subtitle_tracks, error, created_at, parsed_season, parsed_number)
SELECT id, path, size, title_id, episode_id, extra_label, status, hls_dir, duration_s,
  audio_tracks, subtitle_tracks, error, created_at, parsed_season, parsed_number
FROM media_files;

DROP TABLE media_files;
ALTER TABLE media_files_new RENAME TO media_files;
CREATE INDEX idx_media_files_title ON media_files(title_id);
