const { createClient } = require('@supabase/supabase-js');

const ONE_HOUR_MS = 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const PAID_STATUSES = ['active', 'trialing'];

let _client = null;

function getSupabase() {
  if (_client) return _client;
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.');
  }
  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  return _client;
}

function isPaid(subscriptionStatus) {
  return subscriptionStatus != null && PAID_STATUSES.includes(subscriptionStatus);
}

/**
 * Find free users who:
 * 1. Have a parsed resume (resume_parsed IS NOT NULL)
 * 2. Uploaded their resume between 1–2 hours ago (resume_uploaded_at)
 * 3. Have no active subscription
 *
 * Uses resume_uploaded_at as the trigger — fires 1hr after the upload event
 * regardless of when (or whether) the user created an account. This captures
 * the full resume-upload cohort, not just signed-up users.
 *
 * TEST VARIANT — compares against created_at-based production worker.
 */
async function findEligibleUsers() {
  const supabase = getSupabase();

  const windowStart = new Date(Date.now() - 2 * ONE_HOUR_MS).toISOString(); // 2 hours ago
  const windowEnd   = new Date(Date.now() - ONE_HOUR_MS).toISOString();     // 1 hour ago

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, email, resume_parsed, subscription_status, resume_uploaded_at')
    .not('resume_parsed', 'is', null)
    .not('resume_uploaded_at', 'is', null)
    .gte('resume_uploaded_at', windowStart)
    .lte('resume_uploaded_at', windowEnd);

  if (error) throw new Error(`profiles query failed: ${error.message}`);

  return (profiles || [])
    .filter((p) => !isPaid(p.subscription_status) && p.email)
    .map((p) => ({
      id: p.id,
      email: p.email,
      resume_parsed: p.resume_parsed,
      created_at: p.resume_uploaded_at, // use upload time as the trigger timestamp
    }));
}

/**
 * Batch fetch the best matching job for each eligible user using the
 * production match_jobs_for_survey() RPC — the same HNSW vector search
 * + structured boosts (intent, role category, location, SOC family,
 * graduation year) that powers the in-app matches feed.
 *
 * Strategy:
 * 1. Look up each user's survey_id (surveys.user_id = profiles.id).
 *    Every user who completed onboarding has a survey with an embedding
 *    generated within seconds of signup — well before this 1-hour cron fires.
 * 2. Call match_jobs_for_survey(survey_id, limit=10, fresh_days=3) via RPC.
 * 3. Take the top result (highest total_score) as the job to feature.
 * 4. If no survey exists or the RPC returns nothing, skip that user silently.
 *
 * Returns a Map of userId -> best job object.
 */
async function findBestJobsForUsers(users) {
  const supabase = getSupabase();
  const bestByUser = new Map();

  // Step 1: batch-fetch survey IDs for all users in one query
  const userIds = users.map((u) => u.id);
  const { data: surveys, error: surveyError } = await supabase
    .from('surveys')
    .select('id, user_id')
    .in('user_id', userIds);

  if (surveyError) {
    console.error(`[queries] surveys lookup failed: ${surveyError.message}`);
    return bestByUser;
  }

  // Build userId -> surveyId map
  const surveyByUser = new Map();
  for (const s of surveys || []) {
    surveyByUser.set(s.user_id, s.id);
  }

  // Step 2: call match_jobs_for_survey RPC for each user in parallel
  await Promise.all(
    users.map(async (user) => {
      const surveyId = surveyByUser.get(user.id);

      if (!surveyId) {
        console.log(`[queries] No survey found for ${user.email} — skipping.`);
        return;
      }

      const { data: matches, error: rpcError } = await supabase.rpc(
        'match_jobs_for_survey',
        { p_survey_id: surveyId, p_limit: 10, p_fresh_days: 3 }
      );

      if (rpcError) {
        console.error(`[queries] match_jobs_for_survey failed for ${user.email}: ${rpcError.message}`);
        return;
      }

      if (!matches || matches.length === 0) {
        console.log(`[queries] No fresh matches from RPC for ${user.email} — skipping.`);
        return;
      }

      // RPC returns results ordered by total_score DESC — top result is best match.
      // Fetch the full job row (RPC returns scoring cols but not description/first_seen_at).
      const topMatch = matches[0];

      const { data: jobRows, error: jobError } = await supabase
        .from('jobs')
        .select('id, title, company, location, salary_min, salary_max, work_type, source_url, description, role_category, first_seen_at, last_seen_at, ats_provider')
        .eq('id', topMatch.job_id)
        .single();

      if (jobError || !jobRows) {
        console.error(`[queries] job fetch failed for job ${topMatch.job_id}: ${jobError?.message}`);
        return;
      }

      // Double-check freshness (RPC uses p_fresh_days but belt-and-suspenders)
      const ageDays = (Date.now() - new Date(jobRows.last_seen_at).getTime()) / (24 * 60 * 60 * 1000);
      if (ageDays > 3) {
        console.log(`[queries] Top RPC match for ${user.email} is ${Math.round(ageDays)}d old — skipping.`);
        return;
      }

      // Compute visible match % using the same formula as the production app:
      // visibleMatchPct = clamp(round(70 + total_score * 28), 70, 98)
      const pct = Math.max(70, Math.min(98, Math.round(70 + topMatch.total_score * 28)));

      bestByUser.set(user.id, {
        ...jobRows,
        pct,
        rank: 0,
        total_score: topMatch.total_score,
      });

      console.log(
        `[queries] Best match for ${user.email}: "${jobRows.title}" at ${jobRows.company} ` +
        `(${pct}% match, score=${topMatch.total_score.toFixed(3)})`
      );
    })
  );

  return bestByUser;
}

// Single-user wrapper kept for backwards compat
async function findBestJobForUser(userId) {
  const map = await findBestJobsForUsers([{ id: userId }]);
  return map.get(userId) || null;
}

module.exports = { getSupabase, findEligibleUsers, findBestJobForUser, findBestJobsForUsers };
