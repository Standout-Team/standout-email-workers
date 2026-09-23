/**
 * cart-recovery — one hourly worker for the whole six-email discount sequence.
 *
 * Replaces every earlier abandonment flow (anon-lead 4h/24h/48h/72h and the
 * post-apply follow-up), which are switched off. Their source is kept in this
 * repo for reference; their crons are gone.
 *
 * Each run: load everyone in the sequence window (audience.js), recompute each
 * person's fixed schedule (schedule.js), and send at most one stage per person
 * — the one currently due and not yet sent. Every stage has a 3-hour retry
 * window (three hourly runs); after that, or once its offer's deadline is
 * near, the stage is skipped rather than sent late.
 *
 * SAFETY RAILS, in order:
 *   CART_RECOVERY_ENABLED !== "true"      → no-op.
 *   DRY_RUN !== "false"                   → count only, send nothing, write nothing.
 *   CART_RECOVERY_CUTOVER missing/invalid → refuse (would otherwise mail history).
 *   live without durable KV               → refuse (dedup would reset per instance).
 *   live without all six template ids     → refuse.
 *   SEND_CAP (default 500)                → hard ceiling per run.
 *   Paid / suppressed re-check immediately before every send; a failed check
 *   defers the send (nothing is marked, the next run retries).
 *
 * HOLDOUT: a deterministic CART_RECOVERY_HOLDOUT_PCT (default 15) of addresses,
 * by hash, get no emails; they are recorded with the same schedule so the
 * sequence's lift can be measured against them.
 */
const { createHash } = require('node:crypto');
const { STAGES, OFFERS, templateIdFor } = require('./stages');
const { computeSchedule, isInSendWindow, formatDeadline, MIN_GAP_MS, HOUR } = require('./schedule');
const audience = require('./audience');
const store = require('./kv');
const { signRecoveryToken } = require('./token');

const RETRY_WINDOW_MS = 3 * HOUR;
/** Don't send an offer email in the last 30 minutes of its offer. */
const DEADLINE_GUARD_MS = 30 * 60 * 1000;
const DEFAULT_TZ = 'America/New_York';
const DEFAULT_SEND_CAP = 500;
const UTM_CAMPAIGN = 'cart_recovery_v2';

function isDryRun(env) {
  return String(env.DRY_RUN).toLowerCase() !== 'false';
}

function appBaseUrl(env) {
  const raw = typeof env.STANDOUT_APP_URL === 'string' ? env.STANDOUT_APP_URL.trim() : '';
  return (raw || 'https://www.usestandout.today').replace(/\/+$/, '');
}

function holdoutPct(env) {
  const n = Number(env.CART_RECOVERY_HOLDOUT_PCT ?? 15);
  return Number.isFinite(n) ? Math.min(50, Math.max(0, Math.floor(n))) : 15;
}

function armFor(emailLc, pct, salt = 'cart_recovery_v2') {
  const h = createHash('sha256').update(`${salt}:${emailLc}`).digest();
  return h.readUInt32BE(0) % 100 < pct ? 'holdout' : 'treatment';
}

function sendCap(env) {
  const n = Number(env.SEND_CAP);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SEND_CAP;
}

/**
 * Which stage (if any) is due for this person now. Pure.
 * Returns { stage, slot } or { status: 'none' | 'finished' }.
 */
function dueStage(schedule, nowMs) {
  for (const stage of STAGES) {
    const slot = schedule.stages[stage.id];
    if (!slot) continue;
    if (nowMs < slot.dueMs) return { status: 'none' };
    const windowEnd = Math.min(slot.dueMs + RETRY_WINDOW_MS, slot.expMs - DEADLINE_GUARD_MS);
    if (nowMs < windowEnd) return { stage, slot };
  }
  return { status: 'finished' };
}

function offerUrl({ env, token, stage }) {
  const q = new URLSearchParams({
    t: token,
    utm_source: 'brevo',
    utm_medium: 'email',
    utm_campaign: UTM_CAMPAIGN,
    utm_content: stage.id,
  });
  return `${appBaseUrl(env)}/special-offer?${q.toString()}`;
}

function tzAbbrev(ms, tz) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date(ms))
    .find((x) => x.type === 'timeZoneName');
  return part ? part.value : '';
}

function buildParams({ lead, stage, slot, tz, env, freeApplyUnused }) {
  const offer = OFFERS[stage.offer];
  const token = signRecoveryToken(
    { sv: lead.survey_id, off: offer.key, st: stage.n, exp: Math.floor(slot.expMs / 1000) },
    env.EMAIL_LINK_SECRET
  );
  return {
    FIRSTNAME: lead.first_name || '',
    OFFER_URL: offerUrl({ env, token, stage }),
    DEADLINE: formatDeadline(slot.expMs, tz),
    TZ: tzAbbrev(slot.expMs, tz),
    OFFER_FIRST_PRICE: offer.firstPrice,
    OFFER_RENEWAL_PRICE: offer.renewalPrice,
    FREE_APPLY_UNUSED: freeApplyUnused ? true : '',
  };
}

function preflight(env) {
  if (String(env.CART_RECOVERY_ENABLED).toLowerCase() !== 'true') return { ok: false, status: 'disabled' };
  const dryRun = isDryRun(env);
  const cutoverMs = Date.parse(env.CART_RECOVERY_CUTOVER || '');
  const problems = [];
  if (!Number.isFinite(cutoverMs)) problems.push('CART_RECOVERY_CUTOVER is missing or not an ISO timestamp');
  if (!env.EMAIL_LINK_SECRET) problems.push('EMAIL_LINK_SECRET is missing');
  if (!dryRun) {
    if (!store.isDurable()) problems.push('Vercel KV is not configured (dedup would not be durable)');
    const missing = STAGES.filter((s) => !templateIdFor(s, env)).map((s) => s.templateEnv);
    if (missing.length) problems.push(`missing template ids: ${missing.join(', ')}`);
    if (!env.BREVO_API_KEY) problems.push('BREVO_API_KEY is missing');
  }
  if (problems.length) return { ok: false, status: 'refused', problems, dryRun };
  return { ok: true, dryRun, cutoverMs };
}

async function run(options = {}) {
  const env = options.env || process.env;
  const nowMs = options.nowMs ?? Date.now();
  const deps = {
    findLeads: audience.findLeads,
    exclusionReason: audience.exclusionReason,
    freeApplyUnused: audience.freeApplyUnused,
    send: (...a) => require('./brevo').sendStageEmail(...a),
    ...(options.deps || {}),
  };

  const pre = preflight(env);
  if (!pre.ok) {
    if (pre.status === 'refused') console.error('[cart-recovery] refusing to run:', pre.problems.join('; '));
    return { status: pre.status, problems: pre.problems };
  }
  const { dryRun, cutoverMs } = pre;
  const tz = env.CART_RECOVERY_TZ || DEFAULT_TZ;
  const pct = holdoutPct(env);
  const cap = sendCap(env);
  const usOnly = String(env.CART_RECOVERY_US_ONLY).toLowerCase() === 'true';

  const leads = await deps.findLeads({ nowMs, cutoverMs, usOnly });
  const summary = {
    status: 'ok',
    dry_run: dryRun,
    tz,
    holdout_pct: pct,
    cutover: new Date(cutoverMs).toISOString(),
    in_window: leads.length,
    registered: leads.filter((l) => l.registered).length,
    due: 0,
    would_send: {},
    sent: {},
    holdout: {},
    skipped: {},
    errors: 0,
  };
  const bump = (bucket, key) => {
    summary[bucket][key] = (summary[bucket][key] || 0) + 1;
  };
  let sentThisRun = 0;

  for (const lead of leads) {
    const schedule = computeSchedule(lead.anchor_ms, tz);
    const pick = dueStage(schedule, nowMs);
    if (!pick.stage) continue;
    const { stage, slot } = pick;
    summary.due++;

    try {
      const enr = await store.get(store.keys.enrollment(lead.email_lc));
      if (enr && enr.sv !== lead.survey_id) {
        bump('skipped', 'enrolled_other_survey');
        continue;
      }
      if (await store.get(store.keys.sent(stage.n, lead.email_lc))) {
        bump('skipped', 'already_sent');
        continue;
      }
      if (!isInSendWindow(nowMs, tz)) {
        bump('skipped', 'quiet_hours');
        continue;
      }
      const last = Number(await store.get(store.keys.last(lead.email_lc)));
      if (Number.isFinite(last) && last > 0 && nowMs - last < MIN_GAP_MS) {
        bump('skipped', 'min_spacing');
        continue;
      }

      let reason;
      try {
        reason = await deps.exclusionReason(lead);
      } catch (err) {
        console.warn(`[cart-recovery] exclusion check failed, deferring: ${err.message}`);
        bump('skipped', 'check_failed');
        continue;
      }
      if (reason) {
        bump('skipped', reason);
        continue;
      }

      const arm = enr?.arm || armFor(lead.email_lc, pct);
      if (arm === 'holdout') {
        bump('holdout', stage.id);
        if (!dryRun) {
          await store.setNx(store.keys.enrollment(lead.email_lc), {
            sv: lead.survey_id, anchor: lead.anchor_ms, arm, at: nowMs, registered: lead.registered,
          });
          await store.set(store.keys.sent(stage.n, lead.email_lc), { at: nowMs, holdout: true });
        }
        continue;
      }

      if (sentThisRun >= cap) {
        bump('skipped', 'send_cap');
        continue;
      }

      const params = buildParams({
        lead, stage, slot, tz, env,
        freeApplyUnused: await deps.freeApplyUnused(lead),
      });

      if (dryRun) {
        bump('would_send', stage.id);
        sentThisRun++;
        continue;
      }

      if (!enr) {
        await store.setNx(store.keys.enrollment(lead.email_lc), {
          sv: lead.survey_id, anchor: lead.anchor_ms, arm, at: nowMs, registered: lead.registered,
        });
      }
      const messageId = await deps.send({
        templateId: templateIdFor(stage, env),
        to: [{ email: lead.email, ...(lead.first_name ? { name: lead.first_name } : {}) }],
        params,
        tags: [UTM_CAMPAIGN, stage.id],
      });
      await store.set(store.keys.sent(stage.n, lead.email_lc), { at: nowMs, messageId: messageId || null });
      await store.set(store.keys.last(lead.email_lc), nowMs);
      bump('sent', stage.id);
      sentThisRun++;
    } catch (err) {
      summary.errors++;
      console.error(`[cart-recovery] stage ${stage.id} failed for survey ${lead.survey_id}: ${err.message}`);
    }
  }

  console.log('[cart-recovery] run summary', JSON.stringify(summary));
  return summary;
}

/**
 * Vercel handler. Vercel cron sends `Authorization: Bearer $CRON_SECRET`.
 * When CRON_SECRET is set the header is required; when it is not set the
 * endpoint only ever runs in dry-run mode.
 */
async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = (req && req.headers && req.headers.authorization) || '';
  if (secret && auth !== `Bearer ${secret}`) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  try {
    const env = secret ? process.env : { ...process.env, DRY_RUN: 'true' };
    const result = await run({ env });
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cart-recovery] handler error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
module.exports.handler = handler;
module.exports.run = run;
module.exports._internals = { dueStage, buildParams, armFor, preflight, offerUrl, isDryRun, RETRY_WINDOW_MS };
