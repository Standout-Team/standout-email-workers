require('dotenv').config();

const {
  computeWindow,
  resolveSendCap,
  resolveMatchConcurrency,
  resolveRunBudgetMs,
  balancedRoleMatchEnabled,
  selectForSend,
  evaluateDedupSafety,
  capForDedupAction,
  parseTargetEmails,
  filterToTargets,
  findAnonLeads,
  findFeaturedJobs,
  isStillUnpaid,
} = require('./queries');
const { generateMatchReasons } = require('./match-reason');
const { sendJobEmail } = require('./brevo');
const { signLeadToken, decodeLeadToken } = require('./lead-token');
const sentTracker = require('./sent-tracker');
const { resolveStage, resolveTemplateId, STAGE_ORDER, capForStage } = require('./stages');
const { fetchTailoredBullets, tailoringConfigured } = require('./tailoring');

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
//
// TARGET_EMAILS is orthogonal to both: it narrows whichever window is in force
// to a named list, for QA and support resends. It is a filter, never a bypass —
// every rail (exclusions, sent-tracker, cap, DRY_RUN, the fail-closed dedup
// guard) still applies to a targeted run. See the "Targeted send" section of
// the README.
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

function buildPayload(lead, job, pct, reasons, links, stage, bullets) {
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

  // Tailored bullets, for the stage whose email is built from them. Sent as
  // both a list and numbered scalars: Brevo templates handle {{params.X}}
  // reliably, while iterating a list is fiddlier. Absent keys simply render
  // empty, so a two-bullet result leaves BULLET_3 blank rather than breaking.
  if (Array.isArray(bullets) && bullets.length) {
    params.TAILORED_BULLETS = bullets;
    bullets.forEach((b, i) => { params[`BULLET_${i + 1}`] = b; });
    params.BULLET_COUNT = bullets.length;
  }

  return {
    // Per stage, not per worker: each email in the sequence has its own Brevo
    // template. run() has already refused to start if this is unset, so the
    // null case cannot reach a send.
    templateId: resolveTemplateId(stage, process.env),
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
 *
 * `alreadySentEmails` names the hits. Under KV a hit is completely silent (only
 * the in-memory fallback logs one), and "already mailed, ever" is the single
 * most likely outcome of a support resend request — so a targeted run has to be
 * able to say which target it was.
 */
async function partitionBySentTracker(leads, stage) {
  const unsent = [];
  const alreadySentEmails = [];
  let alreadySent = 0;
  let trackerErrors = 0;

  for (let i = 0; i < leads.length; i += KV_CHECK_CHUNK) {
    const chunk = leads.slice(i, i + KV_CHECK_CHUNK);
    const states = await Promise.all(
      chunk.map(async (lead) => {
        try {
          return (await sentTracker.hasBeenSent(lead.email_lc, stage)) ? 'sent' : 'unsent';
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
      else if (state === 'sent') {
        alreadySent++;
        alreadySentEmails.push(chunk[idx].email_lc);
      } else trackerErrors++;
    });
  }

  return { unsent, alreadySent, alreadySentEmails, trackerErrors };
}

async function run(options = {}) {
  // The budget clock starts HERE, not at the match stage: what the platform
  // kills at maxDuration is the whole invocation, so every read before the
  // match fan-out — surveys, exclusions, the KV partition — is time the match
  // stage no longer has.
  const runStartMs = Date.now();
  const dryRun = isDryRun();

  // Which email in the sequence this invocation is sending. One cron entry per
  // stage, each pinning EMAIL_STAGE; an unset value is the 1h email, so the
  // existing cron keeps behaving exactly as it did before the sequence existed.
  // Explicit argument first, EMAIL_STAGE second. The argument is what makes
  // three hourly crons possible: Vercel cron entries carry only a path and a
  // schedule — there are NO per-cron environment variables — so three crons
  // sharing one env var would all run the same stage. Each stage gets its own
  // thin entrypoint under api/ that names its stage here instead.
  const stage = resolveStage(options.stage ?? process.env.EMAIL_STAGE);
  const templateId = resolveTemplateId(stage, process.env);
  console.log(
    `[abandonment-anon-lead-email] Stage ${stage.id} (${stage.label}) — ` +
      `Brevo template ${templateId ?? '(unset)'}.`
  );

  const win = computeWindow(runStartMs, process.env, stage);
  if (win.warning) console.warn(`[abandonment-anon-lead-email] ${win.warning}`);
  const { cap: requestedCap, warning: capWarning } = resolveSendCap(process.env, win.mode);
  if (capWarning) console.warn(`[abandonment-anon-lead-email] ${capWarning}`);
  const { concurrency, warning: concurrencyWarning } = resolveMatchConcurrency(process.env);
  if (concurrencyWarning) console.warn(`[abandonment-anon-lead-email] ${concurrencyWarning}`);
  const { budgetMs, warning: budgetWarning } = resolveRunBudgetMs(process.env);
  if (budgetWarning) console.warn(`[abandonment-anon-lead-email] ${budgetWarning}`);
  // The matcher MODE, resolved once for the whole run — every lead in a run is
  // ranked the same way. It must match the main app's MATCH_ROLE_FANOUT, or the
  // job this email features and the top job of the feed the lead lands in are
  // chosen by different matchers. Logged below and returned in the summary so a
  // divergence is diagnosable from the logs alone.
  const balanced = balancedRoleMatchEnabled(process.env);

  // TARGET_EMAILS — QA/support targeted send. Parsed and announced before the
  // dedup guard so the banner lands on every run while it is set, including the
  // ones that abort. Leaving it set is a silent outage of the whole funnel, so
  // this banner IS the alarm: it has to be the loudest thing in the log.
  const targeting = parseTargetEmails(process.env);
  if (targeting.active) {
    const list = targeting.targets.length > 0 ? targeting.targets.join(', ') : '(nobody)';
    console.warn(`[abandonment-anon-lead-email] ${'='.repeat(72)}`);
    console.warn(
      `[abandonment-anon-lead-email] === TARGETED MODE ACTIVE — only ${list} can be emailed; ` +
        'real leads are NOT being sent ==='
    );
    console.warn(
      '[abandonment-anon-lead-email] TARGET_EMAILS is set, so every other lead in this window is ' +
        'being withheld and the funnel is dark. UNSET TARGET_EMAILS AND REDEPLOY the moment the ' +
        'QA/support send is done.'
    );
    if (targeting.invalid.length > 0) {
      console.warn(
        `[abandonment-anon-lead-email] TARGET_EMAILS: ignoring ${targeting.invalid.length} ` +
          `entr${targeting.invalid.length === 1 ? 'y' : 'ies'} that ${
            targeting.invalid.length === 1 ? 'is not a' : 'are not'
          } plausible email address${targeting.invalid.length === 1 ? '' : 'es'} — ` +
          `${targeting.invalid.join(', ')}.`
      );
    }
    if (targeting.targets.length === 0) {
      console.warn(
        '[abandonment-anon-lead-email] TARGET_EMAILS parsed to ZERO valid addresses — this run ' +
          'can send to nobody at all. Fix the list, or unset it to resume normal sending.'
      );
    }
    console.warn(`[abandonment-anon-lead-email] ${'='.repeat(72)}`);
  }

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

  // Checked after the dedup guard on purpose: that rail protects the list from
  // being re-mailed and stays the first thing to trip. This one only protects
  // the run from a deploy mistake. A dry run needs no template, so it warns
  // instead — that is how you rehearse a new stage before its template exists.
  if (!templateId) {
    const detail =
      `Stage "${stage.id}" (${stage.label}) has no Brevo template — set ${stage.templateEnv}. ` +
      `Known stages: ${STAGE_ORDER.join(', ')}.`;
    if (!dryRun) {
      // Refuse the whole run rather than let Brevo reject each send one at a
      // time: a cohort of individual failures buries the real cause. Nothing is
      // marked sent, so the next run recovers once the env var lands.
      throw new Error(detail);
    }
    console.warn(`[abandonment-anon-lead-email] ${detail} Dry run continues.`);
  }

  // Same shape as the template guard, and for the same reason: a stage whose
  // email is BUILT from tailored bullets cannot send a single one without the
  // endpoint that produces them, so discovering that per-lead would bury the
  // cause under a cohort of identical deferrals.
  if (stage.requiresTailoring && !tailoringConfigured(process.env)) {
    const detail =
      `Stage "${stage.id}" (${stage.label}) is built from tailored bullets and needs ` +
      'TAILORING_ENDPOINT_URL and TAILORING_ENDPOINT_SECRET.';
    if (!dryRun) throw new Error(detail);
    console.warn(`[abandonment-anon-lead-email] ${detail} Dry run continues without bullets.`);
  }

  // Two ceilings, both of which can only tighten: the dedup guard's, and the
  // stage's own. The 48h email pays for an LLM call per recipient, so it cannot
  // work the whole cohort the way a template-only email can.
  const dedupCap = capForDedupAction(requestedCap, dedup.action);
  const cap = capForStage(dedupCap, stage);
  if (cap !== dedupCap) {
    console.log(
      `[abandonment-anon-lead-email] Stage ${stage.id} caps this run at ${cap} ` +
        `(was ${dedupCap === null ? 'uncapped' : dedupCap}). Leads past the cap are left for later runs.`
    );
  }
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
    targeted: targeting.active,
    targetCount: targeting.targets.length,
    withheld: 0,
    eligible: 0,
    alreadySent: 0,
    remaining: 0,
    selected: 0,
    deferred: 0,
    deferredByBudget: 0,
    sent: 0,
    skipped: 0,
    balanced,
    dryRun,
  };

  console.log(
    `[abandonment-anon-lead-email] Starting run — mode=${win.mode}` +
      (win.backfillDays ? ` (BACKFILL_DAYS=${win.backfillDays})` : '') +
      `, window=${win.startIso} → ${win.endIso}, cap=${capLabel}, dedup=${dedupLabel}, ` +
      `targeted=${targeting.active}` +
      (targeting.active ? ` (${targeting.targets.length} target(s))` : '') +
      `, matchConcurrency=${concurrency}, budget=${budgetMs}ms, ` +
      `roleFanout=${balanced ? 'on' : 'off'}, DRY_RUN=${dryRun}`
  );

  let eligible;
  try {
    eligible = await findAnonLeads(win, targeting, stage);
  } catch (err) {
    console.error('[abandonment-anon-lead-email] Supabase query failed, aborting run:', err.message);
    throw err;
  }

  // Targeted filter: after the audience is resolved, before the sent-tracker
  // partition — so the tracker, the cap and every downstream rail see exactly
  // the leads this run may actually mail, and their counts stay honest.
  if (targeting.active) {
    const { selected: onTarget, dropped, missing } = filterToTargets(eligible, targeting.targets);

    for (const email of missing) {
      console.warn(
        `[abandonment-anon-lead-email] TARGET NOT FOUND: ${email} is not among this run's ` +
          `${eligible.length} candidate(s) for mode=${win.mode} window ${win.startIso} → ` +
          `${win.endIso}. Either their survey falls outside that window — raise BACKFILL_DAYS ` +
          'to reach an older lead — or they fail the audience criteria (marketing opt-in, ' +
          'anonymous with no account, a parsed resume carrying a plausible email). If they were ' +
          'dropped by the exclusion set instead, the TARGETED MODE line above names them.'
      );
    }

    if (dropped.length > 0) {
      console.warn(
        `[abandonment-anon-lead-email] TARGETED MODE: withholding ${dropped.length} real lead(s) ` +
          'that this run would otherwise have emailed.'
      );
    }

    summary.withheld = dropped.length;
    eligible = onTarget;
  }

  summary.eligible = eligible.length;

  if (eligible.length === 0) {
    console.log(
      targeting.active
        ? '[abandonment-anon-lead-email] No targeted lead is eligible in this window — see the ' +
            'TARGET NOT FOUND warning(s) above for which one and why.'
        : '[abandonment-anon-lead-email] No eligible leads in this window.'
    );
    return summary;
  }

  const { unsent, alreadySent, alreadySentEmails, trackerErrors } = await partitionBySentTracker(eligible, stage);

  // Under KV the sent-tracker drops a lead without a word. In targeted mode
  // every lead here IS a target, so a hit is the answer to "why did my resend
  // do nothing" — one send per lead email, ever, and that rail holds here too.
  if (targeting.active && alreadySentEmails.length > 0) {
    console.warn(
      `[abandonment-anon-lead-email] TARGETED MODE: ${alreadySentEmails.length} target(s) were ` +
        `already mailed and will not be mailed again — ${alreadySentEmails.join(', ')}. The ` +
        'sent-tracker is one-send-per-lead-email forever; targeted mode does not reset it.'
    );
  }

  const { selected, deferred } = selectForSend(unsent, cap);
  Object.assign(summary, {
    alreadySent,
    remaining: unsent.length,
    selected: selected.length,
    deferred,
  });

  console.log(
    `[abandonment-anon-lead-email] ${eligible.length} eligible after exclusions` +
      (targeting.active ? ` and targeting (${summary.withheld} real lead(s) withheld)` : '') +
      ` — ${alreadySent} already sent, ${unsent.length} remaining, ${selected.length} selected ` +
      `this run (cap=${capLabel}, ${deferred} left for later runs).`
  );

  if (selected.length === 0) {
    console.log('[abandonment-anon-lead-email] Nothing left to send in this window.');
    summary.skipped = trackerErrors;
    return summary;
  }

  let featured;
  try {
    featured = await findFeaturedJobs(selected, { runStartMs, budgetMs, concurrency, balanced });
  } catch (err) {
    console.error('[abandonment-anon-lead-email] Featured-job lookup failed, aborting:', err.message);
    throw err;
  }

  const sendable = featured.matched;
  const deferredByBudget = featured.deferredByBudget;
  summary.deferredByBudget = deferredByBudget;

  // A budget cut is not a failure and not a skip: those leads were never
  // attempted, nothing marked them sent, and the KV dedup hands them straight
  // back to the next hourly run.
  if (deferredByBudget > 0) {
    console.warn(
      `[abandonment-anon-lead-email] RUN BUDGET reached after ${Date.now() - runStartMs}ms of ` +
        `${budgetMs}ms — ${selected.length - deferredByBudget} lead(s) processed, ` +
        `${deferredByBudget} deferred to the next run (not sent, not marked; the sent-tracker ` +
        're-offers them next hour). Lower SEND_CAP if this repeats.'
    );
  }

  let sentCount = 0;
  let tailoringDeferred = 0;
  // leads with a failed tracker lookup + leads with no fresh match (leads the
  // budget deferred are neither — they are still pending)
  let skipped = trackerErrors + (selected.length - sendable.length - deferredByBudget);

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

      // Skip-and-retry, not degrade (owner decision 2026-08-21). Nothing is
      // marked, so the next hourly run re-offers this lead — which only works
      // because this stage's window spans three hours. See stages.js.
      let bullets = null;
      if (stage.requiresTailoring) {
        bullets = await fetchTailoredBullets(lead, job, process.env);
        if (!bullets && !dryRun) {
          tailoringDeferred++;
          continue;
        }
      }

      const payload = buildPayload(lead, job, pct, reasons, links, stage, bullets);

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

      // One send per lead email per stage, ever. partitionBySentTracker
      // already dropped the known-sent; this re-check closes the window between
      // that partition and this send (overlapping cron runs, a long backfill).
      const alreadyMailed = await sentTracker.hasBeenSent(lead.email_lc, stage);
      if (alreadyMailed) {
        console.log(`[abandonment-anon-lead-email] Already sent to ${lead.email_lc}, skipping.`);
        skipped++;
        continue;
      }

      // The cohort's exclusions were resolved when the run began. A lead who
      // paid since then must not get an abandonment email, and across a 24h or
      // 48h stage that gap is the whole point — so re-ask right before we send.
      // A failed check defers rather than sends: nothing is marked, so the next
      // hourly run picks them up again.
      let stillUnpaid;
      try {
        stillUnpaid = await isStillUnpaid(lead);
      } catch (err) {
        console.warn(
          `[abandonment-anon-lead-email] paid re-check failed for ${lead.email_lc}, deferring:`,
          err.message
        );
        skipped++;
        continue;
      }
      if (!stillUnpaid) {
        console.log(
          `[abandonment-anon-lead-email] ${lead.email_lc} converted since the cohort was built, skipping.`
        );
        skipped++;
        continue;
      }

      const messageId = await sendJobEmail(payload);
      await sentTracker.markSent(lead.email_lc, job.id, stage);
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

  // Budget-deferred leads are pending, so they belong with the cap-deferred in
  // "left for later runs" rather than in `skipped`.
  const budgetNote = deferredByBudget > 0 ? ` (+${deferredByBudget} deferred by the run budget)` : '';
  // Tailoring deferrals are pending too — unmarked, so the next run re-offers
  // them. Surfaced in the summary rather than left to a grep: a stage quietly
  // deferring its whole cohort every hour is exactly the kind of failure that
  // otherwise looks like "no eligible leads".
  const tailoringNote =
    tailoringDeferred > 0 ? ` (+${tailoringDeferred} deferred, tailoring unavailable)` : '';
  summary.tailoringDeferred = tailoringDeferred;

  if (dryRun) {
    console.log(
      `[DRY RUN COMPLETE] Would send ${sentCount} of ${unsent.length} eligible — ` +
        `cap=${capLabel}; ${eligible.length} in window after exclusions, ${alreadySent} already sent, ` +
        `${deferred} left for later runs${budgetNote}${tailoringNote}, ${skipped} skipped.`
    );
  } else {
    // `remaining` is the number the operator watches to decide when to unset
    // BACKFILL_DAYS. It plateaus rather than reaching 0 when the tail has no
    // fresh job match — those leads are unmailable, not pending.
    console.log(
      `[abandonment-anon-lead-email] Run complete — mode=${win.mode}, sent ${sentCount}, ` +
        `skipped ${skipped}, ${Math.max(0, unsent.length - sentCount)} remaining after this ` +
        `run${budgetNote}${tailoringNote}.`
    );
  }

  return summary;
}

/**
 * Builds the Vercel serverless handler for one stage.
 *
 * Stage resolution, in order: the stage this handler was built for, then
 * ?stage= on the request, then EMAIL_STAGE. The query param exists for manual
 * invocation — Vercel only fires crons on production deployments, so a staging
 * run is someone POSTing this endpoint by hand and it needs to be able to pick
 * a stage without a redeploy. An unknown value throws rather than falling back
 * to the 1h email, which would mail the wrong copy on the wrong schedule.
 */
function createHandler(stageId) {
  return async function handler(req, res) {
    const requested =
      stageId ??
      (req && req.query && typeof req.query.stage === 'string' ? req.query.stage : undefined);
    try {
      const result = await run({ stage: requested });
      res.status(200).json({ ok: true, ...result });
    } catch (err) {
      console.error('[abandonment-anon-lead-email] Handler error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  };
}

// Default export stays the 1h email so the existing cron path is unchanged.
const handler = createHandler(null);

module.exports = handler;
module.exports.run = run;
module.exports.handler = handler;
module.exports.createHandler = createHandler;
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
