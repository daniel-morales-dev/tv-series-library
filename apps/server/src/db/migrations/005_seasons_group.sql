-- TMDB "Seasons" episode group the title's seasons come from. NULL = not decided yet,
-- '' = decided, official seasons (or a folder-matched group) are used.
ALTER TABLE titles ADD COLUMN seasons_group_id TEXT;
