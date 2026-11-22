# Offline booking benchmark

Run from the project root with installed dependencies:

```powershell
node load/local-booking.mjs
```

For a short video rehearsal, run:

```powershell
node load/local-booking.mjs --demo
```

This runs 25, 50, and 100 concurrent booking attempts per version, with one
warm-up and three measured runs per stage. The terminal shows accepted and
failed attempts, p95 for successful attempts, and inventory reconciliation as
each run finishes. Label this footage as a local booking-function benchmark.
Use separate evidence from the deployed API for the live deployment and its
request-drop threshold.

For one 10,000-attempt run per approach, in batches of 100 concurrent attempts:

```powershell
node load/local-booking.mjs --10000
```

This mode runs baseline first, then optimized, once each with no discarded
warm-up. Each approach uses one fresh 10,000-ticket event. Timings are therefore
single-run observations, with possible execution-order effects. Raw output
includes successful-attempt latencies and error causes.

To launch a custom burst without waiting for previous calls to settle, use
`--burst-N` with a whole number from 1 through 10,000:

```powershell
node load/local-booking.mjs --burst-100
node load/local-booking.mjs --burst-1000
node load/local-booking.mjs --burst-10000
```

Each version shows an animated activity bar and elapsed timer while Workerd
runs the burst. The final comparison shows exact counts. In interactive terminals,
the activity line updates in place. Captured output uses one line per update.
The final terminal comparison uses bars for the accepted share and lists exact
failure counts, p95 latency, elapsed time, and inventory totals for each version.

This burst runs once per approach and records launch span: under saturation,
launching promises itself can take substantial time, so this is not a guarantee
of simultaneous arrivals. Checkpoints are saved after each approach.
`inventoryPassed` requires both internal inventory consistency and agreement
with successful responses; a committed booking whose response was lost can
fail that combined check even when tickets_sold equals stored bookings.

This bundles the existing baseline and optimized booking functions into an
ephemeral Miniflare Worker with a local D1 binding. A loopback request starts
each run. Booking operations use the binding inside Workerd, avoiding the
Node-to-Workerd proxy for each query. The Worker listens only on loopback and has
no Queue binding or email credentials. Host and Worker outbound fetch are denied.
The runner uses installed packages and requires no Wrangler configuration.

Both algorithms use the production schema to isolate the booking algorithm.
Each stage uses a fresh 10,000-ticket event, alternating execution order across
six repetitions. The first repetition is warm-up; the other five contribute to
the summary. Each concurrent attempt books one ticket with a unique key.
Inventory is reconciled after every burst. Output asserts an empty outbox and
zero attempted Worker outbound requests.

Raw timings and summary CSV are written under ignored `load/results/local-*`.
The summary reports the median per-run p95 latency, with min/max. Timings come
from the local Worker clock and should be compared with runs of this harness.
This measures booking functions, not end-to-end HTTP/authentication latency,
sustained throughput, production capacity, or duplicate-key retry correctness.
The old k6 sweep still targets deployed services: do not use it for offline work.

## Offline HTTP stress test (full request path)

```powershell
node load/local-http.mjs                       # both versions, stages 750,1000,1500,2000
node load/local-http.mjs --target=baseline     # one version; RESULT compares with the other's last run
```

Runs the real Worker (`src/worker/index.ts`) in local Miniflare and fires each stage as one
simultaneous burst of real HTTP booking requests: Hono routing, RS256 JWT verification, user sync,
idempotency, booking batch, local D1. Each environment gets its own schema (`migrations/` for
baseline, `migrations-production/` for optimized). JWKS comes from a locally generated key; any
other outbound fetch is blocked and fails the run. No Clerk, Cloudflare, Queue or Resend usage.

A request is **dropped** when it times out on the client (default 10 s), returns 5xx, or its
connection is reset by the server. A stage breaks when more than 1% are dropped. Each stage books
a fresh 10,000-ticket event and reconciles `tickets_sold` with stored bookings afterwards. A warm-up
also checks that a repeated Idempotency-Key returns `201` then `200` and sells one ticket.
`--customers=N` signs N distinct customer tokens; use a value above the largest stage so each
request comes from a first-time user (cold user cache).
