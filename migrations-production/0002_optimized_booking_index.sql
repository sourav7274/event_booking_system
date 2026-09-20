-- Production booking path uses a single atomic D1 batch; this index keeps event booking lookups narrow.
CREATE INDEX IF NOT EXISTS bookings_event_status_created_idx ON bookings(event_id, status, created_at DESC);
