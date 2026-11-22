// Offline booking-function benchmark. Never reads Wrangler config or credentials.
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';

const args = process.argv.slice(2);
const eventCapacity = 10_000;
const [mode] = args;
const burstSize = /^--burst-[1-9]\d*$/.test(mode ?? '') ? Number(mode.slice('--burst-'.length)) : 0;
const burst = burstSize > 0 && burstSize <= eventCapacity;
const endurance = mode === '--10000';
const demo = mode === '--demo';
if (args.length > 1 || (args.length === 1 && !burst && !endurance && !demo)) {
  console.error(`Usage: node load/local-booking.mjs [--demo | --10000 | --burst-N] (N: 1–${eventCapacity})`);
  process.exit(2);
}

globalThis.fetch = () => { throw new Error('External fetch forbidden'); };
const bundled = await build({ entryPoints: ['load/local-booking-worker.mjs'], bundle: true, platform: 'neutral', format: 'esm', write: false });
let blocked = 0;
const mf = new Miniflare({
  modules: true,
  script: bundled.outputFiles[0].text,
  host: '127.0.0.1',
  d1Databases: ['DB'],
  outboundService: () => { blocked++; throw new Error('Outbound network forbidden'); },
});
const db = await mf.getD1Database('DB');
const rows = [];
const singleRun = endurance || burst;
const stages = burst ? [burstSize] : endurance ? [100] : demo ? [25, 50, 100] : [10,25,50,100,200,400,800];
const repetitions = singleRun ? 1 : demo ? 4 : 6;
const directory = `load/results/local-${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(directory,{recursive:true});
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1];

async function runLocalBookings(input) {
  const response = await mf.dispatchFetch('http://127.0.0.1/burst', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Local benchmark worker returned HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}
let progressWorker;
try {
  if (burst) console.log(`LOCAL BOOKING BURST | ${burstSize.toLocaleString('en-US')} attempts per version | baseline then optimized`);
  if (demo) console.log('LOCAL REHEARSAL | Booking functions and local D1 | 1 warm-up + 3 measured runs per version');
  // Apply the same schema to both paths to isolate their algorithmic difference.
  for (const file of (await readdir('migrations-production')).filter(f => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(`migrations-production/${file}`, 'utf8')).replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').filter(s => s.trim())) await db.prepare(statement).run();
  }
  await db.prepare("INSERT INTO users(clerk_id,email,role) VALUES ('local-organizer','organizer@example.invalid','ORGANIZER'),('local-customer','customer@example.invalid','CUSTOMER')").run();
  for (const concurrency of stages) {
    for (let repeat = 0; repeat < repetitions; repeat++) {
      for (const target of repeat % 2 ? ['optimized','baseline'] : ['baseline','optimized']) {
        const id = crypto.randomUUID();
        await db.prepare("INSERT INTO events(id,organizer_id,title,description,venue,starts_at,ends_at,capacity,price_minor,currency,status) VALUES (?,'local-organizer','Local benchmark','','Local','2099-01-01T00:00:00Z','2099-01-02T00:00:00Z',?,1000,'INR','PUBLISHED')").bind(id, eventCapacity).run();
        const attempts = endurance ? 10000 : concurrency;
        console.log(`Starting ${target}: ${attempts} attempts (${concurrency} concurrent launch limit)`);
        const counters = singleRun ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT) : undefined;
        const progress = counters ? new Int32Array(counters) : undefined;
        if (counters) {
          progressWorker = new Worker(new URL('./burst-progress.mjs', import.meta.url), {
            workerData: { target, attempts, startedAt: Date.now(), counters, interactive: Boolean(process.stdout.isTTY) },
          });
        }
        const { latencies, failures, duration, launchSpanMs } = await runLocalBookings({ target, eventId: id, attempts, concurrency });
        if (progress) Atomics.store(progress, 0, 1);
        const inventory = await db.prepare('SELECT tickets_sold, (SELECT COALESCE(SUM(quantity),0) FROM bookings WHERE event_id = ?) AS booked FROM events WHERE id = ?').bind(id,id).first();
        const inventoryPassed = inventory.tickets_sold === inventory.booked && inventory.booked === attempts-failures.length;
        const warmup = !singleRun && repeat === 0;
        const p95 = percentile(latencies, .95);
        rows.push({ target, concurrency, attempts, repeat, warmup, accepted: latencies.length, failures, p50: percentile(latencies,.5), p95, p99: percentile(latencies,.99), duration, launchSpanMs, inventory, inventoryPassed, latencies });
        await writeFile(`${directory}/checkpoint.json`, JSON.stringify({burst,rows},null,2));
        if (progressWorker) {
          await progressWorker.terminate();
          progressWorker = undefined;
          if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
        }
        const latency = p95 === undefined ? 'n/a' : `${p95.toFixed(2)} ms`;
        if (!burst) console.log(`${target} | ${concurrency} concurrent | ${warmup ? 'warm-up' : `run ${singleRun ? 1 : repeat}`} | accepted ${latencies.length}/${attempts} | failed ${failures.length} | p95 ${latency} | inventory ${inventoryPassed ? 'OK' : 'MISMATCH'}`);
      }
    }
    if (!burst) console.log(`Completed concurrency ${concurrency}, both paths`);
  }
  const outbox = await db.prepare('SELECT COUNT(*) AS count FROM outbox').first();
  if (outbox.count !== 0 || blocked !== 0) throw new Error('Isolation assertion failed');
  await writeFile(`${directory}/raw.json`, JSON.stringify({scope:'Local D1 booking functions inside Workerd; no deployed API, auth, queue or email', endurance, burst, blocked, outbox, rows},null,2));
  const summary = ['concurrency,target,median_p95_ms,min_p95_ms,max_p95_ms,accepted,failures'];
  for (const concurrency of stages) for (const target of ['baseline','optimized']) {
    const group = rows.filter(r => r.concurrency === concurrency && r.target === target && !r.warmup);
    const values = group.map(r => r.p95).filter(value => value !== undefined);
    const timings = values.length ? [percentile(values,.5), Math.min(...values), Math.max(...values)].map(value => value.toFixed(2)) : ['', '', ''];
    summary.push([concurrency,target,...timings,group.reduce((n,r)=>n+r.accepted,0),group.reduce((n,r)=>n+r.failures.length,0)].join(','));
  }
  await writeFile(`${directory}/summary.csv`,summary.join('\n'));
  if (burst) {
    console.log('\nRESULTS | # accepted, - failed');
    for (const row of rows) {
      const acceptedRatio = row.accepted / row.attempts;
      const filled = Math.round(acceptedRatio * 24);
      const bar = '#'.repeat(filled) + '-'.repeat(24 - filled);
      const latency = row.p95 === undefined ? 'n/a' : `${(row.p95 / 1000).toFixed(2)}s`;
      console.log(`${row.target.padEnd(9)} [${bar}] ${(acceptedRatio * 100).toFixed(1)}% accepted`);
      console.log(`          ${row.accepted}/${row.attempts} accepted | ${row.failures.length} failed | p95 ${latency} | ${(row.duration / 1000).toFixed(1)}s elapsed`);
      console.log(`          Inventory ${row.inventoryPassed ? 'OK' : 'MISMATCH'} | ${row.inventory.tickets_sold} sold | ${row.inventory.booked} booked`);
    }
  } else {
    console.log(summary.join('\n'));
  }
  console.log(`Results saved to ${directory}`);
} finally {
  await progressWorker?.terminate();
  await mf.dispose();
}
