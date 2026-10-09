ALTER TABLE titles ADD COLUMN episode_group_id TEXT;
ALTER TABLE media_files ADD COLUMN parsed_season INTEGER;
ALTER TABLE media_files ADD COLUMN parsed_number INTEGER;

CREATE TABLE source_dirs (
  path TEXT PRIMARY KEY,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season_number INTEGER
);

CREATE TABLE pending_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  size INTEGER,
  parsed TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('unparsed', 'no_match', 'unmapped_episode')),
  candidates TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ignored')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
