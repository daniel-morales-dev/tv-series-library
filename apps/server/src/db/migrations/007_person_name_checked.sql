-- 1 once the person's display name was resolved to Latin script (or needs no resolving): never queried again.
ALTER TABLE people ADD COLUMN name_checked INTEGER NOT NULL DEFAULT 0;
