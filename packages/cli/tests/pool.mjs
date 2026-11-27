import { availableParallelism } from 'node:os';

const cpus = availableParallelism();
export const TEST_CONCURRENCY = cpus <= 4 ? 2 : Math.min(cpus, 6);
export const SPAWN_CONCURRENCY = cpus <= 4 ? 3 : Math.min(cpus, 8);

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
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  const rejected = settled.find((entry) => entry.status === 'rejected');
  if (rejected) throw rejected.reason;
  return results;
}
