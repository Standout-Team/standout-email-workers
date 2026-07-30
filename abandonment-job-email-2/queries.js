/**
 * abandonment-job-email-2/queries.js — all Supabase reads for email 2.
 */

const { getSupabase } = require('../lib/supabase');
const { PROFILE_COLUMNS, filterSendable, fetchNewestSurveyIds } = require('../lib/eligibility');
const { mapWithConcurrency, chunk, RPC_CONCURRENCY } = require('../lib/concurrency');

const ONE_HOUR_MS = 60 * 60 * 1000;

// Email 2 lands 24h after email 1 actually went out — not 25h after signup.
// Anchoring on the send marker instead of created_at means a user whose email 1
// was delayed still gets a 24h gap rather than a 20-minute one.
const MIN_GAP_MS = 24 * ONE_HOUR_MS;
// Backstop, same reasoning as worker 1: don't mail the historical backlog on
// first deploy.
const MAX_AGE_MS = 96 * ONE_HOUR_MS;

// The product's sendable-job window. Was 30, which overstated the count
// relative to what the dashboard actually shows when they click through.
const COUNT_FRESH_DAYS = 21;
const COUNT_LIMIT = 20;

const JOB_COLUMNS =
  'id, title, company, location, salary_min, salary_max, work_type, source_url, role_category, first_seen_at, last_seen_at';

/**
 * Users who were sent email 1 at least 24h ago, have not been sent email 2,
 * signed up within the last 96h, and pass the shared exclusions.
 */
async function findEligibleUsers() {
  const supabase = getSupabase();
  const now = Date.now();
  const sentBefore = new Date(now - MIN_GAP_MS).toISOString();
  const createdAfter = new Date(now - MAX_AGE_MS).toISOString();

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .not('abandonment_email_1_sent_at', 'is', null)
    .lte('abandonment_email_1_sent_at', sentBefore)
    .is('abandonment_email_2_sent_at', null)
    .gte('created_at', createdAfter)
    .not('resume_parsed', 'is', null)
    .not('email', 'is', null);

  if (error) throw new Error(`profiles query failed: ${error.message}`);

  const { users } = await filterSendable(supabase, profiles || [], 'abandonment-job-email-2');
  return users;
}

/**
 * For each user: the job featured in email 1 (from
 * profiles.abandonment_email_1_job_id — no KV dependency, which is what used to
 * make this whole worker throw) plus a live match count.
 *
 * Jobs are fetched in ONE batched query; the RPC fan-out is bounded.
 * Returns Map<userId, { job, matchCount }>.
 */
async function findJobsAndMatchCounts(users) {
  const result = new Map();
  if (!users || users.length === 0) return result;

  const supabase = getSupabase();

  // Step 1: one batched fetch for every distinct email-1 job.
  const jobIds = [
    ...new Set(users.map((u) => u.abandonment_email_1_job_id).filter((id) => id != null)),
  ];
  const jobById = new Map();
  for (const part of chunk(jobIds, 200)) {
    const { data, error } = await supabase.from('jobs').select(JOB_COLUMNS).in('id', part);
    if (error) throw new Error(`jobs query failed: ${error.message}`);
    for (const row of data || []) jobById.set(row.id, row);
  }

  // Step 2: match counts, bounded concurrency (match_jobs_for_survey is an
  // HNSW vector search — an unbounded fan-out here hit prod Postgres).
  const surveyByUser = await fetchNewestSurveyIds(supabase, users.map((u) => u.id));

  const rows = await mapWithConcurrency(users, RPC_CONCURRENCY, async (user) => {
    const jobId = user.abandonment_email_1_job_id;
    if (jobId == null) {
      console.log(`[email2/queries] No email-1 job id for user ${user.id} — skipping.`);
      return null;
    }
    const job = jobById.get(jobId);
    if (!job) {
      console.log(`[email2/queries] Job ${jobId} not found for user ${user.id} — skipping.`);
      return null;
    }

    let matchCount = 0;
    const surveyId = surveyByUser.get(user.id);
    if (surveyId) {
      const { data: matches, error: rpcError } = await supabase.rpc('match_jobs_for_survey', {
        p_survey_id: surveyId,
        p_limit: COUNT_LIMIT,
        p_fresh_days: COUNT_FRESH_DAYS,
      });
      if (rpcError) {
        console.error(`[email2/queries] match count failed for user ${user.id}: ${rpcError.message}`);
      } else {
        matchCount = (matches || []).length;
      }
    }

    return { userId: user.id, job, matchCount };
  });

  for (const row of rows) {
    if (row) result.set(row.userId, { job: row.job, matchCount: row.matchCount });
  }

  return result;
}

module.exports = {
  findEligibleUsers,
  findJobsAndMatchCounts,
  MIN_GAP_MS,
  MAX_AGE_MS,
  COUNT_FRESH_DAYS,
};
