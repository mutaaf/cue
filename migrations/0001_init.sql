CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT NOT NULL, source TEXT NOT NULL, time TEXT NOT NULL, priority TEXT NOT NULL, data TEXT NOT NULL, received TEXT NOT NULL);
CREATE INDEX events_received ON events(received);
CREATE INDEX events_type ON events(type, received);
CREATE TABLE deliveries (event_id TEXT NOT NULL, subscriber TEXT NOT NULL, status TEXT NOT NULL, error TEXT, at TEXT NOT NULL, PRIMARY KEY (event_id, subscriber));
CREATE TABLE dead (id TEXT PRIMARY KEY, type TEXT NOT NULL, source TEXT NOT NULL, time TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE budget (day TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, shed INTEGER NOT NULL DEFAULT 0);
