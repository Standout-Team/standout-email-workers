/**
 * stages.js — the cart-recovery sequence as data.
 *
 * Six emails. Emails 1–5 sell one offer (m75: $10 first month of Pro Monthly,
 * then $40/month). Email 6 sells a different, bigger offer (a75: "9 months
 * free", $40 first year of Annual, then $160/year) with its own deadline.
 *
 * PRICE PARITY: every figure here must equal RECOVERY_OFFERS in Standout-pro's
 * shared/recovery-offer.ts, which is what /special-offer renders and what
 * checkout charges. The coupon is chosen server-side from the offer key.
 *
 * `slot` names the schedule rule in schedule.js; `offer` names the token's
 * offer key and which deadline the token expires at.
 */

const OFFERS = Object.freeze({
  m75: Object.freeze({ key: 'm75', firstPrice: '$10', renewalPrice: '$40/month', deadline: 'deadline1' }),
  a75: Object.freeze({ key: 'a75', firstPrice: '$40', renewalPrice: '$160/year', deadline: 'deadline2' }),
});

const STAGES = Object.freeze([
  Object.freeze({ n: 1, id: 'e1', offer: 'm75', templateEnv: 'BREVO_TEMPLATE_ID_CR_E1', role: 'offer' }),
  Object.freeze({ n: 2, id: 'e2', offer: 'm75', templateEnv: 'BREVO_TEMPLATE_ID_CR_E2', role: 'how_it_works' }),
  Object.freeze({ n: 3, id: 'e3', offer: 'm75', templateEnv: 'BREVO_TEMPLATE_ID_CR_E3', role: 'objections' }),
  Object.freeze({ n: 4, id: 'e4', offer: 'm75', templateEnv: 'BREVO_TEMPLATE_ID_CR_E4', role: 'one_step_left' }),
  Object.freeze({ n: 5, id: 'e5', offer: 'm75', templateEnv: 'BREVO_TEMPLATE_ID_CR_E5', role: 'last_call' }),
  Object.freeze({ n: 6, id: 'e6', offer: 'a75', templateEnv: 'BREVO_TEMPLATE_ID_CR_E6', role: 'nine_months_free' }),
]);

function stageByN(n) {
  const s = STAGES.find((x) => x.n === n);
  if (!s) throw new Error(`Unknown cart-recovery stage ${n}`);
  return s;
}

function templateIdFor(stage, env = process.env) {
  const id = Number(env[stage.templateEnv]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

module.exports = { OFFERS, STAGES, stageByN, templateIdFor };
