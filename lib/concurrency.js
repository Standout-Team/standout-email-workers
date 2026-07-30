/**
 * lib/concurrency.js
 *
 * Bounded parallel map, no dependencies.
 *
 * Both workers previously did `await Promise.all(users.map(...))` where each
 * task called match_jobs_for_survey() — an HNSW vector search over the jobs
 * table. An hour with 200 signups fired 200 concurrent vector searches at prod
 * Postgres from a cron nobody is watching. The product caps the same RPC at 4
 * (RPC_CONCURRENCY in server/inngest/functions/match-queue-build.ts); we match
 * that number deliberately.
 *
 * Results are returned positionally, like Array.prototype.map. A rejection from
 * `fn` propagates and aborts the remaining work, so callers that want
 * per-item resilience must catch inside `fn` — both workers do.
 */

const RPC_CONCURRENCY = 4;

async function mapWithConcurrency(items, limit, fn) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  if (list.length === 0) return results;

  const workers = Math.max(1, Math.min(Math.floor(Number(limit)) || 1, list.length));
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      results[index] = await fn(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

// Split an array into fixed-size chunks — used to keep `.in(...)` filters
// (which PostgREST serializes into the query string) off the URL length limit.
function chunk(items, size) {
  const list = Array.from(items || []);
  const step = Math.max(1, Math.floor(Number(size)) || 1);
  const out = [];
  for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
  return out;
}

module.exports = { mapWithConcurrency, chunk, RPC_CONCURRENCY };
