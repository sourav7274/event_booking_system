// Offline stress test of the real Venueflow Worker (src/worker/index.ts) over HTTP.
// Fires N booking requests at the same instant against baseline, then against optimized.
// No Cloudflare, Clerk, Queue, or Resend calls: JWKS comes from a local key, other outbound fetches are blocked.
//
// A customer gives up after --timeout seconds (default 10): a later answer counts as dropped.
// Usage: node load/local-http.mjs [--users=1250] [--timeout=10]
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';

const opts = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const users = Number(opts.users ?? 1250);
const timeoutS = Number(opts.timeout ?? 10);
if (!Number.isInteger(users) || users < 1 || users > 10_000 || !(timeoutS > 0)) {
  console.error('Usage: node load/local-http.mjs [--users=1250] [--timeout=10]');
  process.exit(2);
}
const issuer = 'https://clerk.local.invalid';
const audience = 'venueflow';
const secret = 'local-benchmark-secret';
const CAP_MS = 120_000; // no answer within 2 minutes = dropped

const color = Boolean(process.stdout.isTTY || process.env.TERM) && !process.env.NO_COLOR;
const paint = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = paint('32'), red = paint('31'), dim = paint('2'), bold = paint('1');
const BAR = 40;
// Solid bar scaled to all customers; any non-zero count shows at least one block.
const bar = (n, total, paintFn = (x) => x) => {
  const w = n > 0 ? Math.max(1, Math.round((n / total) * BAR)) : 0;
  return paintFn('█'.repeat(w)) + ' '.repeat(BAR - w);
};

console.log('');
console.log(bold(`STRESS TEST: ${users.toLocaleString('en-US')} customers book at the same instant`));
console.log(dim(`Each customer waits up to ${timeoutS}s. Dropped = no booking confirmation within ${timeoutS}s.`));
console.log('');

const bundled = await build({
  entryPoints: ['src/worker/index.ts'], bundle: true, format: 'esm', platform: 'neutral', write: false,
  mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser', 'import'], logLevel: 'error',
});
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'local', alg: 'RS256', use: 'sig' }] };
// One distinct customer per request.
const tokens = await Promise.all(Array.from({ length: users }, (_, i) =>
  new SignJWT({ email: `customer${i}@example.invalid` }).setProtectedHeader({ alg: 'RS256', kid: 'local' })
    .setSubject(`local-customer-${i}`).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('2h').sign(privateKey)));

async function startWorker(target) {
  let blocked = 0;
  const mf = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2025-09-01', compatibilityFlags: ['nodejs_compat'],
    host: '127.0.0.1', port: 0, d1Databases: ['DB'],
    bindings: {
      APP_ENV: target === 'baseline' ? 'baseline' : 'production', APP_ORIGIN: 'http://127.0.0.1',
      CLERK_ISSUER: issuer, CLERK_AUDIENCE: audience, ORGANIZER_CLERK_IDS: '', EMAIL_FROM: 'local@example.invalid', BENCHMARK_SECRET: secret,
    },
    outboundService: (request) => {
      if (request.url === `${issuer}/.well-known/jwks.json`) return Response.json(jwks);
      blocked++;
      return new Response('Outbound network forbidden', { status: 599 });
    },
  });
  const url = await mf.ready;
  const db = await mf.getD1Database('DB');
  // Each version gets its own deployed schema.
  const dir = target === 'baseline' ? 'migrations' : 'migrations-production';
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(`${dir}/${file}`, 'utf8')).replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').filter((s) => s.trim())) await db.prepare(statement).run();
  }
  return { mf, db, base: url.origin, blocked: () => blocked };
}

async function newEvent(base) {
  const res = await fetch(`${base}/internal/benchmark/reset`, { method: 'POST', headers: { 'X-Benchmark-Secret': secret } });
  if (res.status !== 201) throw new Error(`event setup failed: ${res.status} ${await res.text()}`);
  return (await res.json()).data.eventId;
}

async function book(base, eventId, i) {
  const started = performance.now();
  try {
    const res = await fetch(`${base}/api/v1/events/${eventId}/bookings`, {
      method: 'POST', signal: AbortSignal.timeout(CAP_MS),
      headers: { Authorization: `Bearer ${tokens[i]}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID(), 'X-Benchmark-Secret': secret },
      body: JSON.stringify({ quantity: 1 }),
    });
    await res.text();
    const ms = performance.now() - started;
    if (ms > timeoutS * 1000) return { status: 'no answer', ms };
    return { status: res.status, ms };
  } catch (error) {
    return { status: error?.name === 'TimeoutError' ? 'no answer' : 'reset', ms: performance.now() - started };
  }
}

const rows = [];
for (const target of ['baseline', 'optimized']) {
  const worker = await startWorker(target);
  try {
    // Warm-up so startup cost is not measured.
    const warm = await newEvent(worker.base);
    await Promise.all(Array.from({ length: Math.min(users, 50) }, (_, i) => book(worker.base, warm, i)));

    const eventId = await newEvent(worker.base);
    console.log(bold(target.toUpperCase()));
    const live = { booked: 0, dropped: 0 };
    const t0 = Date.now();
    const draw = () => {
      const elapsed = (Date.now() - t0) / 1000;
      const pastDeadline = elapsed > timeoutS;
      const waiting = users - live.booked - live.dropped;
      // Past the deadline, anyone still waiting has already given up.
      const gaveUp = live.dropped + (pastDeadline ? waiting : 0);
      const left = pastDeadline ? 0 : waiting;
      process.stdout.write(`\r\x1b[2K  ${dim('waiting')}  ${bar(left, users)}  ${String(left).padStart(5)} left   ${green(`${live.booked} booked`)}   ${red(`${gaveUp} dropped`)}   ${dim(`${Math.floor(elapsed)}s / ${timeoutS}s limit`)}`);
    };
    const ticker = color ? (draw(), setInterval(draw, 200)) : undefined;
    const results = await Promise.all(Array.from({ length: users }, (_, i) => book(worker.base, eventId, i).then((r) => {
      if (r.status === 201) live.booked++; else live.dropped++;
      return r;
    })));
    if (ticker) { clearInterval(ticker); process.stdout.write('\r\x1b[2K'); }

    const booked = results.filter((r) => r.status === 201);
    const dropped = results.filter((r) => r.status === 'reset' || r.status === 'no answer' || r.status >= 500).length;
    const rejected = users - booked.length - dropped;
    const times = booked.map((r) => r.ms).sort((a, b) => a - b);
    const p95 = times.length ? times[Math.ceil(times.length * 0.95) - 1] : undefined;
    // Wait for any in-flight work, then confirm no ticket was oversold or lost.
    let inv; let previous = -1;
    for (let k = 0; k < 120; k++) {
      inv = await worker.db.prepare('SELECT tickets_sold, (SELECT COUNT(*) FROM bookings WHERE event_id = ?) AS stored FROM events WHERE id = ?').bind(eventId, eventId).first();
      if (inv.stored === previous) break;
      previous = inv.stored; await new Promise((r) => setTimeout(r, 300));
    }
    if (worker.blocked() !== 0) throw new Error(`Isolation failed: ${worker.blocked()} outbound requests attempted`);

    const pct = Math.round((dropped / users) * 100);
    const p95Text = p95 === undefined ? '' : dim(`   slowest 5% waited ${(p95 / 1000).toFixed(1)}s+`);
    console.log(`  ${'booked'.padEnd(7)}  ${bar(booked.length, users, green)}  ${String(booked.length).padStart(5)}${p95Text}`);
    console.log(`  ${'dropped'.padEnd(7)}  ${bar(dropped, users, red)}  ${String(dropped).padStart(5)}   ${dropped === 0 ? green('✓ all served') : red(bold(`✗ ${pct}% DROPPED`))}`);
    console.log('');
    if (rejected) console.log(dim(`           ${rejected} rejected (4xx)`));
    if (inv.tickets_sold !== inv.stored) console.log(red(`           INVENTORY MISMATCH: ${inv.tickets_sold} sold vs ${inv.stored} stored`));
    rows.push({ target, users, booked: booked.length, dropped, rejected, p95, ticketsSold: inv.tickets_sold, stored: inv.stored });
  } finally {
    await worker.mf.dispose();
  }
}

const directory = 'load/results';
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/http-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(rows, null, 2));
console.log('');
