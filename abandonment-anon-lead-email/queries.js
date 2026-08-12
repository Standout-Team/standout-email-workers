const { createClient } = require('@supabase/supabase-js');

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const FRESH_DAY_STEPS = [3, 7, 14, 30];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// pending_subscriptions rows in these states mean the lead is already in the
// pay-then-setup recovery flow — a different email owns them.
const CHECKOUT_STATUSES = ['paid', 'created'];
// Per-email ilike counts are one request each; keep the fan-out polite.
const ILIKE_CHUNK = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Window / backfill configuration -------------------------------------
// Leads get one quiet hour before we mail them; that upper bound never moves,
// in either mode.
const SETTLE_MS = ONE_HOUR_MS;
// Normal mode looks back exactly one hour further, so the hourly cron considers
// every survey exactly once.
const NORMAL_LOOKBACK_MS = 2 * ONE_HOUR_MS;
const MIN_BACKFILL_DAYS = 1;
const MAX_BACKFILL_DAYS = 30;
// Backfill cohorts are large; bound the real sends per run so one invocation
// can't fire a fortnight of email at Brevo (or outrun the function timeout).
const DEFAULT_BACKFILL_SEND_CAP = 50;
// Belt-and-suspenders bound for the one non-durable path still allowed to send
// for real (a local drain, where the process outlives the run). Normal mode is
// otherwise uncapped, so a dedup slip there would mail the whole cohort.
const NON_DURABLE_SEND_CAP = 50;
// Strict: digits with an optional sign. "14.5", "14d" and "" are all invalid.
const INTEGER_RE = /^[+-]?\d+$/;
// PostgREST caps a single response; a 30-day backfill can exceed it, so page.
const SURVEY_PAGE_SIZE = 1000;
const MAX_SURVEY_PAGES = 25;

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
 * The survey `created_at` window, in both modes. Pure — takes the clock and the
 * env, returns bounds plus a `warning` string for the caller to log (never logs
 * itself, so it stays unit-testable and can't double-warn).
 *
 *   normal    [now − 2h, now − 1h]              (BACKFILL_DAYS unset/invalid)
 *   backfill  [now − BACKFILL_DAYS d, now − 1h] (1–30, clamped)
 *
 * The backfill window is a strict superset of the normal one — same upper
 * bound — so new abandoners keep being covered while a backfill drains.
 * Anything that isn't a plain integer ≥ 1 falls back to normal mode with a
 * warning; a value above the maximum is clamped rather than rejected.
 */
function computeWindow(nowMs, env = process.env) {
  const endMs = nowMs - SETTLE_MS;
  const normal = {
    mode: 'normal',
    backfillDays: null,
    startMs: nowMs - NORMAL_LOOKBACK_MS,
    endMs,
    warning: null,
  };
  const withIso = (win) => ({
    ...win,
    startIso: new Date(win.startMs).toISOString(),
    endIso: new Date(win.endMs).toISOString(),
  });

  const raw = env.BACKFILL_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return withIso(normal);

  const text = String(raw).trim();
  if (!INTEGER_RE.test(text)) {
    return withIso({
      ...normal,
      warning: `BACKFILL_DAYS="${text}" is not an integer — falling back to the normal 1–2h window.`,
    });
  }

  const requested = Number(text);
  if (requested < MIN_BACKFILL_DAYS) {
    return withIso({
      ...normal,
      warning:
        `BACKFILL_DAYS=${requested} is below the minimum of ${MIN_BACKFILL_DAYS} — ` +
        'falling back to the normal 1–2h window.',
    });
  }

  const days = Math.min(requested, MAX_BACKFILL_DAYS);
  return withIso({
    mode: 'backfill',
    backfillDays: days,
    startMs: nowMs - days * ONE_DAY_MS,
    endMs,
    warning:
      days === requested
        ? null
        : `BACKFILL_DAYS=${requested} exceeds the maximum of ${MAX_BACKFILL_DAYS} — clamped to ${days}.`,
  });
}

/**
 * Max real sends per run. Pure, same warning contract as computeWindow.
 * Explicit SEND_CAP wins in either mode; otherwise backfill runs get the
 * default cap and normal mode is uncapped (`null`) because hourly cohorts are
 * small. Anything that isn't a positive integer falls back to the default.
 */
function resolveSendCap(env = process.env, mode = 'normal') {
  const fallback = mode === 'backfill' ? DEFAULT_BACKFILL_SEND_CAP : null;
  const raw = env.SEND_CAP;
  if (raw === undefined || raw === null || String(raw).trim() === '') return { cap: fallback, warning: null };

  const text = String(raw).trim();
  if (!INTEGER_RE.test(text) || Number(text) < 1) {
    return {
      cap: fallback,
      warning:
        `SEND_CAP="${text}" is not a positive integer — using ` +
        `${fallback === null ? 'no cap' : `the default of ${fallback}`}.`,
    };
  }

  return { cap: Number(text), warning: null };
}

/**
 * Is it safe to send with the dedup state we actually have? Pure — takes three
 * booleans the caller has already resolved and returns a decision plus the
 * reason to log or throw with. No env reads, no network, no logging.
 *
 *   durable                        → 'ok'    KV is configured; dedup survives cold starts.
 *   !durable, real send, on Vercel → 'throw' the dangerous one. Serverless resets the
 *                                            in-memory Set per instance and per cold
 *                                            start, so dedup is simply off — and normal
 *                                            mode is uncapped, so the whole cohort gets
 *                                            re-mailed every hour, silently.
 *   !durable, anything else        → 'warn'  a dry run anywhere, or a real send off
 *                                            Vercel (a local drain), where one process
 *                                            spans the run and the fallback is honest.
 *
 * `onVercel` must be `!!process.env.VERCEL`, which is set on production *and*
 * preview deployments — a preview carrying DRY_RUN=false and a real Brevo key
 * mails real people exactly as hard as production does.
 */
function evaluateDedupSafety({ durable, dryRun, onVercel }) {
  if (durable) {
    return {
      action: 'ok',
      reason: 'KV_REST_API_URL / KV_REST_API_TOKEN are set — send-once dedup is durable.',
    };
  }

  if (!dryRun && onVercel) {
    return {
      action: 'throw',
      reason:
        'KV_REST_API_URL / KV_REST_API_TOKEN are not set, so send-once dedup falls back to an ' +
        'in-memory Set that every serverless instance and cold start resets. Sending for real ' +
        'from a Vercel deployment in that state re-sends this marketing email to the same real ' +
        'people on every hourly run, with nothing in the logs to say so. Configure the KV ' +
        'binding on this project, or set DRY_RUN=true.',
    };
  }

  return {
    action: 'warn',
    reason:
      'KV_REST_API_URL / KV_REST_API_TOKEN are not set — send-once dedup is an in-memory Set, ' +
      'per-process only, so nothing this run records is visible to the next one. Sends are ' +
      `capped at ${NON_DURABLE_SEND_CAP} for this run, and a real send from a Vercel ` +
      'deployment will refuse to run until the KV binding is configured.',
  };
}

/**
 * The send cap actually used, given the dedup decision. Pure; `null` means
 * uncapped. Only the 'warn' path narrows it — to NON_DURABLE_SEND_CAP, or to
 * whatever the operator already asked for if that is lower.
 *
 * Applied in warn-mode dry runs too, so a dry run predicts what a real run in
 * that same environment would actually send.
 */
function capForDedupAction(cap, action) {
  if (action !== 'warn') return cap;
  if (cap === null || cap === undefined || !Number.isFinite(cap)) return NON_DURABLE_SEND_CAP;
  return Math.min(cap, NON_DURABLE_SEND_CAP);
}

// Newest abandoner first — freshest intent converts best, and it keeps paging
// stable (survey id breaks created_at ties).
function byCreatedAtDesc(a, b) {
  const ta = new Date(a.created_at).getTime() || 0;
  const tb = new Date(b.created_at).getTime() || 0;
  if (tb !== ta) return tb - ta;
  return String(b.survey_id ?? '').localeCompare(String(a.survey_id ?? ''));
}

/**
 * Order a cohort newest-first and take the run's slice. Pure; never mutates the
 * input. `cap` of null/undefined/Infinity means uncapped. Everything past the
 * cap is `deferred` — the next hourly run picks it up, and the persistent
 * sent-tracker keeps the already-mailed head out of that run's cohort.
 */
function selectForSend(candidates, cap) {
  const ordered = [...candidates].sort(byCreatedAtDesc);
  if (cap === null || cap === undefined || !Number.isFinite(cap)) {
    return { selected: ordered, deferred: 0 };
  }
  const take = Math.max(0, Math.min(Math.trunc(cap), ordered.length));
  return { selected: ordered.slice(0, take), deferred: ordered.length - take };
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
 * Every opted-in anonymous survey in the window, newest first. Paged, because a
 * long backfill window can hold more rows than PostgREST returns in one
 * response — silently truncating would wedge the drain (the newest page would
 * always come back already-sent and the tail would never be reached).
 */
async function fetchSurveyRows(win) {
  const supabase = getSupabase();
  const rows = [];

  for (let page = 0; page < MAX_SURVEY_PAGES; page++) {
    const from = page * SURVEY_PAGE_SIZE;
    const { data, error } = await supabase
      .from('surveys')
      .select('id, session_id, resume_parsed, created_at, marketing_opt_in_at')
      .eq('marketing_opt_in', true)
      .is('user_id', null)
      .not('resume_parsed', 'is', null)
      .gte('created_at', win.startIso)
      .lte('created_at', win.endIso)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false }) // total order — stable paging across ties
      .range(from, from + SURVEY_PAGE_SIZE - 1);

    if (error) throw new Error(`surveys query failed: ${error.message}`);

    const batch = data || [];
    rows.push(...batch);
    if (batch.length < SURVEY_PAGE_SIZE) return rows;
  }

  console.warn(
    `[queries] survey paging hit the ${MAX_SURVEY_PAGES}-page guard at ${rows.length} row(s) — ` +
      'lower BACKFILL_DAYS and drain in slices.'
  );
  return rows;
}

/**
 * The audience: anonymous, opted-in surveys with a parsed resume that carries a
 * plausible email, in one of two windows (see computeWindow):
 *
 *   normal mode   — created 1–2 hours ago. Hourly cron × 1-hour-wide window =
 *                   every survey is considered exactly once.
 *   backfill mode — BACKFILL_DAYS is set: created between BACKFILL_DAYS ago and
 *                   1 hour ago, i.e. a superset of the normal window, so the
 *                   forward-marching hourly cohort is still covered while the
 *                   backlog drains. Surveys are then reconsidered on every run;
 *                   the persistent sent-tracker (KV) is what makes that
 *                   idempotent, and SEND_CAP is what keeps one run bounded.
 *
 * Everything downstream is age-independent and unchanged in both modes: the
 * exclusion set, the 3-day job-freshness gate, and the send-time token mint.
 * Returned newest-first. Pass `windowOverride` (from computeWindow) when the
 * caller has already resolved and logged the window.
 */
async function findAnonLeads(windowOverride) {
  const win = windowOverride || computeWindow(Date.now(), process.env);
  if (!windowOverride && win.warning) console.warn(`[queries] ${win.warning}`);

  const rows = await fetchSurveyRows(win);

  // One lead per lower(email) — latest consent wins.
  const byEmail = new Map();
  for (const row of rows) {
    const lead = leadFromSurvey(row);
    if (!lead) continue;
    const prev = byEmail.get(lead.email_lc);
    if (!prev || optInTime(lead) >= optInTime(prev)) byEmail.set(lead.email_lc, lead);
  }

  const candidates = [...byEmail.values()].sort(byCreatedAtDesc);
  console.log(
    `[queries] mode=${win.mode} window=${win.startIso} → ${win.endIso}: ` +
      `${rows.length} opted-in anonymous survey(s) → ${candidates.length} candidate lead(s).`
  );
  if (candidates.length === 0) return [];

  const excluded = await findExclusions(candidates);
  const kept = candidates.filter((lead) => !excluded.has(lead.email_lc));
  console.log(`[queries] ${excluded.size} candidate(s) excluded → ${kept.length} lead(s) remain.`);

  return kept;
}

/**
 * Featured job per lead, via the same production RPC the in-app matches feed
 * uses (HNSW vector search + structured boosts). It progressively relaxes the
 * freshness window until it finds a non-closed match.
 *
 * Returns [{ lead, job, pct }] in input order.
 */
async function findFeaturedJobs(leads) {
  const supabase = getSupabase();

  const results = await Promise.all(
    leads.map(async (lead) => {
      for (const freshDays of FRESH_DAY_STEPS) {
        const { data: matches, error: rpcError } = await supabase.rpc('match_jobs_for_survey', {
          p_survey_id: lead.survey_id,
          p_limit: 10,
          p_fresh_days: freshDays,
        });

        if (rpcError) {
          console.error(`[queries] match_jobs_for_survey failed for ${lead.email_lc}: ${rpcError.message}`);
          return null;
        }
        if (!matches || matches.length === 0) {
          console.log(`[queries] No matches within ${freshDays}d for ${lead.email_lc}; trying next window.`);
          continue;
        }

        // Hydrate the whole window's matches in ONE round trip rather than up
        // to 10 sequential .single() calls. The ladder means the worst case per
        // lead was 4 windows x 10 fetches = 40 round trips, all inside the
        // Promise.all that fans out across the entire cohort — and the leads
        // that reach the widest windows are exactly what a backfill run is made
        // of. A row that is missing simply isn't in the map, which lands on the
        // same `continue` the per-row error did.
        const { data: jobRows, error: jobError } = await supabase
          .from('jobs')
          .select(
            'id, title, company, location, salary_min, salary_max, work_type, source_url, description, role_category, first_seen_at, last_seen_at, ats_provider, closed_at'
          )
          .in(
            'id',
            matches.map((m) => m.job_id)
          );

        if (jobError) {
          console.error(`[queries] job fetch failed for ${lead.email_lc}: ${jobError.message}`);
          return null;
        }
        const jobsById = new Map((jobRows || []).map((j) => [j.id, j]));

        // Iterate MATCHES, not jobsById — the RPC returns rows ordered by
        // total_score DESC and `.in()` gives no ordering guarantee, so the map
        // lookup is what preserves "best match first".
        for (const match of matches) {
          const job = jobsById.get(match.job_id);
          if (!job) {
            console.error(`[queries] job ${match.job_id} missing from the batch fetch — skipping.`);
            continue;
          }
          if (job.closed_at) {
            console.log(`[queries] Job ${job.id} is closed — trying next match for ${lead.email_lc}.`);
            continue;
          }

          // Mirrors visibleMatchPct in the main repo (server/marketing/match-digest.ts).
          const pct = Math.max(70, Math.min(98, Math.round(70 + match.total_score * 28)));

          console.log(
            `[queries] ${lead.email_lc} → "${job.title}" at ${job.company} ` +
              `(${pct}% match, score=${match.total_score.toFixed(3)}, freshness=${freshDays}d)`
          );

          return { lead, job, pct };
        }

        console.log(
          `[queries] No open matches within ${freshDays}d for ${lead.email_lc}; trying next window.`
        );
      }

      console.log(`[queries] No open matches within 30d for ${lead.email_lc} — skipping.`);
      return null;
    })
  );

  return results.filter(Boolean);
}

module.exports = {
  getSupabase,
  computeWindow,
  resolveSendCap,
  selectForSend,
  evaluateDedupSafety,
  capForDedupAction,
  findAnonLeads,
  findFeaturedJobs,
  findExclusions,
  _internals: {
    parseResume,
    leadFromSurvey,
    optInTime,
    escapeLike,
    byCreatedAtDesc,
    MIN_BACKFILL_DAYS,
    MAX_BACKFILL_DAYS,
    DEFAULT_BACKFILL_SEND_CAP,
    NON_DURABLE_SEND_CAP,
    NORMAL_LOOKBACK_MS,
    SETTLE_MS,
    ONE_DAY_MS,
  },
};
