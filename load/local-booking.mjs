// Offline booking-function benchmark. Never reads Wrangler config or credentials.
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

globalThis.fetch = () => { throw new Error('External fetch forbidden'); };
const bundled = await build({ entryPoints: ['src/worker/db.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { createBaselineBooking, createOptimizedBooking } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
let blocked = 0;
const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("local only")}}', d1Databases: ['DB'], outboundService: () => { blocked++; throw new Error('Outbound network forbidden'); } });
const db = await mf.getD1Database('DB');
const rows = [];
const endurance = process.argv.includes('--10000');
const burst = process.argv.includes('--burst-10000');
const demo = process.argv.includes('--demo');
const singleRun = endurance || burst;
const stages = burst ? [10000] : endurance ? [100] : demo ? [25, 50, 100] : [10,25,50,100,200,400,800];
const repetitions = singleRun ? 1 : demo ? 4 : 6;
const directory = `load/results/local-${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(directory,{recursive:true});
const customer = { clerkId: 'local-customer', email: 'customer@example.invalid', role: 'CUSTOMER' };
const env = { DB: db, JOBS: { send() { throw new Error('Queue forbidden'); } } };
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1];
let progressWorker;
try {
  if (demo && singleRun) throw new Error('--demo cannot be combined with a 10,000-attempt mode');
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
        await db.prepare("INSERT INTO events(id,organizer_id,title,description,venue,starts_at,ends_at,capacity,price_minor,currency,status) VALUES (?,'local-organizer','Local benchmark','','Local','2099-01-01T00:00:00Z','2099-01-02T00:00:00Z',10000,1000,'INR','PUBLISHED')").bind(id).run();
        const fn = target === 'baseline' ? createBaselineBooking : createOptimizedBooking;
        const latencies = [];
        let launchSpanMs = 0;
        const attempts = endurance ? 10000 : concurrency;
        console.log(`Starting ${target}: ${attempts} attempts (${concurrency} concurrent launch limit)`);
        const counters = burst ? new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT) : undefined;
        const progress = counters ? new Int32Array(counters) : undefined;
        if (counters) {
          progressWorker = new Worker(new URL('./burst-progress.mjs', import.meta.url), {
            workerData: { target, attempts, startedAt: Date.now(), counters, interactive: Boolean(process.stdout.isTTY) },
          });
        }
        const start = performance.now();
        const results = [];
        for (let offset = 0; offset < attempts; offset += concurrency) {
        results.push(...await Promise.allSettled(Array.from({length: Math.min(concurrency, attempts-offset)}, async () => {
          const t = performance.now();
          launchSpanMs = t-start;
          if (progress) Atomics.add(progress, 0, 1);
          try {
            await fn(env, customer, id, 1, crypto.randomUUID(), true);
            latencies.push(performance.now()-t);
          } finally {
            if (progress) Atomics.add(progress, 1, 1);
          }
        })));
        if (endurance && (offset + concurrency) % 1000 === 0) console.log(`${target}: ${offset + concurrency}/${attempts} attempts settled`);
        }
        const duration = performance.now()-start;
        if (progress) Atomics.store(progress, 2, 1);
        const inventory = await db.prepare('SELECT tickets_sold, (SELECT COALESCE(SUM(quantity),0) FROM bookings WHERE event_id = ?) AS booked FROM events WHERE id = ?').bind(id,id).first();
        const failures = results.filter(r => r.status === 'rejected').map(r => ({message: String(r.reason), cause: String(r.reason?.cause ?? '')}));
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
        console.log(`${target} | ${concurrency} concurrent | ${warmup ? 'warm-up' : `run ${singleRun ? 1 : repeat}`} | accepted ${latencies.length}/${attempts} | failed ${failures.length} | p95 ${latency} | inventory ${inventoryPassed ? 'OK' : 'MISMATCH'}${burst ? ` | ${Math.floor(duration / 1000)}s elapsed` : ''}`);
      }
    }
    console.log(`Completed concurrency ${concurrency}, both paths`);
  }
  const outbox = await db.prepare('SELECT COUNT(*) AS count FROM outbox').first();
  if (outbox.count !== 0 || blocked !== 0) throw new Error('Isolation assertion failed');
  await writeFile(`${directory}/raw.json`, JSON.stringify({scope:'Local D1 booking functions, no HTTP/auth/queue/email', endurance, burst, blocked, outbox, rows},null,2));
  const summary = ['concurrency,target,median_p95_ms,min_p95_ms,max_p95_ms,accepted,failures'];
  for (const concurrency of stages) for (const target of ['baseline','optimized']) {
    const group = rows.filter(r => r.concurrency === concurrency && r.target === target && !r.warmup);
    const values = group.map(r => r.p95).filter(value => value !== undefined);
    const timings = values.length ? [percentile(values,.5), Math.min(...values), Math.max(...values)].map(value => value.toFixed(2)) : ['', '', ''];
    summary.push([concurrency,target,...timings,group.reduce((n,r)=>n+r.accepted,0),group.reduce((n,r)=>n+r.failures.length,0)].join(','));
  }
  await writeFile(`${directory}/summary.csv`,summary.join('\n'));
  console.log(summary.join('\n')); console.log(directory);
} finally {
  await progressWorker?.terminate();
  await mf.dispose();
}
