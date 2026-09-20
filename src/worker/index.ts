import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import { AppError, errorResponse } from './errors';
import { currentUser, requireAuth, requireRole } from './auth';
import { createBaselineBooking, createOptimizedBooking, dispatchPendingOutbox, findExistingBooking, getEvent, requireOwnedEvent } from './db';
import { processJob } from './jobs';
import { bookingSchema, createEventSchema, eventListSchema, updateEventSchema } from './validation';
import type { AuthUser, Env, EventRow } from './types';

type Variables = { requestId: string; user: AuthUser };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
  c.header('X-Request-Id', c.get('requestId'));
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
});
app.use('/api/*', cors({ origin: (origin, c) => origin === c.env.APP_ORIGIN ? origin : null, credentials: true, allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'], allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'] }));

app.get('/health', (c) => c.json({ data: { status: 'ok', environment: c.env.APP_ENV } }));
app.get('/openapi.json', (c) => c.json({ openapi: '3.0.3', info: { title: 'Venueflow API', version: '0.1.0' }, paths: { '/api/v1/events': { get: { summary: 'List published events' } }, '/api/v1/events/{eventId}/bookings': { post: { summary: 'Book event tickets' } } } }));
app.get('/docs', (c) => c.html(`<!doctype html><title>Venueflow API</title><main><h1>Venueflow API</h1><p><a href="/openapi.json">OpenAPI document</a></p><p>Use the deployed API with a Clerk bearer token.</p></main>`));

app.get('/api/v1/events', zValidator('query', eventListSchema), async (c) => {
  const { limit, q, from } = c.req.valid('query');
  const clauses = [`status = 'PUBLISHED'`, `starts_at > ?`];
  const bindings: unknown[] = [from ?? new Date().toISOString()];
  if (q) { clauses.push(`(title LIKE ? OR venue LIKE ?)`); bindings.push(`%${q}%`, `%${q}%`); }
  const result = await c.env.DB.prepare(`SELECT id, title, description, venue, starts_at, ends_at, capacity, tickets_sold, price_minor, currency, status FROM events WHERE ${clauses.join(' AND ')} ORDER BY starts_at ASC LIMIT ?`).bind(...bindings, limit).all<EventRow>();
  return c.json({ data: result.results.map(publicEvent) });
});

app.get('/api/v1/events/:eventId', async (c) => {
  const event = await getEvent(c.env, c.req.param('eventId'));
  if (!event || event.status === 'DRAFT') throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found.');
  return c.json({ data: publicEvent(event) });
});

app.get('/api/v1/me', requireAuth, (c) => c.json({ data: currentUser(c) }));

app.get('/api/v1/me/bookings', requireAuth, requireRole('CUSTOMER'), async (c) => {
  const user = currentUser(c);
  const result = await c.env.DB.prepare(`SELECT b.id, b.quantity, b.total_price_minor, b.status, b.created_at, e.id AS event_id, e.title, e.venue, e.starts_at, e.currency FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.customer_id = ? ORDER BY b.created_at DESC`).bind(user.clerkId).all();
  return c.json({ data: result.results });
});

app.post('/api/v1/events/:eventId/bookings', requireAuth, requireRole('CUSTOMER'), zValidator('json', bookingSchema), async (c) => {
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey || idempotencyKey.length > 128) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'An Idempotency-Key header of up to 128 characters is required.');
  const user = currentUser(c);
  const existing = await findExistingBooking(c.env, user.clerkId, idempotencyKey);
  if (existing) return c.json({ data: existing, meta: { replayed: true } }, 200);
  const booking = c.env.APP_ENV === 'baseline'
    ? await createBaselineBooking(c.env, user, c.req.param('eventId'), c.req.valid('json').quantity, idempotencyKey)
    : await createOptimizedBooking(c.env, user, c.req.param('eventId'), c.req.valid('json').quantity, idempotencyKey);
  if (c.req.header('X-Benchmark-Secret') && c.req.header('X-Benchmark-Secret') === c.env.BENCHMARK_SECRET) {
    await c.env.DB.prepare(`UPDATE outbox SET payload = ? WHERE aggregate_id = ? AND type = 'BOOKING_CONFIRMATION' AND status = 'PENDING'`).bind(
      JSON.stringify({ bookingId: booking.id, eventId: booking.event_id, customerId: booking.customer_id, benchmark: true }), booking.id,
    ).run();
  }
  c.executionCtx.waitUntil(dispatchPendingOutbox(c.env));
  return c.json({ data: booking }, 201);
});

app.post('/api/v1/organizer/events', requireAuth, requireRole('ORGANIZER'), zValidator('json', createEventSchema), async (c) => {
  const body = c.req.valid('json');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(`INSERT INTO events (id, organizer_id, title, description, venue, starts_at, ends_at, capacity, price_minor, currency, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, currentUser(c).clerkId, body.title, body.description, body.venue, body.startsAt, body.endsAt, body.capacity, body.priceMinor, body.currency, body.status).run();
  return c.json({ data: publicEvent((await getEvent(c.env, id))!) }, 201);
});

app.get('/api/v1/organizer/events', requireAuth, requireRole('ORGANIZER'), async (c) => {
  const result = await c.env.DB.prepare('SELECT * FROM events WHERE organizer_id = ? ORDER BY starts_at DESC').bind(currentUser(c).clerkId).all<EventRow>();
  return c.json({ data: result.results.map(publicEvent) });
});

app.get('/api/v1/organizer/events/:eventId/bookings', requireAuth, requireRole('ORGANIZER'), async (c) => {
  await requireOwnedEvent(c.env, c.req.param('eventId')!, currentUser(c).clerkId);
  const result = await c.env.DB.prepare(`SELECT b.id, b.quantity, b.status, b.created_at, u.email FROM bookings b JOIN users u ON u.clerk_id = b.customer_id WHERE b.event_id = ? ORDER BY b.created_at DESC`).bind(c.req.param('eventId')).all();
  return c.json({ data: result.results });
});

app.patch('/api/v1/organizer/events/:eventId', requireAuth, requireRole('ORGANIZER'), zValidator('json', updateEventSchema), async (c) => {
  const event = await requireOwnedEvent(c.env, c.req.param('eventId'), currentUser(c).clerkId);
  const body = c.req.valid('json');
  const fieldMap: Record<string, string> = { title: 'title', description: 'description', venue: 'venue', startsAt: 'starts_at', endsAt: 'ends_at', capacity: 'capacity', priceMinor: 'price_minor', currency: 'currency', status: 'status' };
  const entries = Object.entries(body).filter(([, value]) => value !== undefined);
  const changed = entries.filter(([key, value]) => String((event as unknown as Record<string, unknown>)[fieldMap[key]!]) !== String(value));
  if (changed.length === 0) return c.json({ data: publicEvent(event), meta: { unchanged: true } });
  if (body.capacity !== undefined && body.capacity < event.tickets_sold) throw new AppError(409, 'CAPACITY_BELOW_SOLD', 'Capacity cannot be lower than confirmed tickets.');
  const sets = changed.map(([key]) => `${fieldMap[key]!} = ?`);
  const values = changed.map(([, value]) => value);
  const outboxId = crypto.randomUUID();
  const version = event.version + 1;
  const changedFields = changed.map(([key]) => key);
  const notificationFields = new Set(['title', 'description', 'venue', 'startsAt', 'endsAt', 'status']);
  const shouldNotify = changedFields.some((field) => notificationFields.has(field));
  const statements = [c.env.DB.prepare(`UPDATE events SET ${sets.join(', ')}, version = ?, updated_at = ? WHERE id = ? AND organizer_id = ?`).bind(...values, version, new Date().toISOString(), event.id, currentUser(c).clerkId)];
  if (shouldNotify) statements.push(c.env.DB.prepare(`INSERT INTO outbox (id, type, aggregate_id, payload) VALUES (?, 'EVENT_UPDATE', ?, ?)`).bind(outboxId, event.id, JSON.stringify({ eventId: event.id, version, changes: changed.map(([field, value]) => ({ field, value })) })));
  await c.env.DB.batch(statements);
  if (shouldNotify) c.executionCtx.waitUntil(dispatchPendingOutbox(c.env));
  return c.json({ data: publicEvent((await getEvent(c.env, event.id))!) });
});

app.get('/api/v1/organizer/events/:eventId/notifications', requireAuth, requireRole('ORGANIZER'), async (c) => {
  await requireOwnedEvent(c.env, c.req.param('eventId')!, currentUser(c).clerkId);
  const result = await c.env.DB.prepare(`SELECT o.id, o.type, o.status, o.created_at, o.processed_at, o.last_error, COUNT(d.id) AS deliveries, SUM(CASE WHEN d.status = 'SENT' THEN 1 ELSE 0 END) AS sent FROM outbox o LEFT JOIN notification_deliveries d ON d.outbox_id = o.id WHERE o.aggregate_id = ? GROUP BY o.id ORDER BY o.created_at DESC`).bind(c.req.param('eventId')).all();
  return c.json({ data: result.results });
});

app.post('/internal/benchmark/reset', async (c) => {
  if (c.req.header('X-Benchmark-Secret') !== c.env.BENCHMARK_SECRET) throw new AppError(404, 'NOT_FOUND', 'Not found.');
  const id = crypto.randomUUID();
  const organizer = 'benchmark-organizer';
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT OR IGNORE INTO users (clerk_id, email, role) VALUES (?, ?, 'ORGANIZER')`).bind(organizer, 'organizer@benchmark.invalid'),
    c.env.DB.prepare(`INSERT INTO events (id, organizer_id, title, description, venue, starts_at, ends_at, capacity, price_minor, currency, status) VALUES (?, ?, 'Benchmark Event', 'Synthetic benchmark event for load testing only.', 'Load Lab', ?, ?, 10000, 1000, 'USD', 'PUBLISHED')`).bind(id, organizer, new Date(Date.now() + 86_400_000).toISOString(), new Date(Date.now() + 90_000_000).toISOString()),
  ]);
  return c.json({ data: { eventId: id, capacity: 10000 } }, 201);
});

app.onError((error, c) => errorResponse(c, error));
app.notFound(async (c) => {
  if (c.env.ASSETS) {
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    if (asset.status !== 404) return asset;
    return c.env.ASSETS.fetch(new Request(new URL('/', c.req.url)));
  }
  return c.json({ error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: c.get('requestId') } }, 404);
});

function publicEvent(event: EventRow) {
  return { id: event.id, title: event.title, description: event.description, venue: event.venue, startsAt: event.starts_at, endsAt: event.ends_at, capacity: event.capacity, ticketsSold: event.tickets_sold, ticketsRemaining: event.capacity - event.tickets_sold, priceMinor: event.price_minor, currency: event.currency, status: event.status, version: event.version };
}

export default {
  fetch: app.fetch,
  queue: async (batch: MessageBatch<unknown>, env: Env) => {
    for (const message of batch.messages) {
      await processJob(env, message.body as import('./types').JobMessage);
      message.ack();
    }
  },
  scheduled: async (_controller, env: Env, ctx: ExecutionContext) => { ctx.waitUntil(dispatchPendingOutbox(env)); },
} satisfies ExportedHandler<Env>;
