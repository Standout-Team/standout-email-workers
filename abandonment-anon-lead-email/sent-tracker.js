/**
 * sent-tracker.js
 *
 * Tracks which leads have already received which email in the abandonment
 * sequence. Keyed by lowercased email, not user id — these people have no
 * account yet — and namespaced per stage, so Email 2 never reads Email 1's
 * receipt. Uses Vercel KV in production (persistent across serverless
 * restarts). Falls back to an in-memory set locally / when KV env vars are
 * absent.
 *
 * That fallback is per-process and therefore NON-DURABLE: on Vercel every
 * instance and every cold start starts with an empty Set, so dedup silently
 * stops working and the same leads are re-mailed on every run. `isDurable()`
 * is what lets the caller refuse to send for real in that state — see
 * `evaluateDedupSafety` in queries.js and the guard at the top of run().
 *
 * TWO NAMESPACE RULES, both load-bearing:
 *
 *   1. Stage `first` keeps the bare `anon_lead_sent:` prefix it has used since
 *      launch (see stages.js). With KV_ENV_PREFIX unset, the keys this module
 *      writes are byte-identical to the ones already in production KV.
 *
 *   2. KV_ENV_PREFIX namespaces the entire keyspace per environment. Leave it
 *      unset in production. SET IT IN STAGING: without it a staging run writes
 *      into production's keyspace, marks real leads as sent, and silently
 *      suppresses the production email they were owed. Nothing downstream
 *      would report that — the lead simply never hears from us again.
 */

const { DEFAULT_STAGE, resolveStage } = require('./stages');

// Every in-memory log line carries this, so "dedup was off" is greppable
// instead of being a lowercase aside.
const MEMORY_TAG = '[sent-tracker] (in-memory, NON-DURABLE)';

/**
 * Environment namespace, read at call time so dotenv and tests can set it
 * after this module has loaded. Empty in production by design.
 */
function envPrefix() {
  const raw = String(process.env.KV_ENV_PREFIX || '').trim();
  return raw ? `${raw}:` : '';
}

/**
 * The full KV key for one lead at one stage. Exported for tests, which assert
 * the production key is unchanged — that assertion is the guard rail against
 * anyone "tidying" the prefix and re-mailing the whole history.
 */
function kvKeyFor(emailLc, stage = DEFAULT_STAGE) {
  return `${envPrefix()}${resolveStage(stage).kvKey}:${emailLc}`;
}

// Detect whether Vercel KV is configured
function isKVAvailable() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

/**
 * Does dedup state survive this process? Only Vercel KV does. Read at call
 * time rather than at import time, so dotenv (and tests) can set the env after
 * this module has loaded.
 */
function isDurable() {
  return isKVAvailable();
}

// Lazy-load @vercel/kv only when available to avoid import errors locally
function getKV() {
  const { kv } = require('@vercel/kv');
  return kv;
}

// In-memory fallback for local dry runs. Holds full composed keys, so it is
// stage-aware and environment-aware exactly like the KV path.
const memorySet = new Set();

async function hasBeenSent(emailLc, stage = DEFAULT_STAGE) {
  const key = kvKeyFor(emailLc, stage);

  if (isKVAvailable()) {
    const val = await getKV().get(key);
    return val !== null;
  }

  // Only hits are logged — a miss is every lead in the cohort, and a hit is the
  // one case where the non-durable store actually changed a decision.
  const hit = memorySet.has(key);
  if (hit) {
    console.log(`${MEMORY_TAG} ${emailLc} was already mailed by THIS process — a restart forgets it`);
  }
  return hit;
}

/**
 * Records the send. `jobId` is not bookkeeping: Email 2 reads back the job
 * Email 1 featured so it can show a different one, so this value is a real
 * input to a later stage rather than a debugging aid.
 */
async function markSent(emailLc, jobId, stage = DEFAULT_STAGE) {
  const key = kvKeyFor(emailLc, stage);

  if (isKVAvailable()) {
    // Store indefinitely — one send per lead per stage, ever.
    await getKV().set(key, { jobId, sentAt: new Date().toISOString() });
    return;
  }

  memorySet.add(key);
  console.log(`${MEMORY_TAG} marked ${emailLc} as sent — NOT persisted; a restart re-mails them`);
}

/**
 * The receipt from an earlier stage, or null. Email 2 uses this to exclude the
 * job Email 1 already featured. Returns null rather than throwing when the
 * receipt is missing or shaped unexpectedly — a lead whose earlier job we
 * cannot recover should still get their email, just without the exclusion.
 */
async function getSendRecord(emailLc, stage = DEFAULT_STAGE) {
  if (!isKVAvailable()) return null;
  try {
    const val = await getKV().get(kvKeyFor(emailLc, stage));
    return val && typeof val === 'object' ? val : null;
  } catch (err) {
    console.warn(
      `[sent-tracker] could not read ${resolveStage(stage).id} receipt for ${emailLc}: ${err.message}`
    );
    return null;
  }
}

module.exports = { hasBeenSent, markSent, getSendRecord, isDurable, kvKeyFor };
