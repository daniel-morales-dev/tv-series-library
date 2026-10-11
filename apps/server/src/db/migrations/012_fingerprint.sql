-- T9c: content identity of a media file (size + sha1 of its first, middle and last 64 KiB blocks), so a file
-- that moved to another folder or root can be re-associated with its row (same id, progress, HLS) instead of
-- being re-ingested. Null until the ingestor computes it lazily during a scan.
ALTER TABLE media_files ADD COLUMN fingerprint TEXT;
CREATE INDEX idx_media_files_fingerprint ON media_files(fingerprint);
