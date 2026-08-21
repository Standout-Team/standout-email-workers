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

const { EMAIL_STAGES, STAGE_ORDER, DEFAULT_STAGE, resolveStage, resolveTemplateId } = require('./stages');
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
  ]);
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

test('computeWindow: each stage selects the hour that ended delayMs ago', () => {
  for (const id of STAGE_ORDER) {
    const stage = EMAIL_STAGES[id];
    const win = computeWindow(NOW, {}, stage);
    assert.equal(win.endMs, NOW - stage.delayMs, `${id} upper bound is the stage delay`);
    assert.equal(win.endMs - win.startMs, HOUR, `${id} cohort is exactly one hourly bucket`);
    assert.equal(win.stage, id);
  }
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
  assert.equal(win.endMs - win.startMs, HOUR, 'falls back to the normal one-hour cohort');
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
  const env = { BREVO_TEMPLATE_ID_ANON_LEAD: '39', BREVO_TEMPLATE_ID_ANON_LEAD_24H: '41' };
  assert.equal(resolveTemplateId(EMAIL_STAGES.first, env), 39);
  assert.equal(resolveTemplateId(EMAIL_STAGES.day1, env), 41);
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

test('the deferred 72h discount stage is not defined yet', () => {
  // It is blocked on Stripe coupon infrastructure and ships separately.
  // Defining it early would make it eligible to send with no template.
  assert.equal(STAGE_ORDER.length, 3);
  assert.ok(!Object.keys(EMAIL_STAGES).some((id) => /72|discount/i.test(id)));
});
