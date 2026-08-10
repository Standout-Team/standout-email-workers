/**
 * sent-tracker.js
 *
 * Tracks which users have already received the abandonment email.
 * Uses Vercel KV in production (persistent across serverless restarts).
 * Falls back to an in-memory set locally / when KV env vars are absent.
 */

const KV_PREFIX = 'abandonment_resume_trigger_sent:'; // TEST variant — separate dedup namespace

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

async function hasBeenSent(userId) {
  if (isKVAvailable()) {
    const val = await getKV().get(`${KV_PREFIX}${userId}`);
    return val !== null;
  }
  return memorySet.has(userId);
}

async function markSent(userId, jobId) {
  if (isKVAvailable()) {
    // Store indefinitely — one send per user, ever
    await getKV().set(`${KV_PREFIX}${userId}`, { jobId, sentAt: new Date().toISOString() });
  } else {
    memorySet.add(userId);
    console.log(`[sent-tracker] (in-memory) marked ${userId} as sent`);
  }
}

module.exports = { hasBeenSent, markSent };
