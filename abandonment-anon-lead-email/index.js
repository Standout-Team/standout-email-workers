require('dotenv').config();

const { findAnonLeads, findFeaturedJobs } = require('./queries');
const { generateMatchReasons } = require('./match-reason');
const { sendJobEmail } = require('./brevo');
const { signLeadToken, decodeLeadToken } = require('./lead-token');
const sentTracker = require('./sent-tracker');

// ---------------------------------------------------------------------------
// Anonymous-lead re-engagement.
//
// These people uploaded a resume, opted in, hit the paywall and left — they
// have no account, so there is nothing to magic-link them into. Instead every
// CTA carries a signed lead token that /your-match trades for their restored
// survey + resume and one free apply.
// ---------------------------------------------------------------------------

const UTM = {
  utm_source: 'brevo',
  utm_medium: 'email',
  utm_campaign: 'anon_lead',
};

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

// Posted-age is a first_seen_at story — worker 1 names the param lastSeenAt but
// passes first_seen_at; same value, misleading name. Named honestly here.
function formatJobAge(firstSeenAt) {
  if (!firstSeenAt) return '';
  const days = Math.floor((Date.now() - new Date(firstSeenAt).getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'Posted today';
  if (days === 1) return 'Posted yesterday';
  if (days <= 3) return `Posted ${days} days ago`;
  return ''; // don't show age badge for anything older than 3 days
}

function firstNameFor(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

/**
 * Both CTAs land on /your-match carrying the same 14-day lead token; `next`
 * tells the page to continue straight to the full match list. Query string
 * only — the app's edge middleware swallows dotted path segments.
 *
 * Returns null when EMAIL_LINK_SECRET is missing: there is no useful fallback
 * URL, the landing page cannot resolve the lead without a token.
 */
function buildLinks(lead, job) {
  const secret = process.env.EMAIL_LINK_SECRET;
  if (!secret) return null;

  const appUrl = process.env.STANDOUT_APP_URL || 'https://www.usestandout.today';
  const token = signLeadToken({ sv: lead.survey_id, jb: job.id }, secret);

  const jobUrl = `${appUrl}/your-match?${new URLSearchParams({ t: token, ...UTM }).toString()}`;
  const matchesUrl = `${appUrl}/your-match?${new URLSearchParams({
    t: token,
    ...UTM,
    next: 'matches',
  }).toString()}`;

  return { token, jobUrl, matchesUrl };
}

function buildPayload(lead, job, pct, reasons, links) {
  const firstName = firstNameFor(lead.name);

  const params = {
    FIRST_NAME: firstName,
    JOB_TITLE: job.title,
    COMPANY_NAME: job.company,
    JOB_LOCATION: job.location,
    WORK_TYPE: job.work_type,
    JOB_AGE: formatJobAge(job.first_seen_at),
    MATCH_PCT: pct || '',
    MATCH_REASON_1: reasons[0],
    MATCH_REASON_2: reasons[1],
    MATCH_REASON_3: reasons[2],
    JOB_URL: links.jobUrl,
    MATCHES_URL: links.matchesUrl,
  };
  const salary = formatSalary(job.salary_min, job.salary_max);
  if (salary) params.SALARY_RANGE = salary;

  return {
    templateId: process.env.BREVO_TEMPLATE_ID_ANON_LEAD,
    to: [{ email: lead.email, name: firstName }],
    params,
  };
}

async function run() {
  const dryRun = isDryRun();
  console.log(`[abandonment-anon-lead-email] Starting run — DRY_RUN=${dryRun}`);

  let leads;
  try {
    leads = await findAnonLeads();
  } catch (err) {
    console.error('[abandonment-anon-lead-email] Supabase query failed, aborting run:', err.message);
    throw err;
  }

  if (leads.length === 0) {
    console.log('[abandonment-anon-lead-email] No eligible leads in this window.');
    return { eligible: 0, sent: 0, skipped: 0, dryRun };
  }

  let sendable;
  try {
    sendable = await findFeaturedJobs(leads);
  } catch (err) {
    console.error('[abandonment-anon-lead-email] Featured-job lookup failed, aborting:', err.message);
    throw err;
  }

  let sentCount = 0;
  let skipped = leads.length - sendable.length; // leads with no fresh match

  for (const { lead, job, pct } of sendable) {
    try {
      const links = buildLinks(lead, job);
      if (!links) {
        console.warn(
          `[abandonment-anon-lead-email] EMAIL_LINK_SECRET is not set — skipping ${lead.email_lc}; ` +
            'the landing page cannot resolve a lead without a token.'
        );
        skipped++;
        continue;
      }

      const reasons = await generateMatchReasons(lead.resume_parsed, job);
      const payload = buildPayload(lead, job, pct, reasons, links);

      if (dryRun) {
        console.log(
          `[DRY RUN] Would send to: ${lead.email} — Job: ${job.title} at ${job.company} ` +
            `(${pct}% match, ${formatJobAge(job.first_seen_at) || 'no age badge'})`
        );
        console.log(`[DRY RUN] JOB_URL: ${links.jobUrl}`);
        console.log('[DRY RUN] token payload:', JSON.stringify(decodeLeadToken(links.token)));
        console.log('[DRY RUN] Brevo params:', JSON.stringify(payload.params, null, 2));
        sentCount++;
        continue;
      }

      // One send per lead email, ever — also guards overlapping cron runs.
      const alreadySent = await sentTracker.hasBeenSent(lead.email_lc);
      if (alreadySent) {
        console.log(`[abandonment-anon-lead-email] Already sent to ${lead.email_lc}, skipping.`);
        skipped++;
        continue;
      }

      const messageId = await sendJobEmail(payload);
      await sentTracker.markSent(lead.email_lc, job.id);
      sentCount++;
      console.log(
        `[abandonment-anon-lead-email] Sent to ${lead.email_lc} (messageId=${messageId}, jobId=${job.id})`
      );
    } catch (err) {
      console.error(`[abandonment-anon-lead-email] Failed for ${lead.email_lc}, skipping:`, err.message);
      skipped++;
    }
  }

  if (dryRun) {
    console.log(`[DRY RUN COMPLETE] Would have sent ${sentCount} emails (${skipped} skipped).`);
  } else {
    console.log(`[abandonment-anon-lead-email] Run complete — sent ${sentCount}, skipped ${skipped}.`);
  }

  return { eligible: leads.length, sent: sentCount, skipped, dryRun };
}

// Vercel serverless handler — mounted at /api/abandonment-anon-lead-email
async function handler(req, res) {
  try {
    const result = await run();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[abandonment-anon-lead-email] Handler error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
module.exports.run = run;
module.exports.handler = handler;
module.exports._internals = { formatSalary, formatJobAge, firstNameFor, buildLinks, buildPayload };

// Run directly via `node index.js`
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[abandonment-anon-lead-email] Fatal:', err.message);
      process.exit(1);
    });
}
