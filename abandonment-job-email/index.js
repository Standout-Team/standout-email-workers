/**
 * abandonment-job-email — Email 1.
 *
 * Runs hourly. Finds users who signed up 1–24h ago with a parsed resume, no
 * billing engagement and no suppression, picks their best fresh job match, and
 * sends the Brevo template.
 *
 * Dedup + eligibility state is Postgres (profiles.abandonment_email_1_sent_at /
 * _job_id), claimed atomically before the send — see lib/claims.js.
 *
 * Logging contract: user ids, job ids, counts and sanitized job titles ONLY.
 * Never an email address, never a minted magic link (it is a bearer credential),
 * never a full params object, never resume content.
 */

require('dotenv').config();

const { findEligibleUsers, findBestJobsForUsers } = require('./queries');
const { generateMatchReasons } = require('./match-reason');
const sentTracker = require('./sent-tracker');

const { getSupabase } = require('../lib/supabase');
const { isDryRun } = require('../lib/dry-run');
const { buildMagicLink, appUrl } = require('../lib/magic-link');
const { sanitizeParam, sanitizeName } = require('../lib/sanitize');
const { sendTransacEmail } = require('../lib/brevo');
const { claimEmail1, releaseEmail1 } = require('../lib/claims');

const LOG = '[abandonment-job-email]';
const CAMPAIGN = 'abandonment';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

// Validated at the top of every run — including dry runs. A dry run whose
// template id is missing is not validating the thing it claims to validate.
function readConfig() {
  const brevoKey = process.env.BREVO_API_KEY || process.env.BREVO_KEY;
  if (!brevoKey) throw new Error('Missing BREVO_API_KEY env var.');

  const rawTemplate = process.env.BREVO_TEMPLATE_ID;
  const templateId = Number(rawTemplate);
  if (!rawTemplate || !Number.isInteger(templateId) || templateId <= 0) {
    throw new Error('Missing or non-numeric BREVO_TEMPLATE_ID env var.');
  }

  return { brevoKey, templateId, appUrl: appUrl() };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatSalary(min, max) {
  const m = Number(min) || 0;
  const x = Number(max) || 0;
  const k = (v) => `$${Math.round(v / 1000)}K`;
  if (m > 0 && x > 0) return `${k(m)}–${k(x)}`;
  if (m > 0) return k(m);
  if (x > 0) return k(x);
  return '';
}

// first_seen_at, deliberately: it means "when this posting first appeared",
// i.e. posted-at. last_seen_at is the ingest freshness watermark and would read
// "Posted today" for a six-month-old listing re-crawled this morning.
function formatJobAge(firstSeenAt) {
  if (!firstSeenAt) return '';
  const days = Math.floor((Date.now() - new Date(firstSeenAt).getTime()) / (24 * 60 * 60 * 1000));
  if (!Number.isFinite(days)) return '';
  if (days <= 0) return 'Posted today';
  if (days === 1) return 'Posted yesterday';
  if (days <= 3) return `Posted ${days} days ago`;
  return ''; // don't show the age badge for anything older than 3 days
}

function firstNameFor(resumeParsed, email) {
  const name = resumeParsed && typeof resumeParsed.name === 'string' ? resumeParsed.name.trim() : '';
  if (name) return name.split(/\s+/)[0];
  const prefix = (email || '').split('@')[0] || 'there';
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

function buildPayload(user, job, reasons, firstName, config) {
  const base = (config && config.appUrl) || appUrl();

  // UTMs are baked into the redirect path, which is signed INTO the token —
  // so the destination can't be repointed by anyone who intercepts the link.
  const jobRedirect = `/dashboard?job=${job.id}&utm_source=brevo&utm_medium=email&utm_campaign=${CAMPAIGN}`;
  const matchesRedirect = `/matches?utm_source=brevo&utm_medium=email&utm_campaign=${CAMPAIGN}`;

  // Self-minted URLs — NOT sanitized (stripping their & or = would break them).
  const jobUrl = buildMagicLink(base, user.id, jobRedirect);
  const matchesUrl = buildMagicLink(base, user.id, matchesRedirect);

  const params = {
    FIRST_NAME: sanitizeParam(firstName, 100),
    JOB_TITLE: sanitizeParam(job.title),
    COMPANY_NAME: sanitizeParam(job.company),
    JOB_LOCATION: sanitizeParam(job.location),
    WORK_TYPE: sanitizeParam(job.work_type),
    JOB_AGE: sanitizeParam(formatJobAge(job.first_seen_at)),
    MATCH_PCT: job.pct || '',
    MATCH_REASON_1: sanitizeParam(reasons[0]),
    MATCH_REASON_2: sanitizeParam(reasons[1]),
    MATCH_REASON_3: sanitizeParam(reasons[2]),
    JOB_URL: jobUrl,
    MATCHES_URL: matchesUrl,
  };

  const salary = formatSalary(job.salary_min, job.salary_max);
  if (salary) params.SALARY_RANGE = sanitizeParam(salary);

  return {
    templateId: (config && config.templateId) || Number(process.env.BREVO_TEMPLATE_ID),
    to: [{ email: user.email, name: sanitizeName(firstName) }],
    params,
  };
}

// ---------------------------------------------------------------------------
// Transition guard (legacy KV) — delete with sent-tracker.js after ~2026-08-01
// ---------------------------------------------------------------------------

/**
 * Users emailed before the Postgres columns existed have no
 * abandonment_email_1_sent_at, so they'd look eligible again. If KV still
 * remembers them, back-fill the DB column from KV and skip the send.
 *
 * Returns true when the user was already emailed (skip them).
 *
 * In a dry run this stays READ-ONLY: it reports the skip but performs no
 * back-fill, because a dry run must not write to the database.
 */
async function consumeLegacySend(supabase, user, dryRun) {
  if (!sentTracker.isKVConfigured()) return false; // KV decommissioned — nothing to guard

  let alreadySent;
  try {
    alreadySent = await sentTracker.hasBeenSent(user.id);
  } catch (err) {
    // A KV outage must not silently re-send email 1 to the legacy cohort.
    throw new Error(`legacy KV transition guard failed: ${err.message}`);
  }
  if (!alreadySent) return false;

  if (dryRun) {
    console.log(`[DRY RUN] user ${user.id} already has a legacy KV send — would back-fill and skip.`);
    return true;
  }

  let legacyJobId = null;
  try {
    legacyJobId = await sentTracker.getSentJobId(user.id);
  } catch (err) {
    console.error(`${LOG} could not read legacy job id for user ${user.id}: ${err.message}`);
  }

  try {
    await claimEmail1(supabase, user.id, legacyJobId);
    console.log(`${LOG} back-filled legacy KV send for user ${user.id} (job ${legacyJobId ?? 'unknown'}).`);
  } catch (err) {
    console.error(`${LOG} legacy back-fill failed for user ${user.id}: ${err.message}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const dryRun = isDryRun();
  const config = readConfig();
  const supabase = getSupabase();

  console.log(`${LOG} Starting run — DRY_RUN=${dryRun}`);

  const users = await findEligibleUsers();
  console.log(`${LOG} ${users.length} sendable user(s) in the 1–24h abandonment band.`);

  const result = { eligible: users.length, matched: 0, sent: 0, wouldSend: 0, skipped: 0, failed: 0, dryRun };
  if (users.length === 0) return result;

  const bestJobMap = await findBestJobsForUsers(users);

  for (const user of users) {
    const job = bestJobMap.get(user.id);
    if (!job) {
      result.skipped++;
      continue; // no suitable fresh match
    }
    result.matched++;

    const safeTitle = sanitizeParam(job.title, 80);

    // Legacy transition guard — only meaningful while KV is still wired up.
    try {
      if (await consumeLegacySend(supabase, user, dryRun)) {
        result.skipped++;
        continue;
      }
    } catch (err) {
      console.error(`${LOG} aborting run: ${err.message}`);
      throw err;
    }

    if (dryRun) {
      // No claims, no writes, no Anthropic call, no Brevo call.
      console.log(`[DRY RUN] would send to user ${user.id} — job ${job.id} "${safeTitle}" (${job.pct}%)`);
      result.wouldSend++;
      continue;
    }

    // Atomic claim BEFORE the LLM call and the send. Losing the race means
    // another run owns this user — skip without spending a token.
    let claimed;
    try {
      claimed = await claimEmail1(supabase, user.id, job.id);
    } catch (err) {
      console.error(`${LOG} claim failed for user ${user.id}: ${err.message}`);
      result.failed++;
      continue;
    }
    if (!claimed) {
      console.log(`${LOG} user ${user.id} already claimed by another run — skipping.`);
      result.skipped++;
      continue;
    }

    try {
      const firstName = firstNameFor(user.resume_parsed, user.email);
      const reasons = await generateMatchReasons(user.resume_parsed, job);
      const payload = buildPayload(user, job, reasons, firstName, config);

      const messageId = await sendTransacEmail({
        templateId: payload.templateId,
        to: payload.to,
        params: payload.params,
        apiKey: config.brevoKey,
      });

      result.sent++;
      console.log(`${LOG} sent to user ${user.id} — job ${job.id} "${safeTitle}" (messageId=${messageId || 'n/a'})`);
    } catch (err) {
      // Release the claim so the next hourly run retries this user.
      try {
        await releaseEmail1(supabase, user.id);
      } catch (releaseErr) {
        console.error(
          `${LOG} CLAIM STUCK for user ${user.id} — send failed AND release failed: ${releaseErr.message}. ` +
            'This user will not be retried; clear abandonment_email_1_sent_at manually.'
        );
      }
      result.failed++;
      console.error(`${LOG} send failed for user ${user.id} (job ${job.id}): ${err.message}`);
    }
  }

  console.log(
    `${LOG} Run complete — eligible ${result.eligible}, matched ${result.matched}, ` +
      `sent ${result.sent}, wouldSend ${result.wouldSend}, skipped ${result.skipped}, failed ${result.failed}.`
  );

  return result;
}

module.exports = { run };
module.exports._internals = { formatSalary, formatJobAge, firstNameFor, buildPayload, readConfig, consumeLegacySend };

// Run directly via `node index.js`
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`${LOG} Fatal:`, err.message);
      process.exit(1);
    });
}
