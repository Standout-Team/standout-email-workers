/**
 * abandonment-job-email-2 — Email 2 (24h loss-aversion nurture).
 *
 * Runs hourly at :30 (staggered off worker 1). Re-surfaces the SAME job email 1
 * featured, plus a live match count.
 *
 * This worker has never successfully sent an email: it called
 * sentTracker.getSentJobId(), which did not exist, so every user threw. The
 * featured job now comes from profiles.abandonment_email_1_job_id and dedup is
 * an atomic claim on profiles.abandonment_email_2_sent_at.
 *
 * Logging contract: user ids, job ids, counts and sanitized job titles ONLY.
 */

require('dotenv').config();

const { findEligibleUsers, findJobsAndMatchCounts } = require('./queries');

const { getSupabase } = require('../lib/supabase');
const { isDryRun } = require('../lib/dry-run');
const { buildMagicLink, appUrl } = require('../lib/magic-link');
const { sanitizeParam, sanitizeName } = require('../lib/sanitize');
const { sendTransacEmail } = require('../lib/brevo');
const { claimEmail2, releaseEmail2 } = require('../lib/claims');

const LOG = '[email2]';
const CAMPAIGN = 'abandonment_2';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

// The old code defaulted the template to `parseInt(… || '40')`. A hardcoded
// fallback template id is how you mail the wrong template to real users when an
// env var goes missing — there is no default now.
function readConfig() {
  const brevoKey = process.env.BREVO_API_KEY || process.env.BREVO_KEY;
  if (!brevoKey) throw new Error('Missing BREVO_API_KEY env var.');

  const rawTemplate = process.env.BREVO_TEMPLATE_ID_2;
  const templateId = Number(rawTemplate);
  if (!rawTemplate || !Number.isInteger(templateId) || templateId <= 0) {
    throw new Error('Missing or non-numeric BREVO_TEMPLATE_ID_2 env var.');
  }

  return { brevoKey, templateId, appUrl: appUrl() };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

// Splits on /\s+/ like worker 1. The old `split(' ')` let a leading "\r\n" ride
// along into the Brevo recipient name — a CRLF header-injection vector.
function getFirstName(resumeParsed) {
  const name = resumeParsed && typeof resumeParsed.name === 'string' ? resumeParsed.name.trim() : '';
  if (!name) return 'there';
  return name.split(/\s+/)[0] || 'there';
}

function timeSinceSignup(createdAt) {
  const hours = Math.round((Date.now() - new Date(createdAt).getTime()) / (60 * 60 * 1000));
  if (!Number.isFinite(hours)) return '';
  if (hours < 24) return `${hours} hours`;
  const days = Math.round(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''}`;
}

function buildPayload(user, job, matchCount, firstName, config) {
  const base = (config && config.appUrl) || appUrl();

  const jobRedirect = `/dashboard?job=${job.id}&utm_source=brevo&utm_medium=email&utm_campaign=${CAMPAIGN}`;
  const matchesRedirect = `/matches?utm_source=brevo&utm_medium=email&utm_campaign=${CAMPAIGN}`;

  // Self-minted URLs — NOT sanitized.
  const jobUrl = buildMagicLink(base, user.id, jobRedirect);
  const matchesUrl = buildMagicLink(base, user.id, matchesRedirect);

  const params = {
    FIRST_NAME: sanitizeParam(firstName, 100),
    JOB_TITLE: sanitizeParam(job.title),
    COMPANY_NAME: sanitizeParam(job.company),
    JOB_LOCATION: sanitizeParam(job.location),
    WORK_TYPE: sanitizeParam(job.work_type),
    MATCH_PCT: '', // not rendered in the email 2 job card; kept for template parity
    MATCH_COUNT: matchCount || 'several',
    TIME_SINCE_SIGNUP: sanitizeParam(timeSinceSignup(user.created_at)),
    JOB_URL: jobUrl,
    MATCHES_URL: matchesUrl,
  };

  return {
    templateId: (config && config.templateId) || Number(process.env.BREVO_TEMPLATE_ID_2),
    to: [{ email: user.email, name: sanitizeName(firstName) }],
    params,
  };
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
  console.log(`${LOG} ${users.length} sendable user(s) 24h past email 1.`);

  const result = { eligible: users.length, matched: 0, sent: 0, wouldSend: 0, skipped: 0, failed: 0, dryRun };
  if (users.length === 0) return result;

  const jobData = await findJobsAndMatchCounts(users);

  for (const user of users) {
    const data = jobData.get(user.id);
    if (!data) {
      result.skipped++;
      continue; // no email-1 job id, or the job row is gone
    }
    result.matched++;

    const { job, matchCount } = data;
    const safeTitle = sanitizeParam(job.title, 80);

    if (dryRun) {
      console.log(`[DRY RUN] would send to user ${user.id} — job ${job.id} "${safeTitle}" (${matchCount} matches)`);
      result.wouldSend++;
      continue;
    }

    let claimed;
    try {
      claimed = await claimEmail2(supabase, user.id);
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
      const firstName = getFirstName(user.resume_parsed);
      const payload = buildPayload(user, job, matchCount, firstName, config);

      const messageId = await sendTransacEmail({
        templateId: payload.templateId,
        to: payload.to,
        params: payload.params,
        apiKey: config.brevoKey,
      });

      result.sent++;
      console.log(`${LOG} sent to user ${user.id} — job ${job.id} "${safeTitle}" (messageId=${messageId || 'n/a'})`);
    } catch (err) {
      try {
        await releaseEmail2(supabase, user.id);
      } catch (releaseErr) {
        console.error(
          `${LOG} CLAIM STUCK for user ${user.id} — send failed AND release failed: ${releaseErr.message}. ` +
            'This user will not be retried; clear abandonment_email_2_sent_at manually.'
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
module.exports._internals = { getFirstName, timeSinceSignup, buildPayload, readConfig };

// Run directly via `node index.js`
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`${LOG} Fatal:`, err.message);
      process.exit(1);
    });
}
