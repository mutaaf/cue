-- Who reported each review change. The events table keeps whichever copy came first, so without this
-- nobody could tell whether Stage Manager also saw a change the Mac watcher reported first.
CREATE TABLE echoes (id TEXT NOT NULL, source TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (id, source));
