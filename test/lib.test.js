const test = require('node:test');
const assert = require('node:assert/strict');

const { mapWithConcurrency, chunk, RPC_CONCURRENCY } = require('../lib/concurrency');
const { requireCronAuth } = require('../lib/cron-auth');
const { hasBillingSignal, normalizeEmail } = require('../lib/eligibility');

// --- concurrency ------------------------------------------------------------

test('mapWithConcurrency preserves order and never exceeds the limit', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let inFlight = 0;
  let peak = 0;

  const out = await mapWithConcurrency(items, 4, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return n * 2;
  });

  assert.deepEqual(out, items.map((n) => n * 2));
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
});

test('mapWithConcurrency handles empty input and limits above the item count', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 99, async (n) => n), [1, 2]);
});

test('RPC concurrency matches the product cap for match_jobs_for_survey', () => {
  assert.equal(RPC_CONCURRENCY, 4);
});

test('chunk splits without dropping items', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 10), []);
});

// --- cron auth --------------------------------------------------------------

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

function withSecret(value, fn) {
  const prev = process.env.CRON_SECRET;
  if (value === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }
}

test('requireCronAuth accepts the Vercel cron bearer token', () => {
  withSecret('s3cret', () => {
    const res = fakeRes();
    assert.equal(requireCronAuth({ headers: { authorization: 'Bearer s3cret' } }, res), true);
    assert.equal(res.statusCode, null);
  });
});

test('requireCronAuth rejects a missing or wrong token with 401', () => {
  withSecret('s3cret', () => {
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: 's3cret' }]) {
      const res = fakeRes();
      assert.equal(requireCronAuth({ headers }, res), false);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, { ok: false });
    }
  });
});

test('requireCronAuth fails CLOSED when CRON_SECRET is unset', () => {
  withSecret(undefined, () => {
    const res = fakeRes();
    assert.equal(requireCronAuth({ headers: { authorization: 'Bearer anything' } }, res), false);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { ok: false, error: 'Internal error' });
  });
});

// --- eligibility ------------------------------------------------------------

test('hasBillingSignal excludes ANY stripe status, not just active/trialing', () => {
  for (const status of ['active', 'trialing', 'incomplete', 'past_due', 'unpaid', 'canceled']) {
    assert.equal(hasBillingSignal({ subscription_status: status }), true, status);
  }
  assert.equal(hasBillingSignal({ stripe_subscription_id: 'sub_123' }), true);
  assert.equal(hasBillingSignal({ plan: 'pro_monthly' }), true);
});

test('hasBillingSignal leaves a genuinely free, unbilled profile alone', () => {
  assert.equal(hasBillingSignal({ plan: 'free', subscription_status: null, stripe_subscription_id: null }), false);
  assert.equal(hasBillingSignal({}), false);
  assert.equal(hasBillingSignal(null), false);
  // A stripe customer id alone is not a billing signal — Stripe mints one the
  // moment a Checkout session opens, including for people who bounce off it.
  assert.equal(hasBillingSignal({ plan: 'free', stripe_customer_id: 'cus_123' }), false);
});

test('normalizeEmail matches how the suppression table stores addresses', () => {
  assert.equal(normalizeEmail('  Jane@Example.COM '), 'jane@example.com');
  assert.equal(normalizeEmail(null), '');
});
