CREATE TABLE IF NOT EXISTS users (
  clerk_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('CUSTOMER', 'ORGANIZER')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL REFERENCES users(clerk_id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  venue TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  tickets_sold INTEGER NOT NULL DEFAULT 0 CHECK (tickets_sold >= 0),
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'CANCELLED')) DEFAULT 'DRAFT',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (tickets_sold <= capacity),
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  customer_id TEXT NOT NULL REFERENCES users(clerk_id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  unit_price_minor INTEGER NOT NULL,
  total_price_minor INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED')) DEFAULT 'CONFIRMED',
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(customer_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('BOOKING_CONFIRMATION', 'EVENT_UPDATE')),
  aggregate_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'DISPATCHED', 'PROCESSED', 'FAILED')) DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dispatched_at TEXT,
  processed_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES outbox(id),
  recipient_email TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED_TEST')) DEFAULT 'PENDING',
  provider_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS events_public_list_idx ON events(status, starts_at, id);
CREATE INDEX IF NOT EXISTS events_organizer_idx ON events(organizer_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS bookings_event_idx ON bookings(event_id, customer_id);
CREATE INDEX IF NOT EXISTS bookings_customer_idx ON bookings(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(status, created_at);
CREATE INDEX IF NOT EXISTS deliveries_outbox_idx ON notification_deliveries(outbox_id, status);
