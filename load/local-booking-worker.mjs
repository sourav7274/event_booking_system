import { createBaselineBooking, createOptimizedBooking } from '../src/worker/db.ts';
import { z } from 'zod';

const customer = { clerkId: 'local-customer', email: 'customer@example.invalid', role: 'CUSTOMER' };
const burstInput = z.object({
  target: z.enum(['baseline', 'optimized']),
  eventId: z.string().uuid(),
  attempts: z.number().int().min(1).max(10_000),
  concurrency: z.number().int().min(1).max(10_000),
});

export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/burst') {
      return new Response('Not found', { status: 404 });
    }
    if (request.headers.get('content-type') !== 'application/json') {
      return new Response('Expected JSON', { status: 415 });
    }
    const input = burstInput.safeParse(await request.json().catch(() => null));
    if (!input.success) return new Response('Invalid benchmark input', { status: 400 });
    const { target, eventId, attempts, concurrency } = input.data;
    const book = target === 'baseline' ? createBaselineBooking : createOptimizedBooking;
    let launchSpanMs = 0;
    const latencies = [];
    const failures = [];
    // Workerd may coarsen its clock, so use it consistently for both paths.
    const start = Date.now();
    for (let offset = 0; offset < attempts; offset += concurrency) {
      const batchSize = Math.min(concurrency, attempts - offset);
      await Promise.all(Array.from({ length: batchSize }, async () => {
        const started = Date.now();
        launchSpanMs = started - start;
        try {
          await book(env, customer, eventId, 1, crypto.randomUUID(), true);
          latencies.push(Date.now() - started);
        } catch (error) {
          failures.push({ message: String(error), cause: String(error?.cause ?? '') });
        }
      }));
    }
    return Response.json({ latencies, failures, duration: Date.now() - start, launchSpanMs });
  },
};
