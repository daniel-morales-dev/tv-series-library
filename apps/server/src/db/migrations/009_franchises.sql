-- T49: a franchise groups independent titles (TMDB has no relation between series). The Series/Movie
-- label is derived from titles.kind at read time. franchise_order is 1-based within the franchise.
CREATE TABLE franchises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);
ALTER TABLE titles ADD COLUMN franchise_id INTEGER REFERENCES franchises(id) ON DELETE SET NULL;
ALTER TABLE titles ADD COLUMN franchise_order INTEGER;
CREATE INDEX idx_titles_franchise ON titles(franchise_id);
