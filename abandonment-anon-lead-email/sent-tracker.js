/**
 * sent-tracker.js
 *
 * Tracks which leads have already received the anon-lead email. Keyed by
 * lowercased email, not user id — these people have no account yet.
 * Uses Vercel KV in production (persistent across serverless restarts).
 * Falls back to an in-memory set locally / when KV env vars are absent.
 *
 * That fallback is per-process and therefore NON-DURABLE: on Vercel every
 * instance and every cold start starts with an empty Set, so dedup silently
 * stops working and the same leads are re-mailed on every run. `isDurable()`
 * is what lets the caller refuse to send for real in that state — see
 * `evaluateDedupSafety` in queries.js and the guard at the top of run().
 */

const KV_PREFIX = 'anon_lead_sent:';

// Every in-memory log line carries this, so "dedup was off" is greppable
// instead of being a lowercase aside.
const MEMORY_TAG = '[sent-tracker] (in-memory, NON-DURABLE)';

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

// In-memory fallback for local dry runs
const memorySet = new Set();

async function hasBeenSent(emailLc) {
  if (isKVAvailable()) {
    const val = await getKV().get(`${KV_PREFIX}${emailLc}`);
    return val !== null;
  }

  // Only hits are logged — a miss is every lead in the cohort, and a hit is the
  // one case where the non-durable store actually changed a decision.
  const hit = memorySet.has(emailLc);
  if (hit) {
    console.log(`${MEMORY_TAG} ${emailLc} was already mailed by THIS process — a restart forgets it`);
  }
  return hit;
}

async function markSent(emailLc, jobId) {
  if (isKVAvailable()) {
    // Store indefinitely — one send per lead, ever
    await getKV().set(`${KV_PREFIX}${emailLc}`, { jobId, sentAt: new Date().toISOString() });
    return;
  }

  memorySet.add(emailLc);
  console.log(`${MEMORY_TAG} marked ${emailLc} as sent — NOT persisted; a restart re-mails them`);
}

module.exports = { hasBeenSent, markSent, isDurable };
