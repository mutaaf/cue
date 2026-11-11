-- Paired phones for Web Push. An endpoint is the push service's opaque address for one browser install.
CREATE TABLE pager (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, at TEXT NOT NULL);
