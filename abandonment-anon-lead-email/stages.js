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
 *               Stage `first` is now on RETRY_SPAN_MS like every other stage
 *               (2026-09-09). It kept LAUNCH_SPAN_MS only because widening it
 *               would have changed a live email's behaviour for no other
 *               reason; that argument is spent — the 1h free-apply email is
 *               being replaced by a 4h monthly-offer email on a new template,
 *               so its behaviour is changing regardless and there is no live
 *               copy left to preserve. Taking the retry budget in the same
 *               change costs one deploy instead of two and stops the silent
 *               loss the other three stages were already protected from.
 *
 *               The cut-over is not free and must be run deliberately. Two
 *               things happen on the first deploy:
 *                 - Leads already mailed under the 1h regime are deduped by
 *                   the unchanged `anon_lead_sent` KV key and get nothing.
 *                 - Everyone whose survey settled between 4h and 7h ago is in
 *                   range at once — a one-off catch-up cohort up to ~3× a
 *                   normal hourly cohort, none of it deduped, because those
 *                   leads aged past the old 1–2h window while it was still 1h
 *                   wide. SET SEND_CAP FOR THE FIRST RUN. It is not needed
 *                   afterwards: from the second tick on, each survey has
 *                   already been seen and the KV receipt carries it.
 *
 *   maxPerRun   A hard ceiling on real sends per run for this stage, applied
 *               on top of SEND_CAP. The 48h email makes an LLM call per
 *               recipient inside a 280s budget, so it cannot use the whole
 *               cohort the way a template-only email can.
 *
 *   offer       Optional. A discount this stage's email advertises, as DATA:
 *               the percentage, the product path that sells it, whether that
 *               path takes a lead token, the query param the app reads, and
 *               the two prices the copy states. Present only on the stages
 *               that carry one, so the sequence stays data-driven —
 *               buildPayload adds the OFFER_* params when it is set and sends
 *               none of them when it is not. Every figure the email states
 *               lives here and nowhere else in this repo; index.js states no
 *               price or percent of its own. See the parity rules below.
 *
 * TWO STAGES NOW CARRY AN OFFER, and they sell different cadences:
 *
 *   `first` (4h)  75% off the FIRST MONTH of Pro Monthly — $10 for month one,
 *                 renewing at $40/mo. Sold by `/your-match`, which is the same
 *                 token-bearing landing page the rest of the sequence uses, so
 *                 this link CARRIES THE LEAD TOKEN (`tokenized: true`) and the
 *                 app reads `offer=monthly75` off it. That is the one
 *                 structural difference from the 72h offer below.
 *   `day3` (72h)  75% off the FIRST YEAR of the annual plan — sold by the
 *                 product's live paid-retargeting page `/comeback`, which is a
 *                 cold page and consumes no token.
 *
 * The 72h discount email ships as stage `day3` (owner decision 2026-08-27).
 * Its Stripe-coupon blocker is resolved by reusing the product's existing
 * paid-retargeting offer rather than minting a new one: the email points at
 * `/comeback`, which is live in Standout-pro along with its coupon
 * (STRIPE_COUPON_RETARGET_75) and the server-side checkout enforcement.
 *
 * PERCENT PARITY IS LOAD-BEARING, ONCE PER OFFER. The number an email states,
 * the number the landing page renders its prices from, and the number Stripe
 * charges are three copies of one figure; if they drift the user is shown one
 * number and billed another, which is the failure mode this codebase treats as
 * unacceptable. So:
 *
 *   `first.offer`  percent / firstTermPrice / renewalPrice MUST stay equal to
 *                  the LEAD-OFFER constants in Standout-pro's
 *                  `shared/retarget-offer.ts` (LEAD_OFFER_DISCOUNT_PERCENT = 75)
 *                  and to the percent_off on THIS OFFER'S OWN Stripe coupon,
 *                  "Brevo_Anon_Lead_75% off" (id b0XANPC4, overridable via
 *                  STRIPE_COUPON_LEAD_OFFER_75) — not the annual coupon below.
 *                  Prices must match the pro_monthly Group A sticker ($40/mo →
 *                  $10 for month one). `/your-match?offer=monthly75` renders
 *                  from them.
 *   `day3.offer`   percent MUST stay equal to RETARGET_DISCOUNT_PERCENT in the
 *                  same file (= 75) and to STRIPE_COUPON_RETARGET_75's own
 *                  percent_off. `/comeback` renders its prices from it.
 *
 * The two happen to share the number 75 today. They are still two independent
 * parity rules against two different product surfaces — a Stripe coupon each,
 * so ending one campaign leaves the other alone. Do not collapse them into one
 * constant here, or one coupon in Stripe, or a change to one offer silently
 * moves the other.
 */

const ONE_HOUR_MS = 60 * 60 * 1000;

// The launch span. NO STAGE USES IT ANY MORE — `first` moved to RETRY_SPAN_MS
// with the 4h cut-over (2026-09-09). Kept, and still exported, because it is
// the number that sizes the one-off catch-up cohort that cut-over produces:
// the surveys stranded between the old 1h-wide window and the new 3h one.
const LAUNCH_SPAN_MS = ONE_HOUR_MS;
// Three chances at every stage before a deferred lead falls out of range.
const RETRY_SPAN_MS = 3 * ONE_HOUR_MS;

const EMAIL_STAGES = Object.freeze({
  first: Object.freeze({
    id: 'first',
    label: '4h',
    // Was 1h from launch until 2026-09-09. The email kept its "we found the
    // best job for you" value prop but swapped its primary CTA from the free
    // apply to the monthly offer below, and an offer reads better with a
    // little more distance from the paywall the lead just walked away from.
    delayMs: 4 * ONE_HOUR_MS,
    // Retry budget, like every other stage — see the spanMs note above for the
    // cut-over this earns and the SEND_CAP the first run needs.
    spanMs: RETRY_SPAN_MS,
    // Template-only: no LLM call per recipient, so nothing here the whole
    // cohort cannot afford.
    maxPerRun: null,
    requiresTailoring: false,
    // DO NOT RENAME. The send-once receipt every lead ever mailed by this
    // stage is filed under this exact key, including the ones mailed under the
    // 1h regime — which is precisely what stops the cut-over mailing them a
    // second first-stage email. See the kvKey note at the top of this file.
    kvKey: 'anon_lead_sent',
    // A NEW Brevo template — the 4h monthly-offer copy, not the retired 1h
    // free-apply one (39). Same env var, so nothing else has to move.
    templateEnv: 'BREVO_TEMPLATE_ID_ANON_LEAD',
    // 75% off the FIRST MONTH of Pro Monthly. Data only: the percent and both
    // prices are stated here and nowhere else in this repo, and `tokenized`
    // is what tells buildPayload to sign the lead token into the link — unlike
    // day3's cold /comeback URL. `param` is the flag the main app reads
    // (`/your-match?offer=monthly75`). The percent must equal
    // LEAD_OFFER_DISCOUNT_PERCENT in Standout-pro's shared/retarget-offer.ts
    // and the percent_off on this offer's own Stripe coupon,
    // "Brevo_Anon_Lead_75% off" (id b0XANPC4) — NOT the annual
    // STRIPE_COUPON_RETARGET_75 day3 charges. See the parity rules at the top.
    offer: Object.freeze({
      percent: 75,
      path: '/your-match',
      tokenized: true,
      param: 'monthly75',
      firstTermPrice: '$10',
      renewalPrice: '$40/mo',
      cadence: 'month',
    }),
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
    // Template-only, like the 4h and 24h emails: no LLM call per recipient, so
    // there is nothing here that the whole cohort cannot afford.
    maxPerRun: null,
    requiresTailoring: false,
    kvKey: 'anon_lead_72h_sent',
    templateEnv: 'BREVO_TEMPLATE_ID_ANON_LEAD_72H',
    // 75% off the first year, sold by the product's own /comeback page. That
    // page is cold and consumes no lead token, so there is no `tokenized` here
    // and buildPayload leaves the URL bare — the deliberate contrast with
    // `first.offer` above. It states no prices either: the annual figures are
    // the template's copy, unchanged since 2026-08-27. The percent must equal
    // RETARGET_DISCOUNT_PERCENT in Standout-pro's shared/retarget-offer.ts and
    // the Stripe coupon's percent_off — see the parity rules at the top.
    offer: Object.freeze({ percent: 75, path: '/comeback' }),
  }),
});

// Chronological. The order a lead moves through the sequence.
const STAGE_ORDER = Object.freeze(['first', 'day1', 'day2', 'day3']);

// Every caller that predates the sequence gets the first email in it, so an
// un-passed stage argument anywhere still means "stage `first`" — what that
// stage sends changed on 2026-09-09, but which stage it resolves to did not.
const DEFAULT_STAGE = EMAIL_STAGES.first;

/**
 * Accepts a stage object, a stage id, or nothing. Returns a stage object.
 * Throws on an id that does not exist rather than silently mailing the wrong
 * template — a typo in EMAIL_STAGE should fail the run, not send Email 1's
 * copy (now an offer) on Email 3's schedule.
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
