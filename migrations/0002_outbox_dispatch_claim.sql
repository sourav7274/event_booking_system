ALTER TABLE outbox ADD COLUMN dispatch_token TEXT;
ALTER TABLE outbox ADD COLUMN dispatch_started_at TEXT;

CREATE INDEX IF NOT EXISTS outbox_dispatch_claim_idx
  ON outbox(status, dispatch_started_at, created_at);
