-- Delivery latency: milliseconds from publish (minus any contract delay) to a subscriber finishing.
ALTER TABLE deliveries ADD COLUMN ms INTEGER;
CREATE INDEX deliveries_at ON deliveries(at);
-- The weekly replay drill. One row per drill; ok is null while it runs.
CREATE TABLE drills (id TEXT PRIMARY KEY, started TEXT NOT NULL, replayed TEXT, verified TEXT, ok INTEGER, ms INTEGER, note TEXT);
-- DMARC aggregate reports: counts only.
CREATE TABLE dmarc (id TEXT PRIMARY KEY, org TEXT NOT NULL, day TEXT NOT NULL, pass INTEGER NOT NULL, fail INTEGER NOT NULL, at TEXT NOT NULL);
