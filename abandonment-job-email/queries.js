/**
 * abandonment-job-email/queries.js — all Supabase reads for email 1.
 */

const { getSupabase } = require('../lib/supabase');
const {
  PROFILE_COLUMNS,
  filterSendable,
  fetchNewestSurveyIds,
} = require('../lib/eligibility');
const { mapWithConcurrency, chunk, RPC_CONCURRENCY } = require('../lib/concurrency');

const ONE_HOUR_MS = 60 * 60 * 1000;
const FRESH_DAYS = 3;

// Age band. The old query used a moving 1–2h window, which meant a single
// failed/slow/skipped run dropped that hour's cohort on the floor forever, and
// a schedule change silently double-sent. State now lives in
// profiles.abandonment_email_1_sent_at, so eligibility is "old enough, not yet
// sent" and a missed run simply catches up on the next one.
const MIN_AGE_MS = 1 * ONE_HOUR_MS;
// Backstop so the FIRST deploy of the state-based query doesn't mail the entire
// historical backlog of never-emailed users.
const MAX_AGE_MS = 24 * ONE_HOUR_MS;

const JOB_COLUMNS =
  'id, title, company, location, salary_min, salary_max, work_type, source_url, description, role_category, first_seen_at, last_seen_at, ats_provider';

/**
 * Users who signed up 1–24h ago, have a parsed resume, have not been sent
 * email 1, and pass the shared billing/suppression exclusions.
 */
async function findEligibleUsers() {
  const supabase = getSupabase();
  const now = Date.now();
  const notBefore = new Date(now - MAX_AGE_MS).toISOString();
  const notAfter = new Date(now - MIN_AGE_MS).toISOString();

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .is('abandonment_email_1_sent_at', null)
    .not('resume_parsed', 'is', null)
    .not('email', 'is', null)
    .gte('created_at', notBefore)
    .lte('created_at', notAfter);

  if (error) throw new Error(`profiles query failed: ${error.message}`);

  const { users } = await filterSendable(supabase, profiles || [], 'abandonment-job-email');
  return users;
}

/**
 * Best fresh job per user via the production match_jobs_for_survey() RPC — the
 * same HNSW vector search + structured boosts that powers the in-app feed.
 *
 * 1. one query for every user's newest EMBEDDED survey
 * 2. the RPC per user, capped at RPC_CONCURRENCY (was an unbounded Promise.all
 *    against prod Postgres)
 * 3. ONE batched job fetch for every top match (was a `.single()` per user)
 *
 * Returns Map<userId, job>. Never throws for a single user — an RPC or fetch
 * failure drops that user from the map and the run continues.
 */
async function findBestJobsForUsers(users) {
  const supabase = getSupabase();
  const bestByUser = new Map();
  if (!users || users.length === 0) return bestByUser;

  const surveyByUser = await fetchNewestSurveyIds(supabase, users.map((u) => u.id));

  // Step 1: score every user (bounded concurrency).
  const scored = await mapWithConcurrency(users, RPC_CONCURRENCY, async (user) => {
    const surveyId = surveyByUser.get(user.id);
    if (!surveyId) {
      console.log(`[queries] No embedded survey for user ${user.id} — skipping.`);
      return null;
    }

    const { data: matches, error: rpcError } = await supabase.rpc('match_jobs_for_survey', {
      p_survey_id: surveyId,
      p_limit: 10,
      p_fresh_days: FRESH_DAYS,
    });

    if (rpcError) {
      console.error(`[queries] match_jobs_for_survey failed for user ${user.id}: ${rpcError.message}`);
      return null;
    }
    if (!matches || matches.length === 0) {
      console.log(`[queries] No fresh matches for user ${user.id} — skipping.`);
      return null;
    }

    // RPC returns results ordered by total_score DESC — top result is best.
    return { userId: user.id, top: matches[0] };
  });

  const hits = scored.filter(Boolean);
  if (hits.length === 0) return bestByUser;

  // Step 2: one batched fetch for every distinct top-match job.
  const jobIds = [...new Set(hits.map((h) => h.top.job_id))];
  const jobById = new Map();
  for (const part of chunk(jobIds, 200)) {
    const { data: jobRows, error: jobError } = await supabase
      .from('jobs')
      .select(JOB_COLUMNS)
      .in('id', part);
    if (jobError) throw new Error(`jobs query failed: ${jobError.message}`);
    for (const row of jobRows || []) jobById.set(row.id, row);
  }

  // Step 3: per-user freshness double-check + visible match %.
  for (const { userId, top } of hits) {
    const job = jobById.get(top.job_id);
    if (!job) {
      console.error(`[queries] job ${top.job_id} not found for user ${userId} — skipping.`);
      continue;
    }

    // Belt-and-suspenders on top of the RPC's p_fresh_days.
    const ageDays = (Date.now() - new Date(job.last_seen_at).getTime()) / (24 * 60 * 60 * 1000);
    if (!Number.isFinite(ageDays) || ageDays > FRESH_DAYS) {
      console.log(`[queries] Top match for user ${userId} is ${Math.round(ageDays)}d old — skipping.`);
      continue;
    }

    // Same visible-match formula as the production app.
    const pct = Math.max(70, Math.min(98, Math.round(70 + top.total_score * 28)));

    bestByUser.set(userId, { ...job, pct, rank: 0, total_score: top.total_score });
  }

  return bestByUser;
}

module.exports = { findEligibleUsers, findBestJobsForUsers, FRESH_DAYS, MIN_AGE_MS, MAX_AGE_MS };
