/**
 * The 72h offer email's payload contract (stage `day3`).
 *
 * The email advertises 75% off the first year and sends the click to the
 * product's own /comeback page, which renders its prices from
 * RETARGET_DISCOUNT_PERCENT in Standout-pro's shared/retarget-offer.ts and
 * charges them through the STRIPE_COUPON_RETARGET_75 coupon. Three copies of
 * one number, so what is asserted here is that the worker sends the same one —
 * and that no other stage sends the params at all, since a template that
 * referenced an absent OFFER_PERCENT would render an empty discount.
 *
 * buildPayload is pure apart from the two env vars it reads, so this suite
 * needs no stubs — unlike stage-drive.test.js, nothing here reaches Supabase,
 * Brevo or KV.
 *
 *   node --test            (from the repo root or this directory)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('./index');
const { EMAIL_STAGES, STAGE_ORDER } = require('./stages');

const { buildPayload, appBaseUrl } = _internals;

const LEAD = { email: 'Lead@Example.com', email_lc: 'lead@example.com', name: 'Jordan Reyes' };
const JOB = {
  id: 5150,
  title: 'Account Executive',
  company: 'examplecorp',
  location: 'Austin, TX',
  work_type: 'remote',
  first_seen_at: new Date().toISOString(),
};
const REASONS = ['reason one', 'reason two', 'reason three'];
const LINKS = {
  token: 'stub-token',
  jobUrl: 'https://app.example.com/your-match?t=stub-token',
  matchesUrl: 'https://app.example.com/your-match?t=stub-token&next=matches',
};

const GUARDED_ENV = ['STANDOUT_APP_URL', 'BREVO_TEMPLATE_ID_ANON_LEAD_72H'];
let saved;

test.beforeEach(() => {
  saved = Object.fromEntries(GUARDED_ENV.map((k) => [k, process.env[k]]));
  process.env.STANDOUT_APP_URL = 'https://app.example.com';
});

test.afterEach(() => {
  for (const key of GUARDED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const payloadFor = (stage) => buildPayload(LEAD, JOB, 91, REASONS, LINKS, stage, null);

// --- The offer params ------------------------------------------------------

test('day3 carries the offer percent and a /comeback URL with its own campaign', () => {
  const { params } = payloadFor(EMAIL_STAGES.day3);

  assert.equal(params.OFFER_PERCENT, 75);
  assert.equal(
    params.OFFER_URL,
    'https://app.example.com/comeback?utm_source=brevo&utm_medium=email&utm_campaign=abandonment_72h'
  );
});

test('the advertised percent is the stage offer, not a second literal', () => {
  // The one number this email is allowed to state. Reading it from the stage is
  // what keeps it equal to /comeback's price and the Stripe coupon's percent_off.
  const { params } = payloadFor(EMAIL_STAGES.day3);
  assert.equal(params.OFFER_PERCENT, EMAIL_STAGES.day3.offer.percent);
});

test('the offer URL carries no lead token', () => {
  // /comeback does not consume one — it is a cold page, and the lead's restored
  // context comes from the account-claim path after checkout. Signing a token
  // into it would leak a credential into a link that cannot use it.
  const { params } = payloadFor(EMAIL_STAGES.day3);
  assert.ok(!params.OFFER_URL.includes('t='), 'no token param');
  assert.ok(!params.OFFER_URL.includes(LINKS.token), 'and not the token value either');
});

test('the token-bearing links survive alongside the offer', () => {
  // The template keeps a secondary "see your match" CTA, so day3 sends both.
  const { params } = payloadFor(EMAIL_STAGES.day3);
  assert.equal(params.JOB_URL, LINKS.jobUrl);
  assert.equal(params.MATCHES_URL, LINKS.matchesUrl);
});

test('the earlier stages send neither offer param', () => {
  for (const id of ['first', 'day1', 'day2']) {
    const { params } = payloadFor(EMAIL_STAGES[id]);
    assert.equal(params.OFFER_PERCENT, undefined, `${id} must not advertise a discount`);
    assert.equal(params.OFFER_URL, undefined, `${id} must not link to /comeback`);
    assert.ok(!('OFFER_URL' in params), `${id} must omit the key, not send it empty`);
  }
});

test('exactly one stage in the sequence carries an offer', () => {
  const offering = STAGE_ORDER.filter((id) => 'OFFER_URL' in payloadFor(EMAIL_STAGES[id]).params);
  assert.deepEqual(offering, ['day3']);
});

test('an un-passed stage is the launch stage, so no offer params', () => {
  const { params } = buildPayload(LEAD, JOB, 91, REASONS, LINKS, undefined, null);
  assert.ok(!('OFFER_URL' in params));
});

// --- The app base the URL is built from ------------------------------------

test('the offer URL is built from the same app base as the token links', () => {
  process.env.STANDOUT_APP_URL = 'https://www.usestandout.today';
  const { params } = payloadFor(EMAIL_STAGES.day3);
  assert.ok(params.OFFER_URL.startsWith('https://www.usestandout.today/comeback?'));
});

test('a trailing slash or stray whitespace cannot produce a double-slash URL', () => {
  for (const raw of ['https://app.example.com/', 'https://app.example.com//', '  https://app.example.com  ']) {
    process.env.STANDOUT_APP_URL = raw;
    const { params } = payloadFor(EMAIL_STAGES.day3);
    assert.ok(
      params.OFFER_URL.startsWith('https://app.example.com/comeback?'),
      `${JSON.stringify(raw)} produced ${params.OFFER_URL}`
    );
  }
});

test('an unset STANDOUT_APP_URL falls back to the production origin', () => {
  delete process.env.STANDOUT_APP_URL;
  assert.equal(appBaseUrl(), 'https://www.usestandout.today');
  const { params } = payloadFor(EMAIL_STAGES.day3);
  assert.ok(params.OFFER_URL.startsWith('https://www.usestandout.today/comeback?'));
});

// --- Template selection ----------------------------------------------------

test("day3 resolves its own Brevo template, never a sibling stage's", () => {
  process.env.BREVO_TEMPLATE_ID_ANON_LEAD_72H = '45';
  assert.equal(payloadFor(EMAIL_STAGES.day3).templateId, 45);

  delete process.env.BREVO_TEMPLATE_ID_ANON_LEAD_72H;
  assert.equal(
    payloadFor(EMAIL_STAGES.day3).templateId,
    null,
    'a real run refuses at this point rather than sending the wrong copy'
  );
});
