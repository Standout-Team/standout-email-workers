/**
 * Payload sanitization for both workers.
 *
 * Job titles/companies/locations come from third-party ATS feeds and the
 * recipient name comes from a user-uploaded resume. Neither is trusted: nothing
 * hostile may reach a Brevo template param or a MIME header. The self-minted
 * JOB_URL / MATCHES_URL must pass through untouched — sanitizing them would
 * strip the query string and break every link.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DRY_RUN = 'true';

const worker1 = require('../abandonment-job-email/index.js')._internals;
const worker2 = require('../abandonment-job-email-2/index.js')._internals;
const { coerceToThree } = require('../abandonment-job-email/match-reason');

const CONFIG = { templateId: 39, appUrl: 'https://www.usestandout.today' };

const HOSTILE_JOB = {
  id: 42,
  title: 'Analyst\r\nBcc: attacker@evil.com',
  company: '<script>alert(1)</script>Acme',
  location: 'Austin,\tTX',
  work_type: 'remote\n\n',
  first_seen_at: new Date().toISOString(),
  last_seen_at: new Date().toISOString(),
  salary_min: 90000,
  salary_max: 120000,
  pct: 91,
};

const USER = {
  id: '11111111-2222-3333-4444-555555555555',
  email: 'jane@example.com',
  created_at: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
  resume_parsed: { name: 'Jane\r\nX-Injected: 1 Doe' },
};

function assertClean(value, label) {
  assert.equal(/[\r\n\t\x00-\x1f\x7f]/.test(value), false, `${label} contains control characters`);
  assert.equal(/[<>]/.test(value), false, `${label} contains angle brackets`);
}

test('worker 1 sanitizes every string param and the recipient name', () => {
  const reasons = ['Reason <one>\r\ninjected', 'Reason two', 'Reason three'];
  const payload = worker1.buildPayload(USER, HOSTILE_JOB, reasons, 'Jane\r\nEvil', CONFIG);

  for (const key of [
    'FIRST_NAME',
    'JOB_TITLE',
    'COMPANY_NAME',
    'JOB_LOCATION',
    'WORK_TYPE',
    'JOB_AGE',
    'SALARY_RANGE',
    'MATCH_REASON_1',
    'MATCH_REASON_2',
    'MATCH_REASON_3',
  ]) {
    assertClean(String(payload.params[key] ?? ''), key);
  }

  assertClean(payload.to[0].name, 'to[].name');
  assert.ok(payload.to[0].name.length <= 100);
  assert.equal(payload.to[0].email, USER.email);
  assert.equal(payload.templateId, 39);
});

test('worker 1 leaves the self-minted URLs alone', () => {
  const payload = worker1.buildPayload(USER, HOSTILE_JOB, ['a', 'b', 'c'], 'Jane', CONFIG);
  const jobUrl = new URL(payload.params.JOB_URL);
  assert.equal(jobUrl.origin, 'https://www.usestandout.today');
  assert.ok(payload.params.JOB_URL.includes('job=42') || jobUrl.searchParams.has('t'));
  assert.ok(payload.params.MATCHES_URL.startsWith('https://www.usestandout.today'));
});

test('worker 2 sanitizes every string param and splits names on any whitespace', () => {
  const payload = worker2.buildPayload(USER, HOSTILE_JOB, 12, worker2.getFirstName(USER.resume_parsed), CONFIG);

  for (const key of ['FIRST_NAME', 'JOB_TITLE', 'COMPANY_NAME', 'JOB_LOCATION', 'WORK_TYPE', 'TIME_SINCE_SIGNUP']) {
    assertClean(String(payload.params[key] ?? ''), key);
  }
  assertClean(payload.to[0].name, 'to[].name');
  assert.equal(payload.params.MATCH_COUNT, 12);
});

test('worker 2 getFirstName never lets CRLF ride along (old split(" ") bug)', () => {
  assert.equal(worker2.getFirstName({ name: 'Jane\r\nBcc: x@y.z Doe' }), 'Jane');
  assert.equal(worker2.getFirstName({ name: '  Ada  Lovelace ' }), 'Ada');
  assert.equal(worker2.getFirstName({}), 'there');
  assert.equal(worker2.getFirstName(null), 'there');
});

test('worker 1 firstNameFor splits on any whitespace and falls back to the email prefix', () => {
  assert.equal(worker1.firstNameFor({ name: 'Jane\tDoe' }, 'x@y.z'), 'Jane');
  assert.equal(worker1.firstNameFor(null, 'jane@example.com'), 'Jane');
  assert.equal(worker1.firstNameFor(null, ''), 'There');
});

test('match reasons are capped and hostile model output is replaced by fallbacks', () => {
  const job = { title: 'Analyst', company: 'Acme', role_category: 'Data' };

  const capped = coerceToThree(['x'.repeat(500), 'ok two', 'ok three'], job);
  assert.equal(capped.length, 3);
  assert.equal(capped[0].length, 140);

  // Non-strings and empties are dropped, then back-filled from the fallbacks.
  const filled = coerceToThree([null, { evil: true }, '   ', 'only real one'], job);
  assert.equal(filled.length, 3);
  assert.equal(filled[0], 'only real one');
  for (const r of filled) {
    assert.equal(typeof r, 'string');
    assert.ok(r.length > 0);
    assertClean(r, 'reason');
  }

  // Nothing usable at all -> three deterministic fallbacks.
  const none = coerceToThree(null, job);
  assert.equal(none.length, 3);
  assert.deepEqual(none, require('../abandonment-job-email/match-reason').fallbackReasons(job));
});

test('formatJobAge uses first_seen_at (posted-at) and hides the badge past 3 days', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(worker1.formatJobAge(daysAgo(0)), 'Posted today');
  assert.equal(worker1.formatJobAge(daysAgo(1)), 'Posted yesterday');
  assert.equal(worker1.formatJobAge(daysAgo(2)), 'Posted 2 days ago');
  assert.equal(worker1.formatJobAge(daysAgo(9)), '');
  assert.equal(worker1.formatJobAge(null), '');
});

test('formatSalary renders the K-range the template expects', () => {
  assert.equal(worker1.formatSalary(90000, 120000), '$90K–$120K');
  assert.equal(worker1.formatSalary(90000, 0), '$90K');
  assert.equal(worker1.formatSalary(0, 0), '');
});
