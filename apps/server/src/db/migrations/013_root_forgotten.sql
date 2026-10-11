-- T9d: "forget" a root without deleting its catalog rows. A forgotten root disappears from /api/roots and from
-- the ingestor scan, but its media_files rows (progress, HLS) stay so a re-added folder can be re-linked.
ALTER TABLE library_roots ADD COLUMN forgotten INTEGER NOT NULL DEFAULT 0;
