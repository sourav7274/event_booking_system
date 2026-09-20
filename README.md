# Venueflow — Event Booking System

Venueflow is a TypeScript Event Booking System for organizers and customers. It is designed for deployment on Cloudflare Workers with D1, Queues, Clerk, and Resend.

## What is implemented

- Public event browsing and a compact React booking dashboard.
- Clerk JWT verification with server-side `CUSTOMER` and `ORGANIZER` roles.
- Organizer event creation, listing, updates, booking visibility, and notification status.
- Customer booking history and idempotent booking requests.
- General-admission inventory, 1–10 tickets per booking, integer minor-unit pricing, UTC timestamps.
- A transactional outbox, Queue consumer, Cron reconciliation, real Resend email delivery, retries, and deterministic email idempotency keys.
- Separate `baseline` and `production` Worker environments for the performance experiment.

## Architecture

```text
React/Vite dashboard ─┐
                      ├─ Cloudflare Worker / Hono API ─ D1
API clients ──────────┘              │                  ├─ users
                                     │                  ├─ events
                                     │                  ├─ bookings
                                     │                  ├─ outbox
                                     │                  └─ notification_deliveries
                                     └─ Cloudflare Queue ─ Resend Email API
```

The Worker serves both static React assets and the API. This avoids a second frontend deployment and cross-origin configuration.

## Roles and access

| Capability | Customer | Organizer |
|---|---:|---:|
| Browse published events | Yes | Yes |
| Book tickets | Yes | No |
| View own bookings | Yes | No |
| Create/update own events | No | Yes |
| View bookings/notification status for own events | No | Yes |

Clerk handles identity, session, password security, and signed tokens. The Worker verifies the JWT locally and D1 remains the authority for application roles. A user cannot submit a role in an API request. Configure bootstrap organizers through `ORGANIZER_CLERK_IDS`.

## Key design decisions

### Cloudflare-native deployment

Cloudflare was chosen over Vercel because the free account already supplies Workers, D1, Queues, Cron, static assets, and a custom domain route in one deployment model. The project uses two new D1 databases, not the existing account database, to avoid destructive migration risk and to isolate load-test evidence.

```text
venueflow-production Worker ─ production D1 ─ production Queue ─ real Resend delivery
venueflow-baseline Worker   ─ baseline D1   ─ benchmark Queue  ─ synthetic test recipients
```

The baseline uses `workers.dev`; only production needs a custom domain. Two Workers and two D1 databases are well within the current free limits of 100 Worker projects and 10 D1 databases per account.

### Inventory and idempotency

Money is stored as integer minor units. Event times are ISO-8601 UTC strings. Every booking requires an `Idempotency-Key`; `UNIQUE(customer_id, idempotency_key)` makes client retries return the original booking.

The final production migration adds a database trigger that atomically validates event availability and increments `tickets_sold` during booking insertion. The invariant is:

```text
tickets_sold = sum(confirmed booking quantities) <= capacity
```

All SQL values are parameterized. Dynamic update field names are selected only from an internal allowlist after Zod validation.

### Reliable background work

D1 and Cloudflare Queues cannot share one distributed transaction. The solution is a transactional outbox:

1. The booking/update and its outbox row commit together in D1.
2. The request schedules an immediate queue dispatch after commit.
3. A Cron Trigger re-dispatches pending rows if the process fails between commit and queue publication.
4. Queue consumers call Resend and persist delivery state.
5. Deterministic Resend idempotency keys prevent duplicate email side effects during retries.

Booking confirmations use `booking-confirmed/{bookingId}`. Event updates use `event-updated/{eventId}/{version}/{recipient}`. Benchmark addresses ending in `.invalid` are marked `SUPPRESSED_TEST`; normal recipients use the real Resend API.

### Scope boundaries

This submission intentionally excludes payments, refunds, customer cancellations, reserved seating, ticket tiers, hard event deletion, and public organizer sign-up. Published events are cancelled through status updates to preserve audit history.

## Local setup

1. Install Node.js 22+ and authenticate Wrangler:

   ```bash
   npm install
   npx wrangler login
   ```

2. For a local-only run, skip Cloudflare resource creation for now. Copy the environment template:

   ```powershell
   Copy-Item .dev.vars.example .dev.vars
   ```

   Then run the local production schema and development server:

   ```bash
   npm run db:migrate:local
   npm run dev
   ```

   Open the local URL shown by Wrangler (normally `http://localhost:8787`). Public health and dashboard routes work without Clerk configuration; protected API routes require valid Clerk values in `.dev.vars`.

3. When ready for remote deployment, create two D1 databases and two Queues:

   ```bash
   npx wrangler d1 create venueflow-production
   npx wrangler d1 create venueflow-baseline
   npx wrangler queues create venueflow-production-jobs
   npx wrangler queues create venueflow-baseline-jobs
   ```

4. Copy the returned D1 IDs into `wrangler.jsonc`. Never commit `.dev.vars`.

5. Configure Clerk:

   - Create a Clerk application.
   - Configure a session-token custom claim containing the verified primary email.
   - Copy the JWT public key, issuer, and audience into Worker configuration.
   - Add a Clerk user ID to `ORGANIZER_CLERK_IDS` for organizer testing.

6. Configure Resend:

   - Add an existing-domain subdomain such as `events.example.com`.
   - Add the shown SPF/DKIM DNS records.
   - Verify the domain and store `RESEND_API_KEY` as a Worker secret.

7. Apply migrations. Baseline uses the `migrations/` directory; production uses the separate `migrations-production/` directory, which adds the optimized trigger:

   ```bash
   npx wrangler d1 migrations apply venueflow-baseline --remote --env baseline
   npx wrangler d1 migrations apply venueflow-production --remote
   ```

7. Start locally:

   ```bash
   npm run dev
   ```

## Deployment

```bash
npm run deploy
npm run deploy:baseline
```

Set sensitive values with `wrangler secret put` rather than `vars`:

```bash
npx wrangler secret put CLERK_JWT_PUBLIC_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put BENCHMARK_SECRET
```

Attach the production Worker to a dedicated subdomain such as `events.example.com`. Keep the baseline only on its generated `workers.dev` URL.

## API overview

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Deployment health |
| GET | `/api/v1/events` | Public published events |
| GET | `/api/v1/events/:eventId` | Public event detail |
| GET | `/api/v1/me` | Authenticated user profile |
| POST | `/api/v1/events/:eventId/bookings` | Customer booking; requires `Idempotency-Key` |
| GET | `/api/v1/me/bookings` | Customer history |
| POST | `/api/v1/organizer/events` | Create an event |
| GET | `/api/v1/organizer/events` | Organizer-owned events |
| PATCH | `/api/v1/organizer/events/:eventId` | Update owned event and enqueue notifications |
| GET | `/api/v1/organizer/events/:eventId/bookings` | Event bookings |
| GET | `/api/v1/organizer/events/:eventId/notifications` | Background-work status |

Interactive documentation is available at `/docs`; `/openapi.json` provides the machine-readable contract.

## Performance experiment

The assessment requires an honest before/after result. Do not create artificial delays or errors.

1. Build the first reasonable, correct, low-concurrency implementation.
2. Tag it `baseline-v1`, deploy the baseline environment, and run the same k6 scenario described below.
3. Capture p50/p95/p99, successful bookings, unexpected failures, database errors, and inventory reconciliation.
4. Identify the measured bottleneck.
5. Apply only justified improvements, such as fewer D1 round trips, atomic trigger-based reservation, narrower queries, indexes, and asynchronous queue publication.
6. Deploy production and repeat exactly the same scenario.

The current baseline performs an availability read followed by a conditional transactional batch. Production is prepared for the trigger-based reservation migration. Do not claim a concurrency limit until k6 produces it.

Use a high-capacity synthetic event so `409 SOLD_OUT` is not mistaken for a dropped request. A stage fails when unexpected timeout/5xx failures exceed 1%, p95 exceeds 750 ms, throughput plateaus, or inventory is inconsistent.

Suggested stages are `10 → 25 → 50 → 100 → 200 → 400 → 800` synchronized virtual users, one booking per VU and a unique idempotency key. Preserve raw output and only report the highest repeatable passing stage.

The included script resets a new high-capacity event for every run and marks its jobs as benchmark-only:

```bash
k6 run -e BASE_URL=https://your-worker.example \
  -e CUSTOMER_TOKEN=your-clerk-session-jwt \
  -e BENCHMARK_SECRET=your-secret \
  -e VUS=100 load/k6-booking.js
```

Run it against baseline first, save the console output, then repeat against production with the same `VUS` stages. The benchmark secret suppresses Resend delivery only for these synthetic jobs; it does not affect ordinary bookings.

Separately test event-update fan-out at 10, 25, 50, and 100 recipients. Measure update response latency, pending jobs, queue drain time, retries, and duplicate logical deliveries. Demonstrate real emails only with controlled addresses; Resend free tier is limited to 100 emails/day.

Cloudflare quotas are account-wide, even with separate D1 databases. Keep total test traffic bounded and check the account before rerunning a large test.

## Video checklist

- Show your face and speak English for 3–4 minutes.
- Make API calls against the deployed URL.
- Run the baseline at its final passing stage and first failing stage live.
- Explain the observed bottleneck and the specific optimization it justified.
- Run the matching optimized stage and show the measured delta.
- Demonstrate a real booking-confirmation email and real event-update email.
- Show that unauthorized role actions are rejected.

## Verification

```bash
npm run build
npm test
```

Before submission, add integration coverage for role ownership, malformed inputs, idempotency, sold-out behavior, concurrent inventory safety, outbox recovery, queue retry, and notification deduplication. Record deployed benchmark output and the video URL in this README.
