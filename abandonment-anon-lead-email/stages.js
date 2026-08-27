/**
 * stages.js
 *
 * The abandonment sequence as data: one entry per email, shared by the worker
 * (`index.js`), the audience query (`queries.js`) and the dedup store
 * (`sent-tracker.js`). It lives in its own module so those three can all read
 * it without importing each other.
 *
 * Adding a stage is adding an entry here plus its Brevo template — nothing
 * else in the worker knows the sequence's shape.
 *
 * Two fields are load-bearing beyond their obvious meaning:
 *
 *   kvKey       Namespaces the send-once receipt. `first` keeps the bare
 *               `anon_lead_sent` it has used since launch. RENAMING IT MAKES
 *               EVERY LEAD EVER MAILED LOOK UNMAILED, and Email 1 re-fires
 *               across the entire history on the next hourly tick. The spec
 *               calls this key `anon_lead_1h_sent`; the spec is wrong.
 *
 *   delayMs     How long after the survey was created this email goes out, and
 *               therefore which slice of surveys each hourly run considers.
 *               See computeWindow in queries.js.
 *
 *   spanMs      How wide that slice is. This is a RETRY BUDGET, not a cohort
 *               size. A lead the run defers — budget exhausted, tailoring
 *               unavailable, a failed paid re-check — is left unmarked so it
 *               can be picked up again, but with a one-hour span the window
 *               has moved past them by the next tick and they are lost
 *               silently. A three-hour span gives each lead three chances.
 *               Widening is safe because the send-once receipt is per stage
 *               and durable, and partitionBySentTracker drops already-sent
 *               leads BEFORE the match fan-out, so the extra width costs KV
 *               reads rather than vector searches.
 *
 *               Stage `first` deliberately keeps the one-hour span it has
 *               used since launch. Widening it is the right fix for the same
 *               silent loss, but it changes the behaviour of a live email and
 *               the first run afterwards sees a one-off catch-up cohort — do
 *               that deliberately, with a SEND_CAP, not as a side effect.
 *
 *   maxPerRun   A hard ceiling on real sends per run for this stage, applied
 *               on top of SEND_CAP. The 48h email makes an LLM call per
 *               recipient inside a 280s budget, so it cannot use the whole
 *               cohort the way a template-only email can.
 *
 *   offer       Optional. A discount this stage's email advertises: the
 *               percentage and the product path that sells it. Present only on
 *               the stage that carries one, so the sequence stays data-driven —
 *               buildPayload adds OFFER_PERCENT / OFFER_URL when it is set and
 *               sends neither param when it is not. See the parity rule below.
 *
 * The 72h discount email now ships as stage `day3` (owner decision
 * 2026-08-27). Its Stripe-coupon blocker is resolved by reusing the product's
 * existing paid-retargeting offer rather than minting a new one: the email
 * points at `/comeback`, which is live in Standout-pro along with its coupon
 * (STRIPE_COUPON_RETARGET_75) and the server-side checkout enforcement.
 *
 * PERCENT PARITY IS LOAD-BEARING. `day3.offer.percent` MUST stay equal to
 * RETARGET_DISCOUNT_PERCENT in Standout-pro's `shared/retarget-offer.ts` (= 75)
 * and to the Stripe coupon's own percent_off. This email advertises the number,
 * /comeback renders its prices from it, and Stripe charges it — three copies of
 * one figure. If they drift the user is shown one number and billed another,
 * which is the failure mode this codebase treats as unacceptable.
 */

const ONE_HOUR_MS = 60 * 60 * 1000;

// The launch span. Kept for stage `first` so its live behaviour is untouched.
const LAUNCH_SPAN_MS = ONE_HOUR_MS;
// Three chances at each new stage before a deferred lead falls out of range.
const RETRY_SPAN_MS = 3 * ONE_HOUR_MS;

const EMAIL_STAGES = Object.freeze({
  first: Object.freeze({
    id: 'first',
    label: '1h',
    delayMs: ONE_HOUR_MS,
    spanMs: LAUNCH_SPAN_MS,
    maxPerRun: null,
    requiresTailoring: false,
    kvKey: 'anon_lead_sent',
    templateEnv: 'BREVO_TEMPLATE_ID_ANON_LEAD',
  }),
  day1: Object.freeze({
    id: 'day1',
    label: '24h',
    delayMs: 24 * ONE_HOUR_MS,
    spanMs: RETRY_SPAN_MS,
    maxPerRun: null,
    requiresTailoring: false,
    kvKey: 'anon_lead_24h_sent',
    templateEnv: 'BREVO_TEMPLATE_ID_ANON_LEAD_24H',
  }),
  day2: Object.freeze({
    id: 'day2',
    label: '48h',
    delayMs: 48 * ONE_HOUR_MS,
    spanMs: RETRY_SPAN_MS,
    // One tailoring call per recipient against a 280s budget. Start low and
    // raise it once deferredByBudget shows there is headroom.
    maxPerRun: 10,
    // This email shows the lead their application already written, so it
    // cannot be sent without bullets. A failure defers the lead rather than
    // sending a thinner email — see tailoring.js.
    requiresTailoring: true,
    kvKey: 'anon_lead_48h_sent',
    templateEnv: 'BREVO_TEMPLATE_ID_ANON_LEAD_48H',
  }),
  day3: Object.freeze({
    id: 'day3',
    label: '72h',
    delayMs: 72 * ONE_HOUR_MS,
    spanMs: RETRY_SPAN_MS,
    // Template-only, like the 1h and 24h emails: no LLM call per recipient, so
    // there is nothing here that the whole cohort cannot afford.
    maxPerRun: null,
    requiresTailoring: false,
    kvKey: 'anon_lead_72h_sent',
    templateEnv: 'BREVO_TEMPLATE_ID_ANON_LEAD_72H',
    // 75% off the first year, sold by the product's own /comeback page. The
    // percent must equal RETARGET_DISCOUNT_PERCENT in Standout-pro's
    // shared/retarget-offer.ts and the Stripe coupon's percent_off — see the
    // parity note at the top of this file.
    offer: Object.freeze({ percent: 75, path: '/comeback' }),
  }),
});

// Chronological. The order a lead moves through the sequence.
const STAGE_ORDER = Object.freeze(['first', 'day1', 'day2', 'day3']);

// Every caller that predates the sequence gets the 1h email, so an un-passed
// stage argument anywhere behaves exactly as the worker did before.
const DEFAULT_STAGE = EMAIL_STAGES.first;

/**
 * Accepts a stage object, a stage id, or nothing. Returns a stage object.
 * Throws on an id that does not exist rather than silently mailing the wrong
 * template — a typo in EMAIL_STAGE should fail the run, not send Email 1's
 * copy on Email 3's schedule.
 */
function resolveStage(idOrStage) {
  if (!idOrStage) return DEFAULT_STAGE;
  if (typeof idOrStage === 'object') return idOrStage;
  const stage = EMAIL_STAGES[String(idOrStage).trim()];
  if (!stage) {
    throw new Error(
      `Unknown email stage "${idOrStage}" — expected one of ${STAGE_ORDER.join(', ')}.`
    );
  }
  return stage;
}

/**
 * The Brevo template id for a stage. Pure: reads the env it is handed.
 * Returns null when unset so the caller can decide — index.js refuses to run a
 * stage whose template is missing, which is a clearer failure than Brevo
 * rejecting every send individually.
 */
function resolveTemplateId(stage, env = process.env) {
  const raw = env[resolveStage(stage).templateEnv];
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * The per-stage ceiling applied on top of SEND_CAP. Pure. Returns the tighter
 * of the two, and never widens an operator's explicit cap — a stage ceiling is
 * a rail, so it can only ever reduce.
 */
function capForStage(cap, stage) {
  const max = resolveStage(stage).maxPerRun;
  if (!max) return cap;
  return cap === null ? max : Math.min(cap, max);
}

module.exports = {
  EMAIL_STAGES,
  capForStage,
  LAUNCH_SPAN_MS,
  RETRY_SPAN_MS,
  STAGE_ORDER,
  DEFAULT_STAGE,
  resolveStage,
  resolveTemplateId,
};
