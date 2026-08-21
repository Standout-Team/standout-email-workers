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
 *               therefore which one-hour slice of surveys each hourly run
 *               considers. See computeWindow in queries.js.
 *
 * The 72h discount email is deliberately absent: it is blocked on Stripe
 * coupon infrastructure and ships separately (owner decision 2026-08-21).
 */

const ONE_HOUR_MS = 60 * 60 * 1000;

const EMAIL_STAGES = Object.freeze({
  first: Object.freeze({
    id: 'first',
    label: '1h',
    delayMs: ONE_HOUR_MS,
    kvKey: 'anon_lead_sent',
    templateEnv: 'BREVO_TEMPLATE_ID_ANON_LEAD',
  }),
  day1: Object.freeze({
    id: 'day1',
    label: '24h',
    delayMs: 24 * ONE_HOUR_MS,
    kvKey: 'anon_lead_24h_sent',
    templateEnv: 'BREVO_TEMPLATE_ID_ANON_LEAD_24H',
  }),
  day2: Object.freeze({
    id: 'day2',
    label: '48h',
    delayMs: 48 * ONE_HOUR_MS,
    kvKey: 'anon_lead_48h_sent',
    templateEnv: 'BREVO_TEMPLATE_ID_ANON_LEAD_48H',
  }),
});

// Chronological. The order a lead moves through the sequence.
const STAGE_ORDER = Object.freeze(['first', 'day1', 'day2']);

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

module.exports = {
  EMAIL_STAGES,
  STAGE_ORDER,
  DEFAULT_STAGE,
  resolveStage,
  resolveTemplateId,
};
