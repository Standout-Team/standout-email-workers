/**
 * The 48h email's failure contract: every way tailoring can fail must produce
 * a SKIP, never a degraded send. The email exists to show finished work, so a
 * version without bullets is worse than the email it replaced.
 *
 * Each test here stands for a real outage shape — endpoint down, endpoint slow,
 * endpoint returning junk — because the cost of getting this wrong is not an
 * error, it is a worse email going out at scale.
 *
 *   node --test            (from the repo root or this directory)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchTailoredBullets,
  tailoringConfigured,
  TAILORING_TIMEOUT_MS,
  MIN_BULLETS,
  MAX_BULLETS,
} = require('./tailoring');

const ENV = {
  TAILORING_ENDPOINT_URL: 'https://app.example.com/api/lead-tailoring',
  TAILORING_ENDPOINT_SECRET: 'shh',
};
const LEAD = { email_lc: 'lead@example.com', survey_id: 4242 };
const JOB = { id: 99001 };

const realFetch = global.fetch;
const stubFetch = (impl) => { global.fetch = impl; };
test.afterEach(() => { global.fetch = realFetch; });

const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

// --- Configuration ---------------------------------------------------------

test('tailoringConfigured needs both the URL and the secret', () => {
  assert.equal(tailoringConfigured(ENV), true);
  assert.equal(tailoringConfigured({ TAILORING_ENDPOINT_URL: ENV.TAILORING_ENDPOINT_URL }), false);
  assert.equal(tailoringConfigured({ TAILORING_ENDPOINT_SECRET: 'shh' }), false);
  assert.equal(tailoringConfigured({}), false);
});

test('an unconfigured endpoint yields null without attempting a request', async () => {
  let called = false;
  stubFetch(async () => { called = true; });
  assert.equal(await fetchTailoredBullets(LEAD, JOB, {}), null);
  assert.equal(called, false);
});

// --- The happy path --------------------------------------------------------

test('returns the bullets the endpoint provides', async () => {
  stubFetch(ok({ bullets: ['Led the migration', 'Cut latency 40%'] }));
  assert.deepEqual(await fetchTailoredBullets(LEAD, JOB, ENV), [
    'Led the migration',
    'Cut latency 40%',
  ]);
});

test('sends the lead and job the endpoint needs, authenticated', async () => {
  let seen = null;
  stubFetch(async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, json: async () => ({ bullets: ['a', 'b'] }) };
  });
  await fetchTailoredBullets(LEAD, JOB, ENV);
  assert.equal(seen.url, ENV.TAILORING_ENDPOINT_URL);
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.authorization, 'Bearer shh');
  assert.deepEqual(JSON.parse(seen.opts.body), { surveyId: 4242, jobId: 99001 });
});

test('caps the bullets so a chatty endpoint cannot overflow the template', async () => {
  stubFetch(ok({ bullets: ['a', 'b', 'c', 'd', 'e'] }));
  const out = await fetchTailoredBullets(LEAD, JOB, ENV);
  assert.equal(out.length, MAX_BULLETS);
});

test('trims and drops blank bullets before counting them', async () => {
  stubFetch(ok({ bullets: ['  Led the migration  ', '', '   ', 'Cut latency 40%'] }));
  assert.deepEqual(await fetchTailoredBullets(LEAD, JOB, ENV), [
    'Led the migration',
    'Cut latency 40%',
  ]);
});

// --- Every failure is a skip ----------------------------------------------

test('a non-200 defers the lead', async () => {
  for (const status of [400, 401, 429, 500, 503]) {
    stubFetch(async () => ({ ok: false, status, json: async () => ({}) }));
    assert.equal(await fetchTailoredBullets(LEAD, JOB, ENV), null, `HTTP ${status} must defer`);
  }
});

test('a network error defers rather than throwing', async () => {
  // Throwing here would abort the whole run over one unlucky request.
  stubFetch(async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(await fetchTailoredBullets(LEAD, JOB, ENV), null);
});

test('a timeout defers', async () => {
  stubFetch(async (_url, opts) => {
    // Reproduce what fetch does on abort rather than resolving late.
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    if (opts && opts.signal) throw err;
    throw err;
  });
  assert.equal(await fetchTailoredBullets(LEAD, JOB, ENV), null);
});

test('the timeout is bounded — one hung call must not cost the run', () => {
  // The run budget is 280s and this fires once per recipient.
  assert.ok(TAILORING_TIMEOUT_MS > 0);
  assert.ok(TAILORING_TIMEOUT_MS <= 30000, 'a longer deadline would starve the cohort behind it');
});

test('malformed bodies defer instead of half-rendering', async () => {
  for (const body of [{}, { bullets: null }, { bullets: 'not an array' }, { bullets: [] }, null]) {
    stubFetch(ok(body));
    assert.equal(
      await fetchTailoredBullets(LEAD, JOB, ENV),
      null,
      `${JSON.stringify(body)} must defer`
    );
  }
});

test('unparseable JSON defers', async () => {
  stubFetch(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }));
  assert.equal(await fetchTailoredBullets(LEAD, JOB, ENV), null);
});

test('too few bullets defers rather than sending a thinner email', async () => {
  // One bullet is not "the application already written".
  stubFetch(ok({ bullets: ['only one'] }));
  assert.equal(await fetchTailoredBullets(LEAD, JOB, ENV), null);
  assert.equal(MIN_BULLETS, 2);
});

test('exactly MIN_BULLETS is enough', async () => {
  stubFetch(ok({ bullets: ['one', 'two'] }));
  const out = await fetchTailoredBullets(LEAD, JOB, ENV);
  assert.equal(out.length, MIN_BULLETS);
});

test('non-string entries are dropped, not coerced', async () => {
  stubFetch(ok({ bullets: ['real', 42, null, { a: 1 }, 'also real'] }));
  assert.deepEqual(await fetchTailoredBullets(LEAD, JOB, ENV), ['real', 'also real']);
});
