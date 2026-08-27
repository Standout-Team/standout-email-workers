/**
 * The sequence's shape: stage definitions, the KV keyspace they namespace, and
 * the windows they select.
 *
 * The most important test in this file is the first one. Stage `first` must
 * keep the exact KV key it has used since launch — if it ever changes, every
 * lead already mailed looks unmailed and Email 1 re-fires across the whole
 * history on the next hourly tick. The implementation spec gets this key wrong
 * (it says `anon_lead_1h_sent`), so the assertion is here to make a
 * well-intentioned "fix" fail loudly instead of shipping.
 *
 *   node --test            (from the repo root or this directory)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EMAIL_STAGES,
  STAGE_ORDER,
  DEFAULT_STAGE,
  resolveStage,
  resolveTemplateId,
  capForStage,
  LAUNCH_SPAN_MS,
  RETRY_SPAN_MS,
} = require('./stages');
const { kvKeyFor } = require('./sent-tracker');
const { computeWindow } = require('./queries');

const NOW = Date.parse('2026-08-21T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

// Every test here runs against a clean namespace; one sets it deliberately.
test.beforeEach(() => { delete process.env.KV_ENV_PREFIX; });
test.after(() => { delete process.env.KV_ENV_PREFIX; });

// --- The launch key, which must never move -------------------------------

test('stage `first` still writes the exact KV key it has used since launch', () => {
  assert.equal(
    kvKeyFor('lead@example.com', EMAIL_STAGES.first),
    'anon_lead_sent:lead@example.com',
    'renaming this re-mails every lead in the history — see stages.js'
  );
});

test('the default stage is `first`, so pre-sequence callers are unchanged', () => {
  assert.equal(DEFAULT_STAGE.id, 'first');
  assert.equal(kvKeyFor('lead@example.com'), 'anon_lead_sent:lead@example.com');
});

test('each stage owns a distinct KV namespace', () => {
  const keys = STAGE_ORDER.map((id) => kvKeyFor('lead@example.com', EMAIL_STAGES[id]));
  assert.equal(new Set(keys).size, keys.length, 'two stages sharing a key would suppress one email');
  assert.deepEqual(keys, [
    'anon_lead_sent:lead@example.com',
    'anon_lead_24h_sent:lead@example.com',
    'anon_lead_48h_sent:lead@example.com',
    'anon_lead_72h_sent:lead@example.com',
  ]);
});

test('the live stages keep the exact kvKeys they shipped with', () => {
  // Same rail as the launch-key test above, extended to every stage that has
  // already mailed real people: changing one of these makes its cohort look
  // unmailed and re-fires that email across the whole history.
  assert.equal(EMAIL_STAGES.first.kvKey, 'anon_lead_sent');
  assert.equal(EMAIL_STAGES.day1.kvKey, 'anon_lead_24h_sent');
  assert.equal(EMAIL_STAGES.day2.kvKey, 'anon_lead_48h_sent');
  assert.equal(EMAIL_STAGES.day3.kvKey, 'anon_lead_72h_sent');
});

// --- Environment namespacing ----------------------------------------------

test('KV_ENV_PREFIX namespaces the whole keyspace', () => {
  process.env.KV_ENV_PREFIX = 'staging';
  assert.equal(kvKeyFor('lead@example.com', EMAIL_STAGES.first), 'staging:anon_lead_sent:lead@example.com');
  assert.equal(kvKeyFor('lead@example.com', EMAIL_STAGES.day1), 'staging:anon_lead_24h_sent:lead@example.com');
});

test('an unset or blank KV_ENV_PREFIX adds nothing', () => {
  assert.equal(kvKeyFor('a@b.com', EMAIL_STAGES.first), 'anon_lead_sent:a@b.com');
  process.env.KV_ENV_PREFIX = '   ';
  assert.equal(kvKeyFor('a@b.com', EMAIL_STAGES.first), 'anon_lead_sent:a@b.com', 'whitespace is not a namespace');
});

test('a staging key can never collide with a production key', () => {
  const prod = kvKeyFor('lead@example.com', EMAIL_STAGES.first);
  process.env.KV_ENV_PREFIX = 'staging';
  const staging = kvKeyFor('lead@example.com', EMAIL_STAGES.first);
  assert.notEqual(prod, staging, 'a collision here marks real leads as sent and suppresses their email');
});

// --- Windows ---------------------------------------------------------------

test('computeWindow: each stage selects the slice that ended delayMs ago', () => {
  for (const id of STAGE_ORDER) {
    const stage = EMAIL_STAGES[id];
    const win = computeWindow(NOW, {}, stage);
    assert.equal(win.endMs, NOW - stage.delayMs, `${id} upper bound is the stage delay`);
    assert.equal(win.endMs - win.startMs, stage.spanMs, `${id} cohort is exactly its own span`);
    assert.equal(win.stage, id);
  }
});

test('the launch stage keeps its one-hour span; the new stages get a retry budget', () => {
  // Widening `first` is the right fix for the same silent loss, but it changes
  // a live email's behaviour and earns a one-off catch-up cohort. Deliberate.
  assert.equal(EMAIL_STAGES.first.spanMs, LAUNCH_SPAN_MS);
  assert.equal(LAUNCH_SPAN_MS, HOUR);
  assert.equal(EMAIL_STAGES.day1.spanMs, RETRY_SPAN_MS);
  assert.equal(EMAIL_STAGES.day2.spanMs, RETRY_SPAN_MS);
  assert.equal(EMAIL_STAGES.day3.spanMs, RETRY_SPAN_MS);
  assert.ok(RETRY_SPAN_MS > LAUNCH_SPAN_MS);
});

test('a deferred lead at a retry-span stage is still in range an hour later', () => {
  // The whole point of spanMs. A lead the run defers is left unmarked so the
  // next tick can pick it up — which only works if the window still covers it.
  const stage = EMAIL_STAGES.day2;
  const survey = NOW - stage.delayMs - 30 * 60 * 1000; // mid-window
  let covered = 0;
  for (let n = 0; n < 3; n++) {
    const win = computeWindow(NOW + n * HOUR, {}, stage);
    if (survey >= win.startMs && survey <= win.endMs) covered++;
  }
  assert.equal(covered, 3, 'three hourly runs should each still see this lead');
});

test('the launch stage gets exactly one chance — the known limitation', () => {
  // Documented rather than fixed, so the asymmetry is visible instead of
  // being mistaken for an oversight.
  const stage = EMAIL_STAGES.first;
  const survey = NOW - stage.delayMs - 30 * 60 * 1000;
  let covered = 0;
  for (let n = 0; n < 3; n++) {
    const win = computeWindow(NOW + n * HOUR, {}, stage);
    if (survey >= win.startMs && survey <= win.endMs) covered++;
  }
  assert.equal(covered, 1, 'a deferred 1h lead falls out of range next tick');
});

test('computeWindow: the two-argument call is byte-identical to the 1h stage', () => {
  const legacy = computeWindow(NOW, {});
  const explicit = computeWindow(NOW, {}, EMAIL_STAGES.first);
  assert.equal(legacy.startMs, explicit.startMs);
  assert.equal(legacy.endMs, explicit.endMs);
  assert.equal(legacy.startMs, NOW - 2 * HOUR, 'the launch window was [now-2h, now-1h]');
  assert.equal(legacy.endMs, NOW - HOUR);
});

test('computeWindow: stage windows do not overlap', () => {
  const wins = STAGE_ORDER.map((id) => computeWindow(NOW, {}, EMAIL_STAGES[id]));
  for (let i = 1; i < wins.length; i++) {
    assert.ok(wins[i].endMs <= wins[i - 1].startMs, 'an overlap would mail one lead twice in a run');
  }
});

test('computeWindow: backfill on a later stage is clamped, never inverted', () => {
  // BACKFILL_DAYS=1 against the 48h stage asks for [now-24h, now-48h].
  const win = computeWindow(NOW, { BACKFILL_DAYS: '1' }, EMAIL_STAGES.day2);
  assert.ok(win.startMs < win.endMs, 'an inverted window silently matches nothing');
  assert.equal(win.endMs - win.startMs, EMAIL_STAGES.day2.spanMs, "falls back to the stage's own span");
});

test('computeWindow: a real backfill on the 1h stage is unchanged', () => {
  const win = computeWindow(NOW, { BACKFILL_DAYS: '14' }, EMAIL_STAGES.first);
  assert.equal(win.mode, 'backfill');
  assert.equal(win.startMs, NOW - 14 * 24 * HOUR, 'the launch backfill formula still applies');
  assert.equal(win.endMs, NOW - HOUR);
});

// --- resolveStage ----------------------------------------------------------

test('resolveStage accepts an id, an object, or nothing', () => {
  assert.equal(resolveStage('day1').id, 'day1');
  assert.equal(resolveStage(EMAIL_STAGES.day2).id, 'day2');
  assert.equal(resolveStage().id, 'first');
  assert.equal(resolveStage('').id, 'first');
});

test('resolveStage throws on an unknown id rather than guessing', () => {
  // Guessing here would mail one stage's copy on another stage's schedule.
  assert.throws(() => resolveStage('day7'), /Unknown email stage "day7"/);
});

// --- Template ids ----------------------------------------------------------

test('resolveTemplateId reads the stage-specific env var', () => {
  const env = {
    BREVO_TEMPLATE_ID_ANON_LEAD: '39',
    BREVO_TEMPLATE_ID_ANON_LEAD_24H: '41',
    BREVO_TEMPLATE_ID_ANON_LEAD_72H: '45',
  };
  assert.equal(resolveTemplateId(EMAIL_STAGES.first, env), 39);
  assert.equal(resolveTemplateId(EMAIL_STAGES.day1, env), 41);
  assert.equal(resolveTemplateId(EMAIL_STAGES.day3, env), 45);
});

test('the 72h stage has no template until its own env var is set', () => {
  // Its Brevo template does not exist yet. index.js refuses a real run in that
  // state, which is exactly the rail that keeps this stage dark until someone
  // sets BREVO_TEMPLATE_ID_ANON_LEAD_72H — the sibling envs must not stand in.
  const env = { BREVO_TEMPLATE_ID_ANON_LEAD: '39', BREVO_TEMPLATE_ID_ANON_LEAD_48H: '44' };
  assert.equal(resolveTemplateId(EMAIL_STAGES.day3, env), null);
});

test('resolveTemplateId returns null when the template is unconfigured', () => {
  // index.js refuses to run a stage with no template, which is a clearer
  // failure than Brevo rejecting every send in the cohort one at a time.
  assert.equal(resolveTemplateId(EMAIL_STAGES.day2, {}), null);
  assert.equal(resolveTemplateId(EMAIL_STAGES.day2, { BREVO_TEMPLATE_ID_ANON_LEAD_48H: '0' }), null);
  assert.equal(resolveTemplateId(EMAIL_STAGES.day2, { BREVO_TEMPLATE_ID_ANON_LEAD_48H: 'abc' }), null);
});

test('every stage points at a distinct template env var', () => {
  const envs = STAGE_ORDER.map((id) => EMAIL_STAGES[id].templateEnv);
  assert.equal(new Set(envs).size, envs.length, 'two stages sharing a template would send the wrong copy');
});

// --- Per-stage send ceiling ------------------------------------------------

test('capForStage tightens an uncapped run at the tailoring stage', () => {
  assert.equal(capForStage(null, EMAIL_STAGES.day2), 10, 'one LLM call per recipient, 280s budget');
});

test('capForStage leaves stages without a ceiling alone', () => {
  assert.equal(capForStage(null, EMAIL_STAGES.first), null);
  assert.equal(capForStage(50, EMAIL_STAGES.day1), 50);
});

test('capForStage never widens an operator cap', () => {
  // A stage ceiling is a rail: it can only ever reduce.
  assert.equal(capForStage(3, EMAIL_STAGES.day2), 3, 'a tighter SEND_CAP wins');
  assert.equal(capForStage(200, EMAIL_STAGES.day2), 10, 'a looser one is pulled down');
});

// --- The 72h offer stage ---------------------------------------------------

test('the sequence is the four emails, in order', () => {
  assert.deepEqual(STAGE_ORDER, ['first', 'day1', 'day2', 'day3']);
  assert.deepEqual(Object.keys(EMAIL_STAGES), ['first', 'day1', 'day2', 'day3']);
});

test('day3 is the 72h email, template-only and uncapped', () => {
  const stage = EMAIL_STAGES.day3;
  assert.equal(stage.id, 'day3');
  assert.equal(stage.label, '72h');
  assert.equal(stage.delayMs, 72 * HOUR);
  assert.equal(stage.maxPerRun, null);
  assert.equal(stage.requiresTailoring, false, 'this email sells an offer, not a rewritten resume');
  assert.equal(stage.templateEnv, 'BREVO_TEMPLATE_ID_ANON_LEAD_72H');
});

test('capForStage passes an operator cap straight through at day3', () => {
  // maxPerRun is null, so the stage adds no ceiling of its own.
  assert.equal(capForStage(null, EMAIL_STAGES.day3), null);
  assert.equal(capForStage(25, EMAIL_STAGES.day3), 25);
});

test("day3's offer is 75% off, frozen, and points at /comeback", () => {
  // 75 is the same number in three places: this email advertises it,
  // Standout-pro's /comeback renders its prices from RETARGET_DISCOUNT_PERCENT,
  // and the Stripe coupon (STRIPE_COUPON_RETARGET_75) charges it. Drift means
  // the user is shown one number and billed another — see stages.js.
  const { offer } = EMAIL_STAGES.day3;
  assert.deepEqual({ ...offer }, { percent: 75, path: '/comeback' });
  assert.ok(Object.isFrozen(offer), 'a mutable offer could be edited into a mismatch at runtime');
});

test('only the offer stage carries an offer', () => {
  assert.equal(EMAIL_STAGES.first.offer, undefined);
  assert.equal(EMAIL_STAGES.day1.offer, undefined);
  assert.equal(EMAIL_STAGES.day2.offer, undefined);
  assert.ok(EMAIL_STAGES.day3.offer);
});

test('resolveStage knows day3', () => {
  assert.equal(resolveStage('day3').id, 'day3');
  assert.throws(() => resolveStage('day4'), /Unknown email stage "day4"/);
});
