import { writeSync } from 'node:fs';
import { workerData } from 'node:worker_threads';

const { target, attempts, startedAt, counters, interactive } = workerData;
const counts = new Int32Array(counters);

function render() {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const checkingInventory = Atomics.load(counts, 0) === 1;
  const position = elapsed % 10;
  const bar = checkingInventory ? '##########' : '-'.repeat(position) + '>' + '-'.repeat(9 - position);
  const phase = checkingInventory ? 'checking inventory' : `running ${attempts} attempts`;
  const line = `${target} [${bar}] ${elapsed}s | ${phase}`;

  // Write directly so the terminal receives a heartbeat throughout the run.
  writeSync(1, interactive ? `\r\x1b[2K${line}` : `${line}\n`);
}

render();
setInterval(render, 1000);
