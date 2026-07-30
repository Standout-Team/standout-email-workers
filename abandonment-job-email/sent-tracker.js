/**
 * sent-tracker.js — LEGACY. Retained ONLY as a transition guard.
 *
 * Dedup now lives in Postgres (profiles.abandonment_email_1_sent_at, claimed
 * atomically — see lib/claims.js). This Vercel-KV tracker exists solely so
 * that users who were emailed BEFORE those columns existed don't get a second
 * copy of email 1 on the first post-deploy run. Worker 1 checks it, back-fills
 * the DB column from it, and never writes to it.
 *
 * Safe to delete (along with KV_REST_API_URL / KV_REST_API_TOKEN and the
 * isKVConfigured() branch in abandonment-job-email/index.js) after ~2026-08-01,
 * by which point every KV-tracked user is >24h past the email-1 window.
 *
 * FAIL CLOSED: in-memory fallback is allowed only in dry-run/local. On Vercel
 * every invocation is a fresh process, so an in-memory Set is a dedup no-op —
 * it silently promised protection it could not deliver. If KV is unavailable
 * during a live run we now throw instead of pretending.
 */

const { isDryRun } = require('../lib/dry-run');

const KV_PREFIX = 'abandonment_sent:';

// In-memory fallback for local dry runs. A Map (not a Set) so getSentJobId()
// can actually return something — that was part of the original bug.
const memory = new Map();

function isKVConfigured() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// Lazy require so local/dry runs don't need @vercel/kv resolvable.
function getKV() {
  const { kv } = require('@vercel/kv');
  return kv;
}

// Throws unless we have real persistence, or we're in a dry run where the
// in-memory Map is honest about what it is.
function assertUsable(op) {
  if (isKVConfigured()) return true;
  if (isDryRun()) return false;
  throw new Error(
    `[sent-tracker] ${op}: KV is not configured and DRY_RUN is false. ` +
      'In-memory dedup is a no-op on serverless — refusing to run. ' +
      'Set KV_REST_API_URL + KV_REST_API_TOKEN, or remove the legacy transition guard.'
  );
}

async function hasBeenSent(userId) {
  if (assertUsable('hasBeenSent')) {
    const val = await getKV().get(`${KV_PREFIX}${userId}`);
    return val !== null && val !== undefined;
  }
  return memory.has(userId);
}

/**
 * The record stored by markSent is `{ jobId, sentAt }`. This getter is what
 * abandonment-job-email-2 called and what never existed — email 2 threw
 * "sentTracker.getSentJobId is not a function" on every user, every run, since
 * the day it shipped. Email 2 now reads profiles.abandonment_email_1_job_id
 * instead; this remains for the worker-1 transition back-fill.
 */
async function getSentJobId(userId) {
  if (assertUsable('getSentJobId')) {
    const val = await getKV().get(`${KV_PREFIX}${userId}`);
    if (!val) return null;
    if (typeof val === 'object' && val.jobId != null) return val.jobId;
    return null;
  }
  const record = memory.get(userId);
  return record && record.jobId != null ? record.jobId : null;
}

async function markSent(userId, jobId) {
  if (assertUsable('markSent')) {
    // Store indefinitely — one send per user, ever.
    await getKV().set(`${KV_PREFIX}${userId}`, { jobId, sentAt: new Date().toISOString() });
    return;
  }
  memory.set(userId, { jobId, sentAt: new Date().toISOString() });
  console.log(`[sent-tracker] (in-memory, dry-run) marked user ${userId} as sent`);
}

// Test seam — drops the in-memory map between cases.
function _resetMemory() {
  memory.clear();
}

module.exports = { hasBeenSent, markSent, getSentJobId, isKVConfigured, _resetMemory };
