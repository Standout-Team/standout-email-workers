require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const brevo = require('@getbrevo/brevo');
const { kv } = require('@vercel/kv');

// ---------------------------------------------------------------------------
// Post-apply follow-up email.
//
// Targets users who submitted a free apply grant (redeemed_at IS NOT NULL)
// exactly 24-25 hours ago and have not since purchased a subscription.
// Sends Brevo template #42 referencing the job they applied to.
// KV dedup key: post_apply_followup_sent:<email_lc> (30-day TTL).
// ---------------------------------------------------------------------------

const TEMPLATE_ID = 42;
const KV_PREFIX = 'post_apply_followup_sent:';
const KV_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const ONE_HOUR_MS = 60 * 60 * 1000;
// Hard ceiling on real sends per run. The 24-25h window is one hour wide and
// the cron is hourly, so a healthy run is small — but a clock skew, a backfill
// or a widened window would otherwise mail the whole cohort at once. Mirrors
// SEND_CAP in abandonment-anon-lead-email/queries.js.
const DEFAULT_SEND_CAP = 200;
// Tighter ceiling when the KV dedup is unavailable, because hasBeenSent() then
// answers "not sent" for everyone and a re-run would mail the cohort twice.
// Same rail as NON_DURABLE_SEND_CAP in the sibling worker.
const NON_DURABLE_SEND_CAP = 50;
// PostgREST hands the pattern straight to ilike, so a stray % or _ inside an
// address would widen the match.
const ILIKE_CHUNK = 25;
const WINDOW_START_MS = 25 * ONE_HOUR_MS; // redeemed 25h+ ago
const WINDOW_END_MS   = 24 * ONE_HOUR_MS; // redeemed up to 24h ago

const UTM = {
  utm_source: 'brevo',
  utm_medium: 'email',
  utm_campaign: 'post_apply_followup',
};

function isDryRun() {
  return String(process.env.DRY_RUN).toLowerCase() !== 'false';
}

function getSupabase() {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

function getBrevoApi() {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('Missing BREVO_API_KEY env var.');
  }
  const api = new brevo.TransactionalEmailsApi();
  api.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);
  return api;
}

function isKVAvailable() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function hasBeenSent(emailLc) {
  if (!isKVAvailable()) return false; // non-durable: allow sends locally
  const val = await kv.get(`${KV_PREFIX}${emailLc}`);
  return val !== null;
}

async function markSent(emailLc) {
  if (!isKVAvailable()) return;
  await kv.set(`${KV_PREFIX}${emailLc}`, { sentAt: new Date().toISOString() }, { ex: KV_TTL_SECONDS });
}

function firstNameFor(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

// Title-case ONLY a word that is entirely lowercase. Lowercasing first turned
// "IBM" into "Ibm" and "eBay" into "Ebay" in a customer-facing email; a company
// that already carries capitals has spelled itself the way it wants.
function capitalize(str) {
  if (!str) return str;
  return String(str)
    .split(' ')
    .map(w => (w && w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function formatSalary(min, max) {
  // Reject null/undefined/'' BEFORE coercing: Number(null) and Number('') are
  // both 0, which is finite — so a job with no salary_min rendered "$0k–$120k"
  // into a customer-facing email rather than omitting the range.
  const usable = (v) => v !== null && v !== undefined && String(v).trim() !== '';
  if (!usable(min) || !usable(max)) return null;
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const fmt = n => `$${Math.round(n / 1000)}k`;
  return `${fmt(lo)}–${fmt(hi)}`;
}

function buildCtaUrl(base) {
  const url = new URL(base);
  Object.entries(UTM).forEach(([k, v]) => url.searchParams.set(k, v));
  return url.toString();
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Case-insensitive "which of these emails exist in `table`?".
 *
 * ILIKE rather than .in(): pending_subscriptions stores 5 addresses that are
 * not lowercased, and an .in() over lowercased grant emails silently misses
 * them — the exact shape of a paid buyer getting a "you did not buy" email.
 * `refine` adds per-table filters (a paid status, an active subscription).
 */
async function emailsPresentIn(db, table, emailsLc, refine) {
  const hits = new Set();
  for (let i = 0; i < emailsLc.length; i += ILIKE_CHUNK) {
    const chunk = emailsLc.slice(i, i + ILIKE_CHUNK);
    let q = db.from(table).select('email').or(
      chunk.map((e) => `email.ilike.${escapeLike(e)}`).join(',')
    );
    if (refine) q = refine(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} lookup failed: ${error.message}`);
    for (const row of data || []) {
      const e = String(row.email || '').toLowerCase();
      if (e) hits.add(e);
    }
  }
  return hits;
}

/**
 * Everyone who must NOT get this email, by address:
 *
 *   a) profiles with an ACTIVE subscription — they bought. Presence alone is
 *      not disqualifying the way it is in the abandonment worker: a free-apply
 *      grantee has an anonymous account by construction, so excluding every
 *      profile would empty the audience.
 *   b) marketing_suppressions — unsubscribed / bounced / complained. Brevo
 *      blocks its own list at send time anyway, so skipping here saves a wasted
 *      send and keeps our database agreeing with theirs (see Standout-pro #407).
 *   c) pending_subscriptions with a paid guest checkout — the pre-account path.
 *
 * (a) and (c) are BOTH needed: a guest checkout lands in pending_subscriptions,
 * an authed purchase never does. Checking only (c) excluded nobody at all.
 */
async function findExclusions(db, emailsLc) {
  const excluded = new Set();

  const subscribed = await emailsPresentIn(db, 'profiles', emailsLc, (q) =>
    q.in('subscription_status', ['active', 'trialing'])
  );
  for (const e of subscribed) excluded.add(e);

  const suppressed = await emailsPresentIn(db, 'marketing_suppressions', emailsLc);
  for (const e of suppressed) excluded.add(e);

  const paid = await emailsPresentIn(db, 'pending_subscriptions', emailsLc, (q) =>
    q.eq('status', 'paid')
  );
  for (const e of paid) excluded.add(e);

  return excluded;
}

/**
 * The per-run ceiling. An explicit SEND_CAP wins; otherwise DEFAULT_SEND_CAP.
 * A non-durable dedup store narrows whatever that is to NON_DURABLE_SEND_CAP —
 * it can only ever reduce, never raise an operator's own cap.
 */
function resolveSendCap(env, kvDurable) {
  const raw = env.SEND_CAP;
  const text = typeof raw === 'string' ? raw.trim() : '';
  let cap = DEFAULT_SEND_CAP;
  if (text) {
    const n = Number(text);
    if (Number.isInteger(n) && n > 0) cap = n;
    else console.warn(`[post-apply-followup] SEND_CAP="${text}" is not a positive integer — using ${cap}.`);
  }
  return kvDurable ? cap : Math.min(cap, NON_DURABLE_SEND_CAP);
}

async function findEligible(db) {
  const now = Date.now();
  const windowStart = new Date(now - WINDOW_START_MS).toISOString();
  const windowEnd   = new Date(now - WINDOW_END_MS).toISOString();

  // Grants redeemed in the 24-25h window
  const { data: grants, error: gErr } = await db
    .from('free_apply_grants')
    .select('email_lc, survey_id, application_id, redeemed_at')
    .not('redeemed_at', 'is', null)
    .gte('redeemed_at', windowStart)
    .lte('redeemed_at', windowEnd);

  if (gErr) throw new Error(`Grant query failed: ${gErr.message}`);
  if (!grants || grants.length === 0) return [];

  // Filter out test users
  const real = grants.filter(g => !g.email_lc.includes('calcal123235'));
  if (real.length === 0) return [];

  const emails = [...new Set(real.map(g => String(g.email_lc || '').toLowerCase()).filter(Boolean))];
  const excluded = await findExclusions(db, emails);
  const kept = real.filter(g => !excluded.has(String(g.email_lc || '').toLowerCase()));

  console.log(
    `[post-apply-followup] ${real.length} in window → ${excluded.size} excluded ` +
      `(subscribed / suppressed / paid) → ${kept.length} eligible.`
  );
  return kept;
}

async function enrichGrant(db, grant) {
  // Get application → job_id
  const { data: apps, error: aErr } = await db
    .from('applications')
    .select('job_id')
    .eq('id', grant.application_id)
    .limit(1);
  if (aErr || !apps || apps.length === 0) return null;

  const jobId = apps[0].job_id;

  // Get job details
  const { data: jobs, error: jErr } = await db
    .from('jobs')
    .select('title, company, location, work_type, salary_min, salary_max')
    .eq('id', jobId)
    .limit(1);
  if (jErr || !jobs || jobs.length === 0) return null;

  const job = jobs[0];

  // Get first name from survey → resume_parsed
  const { data: surveys, error: sErr } = await db
    .from('surveys')
    .select('resume_parsed')
    .eq('id', grant.survey_id)
    .limit(1);

  let firstName = 'there';
  if (!sErr && surveys && surveys.length > 0) {
    const rp = surveys[0].resume_parsed;
    const nameRaw = rp && rp.name ? rp.name : '';
    firstName = firstNameFor(nameRaw);
  }

  const ctaBase = process.env.POST_APPLY_CTA_URL || 'https://usestandout.today/pricing';

  return {
    email: grant.email_lc,
    firstName,
    params: {
      FIRST_NAME: firstName,
      JOB_TITLE: job.title || '',
      COMPANY_NAME: capitalize(job.company || ''),
      JOB_LOCATION: job.location || '',
      WORK_TYPE: capitalize(job.work_type || ''),
      SALARY_RANGE: formatSalary(job.salary_min, job.salary_max) || '',
      CTA_URL: buildCtaUrl(ctaBase),
    },
  };
}

async function sendEmail(api, recipient) {
  const message = new brevo.SendSmtpEmail();
  message.templateId = TEMPLATE_ID;
  message.to = [{ email: recipient.email, name: recipient.firstName }];
  message.params = recipient.params;
  const resp = await api.sendTransacEmail(message);
  return resp && resp.body ? resp.body.messageId : undefined;
}

async function run() {
  const dryRun = isDryRun();
  console.log(`[post-apply-followup] Starting. dry_run=${dryRun} kv_durable=${isKVAvailable()}`);

  const db = getSupabase();
  const brevoApi = getBrevoApi();

  const allEligible = await findEligible(db);
  const cap = resolveSendCap(process.env, isKVAvailable());
  const eligible = allEligible.slice(0, cap);
  if (allEligible.length > eligible.length) {
    console.warn(
      `[post-apply-followup] Capped at ${cap} of ${allEligible.length} eligible — ` +
        `${allEligible.length - eligible.length} deferred to a later run` +
        (isKVAvailable() ? '.' : ' (dedup is NON-DURABLE, so the cap is tightened).')
    );
  }
  console.log(`[post-apply-followup] Eligible (unpaid, redeemed 24-25h ago): ${eligible.length} (cap=${cap})`);

  let sent = 0, skipped = 0, errors = 0;

  for (const grant of eligible) {
    const emailLc = grant.email_lc;

    // KV dedup check
    if (await hasBeenSent(emailLc)) {
      console.log(`[post-apply-followup] SKIP (already sent): ${emailLc}`);
      skipped++;
      continue;
    }

    // Enrich with job + name data
    let recipient;
    try {
      recipient = await enrichGrant(db, grant);
    } catch (err) {
      console.error(`[post-apply-followup] Enrich error for ${emailLc}:`, err.message);
      errors++;
      continue;
    }

    if (!recipient) {
      console.log(`[post-apply-followup] SKIP (no job/survey data): ${emailLc}`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`[post-apply-followup] [DRY RUN] Would send to: ${emailLc} — ${recipient.params.JOB_TITLE} at ${recipient.params.COMPANY_NAME}`);
      sent++;
      continue;
    }

    try {
      const messageId = await sendEmail(brevoApi, recipient);
      await markSent(emailLc);
      console.log(`[post-apply-followup] SENT: ${emailLc} — messageId=${messageId}`);
      sent++;
    } catch (err) {
      console.error(`[post-apply-followup] Send error for ${emailLc}:`, err.message);
      errors++;
    }
  }

  console.log(`[post-apply-followup] Done. sent=${sent} skipped=${skipped} errors=${errors}`);
}

// Exported for tests. The handler stays the default export so the Vercel
// entry point (`api/post-apply-followup-email.js`) is unchanged.
module.exports = async function handler(req, res) {
  try {
    await run();
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[post-apply-followup] Fatal:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};

if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

module.exports._internals = {
  capitalize,
  formatSalary,
  firstNameFor,
  buildCtaUrl,
  escapeLike,
  resolveSendCap,
  DEFAULT_SEND_CAP,
  NON_DURABLE_SEND_CAP,
};
