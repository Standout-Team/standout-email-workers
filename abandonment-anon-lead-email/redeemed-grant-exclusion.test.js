/**
 * Coverage for the 2026-08-24 rail: a lead who has already REDEEMED their free
 * apply is dropped from the 24h email (stage `day1`, template 43) and from
 * nothing else, because the post-apply follow-up (template 42) owns that
 * lead's 24h touch.
 *
 * Two halves, both offline:
 *   1. stageExcludesRedeemedGrants — the pure stage predicate.
 *   2. findExclusions driven against an injected Supabase stand-in, proving
 *      day1 issues the fourth query and `first` / `day2` do not.
 *
 *   node --test            (from the repo root or this directory)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { findExclusions, stageExcludesRedeemedGrants } = require('./queries');
const { EMAIL_STAGES, STAGE_ORDER } = require('./stages');

// --- stageExcludesRedeemedGrants: the pure predicate ------------------------

test('stageExcludesRedeemedGrants: day1 excludes, first and day2 do not', () => {
  assert.equal(stageExcludesRedeemedGrants('first'), false);
  assert.equal(stageExcludesRedeemedGrants('day1'), true);
  assert.equal(stageExcludesRedeemedGrants('day2'), false);
});

test('stageExcludesRedeemedGrants: every stage in the sequence is decided', () => {
  // A stage added later must be considered here rather than defaulting in by
  // accident — this asserts the answer is a boolean for all of them, and that
  // exactly one stage carries the rail today.
  const excluding = STAGE_ORDER.filter((id) => {
    const answer = stageExcludesRedeemedGrants(id);
    assert.equal(typeof answer, 'boolean', `${id} must resolve to a boolean`);
    return answer;
  });
  assert.deepEqual(excluding, ['day1']);
});

test('stageExcludesRedeemedGrants: takes a stage object as well as an id', () => {
  assert.equal(stageExcludesRedeemedGrants(EMAIL_STAGES.day1), true);
  assert.equal(stageExcludesRedeemedGrants(EMAIL_STAGES.first), false);
});

test('stageExcludesRedeemedGrants: an un-passed stage is the launch stage, so no exclusion', () => {
  // Every caller that predates the sequence gets `first` — see stages.js.
  assert.equal(stageExcludesRedeemedGrants(undefined), false);
});

test('stageExcludesRedeemedGrants: an unknown stage id throws, it does not silently pass', () => {
  assert.throws(() => stageExcludesRedeemedGrants('day3'), /Unknown email stage/);
});

// --- findExclusions, against an injected client ------------------------------

/**
 * A chainable Supabase stand-in. Records every query as
 * { table, select, filters } and answers it from `respond`, which defaults to
 * "no rows, no hits". Only the builder methods this module actually calls are
 * implemented, so a new filter shows up as a TypeError rather than a silently
 * ignored condition.
 */
function stubClient(respond = () => ({})) {
  const queries = [];

  const from = (table) => {
    const q = { table, select: null, head: false, filters: [] };
    queries.push(q);

    const chain = {
      select: (cols, opts) => {
        q.select = cols;
        q.head = Boolean(opts && opts.head);
        return chain;
      },
      ilike: (col, val) => (q.filters.push({ op: 'ilike', col, val }), chain),
      in: (col, val) => (q.filters.push({ op: 'in', col, val }), chain),
      gt: (col, val) => (q.filters.push({ op: 'gt', col, val }), chain),
      not: (col, operator, val) => (q.filters.push({ op: 'not', col, operator, val }), chain),
      limit: (n) => (q.filters.push({ op: 'limit', val: n }), chain),
      // Thenable, so `await`ing the builder resolves the query the way
      // PostgREST's does.
      then: (resolve, reject) =>
        Promise.resolve()
          .then(() => ({ data: [], count: 0, error: null, ...respond(q) }))
          .then(resolve, reject),
    };
    return chain;
  };

  return { queries, from };
}

const lead = (emailLc) => ({
  survey_id: `survey-${emailLc.split('@')[0]}`,
  session_id: `session-${emailLc.split('@')[0]}`,
  email: emailLc,
  email_lc: emailLc,
});

const APPLIER = 'applied@example.com';
const CLAIMER = 'claimed@example.com';
const COHORT = [lead(APPLIER), lead(CLAIMER)];

// The table answers with the redeemed lead only. A claim-only grant row is not
// selected by `.not('redeemed_at', 'is', null)`, which the filter assertion
// below is what actually proves.
const grantRespond = (q) =>
  q.table === 'free_apply_grants' ? { data: [{ email_lc: APPLIER }] } : {};

const grantQueries = (client) => client.queries.filter((q) => q.table === 'free_apply_grants');

test('findExclusions: day1 excludes a lead who redeemed their free apply', async () => {
  const client = stubClient(grantRespond);
  const excluded = await findExclusions(COHORT, 'day1', { client });

  assert.equal(excluded.has(APPLIER), true, 'the 24h email belongs to template 42 now');
  assert.equal(excluded.has(CLAIMER), false, 'claiming is still not an exclusion');
});

test('findExclusions: day1 asks free_apply_grants for redeemed rows, by email_lc', async () => {
  const client = stubClient(grantRespond);
  await findExclusions(COHORT, 'day1', { client });

  const [grant, ...extra] = grantQueries(client);
  assert.ok(grant, 'day1 must issue the fourth query');
  assert.deepEqual(extra, [], 'exactly one grant query per run');

  assert.deepEqual(
    grant.filters.find((f) => f.op === 'not'),
    { op: 'not', col: 'redeemed_at', operator: 'is', val: null },
    'a claimed-but-unredeemed grant must not match'
  );
  assert.deepEqual(
    grant.filters.find((f) => f.op === 'in'),
    { op: 'in', col: 'email_lc', val: [APPLIER, CLAIMER] },
    'email_lc is stored lowercase — a plain IN, no ilike fan-out'
  );
});

test('findExclusions: first and day2 never touch free_apply_grants', async () => {
  for (const stageId of ['first', 'day2']) {
    const client = stubClient(grantRespond);
    const excluded = await findExclusions(COHORT, stageId, { client });

    assert.deepEqual(
      grantQueries(client),
      [],
      `${stageId} must not query free_apply_grants`
    );
    assert.equal(
      excluded.has(APPLIER),
      false,
      `${stageId} still mails an applier who has not purchased`
    );
  }
});

test('findExclusions: the default stage is `first`, so it adds no grant query', async () => {
  const client = stubClient(grantRespond);
  const excluded = await findExclusions(COHORT, undefined, { client });

  assert.deepEqual(grantQueries(client), []);
  assert.equal(excluded.size, 0);
});

test('findExclusions: the other three sources are unchanged on day1', async () => {
  const client = stubClient(grantRespond);
  await findExclusions(COHORT, 'day1', { client });

  const tables = new Set(client.queries.map((q) => q.table));
  assert.deepEqual(
    [...tables].sort(),
    ['free_apply_grants', 'marketing_suppressions', 'pending_subscriptions', 'profiles'],
    'day1 is the three existing sources plus one'
  );
});

test('findExclusions: a grant query error throws — it does not soft-fail into a send', async () => {
  const client = stubClient((q) =>
    q.table === 'free_apply_grants' ? { error: { message: 'relation blew up' } } : {}
  );

  await assert.rejects(
    () => findExclusions(COHORT, 'day1', { client }),
    /free_apply_grants query failed: relation blew up/
  );
});

test('findExclusions: day1 unions the grant source with the existing ones', async () => {
  const suppressed = 'gone@example.com';
  const cohort = [...COHORT, lead(suppressed)];
  const client = stubClient((q) => {
    if (q.table === 'free_apply_grants') return { data: [{ email_lc: APPLIER }] };
    if (q.table === 'marketing_suppressions') return { data: [{ email: suppressed }] };
    return {};
  });

  const excluded = await findExclusions(cohort, 'day1', { client });
  assert.deepEqual([...excluded].sort(), [APPLIER, suppressed].sort());
});
