-- T26: chapters (opening/ending/recap markers) read from the media file with ffprobe, once per file.
-- chapters_checked separates "not probed yet" from "probed, has none"; files processed before this
-- migration are backfilled lazily the first time the player asks.
CREATE TABLE media_chapters (
  media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_s REAL NOT NULL,
  end_s REAL NOT NULL,
  title TEXT,
  PRIMARY KEY (media_file_id, idx)
);
ALTER TABLE media_files ADD COLUMN chapters_checked INTEGER NOT NULL DEFAULT 0;
