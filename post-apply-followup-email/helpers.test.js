/**
 * Pure-helper coverage for the post-apply follow-up worker.
 *
 * The worker previously shipped with no tests at all. These pin the pieces a
 * reviewer cannot check by reading: the send-cap rails (including the tighter
 * one that arms when the KV dedup is non-durable), the ILIKE escape that keeps
 * a stray %/_ in an address from widening an exclusion lookup, and the
 * customer-facing formatters.
 *
 *   node --test            (from this directory or the repo root)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  capitalize,
  formatSalary,
  firstNameFor,
  buildCtaUrl,
  escapeLike,
  resolveSendCap,
  DEFAULT_SEND_CAP,
  NON_DURABLE_SEND_CAP,
} = require('./index')._internals;

const quiet = (fn) => {
  const w = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = w; }
};

// --- send cap ---------------------------------------------------------------

test('resolveSendCap: durable dedup and no SEND_CAP uses the default', () => {
  assert.equal(resolveSendCap({}, true), DEFAULT_SEND_CAP);
});

test('resolveSendCap: an explicit SEND_CAP wins', () => {
  assert.equal(resolveSendCap({ SEND_CAP: '7' }, true), 7);
  assert.equal(resolveSendCap({ SEND_CAP: '  7  ' }, true), 7);
});

test('resolveSendCap: a non-durable store narrows the cap to the tighter rail', () => {
  assert.equal(resolveSendCap({}, false), NON_DURABLE_SEND_CAP);
  assert.equal(resolveSendCap({ SEND_CAP: '500' }, false), NON_DURABLE_SEND_CAP);
});

test('resolveSendCap: non-durable never RAISES an operator cap that is already lower', () => {
  assert.equal(resolveSendCap({ SEND_CAP: '5' }, false), 5);
});

test('resolveSendCap: a non-positive-integer SEND_CAP warns and falls back', () => {
  for (const bad of ['0', '-3', 'abc', '2.5']) {
    assert.equal(quiet(() => resolveSendCap({ SEND_CAP: bad }, true)), DEFAULT_SEND_CAP, bad);
  }
});

// --- ILIKE escaping ---------------------------------------------------------

test('escapeLike: neutralises the wildcards PostgREST would otherwise honour', () => {
  assert.equal(escapeLike('a%b@x.com'), 'a\\%b@x.com');
  assert.equal(escapeLike('a_b@x.com'), 'a\\_b@x.com');
  assert.equal(escapeLike('a\\b@x.com'), 'a\\\\b@x.com');
});

test('escapeLike: an ordinary address is untouched', () => {
  assert.equal(escapeLike('first.last+tag@example.com'), 'first.last+tag@example.com');
});

// --- formatters -------------------------------------------------------------

test('capitalize: title-cases an all-lowercase company', () => {
  assert.equal(capitalize('instacart'), 'Instacart');
  assert.equal(capitalize('acme corp'), 'Acme Corp');
});

test('capitalize: leaves a company that already carries capitals alone', () => {
  // The regression this pins: lowercase-then-title-case shipped "Ibm"/"Ebay"
  // into a customer-facing email.
  assert.equal(capitalize('IBM'), 'IBM');
  assert.equal(capitalize('eBay'), 'eBay');
  assert.equal(capitalize('IBM Watson'), 'IBM Watson');
  assert.equal(capitalize('eBay inc'), 'eBay Inc');
});

test('capitalize: empty and missing values pass through', () => {
  assert.equal(capitalize(''), '');
  assert.equal(capitalize(null), null);
});

test('firstNameFor: takes the first token, else a friendly fallback', () => {
  assert.equal(firstNameFor('Ada Lovelace'), 'Ada');
  assert.equal(firstNameFor('  Ada   Lovelace '), 'Ada');
  assert.equal(firstNameFor(''), 'there');
  assert.equal(firstNameFor(null), 'there');
});

test('formatSalary: renders a k-range, or null when either bound is unusable', () => {
  assert.equal(formatSalary(90000, 120000), '$90k–$120k');
  assert.equal(formatSalary('90000', '120000'), '$90k–$120k');
  assert.equal(formatSalary(null, 120000), null);
  assert.equal(formatSalary(90000, undefined), null);
  assert.equal(formatSalary('n/a', 'n/a'), null);
});

test('buildCtaUrl: stamps the UTM triple without dropping existing params', () => {
  const url = new URL(buildCtaUrl('https://www.usestandout.today/pricing?plan=pro'));
  assert.equal(url.searchParams.get('plan'), 'pro');
  assert.equal(url.searchParams.get('utm_source'), 'brevo');
  assert.equal(url.searchParams.get('utm_medium'), 'email');
  assert.equal(url.searchParams.get('utm_campaign'), 'post_apply_followup');
});
