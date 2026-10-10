-- T47c: lazy copy packages and the LRU cache. `pkg_mode` is how the package was (or would be) built:
-- a ready file with pkg_mode = 'copy' and no hls_dir is a copy file whose package is generated on its first play.
ALTER TABLE media_files ADD COLUMN last_played_at TEXT;
ALTER TABLE media_files ADD COLUMN pkg_mode TEXT CHECK (pkg_mode IN ('copy', 'x264'));
ALTER TABLE media_files ADD COLUMN pkg_bytes INTEGER;
