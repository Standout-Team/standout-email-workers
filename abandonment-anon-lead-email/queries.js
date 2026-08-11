const { createClient } = require('@supabase/supabase-js');

const ONE_HOUR_MS = 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// pending_subscriptions rows in these states mean the lead is already in the
// pay-then-setup recovery flow — a different email owns them.
const CHECKOUT_STATUSES = ['paid', 'created'];
// Per-email ilike counts are one request each; keep the fan-out polite.
const ILIKE_CHUNK = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/**
 * surveys.resume_parsed is a JSON-encoded text blob written by the resume
 * parser. Some PDFs smuggle NULs through, which Postgres stores escaped and
 * JSON.parse then chokes on — strip both forms before parsing (the SQL twin
 * does regexp_replace(..., E'\\u0000', '', 'g')). Unparseable = no lead.
 */
function parseResume(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const cleaned = String(raw).replace(/\u0000/g, '').replace(/\\u0000/g, '');
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function leadFromSurvey(row) {
  const parsed = parseResume(row.resume_parsed);
  if (!parsed) return null;

  const email = typeof parsed.email === 'string' ? parsed.email.trim() : '';
  if (!EMAIL_RE.test(email)) return null; // implausible / missing — not a lead

  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';

  return {
    survey_id: row.id,
    session_id: row.session_id,
    email,
    email_lc: email.toLowerCase(),
    name,
    resume_parsed: parsed,
    created_at: row.created_at,
    marketing_opt_in_at: row.marketing_opt_in_at,
  };
}

// Consent recency: marketing_opt_in_at is the durable receipt, created_at the
// fallback for rows stamped before that column existed.
function optInTime(lead) {
  const stamp = lead.marketing_opt_in_at || lead.created_at;
  const t = stamp ? new Date(stamp).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

// PostgREST hands the pattern straight to ilike, so a stray % or _ inside an
// address would widen the match. Over-matching here only ever suppresses a
// send, but it costs nothing to neutralise.
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Case-insensitive "is this email present?" against a table with an `id` PK.
 * One head+count request per email, fanned out ILIKE_CHUNK at a time.
 * `refine` optionally adds filters to each query.
 */
async function emailsPresentIn(table, emailsLc, refine) {
  const supabase = getSupabase();
  const hits = new Set();

  for (let i = 0; i < emailsLc.length; i += ILIKE_CHUNK) {
    const chunk = emailsLc.slice(i, i + ILIKE_CHUNK);
    await Promise.all(
      chunk.map(async (emailLc) => {
        let query = supabase
          .from(table)
          .select('id', { head: true, count: 'exact' })
          .ilike('email', escapeLike(emailLc));
        if (refine) query = refine(query);

        const { count, error } = await query;
        if (error) throw new Error(`${table} email check failed: ${error.message}`);
        if ((count || 0) > 0) hits.add(emailLc);
      })
    );
  }

  return hits;
}

/**
 * Emails we must not mail, unioned from four sources:
 *   a) profiles          — they already have an account (case-insensitive)
 *   b) marketing_suppressions — unsubscribed / bounced / complained
 *   c) pending_subscriptions  — recent paid|created checkout, by session or email
 *   d) free_apply_grants      — already granted a free apply
 */
async function findExclusions(candidates) {
  const supabase = getSupabase();
  const emailsLc = candidates.map((l) => l.email_lc);
  const sessionIds = candidates.map((l) => l.session_id).filter(Boolean);
  const emailBySession = new Map(candidates.map((l) => [l.session_id, l.email_lc]));
  const excluded = new Set();

  const inProfiles = await emailsPresentIn('profiles', emailsLc);
  for (const e of inProfiles) excluded.add(e);

  // Suppressions are stored lowercase — a plain IN is enough.
  const { data: suppressed, error: suppressError } = await supabase
    .from('marketing_suppressions')
    .select('email')
    .in('email', emailsLc);
  if (suppressError) throw new Error(`marketing_suppressions query failed: ${suppressError.message}`);
  for (const row of suppressed || []) excluded.add(String(row.email).toLowerCase());

  const checkoutSince = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
  const refineCheckout = (q) => q.in('status', CHECKOUT_STATUSES).gt('created_at', checkoutSince);

  if (sessionIds.length > 0) {
    const { data: pending, error: pendingError } = await supabase
      .from('pending_subscriptions')
      .select('session_id')
      .in('status', CHECKOUT_STATUSES)
      .gt('created_at', checkoutSince)
      .in('session_id', sessionIds);
    if (pendingError) throw new Error(`pending_subscriptions query failed: ${pendingError.message}`);
    for (const row of pending || []) {
      const emailLc = emailBySession.get(row.session_id);
      if (emailLc) excluded.add(emailLc);
    }
  }

  // Stripe reports the email late, so the session join above can miss a
  // checkout the lead started from another tab.
  const inCheckout = await emailsPresentIn('pending_subscriptions', emailsLc, refineCheckout);
  for (const e of inCheckout) excluded.add(e);

  // Ships with the main-repo migration; until then treat as "no grants yet".
  const { data: granted, error: grantError } = await supabase
    .from('free_apply_grants')
    .select('email_lc')
    .in('email_lc', emailsLc);
  if (grantError) {
    console.warn(`[queries] free_apply_grants unavailable (${grantError.message}) — skipping that exclusion.`);
  } else {
    for (const row of granted || []) excluded.add(String(row.email_lc).toLowerCase());
  }

  return excluded;
}

/**
 * The audience: anonymous, opted-in surveys with a parsed resume that carries a
 * plausible email, created 1–2 hours ago. Hourly cron × 1-hour-wide window =
 * every survey is considered exactly once.
 */
async function findAnonLeads() {
  const supabase = getSupabase();

  const windowStart = new Date(Date.now() - 2 * ONE_HOUR_MS).toISOString(); // 2 hours ago
  const windowEnd = new Date(Date.now() - ONE_HOUR_MS).toISOString();       // 1 hour ago

  const { data: rows, error } = await supabase
    .from('surveys')
    .select('id, session_id, resume_parsed, created_at, marketing_opt_in_at')
    .eq('marketing_opt_in', true)
    .is('user_id', null)
    .not('resume_parsed', 'is', null)
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd);

  if (error) throw new Error(`surveys query failed: ${error.message}`);

  // One lead per lower(email) — latest consent wins.
  const byEmail = new Map();
  for (const row of rows || []) {
    const lead = leadFromSurvey(row);
    if (!lead) continue;
    const prev = byEmail.get(lead.email_lc);
    if (!prev || optInTime(lead) >= optInTime(prev)) byEmail.set(lead.email_lc, lead);
  }

  const candidates = [...byEmail.values()];
  console.log(
    `[queries] ${(rows || []).length} opted-in anonymous survey(s) in window → ${candidates.length} candidate lead(s).`
  );
  if (candidates.length === 0) return [];

  const excluded = await findExclusions(candidates);
  const kept = candidates.filter((lead) => !excluded.has(lead.email_lc));
  console.log(`[queries] ${excluded.size} candidate(s) excluded → ${kept.length} lead(s) remain.`);

  return kept;
}

/**
 * Featured job per lead, via the same production RPC the in-app matches feed
 * uses (HNSW vector search + structured boosts). Top row wins; the lead is
 * dropped when there's no match, the posting closed, or it went stale.
 *
 * Returns [{ lead, job, pct }] in input order.
 */
async function findFeaturedJobs(leads) {
  const supabase = getSupabase();

  const results = await Promise.all(
    leads.map(async (lead) => {
      const { data: matches, error: rpcError } = await supabase.rpc('match_jobs_for_survey', {
        p_survey_id: lead.survey_id,
        p_limit: 10,
        p_fresh_days: 3,
      });

      if (rpcError) {
        console.error(`[queries] match_jobs_for_survey failed for ${lead.email_lc}: ${rpcError.message}`);
        return null;
      }
      if (!matches || matches.length === 0) {
        console.log(`[queries] No fresh matches for ${lead.email_lc} — skipping.`);
        return null;
      }

      // RPC returns rows ordered by total_score DESC — the first is the best.
      const topMatch = matches[0];

      const { data: job, error: jobError } = await supabase
        .from('jobs')
        .select(
          'id, title, company, location, salary_min, salary_max, work_type, source_url, description, role_category, first_seen_at, last_seen_at, ats_provider, closed_at'
        )
        .eq('id', topMatch.job_id)
        .single();

      if (jobError || !job) {
        console.error(`[queries] job fetch failed for job ${topMatch.job_id}: ${jobError?.message}`);
        return null;
      }
      if (job.closed_at) {
        console.log(`[queries] Job ${job.id} is closed — skipping ${lead.email_lc}.`);
        return null;
      }

      const ageMs = Date.now() - new Date(job.last_seen_at).getTime();
      if (!(ageMs <= THREE_DAYS_MS)) {
        console.log(
          `[queries] Top match for ${lead.email_lc} last seen ${Math.round(ageMs / (24 * 60 * 60 * 1000))}d ago — skipping.`
        );
        return null;
      }

      // Mirrors visibleMatchPct in the main repo (server/marketing/match-digest.ts).
      const pct = Math.max(70, Math.min(98, Math.round(70 + topMatch.total_score * 28)));

      console.log(
        `[queries] ${lead.email_lc} → "${job.title}" at ${job.company} ` +
          `(${pct}% match, score=${topMatch.total_score.toFixed(3)})`
      );

      return { lead, job, pct };
    })
  );

  return results.filter(Boolean);
}

module.exports = {
  getSupabase,
  findAnonLeads,
  findFeaturedJobs,
  findExclusions,
  _internals: { parseResume, leadFromSurvey, optInTime, escapeLike },
};
