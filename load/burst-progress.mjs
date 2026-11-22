import { writeSync } from 'node:fs';
import { workerData } from 'node:worker_threads';

const { target, attempts, startedAt, counters, interactive } = workerData;
const counts = new Int32Array(counters);

function render() {
  const settled = Atomics.load(counts, 1);
  const launched = Math.max(settled, Atomics.load(counts, 0));
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const filled = Math.floor(settled * 10 / attempts);
  const bar = '#'.repeat(filled) + '-'.repeat(10 - filled);
  const phase = Atomics.load(counts, 2) === 1 ? 'inventory' : launched < attempts ? 'launching' : 'waiting';
  const line = `${target} [${bar}] ${settled}/${attempts} done | ${launched} launched | ${elapsed}s | ${phase}`;

  // Write directly to the terminal while the benchmark's main thread launches calls.
  writeSync(1, interactive ? `\r\x1b[2K${line}` : `${line}\n`);
}

render();
setInterval(render, 1000);
