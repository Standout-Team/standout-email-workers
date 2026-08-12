require('dotenv').config();

const {
  computeWindow,
  resolveSendCap,
  selectForSend,
  evaluateDedupSafety,
  capForDedupAction,
  findAnonLeads,
  findFeaturedJobs,
} = require('./queries');
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
//
// Two modes, both on the same hourly cron and selected purely by env vars:
// normal (the 1–2h-ago cohort) and backfill (BACKFILL_DAYS, capped by
// SEND_CAP, newest-first, drained cap-per-hour). See computeWindow in
// queries.js and the "Backfill procedure" section of the repo README.
// ---------------------------------------------------------------------------

const UTM = {
  utm_source: 'brevo',
  utm_medium: 'email',
  utm_campaign: 'anon_lead',
};

// Sent-tracker lookups are one KV round-trip each; a backfill cohort is big
// enough that doing them serially would eat the invocation.
const KV_CHECK_CHUNK = 20;

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

/**
 * Split the cohort on the persistent sent-tracker, preserving order. This runs
 * in **both** modes and before the send cap, so (a) a dry run reports the true
 * remaining cohort rather than re-counting a partially drained one, and (b) each
 * run spends its cap on leads that can actually be mailed.
 *
 * A tracker lookup that throws defers the lead to the next run — the failure
 * mode of guessing "unsent" is a duplicate marketing email.
 */
async function partitionBySentTracker(leads) {
  const unsent = [];
  let alreadySent = 0;
  let trackerErrors = 0;

  for (let i = 0; i < leads.length; i += KV_CHECK_CHUNK) {
    const chunk = leads.slice(i, i + KV_CHECK_CHUNK);
    const states = await Promise.all(
      chunk.map(async (lead) => {
        try {
          return (await sentTracker.hasBeenSent(lead.email_lc)) ? 'sent' : 'unsent';
        } catch (err) {
          console.error(
            `[abandonment-anon-lead-email] sent-tracker lookup failed for ${lead.email_lc}, deferring:`,
            err.message
          );
          return 'error';
        }
      })
    );

    states.forEach((state, idx) => {
      if (state === 'unsent') unsent.push(chunk[idx]);
      else if (state === 'sent') alreadySent++;
      else trackerErrors++;
    });
  }

  return { unsent, alreadySent, trackerErrors };
}

async function run() {
  const dryRun = isDryRun();

  const win = computeWindow(Date.now(), process.env);
  if (win.warning) console.warn(`[abandonment-anon-lead-email] ${win.warning}`);
  const { cap: requestedCap, warning: capWarning } = resolveSendCap(process.env, win.mode);
  if (capWarning) console.warn(`[abandonment-anon-lead-email] ${capWarning}`);

  // Dedup safety, before any Supabase or Brevo work. The sent-tracker falls
  // back to a per-process Set when the KV binding is absent, and on Vercel that
  // Set is wiped by every cold start — dedup off, normal mode uncapped, the same
  // marketing email to the same real people every hour. Fail closed there; the
  // cron erroring out is loud within the hour and sends nothing. Everywhere the
  // fallback is legitimate (dry runs, a local drain) warn hard and cap instead.
  const durable = sentTracker.isDurable();
  const dedup = evaluateDedupSafety({ durable, dryRun, onVercel: !!process.env.VERCEL });
  const dedupLabel = durable ? 'durable' : 'non-durable';

  if (dedup.action === 'throw') {
    console.error(`[abandonment-anon-lead-email] ${'='.repeat(72)}`);
    console.error(`[abandonment-anon-lead-email] REFUSING TO RUN — NON-DURABLE DEDUP ON A REAL SEND`);
    console.error(`[abandonment-anon-lead-email] ${dedup.reason}`);
    console.error(`[abandonment-anon-lead-email] ${'='.repeat(72)}`);
    throw new Error(`Refusing to send with non-durable dedup: ${dedup.reason}`);
  }

  const cap = capForDedupAction(requestedCap, dedup.action);
  const capLabel = cap === null ? 'none' : String(cap);

  if (dedup.action === 'warn') {
    console.warn(`[abandonment-anon-lead-email] ${'='.repeat(72)}`);
    console.warn(`[abandonment-anon-lead-email] NON-DURABLE DEDUP — ${dedup.reason}`);
    if (cap !== requestedCap) {
      console.warn(
        `[abandonment-anon-lead-email] Send cap forced to ${capLabel} for this run ` +
          `(requested ${requestedCap === null ? 'none' : requestedCap}).`
      );
    }
    console.warn(`[abandonment-anon-lead-email] ${'='.repeat(72)}`);
  }

  const summary = {
    mode: win.mode,
    backfillDays: win.backfillDays,
    windowStart: win.startIso,
    windowEnd: win.endIso,
    cap,
    dedup: dedupLabel,
    eligible: 0,
    alreadySent: 0,
    remaining: 0,
    selected: 0,
    deferred: 0,
    sent: 0,
    skipped: 0,
    dryRun,
  };

  console.log(
    `[abandonment-anon-lead-email] Starting run — mode=${win.mode}` +
      (win.backfillDays ? ` (BACKFILL_DAYS=${win.backfillDays})` : '') +
      `, window=${win.startIso} → ${win.endIso}, cap=${capLabel}, dedup=${dedupLabel}, ` +
      `DRY_RUN=${dryRun}`
  );

  let eligible;
  try {
    eligible = await findAnonLeads(win);
  } catch (err) {
    console.error('[abandonment-anon-lead-email] Supabase query failed, aborting run:', err.message);
    throw err;
  }
  summary.eligible = eligible.length;

  if (eligible.length === 0) {
    console.log('[abandonment-anon-lead-email] No eligible leads in this window.');
    return summary;
  }

  const { unsent, alreadySent, trackerErrors } = await partitionBySentTracker(eligible);
  const { selected, deferred } = selectForSend(unsent, cap);
  Object.assign(summary, {
    alreadySent,
    remaining: unsent.length,
    selected: selected.length,
    deferred,
  });

  console.log(
    `[abandonment-anon-lead-email] ${eligible.length} eligible after exclusions — ` +
      `${alreadySent} already sent, ${unsent.length} remaining, ${selected.length} selected this run ` +
      `(cap=${capLabel}, ${deferred} left for later runs).`
  );

  if (selected.length === 0) {
    console.log('[abandonment-anon-lead-email] Nothing left to send in this window.');
    summary.skipped = trackerErrors;
    return summary;
  }

  let sendable;
  try {
    sendable = await findFeaturedJobs(selected);
  } catch (err) {
    console.error('[abandonment-anon-lead-email] Featured-job lookup failed, aborting:', err.message);
    throw err;
  }

  let sentCount = 0;
  // leads with a failed tracker lookup + leads with no fresh match
  let skipped = trackerErrors + (selected.length - sendable.length);

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

      // One send per lead email, ever. partitionBySentTracker already dropped
      // the known-sent; this re-check closes the window between that partition
      // and this send (overlapping cron runs, a long backfill invocation).
      const alreadyMailed = await sentTracker.hasBeenSent(lead.email_lc);
      if (alreadyMailed) {
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

  Object.assign(summary, { sent: sentCount, skipped });

  if (dryRun) {
    console.log(
      `[DRY RUN COMPLETE] Would send ${sentCount} of ${unsent.length} eligible — ` +
        `cap=${capLabel}; ${eligible.length} in window after exclusions, ${alreadySent} already sent, ` +
        `${deferred} left for later runs, ${skipped} skipped.`
    );
  } else {
    // `remaining` is the number the operator watches to decide when to unset
    // BACKFILL_DAYS. It plateaus rather than reaching 0 when the tail has no
    // fresh job match — those leads are unmailable, not pending.
    console.log(
      `[abandonment-anon-lead-email] Run complete — mode=${win.mode}, sent ${sentCount}, ` +
        `skipped ${skipped}, ${Math.max(0, unsent.length - sentCount)} remaining after this run.`
    );
  }

  return summary;
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
