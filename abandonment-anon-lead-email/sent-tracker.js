/**
 * sent-tracker.js
 *
 * Tracks which leads have already received the anon-lead email. Keyed by
 * lowercased email, not user id — these people have no account yet.
 * Uses Vercel KV in production (persistent across serverless restarts).
 * Falls back to an in-memory set locally / when KV env vars are absent.
 */

const KV_PREFIX = 'anon_lead_sent:';

// Detect whether Vercel KV is configured
function isKVAvailable() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
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
  return memorySet.has(emailLc);
}

async function markSent(emailLc, jobId) {
  if (isKVAvailable()) {
    // Store indefinitely — one send per lead, ever
    await getKV().set(`${KV_PREFIX}${emailLc}`, { jobId, sentAt: new Date().toISOString() });
  } else {
    memorySet.add(emailLc);
    console.log(`[sent-tracker] (in-memory) marked ${emailLc} as sent`);
  }
}

module.exports = { hasBeenSent, markSent };
