import { AppError } from './errors';
import { listBookedRecipients, loadOutbox, markOutboxFailed, markOutboxProcessed } from './db';
import type { Env, JobMessage } from './types';

type BookingPayload = { bookingId: string; eventId: string; customerId: string; benchmark?: boolean };
type UpdatePayload = { eventId: string; version: number; changedFields: string[] };

async function sendEmail(env: Env, to: string, subject: string, html: string, idempotencyKey: string): Promise<string | null> {
  if (env.APP_ENV === 'baseline' && to.endsWith('.invalid')) return null;
  if (!env.RESEND_API_KEY) throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'Email delivery is not configured.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html }),
  });
  if (!response.ok) throw new Error(`Resend returned ${response.status}`);
  const data = await response.json<{ id?: string }>();
  return data.id ?? null;
}

async function deliverBookingConfirmation(env: Env, outboxId: string): Promise<void> {
  const outbox = await loadOutbox(env, outboxId);
  const payload = JSON.parse(outbox.payload) as BookingPayload;
  const booking = await env.DB.prepare(
    `SELECT b.id, b.quantity, b.total_price_minor, b.created_at, e.title, e.venue, e.starts_at, e.currency, u.email
     FROM bookings b JOIN events e ON e.id = b.event_id JOIN users u ON u.clerk_id = b.customer_id WHERE b.id = ?`,
  ).bind(payload.bookingId).first<{ id: string; quantity: number; total_price_minor: number; created_at: string; title: string; venue: string; starts_at: string; currency: string; email: string }>();
  if (!booking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  const deliveryId = crypto.randomUUID();
  const key = `booking-confirmed/${booking.id}`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notification_deliveries (id, outbox_id, recipient_email, idempotency_key) VALUES (?, ?, ?, ?)`,
  ).bind(deliveryId, outboxId, booking.email, key).run();
  const existing = await env.DB.prepare('SELECT status FROM notification_deliveries WHERE idempotency_key = ?').bind(key).first<{ status: string }>();
  if (existing?.status === 'SENT' || existing?.status === 'SUPPRESSED_TEST') return;
  if (payload.benchmark || booking.email.endsWith('.invalid')) {
    await env.DB.prepare(`UPDATE notification_deliveries SET status = 'SUPPRESSED_TEST', sent_at = ? WHERE idempotency_key = ?`).bind(new Date().toISOString(), key).run();
    return;
  }
  const price = new Intl.NumberFormat('en-US', { style: 'currency', currency: booking.currency }).format(booking.total_price_minor / 100);
  const providerId = await sendEmail(
    env,
    booking.email,
    `Booking confirmed — ${booking.title}`,
    `<h1>Your booking is confirmed</h1><p><strong>${booking.title}</strong></p><p>${new Date(booking.starts_at).toUTCString()} · ${booking.venue}</p><p>${booking.quantity} ticket(s) · ${price}</p><p>Booking reference: ${booking.id}</p>`,
    key,
  );
  await env.DB.prepare(
    `UPDATE notification_deliveries SET status = 'SENT', provider_message_id = ?, sent_at = ?, attempts = attempts + 1 WHERE idempotency_key = ?`,
  ).bind(providerId, new Date().toISOString(), key).run();
}

async function deliverEventUpdate(env: Env, outboxId: string): Promise<void> {
  const outbox = await loadOutbox(env, outboxId);
  const payload = JSON.parse(outbox.payload) as UpdatePayload;
  const event = await env.DB.prepare('SELECT title, venue, starts_at, status FROM events WHERE id = ?').bind(payload.eventId).first<{ title: string; venue: string; starts_at: string; status: string }>();
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found.');
  const recipients = await listBookedRecipients(env, payload.eventId);
  for (const recipient of recipients) {
    const key = `event-updated/${payload.eventId}/${payload.version}/${recipient}`;
    const deliveryId = crypto.randomUUID();
    await env.DB.prepare(`INSERT OR IGNORE INTO notification_deliveries (id, outbox_id, recipient_email, idempotency_key) VALUES (?, ?, ?, ?)`).bind(deliveryId, outboxId, recipient, key).run();
    const existing = await env.DB.prepare('SELECT status FROM notification_deliveries WHERE idempotency_key = ?').bind(key).first<{ status: string }>();
    if (existing?.status === 'SENT' || existing?.status === 'SUPPRESSED_TEST') continue;
    if (recipient.endsWith('.invalid')) {
      await env.DB.prepare(`UPDATE notification_deliveries SET status = 'SUPPRESSED_TEST', sent_at = ? WHERE idempotency_key = ?`).bind(new Date().toISOString(), key).run();
      continue;
    }
    const providerId = await sendEmail(
      env,
      recipient,
      `Event update — ${event.title}`,
      `<h1>${event.title} has been updated</h1><p>${new Date(event.starts_at).toUTCString()} · ${event.venue}</p><p>Status: ${event.status}</p><p>Updated details: ${payload.changedFields.join(', ') || 'event information'}.</p>`,
      key,
    );
    await env.DB.prepare(`UPDATE notification_deliveries SET status = 'SENT', provider_message_id = ?, sent_at = ?, attempts = attempts + 1 WHERE idempotency_key = ?`).bind(providerId, new Date().toISOString(), key).run();
  }
}

export async function processJob(env: Env, message: JobMessage): Promise<void> {
  try {
    if (message.type === 'BOOKING_CONFIRMATION') await deliverBookingConfirmation(env, message.outboxId);
    else await deliverEventUpdate(env, message.outboxId);
    await markOutboxProcessed(env, message.outboxId);
  } catch (error) {
    await markOutboxFailed(env, message.outboxId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
