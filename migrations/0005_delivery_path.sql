-- Which lane delivered: inline (at publish), queue, deferred (long jobs), retry, sweep or replay.
ALTER TABLE deliveries ADD COLUMN path TEXT;
CREATE INDEX deliveries_sub ON deliveries(subscriber, at);
