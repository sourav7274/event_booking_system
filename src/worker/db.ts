import { AppError } from './errors';
import type { AuthUser, Env, EventRow, JobMessage } from './types';

type BookingRecord = { id: string; event_id: string; customer_id: string; quantity: number; unit_price_minor: number; total_price_minor: number; created_at: string };
type OutboxRow = { id: string; type: JobMessage['type']; aggregate_id: string; payload: string; status: string; attempts: number };

const now = () => new Date().toISOString();

export async function getEvent(env: Env, eventId: string): Promise<EventRow | null> {
  return env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first<EventRow>();
}

export async function requireOwnedEvent(env: Env, eventId: string, organizerId: string): Promise<EventRow> {
  const event = await env.DB.prepare('SELECT * FROM events WHERE id = ? AND organizer_id = ?').bind(eventId, organizerId).first<EventRow>();
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found.');
  return event;
}

export async function dispatchPendingOutbox(env: Env, limit = 25): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, type, aggregate_id, payload, status, attempts FROM outbox
     WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT ?`,
  ).bind(limit).all<OutboxRow>();
  let dispatched = 0;
  for (const row of rows.results) {
    const message: JobMessage = row.type === 'BOOKING_CONFIRMATION'
      ? { type: 'BOOKING_CONFIRMATION', outboxId: row.id }
      : { type: 'EVENT_UPDATE', outboxId: row.id };
    await env.JOBS.send(message);
    await env.DB.prepare(
      `UPDATE outbox SET status = 'DISPATCHED', dispatched_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'PENDING'`,
    ).bind(now(), row.id).run();
    dispatched += 1;
  }
  return dispatched;
}

export async function findExistingBooking(env: Env, customerId: string, idempotencyKey: string): Promise<BookingRecord | null> {
  return env.DB.prepare(
    `SELECT id, event_id, customer_id, quantity, unit_price_minor, total_price_minor, created_at
     FROM bookings WHERE customer_id = ? AND idempotency_key = ?`,
  ).bind(customerId, idempotencyKey).first<BookingRecord>();
}

function bookingPayload(bookingId: string, eventId: string, customerId: string): string {
  return JSON.stringify({ bookingId, eventId, customerId });
}

export async function createBaselineBooking(
  env: Env,
  customer: AuthUser,
  eventId: string,
  quantity: number,
  idempotencyKey: string,
): Promise<BookingRecord> {
  // Baseline-v1 intentionally uses a clear read followed by a transactional write batch.
  // The conditional update remains authoritative, so normal load cannot oversell inventory.
  const event = await getEvent(env, eventId);
  if (!event || event.status !== 'PUBLISHED' || new Date(event.starts_at) <= new Date()) {
    throw new AppError(409, 'EVENT_NOT_BOOKABLE', 'This event is not available for booking.');
  }
  if (event.capacity - event.tickets_sold < quantity) throw new AppError(409, 'SOLD_OUT', 'Not enough tickets remain.');

  const bookingId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const update = env.DB.prepare(
    `UPDATE events SET tickets_sold = tickets_sold + ?, updated_at = ?
     WHERE id = ? AND status = 'PUBLISHED' AND starts_at > ? AND tickets_sold + ? <= capacity`,
  ).bind(quantity, now(), eventId, now(), quantity);
  const insertBooking = env.DB.prepare(
    `INSERT INTO bookings (id, event_id, customer_id, quantity, unit_price_minor, total_price_minor, idempotency_key)
     SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
  ).bind(bookingId, eventId, customer.clerkId, quantity, event.price_minor, event.price_minor * quantity, idempotencyKey);
  const insertOutbox = env.DB.prepare(
    `INSERT INTO outbox (id, type, aggregate_id, payload)
     SELECT ?, 'BOOKING_CONFIRMATION', ?, ? WHERE changes() = 1`,
  ).bind(outboxId, bookingId, bookingPayload(bookingId, eventId, customer.clerkId));

  const result = await env.DB.batch([update, insertBooking, insertOutbox]);
  if ((result[0]?.meta.changes ?? 0) !== 1) throw new AppError(409, 'SOLD_OUT', 'Not enough tickets remain.');
  return { id: bookingId, event_id: eventId, customer_id: customer.clerkId, quantity, unit_price_minor: event.price_minor, total_price_minor: event.price_minor * quantity, created_at: now() };
}

export async function createOptimizedBooking(
  env: Env,
  customer: AuthUser,
  eventId: string,
  quantity: number,
  idempotencyKey: string,
): Promise<BookingRecord> {
  const bookingId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  try {
    const result = await env.DB.batch([
      env.DB.prepare(
        `UPDATE events SET tickets_sold = tickets_sold + ?, updated_at = ?
         WHERE id = ? AND status = 'PUBLISHED' AND starts_at > ? AND tickets_sold + ? <= capacity`,
      ).bind(quantity, now(), eventId, now(), quantity),
      env.DB.prepare(
        `INSERT INTO bookings (id, event_id, customer_id, quantity, unit_price_minor, total_price_minor, idempotency_key)
         SELECT ?, e.id, ?, ?, e.price_minor, e.price_minor * ?, ? FROM events e WHERE e.id = ? AND changes() = 1`,
      ).bind(bookingId, customer.clerkId, quantity, quantity, idempotencyKey, eventId),
      env.DB.prepare(`INSERT INTO outbox (id, type, aggregate_id, payload) SELECT ?, 'BOOKING_CONFIRMATION', ?, ? WHERE changes() = 1`).bind(
        outboxId, bookingId, bookingPayload(bookingId, eventId, customer.clerkId),
      ),
      env.DB.prepare(`SELECT id, event_id, customer_id, quantity, unit_price_minor, total_price_minor, created_at FROM bookings WHERE id = ?`).bind(bookingId),
    ]);
    if ((result[0]?.meta.changes ?? 0) !== 1) throw new AppError(409, 'SOLD_OUT', 'This event is unavailable or sold out.');
    const booking = result[3]?.results[0] as BookingRecord | undefined;
    if (!booking) throw new AppError(409, 'SOLD_OUT', 'This event is unavailable or sold out.');
    return booking;
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (message.includes('UNIQUE constraint failed: bookings.customer_id, bookings.idempotency_key')) {
      const existing = await findExistingBooking(env, customer.clerkId, idempotencyKey);
      if (existing) return existing;
    }
    throw error;
  }
}

export async function loadOutbox(env: Env, id: string): Promise<OutboxRow> {
  const row = await env.DB.prepare('SELECT id, type, aggregate_id, payload, status, attempts FROM outbox WHERE id = ?').bind(id).first<OutboxRow>();
  if (!row) throw new AppError(404, 'OUTBOX_NOT_FOUND', 'Background job not found.');
  return row;
}

export async function markOutboxProcessed(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE outbox SET status = 'PROCESSED', processed_at = ?, last_error = NULL WHERE id = ?`).bind(now(), id).run();
}

export async function markOutboxFailed(env: Env, id: string, error: string): Promise<void> {
  await env.DB.prepare(`UPDATE outbox SET status = 'PENDING', last_error = ? WHERE id = ?`).bind(error.slice(0, 500), id).run();
}

export async function listBookedRecipients(env: Env, eventId: string): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT DISTINCT u.email FROM bookings b JOIN users u ON u.clerk_id = b.customer_id
     WHERE b.event_id = ? AND b.status = 'CONFIRMED'`,
  ).bind(eventId).all<{ email: string }>();
  return result.results.map((row) => row.email);
}
