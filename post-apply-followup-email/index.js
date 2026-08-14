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

function capitalize(str) {
  if (!str) return str;
  return str
    .toLowerCase()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatSalary(min, max) {
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

  // Check which emails have already paid
  const emails = real.map(g => g.email_lc);
  const { data: paid, error: pErr } = await db
    .from('pending_subscriptions')
    .select('email')
    .in('email', emails)
    .eq('status', 'paid');

  if (pErr) throw new Error(`Paid subscription query failed: ${pErr.message}`);
  const paidEmails = new Set((paid || []).map(p => (p.email || '').toLowerCase()));

  return real.filter(g => !paidEmails.has(g.email_lc));
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

  const eligible = await findEligible(db);
  console.log(`[post-apply-followup] Eligible (unpaid, redeemed 24-25h ago): ${eligible.length}`);

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
