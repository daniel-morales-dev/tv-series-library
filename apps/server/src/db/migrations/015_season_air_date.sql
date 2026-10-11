-- T86: seasons may not sort chronologically by their internal number (a group adopting a colliding order gets
-- the next free number), so presentation orders by the season's earliest episode air date instead.
ALTER TABLE seasons ADD COLUMN air_date TEXT;
