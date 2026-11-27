import { availableParallelism } from 'node:os';

const cpus = availableParallelism();
export const TEST_CONCURRENCY = Math.max(2, Math.min(cpus, 6));
export const SPAWN_CONCURRENCY = Math.max(4, Math.min(cpus, 8));

let active = 0;
const queue = [];

export function limitSpawn(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        active--;
        if (queue.length > 0) queue.shift()();
      });
    };
    if (active < SPAWN_CONCURRENCY) run();
    else queue.push(run);
  });
}

export async function mapPool(items, fn, limit = SPAWN_CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
