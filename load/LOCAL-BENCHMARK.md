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

To launch 10,000 calls without waiting for previous calls to settle:

```powershell
node load/local-booking.mjs --burst-10000
```

Each version shows a progress bar, the number launched and settled, and an
elapsed timer that refreshes every second. In terminals that expose an interactive
console to Node, it updates in place. Captured output uses one line per update.

This burst runs once per approach and records launch span: under saturation,
launching promises itself can take substantial time, so this is not a guarantee
of 10,000 simultaneous arrivals. Checkpoints are saved after each approach.
`inventoryPassed` requires both internal inventory consistency and agreement
with successful responses; a committed booking whose response was lost can
fail that combined check even when tickets_sold equals stored bookings.

This imports the existing baseline and optimized booking functions and runs them
against an ephemeral Miniflare D1 database. It does not use Wrangler, its config,
credentials, deployed endpoints, Clerk, Queues, or email. Host fetch and Worker
outbound fetch are denied; queue sends throw. No packages are downloaded.

Both algorithms use the production schema to isolate the booking algorithm.
Each stage uses a fresh 10,000-ticket event, alternating execution order across
six repetitions. The first repetition is warm-up; the other five contribute to
the summary. Each concurrent attempt books one ticket with a unique key.
Inventory is reconciled after every burst. Output asserts an empty outbox and
zero attempted Worker outbound requests.

Raw timings and summary CSV are written under ignored `load/results/local-*`.
The summary is the median of five per-burst p95 latencies, with min/max shown.
This measures booking functions, not end-to-end HTTP/authentication latency,
sustained throughput, production capacity, or duplicate-key retry correctness.
The old k6 sweep still targets deployed services: do not use it for offline work.
