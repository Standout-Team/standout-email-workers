require('dotenv').config();

const { createHmac } = require('node:crypto');
const { findEligibleUsers, findBestJobsForUsers } = require('./queries');
const { generateMatchReasons } = require('./match-reason');
const { sendJobEmail } = require('./brevo');
const sentTracker = require('./sent-tracker');

// ---------------------------------------------------------------------------
// Email auto-login magic link
// Ported from server/lib/email-token.ts and server/marketing/links.ts.
// See docs/EMAIL_AUTOLOGIN_MAGIC_LINK.md in the main repo for full details.
// ---------------------------------------------------------------------------

function b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signEmailToken(payload, secret) {
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

/**
 * Mint a signed auto-login URL that routes through /api/auth/email-link.
 * On click: server verifies token → mints fresh Supabase magic link → redirects
 * user signed-in to `redirect`. Falls back to plain UTM link if secret missing.
 */
function buildMagicLink(appUrl, userId, redirect) {
  const secret = process.env.EMAIL_LINK_SECRET;
  if (!secret) return `${appUrl}${redirect}`; // graceful fallback
  const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7-day TTL
  const token = signEmailToken({ uid: userId, redirect, exp }, secret);
  const params = new URLSearchParams({ uid: userId, t: token });
  return `${appUrl}/api/auth/email-link?${params.toString()}`;
}

function isDryRun() {
  return String(process.env.DRY_RUN).toLowerCase() !== 'false';
}

function formatSalary(min, max) {
  const m = Number(min) || 0;
  const x = Number(max) || 0;
  const k = (v) => `$${Math.round(v / 1000)}K`;
  if (m > 0 && x > 0) return `${k(m)}–${k(x)}`;
  if (m > 0) return k(m);
  if (x > 0) return k(x);
  return '';
}

function formatJobAge(lastSeenAt) {
  if (!lastSeenAt) return '';
  const days = Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'Posted today';
  if (days === 1) return 'Posted yesterday';
  if (days <= 3) return `Posted ${days} days ago`;
  return ''; // don't show age badge for anything older than 3 days
}

function firstNameFor(resumeParsed, email) {
  const name = resumeParsed && typeof resumeParsed.name === 'string' ? resumeParsed.name.trim() : '';
  if (name) return name.split(/\s+/)[0];
  const prefix = (email || '').split('@')[0] || 'there';
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

function buildPayload(user, job, reasons, firstName) {
  const appUrl = process.env.STANDOUT_APP_URL || 'https://standout.jobs';

  // Build redirect paths (UTMs baked in — these go inside the signed token)
  const jobRedirect = `/dashboard?job=${job.id}&utm_source=brevo&utm_medium=email&utm_campaign=abandonment`;
  const matchesRedirect = `/matches?utm_source=brevo&utm_medium=email&utm_campaign=abandonment`;

  // Mint auto-login magic links — user lands signed-in with no login/paywall friction.
  // Falls back to plain UTM links if EMAIL_LINK_SECRET is not set.
  const jobUrl     = buildMagicLink(appUrl, user.id, jobRedirect);
  const matchesUrl = buildMagicLink(appUrl, user.id, matchesRedirect);

  const params = {
    FIRST_NAME: firstName,
    JOB_TITLE: job.title,
    COMPANY_NAME: job.company,
    JOB_LOCATION: job.location,
    WORK_TYPE: job.work_type,
    JOB_AGE: formatJobAge(job.first_seen_at),
    MATCH_PCT: job.pct || '',
    MATCH_REASON_1: reasons[0],
    MATCH_REASON_2: reasons[1],
    MATCH_REASON_3: reasons[2],
    JOB_URL: jobUrl,
    MATCHES_URL: matchesUrl,
  };
  const salary = formatSalary(job.salary_min, job.salary_max);
  if (salary) params.SALARY_RANGE = salary;

  return {
    templateId: process.env.BREVO_TEMPLATE_ID_RESUME_TRIGGER || process.env.BREVO_TEMPLATE_ID,
    to: [{ email: user.email, name: firstName }],
    params,
  };
}

async function run() {
  const dryRun = isDryRun();
  console.log(`[abandonment-job-email] Starting run — DRY_RUN=${dryRun}`);

  let users;
  try {
    users = await findEligibleUsers();
  } catch (err) {
    console.error('[abandonment-job-email] Supabase query failed, aborting run:', err.message);
    throw err;
  }

  // The 1-2 hour window in the query ensures each user only appears once, ever.
  // No additional dedup needed — all eligible users are pending.
  const pending = users;
  console.log(`[abandonment-job-email] ${pending.length} user(s) in the 1-2 hour abandonment window.`);

  let sentCount = 0;
  let skipped = 0;

  // Batch-fetch best job for all pending users in 2 queries total
  let bestJobMap;
  try {
    bestJobMap = await findBestJobsForUsers(pending);
  } catch (err) {
    console.error('[abandonment-job-email] Batch job query failed, aborting:', err.message);
    throw err;
  }

  for (const user of pending) {
    const job = bestJobMap.get(user.id);

    if (!job) {
      skipped++;
      continue; // no suitable fresh match — skip silently
    }

    const firstName = firstNameFor(user.resume_parsed, user.email);
    const reasons = await generateMatchReasons(user.resume_parsed, job);
    const payload = buildPayload(user, job, reasons, firstName);

    if (dryRun) {
      console.log(
        `[DRY RUN] Would send to: ${user.email} — Job: ${job.title} at ${job.company} ` +
          `(rank ${job.rank}, ${job.pct}% match, ${formatJobAge(job.first_seen_at)})`
      );
      console.log('[DRY RUN] Brevo params:', JSON.stringify(payload.params, null, 2));
      sentCount++;
      continue;
    }

    // Belt-and-suspenders: skip if already sent (guards against overlapping cron runs)
    const alreadySent = await sentTracker.hasBeenSent(user.id);
    if (alreadySent) {
      console.log(`[abandonment-job-email] Already sent to ${user.email}, skipping.`);
      skipped++;
      continue;
    }

    try {
      const messageId = await sendJobEmail(payload);
      await sentTracker.markSent(user.id, job.id);
      sentCount++;
      console.log(`[abandonment-job-email] Sent to ${user.email} (messageId=${messageId}, jobId=${job.id})`);
    } catch (err) {
      console.error(`[abandonment-job-email] Brevo send failed for ${user.email}, skipping:`, err.message);
      skipped++;
    }
  }

  if (dryRun) {
    console.log(`[DRY RUN COMPLETE] Would have sent ${sentCount} emails (${skipped} skipped).`);
  } else {
    console.log(`[abandonment-job-email] Run complete — sent ${sentCount}, skipped ${skipped}.`);
  }

  return { eligible: users.length, sent: sentCount, skipped, dryRun };
}

// Vercel serverless handler — mounted at /api/abandonment-job-email
async function handler(req, res) {
  try {
    const result = await run();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[abandonment-job-email] Handler error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
module.exports.run = run;
module.exports.handler = handler;
module.exports._internals = { formatSalary, formatJobAge, firstNameFor, buildPayload };

// Run directly via `node index.js`
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[abandonment-job-email] Fatal:', err.message);
      process.exit(1);
    });
}
