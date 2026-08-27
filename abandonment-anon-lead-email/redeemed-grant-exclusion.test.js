/**
 * Coverage for the 2026-08-24 rail: a lead who has already REDEEMED their free
 * apply is dropped from the 24h email (stage `day1`, template 43) and from
 * nothing else, because the post-apply follow-up (template 42) owns that
 * lead's 24h touch.
 *
 * Two halves, both offline:
 *   1. stageExcludesRedeemedGrants — the pure stage predicate.
 *   2. findExclusions driven against an injected Supabase stand-in, proving
 *      day1 issues the fourth query and `first` / `day2` / `day3` do not.
 *
 *   node --test            (from the repo root or this directory)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { findExclusions, stageExcludesRedeemedGrants } = require('./queries');
const { EMAIL_STAGES, STAGE_ORDER } = require('./stages');

// --- stageExcludesRedeemedGrants: the pure predicate ------------------------

test('stageExcludesRedeemedGrants: day1 excludes, the other stages do not', () => {
  assert.equal(stageExcludesRedeemedGrants('first'), false);
  assert.equal(stageExcludesRedeemedGrants('day1'), true);
  assert.equal(stageExcludesRedeemedGrants('day2'), false);
  assert.equal(stageExcludesRedeemedGrants('day3'), false);
});

test('stageExcludesRedeemedGrants: the 72h offer email still goes to appliers', () => {
  // The rail is day1-only and stays that way. A lead who redeemed their free
  // apply and did not buy is exactly who the 75%-off offer is for, and nothing
  // else lands beside it at 72h — template 42 owns the 24h touch, not this one.
  assert.equal(stageExcludesRedeemedGrants('day3'), false);
  assert.equal(stageExcludesRedeemedGrants(EMAIL_STAGES.day3), false);
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
  assert.throws(() => stageExcludesRedeemedGrants('day7'), /Unknown email stage/);
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

test('findExclusions: first, day2 and day3 never touch free_apply_grants', async () => {
  for (const stageId of ['first', 'day2', 'day3']) {
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

// --- chunking: the backfill-sized cohort -------------------------------------
//
// A PostgREST `in.()` travels in the URL. A normal day1 run carries ~10
// addresses, but BACKFILL_DAYS is a supported operator mode and the cohort is
// bounded by SURVEY_PAGE_SIZE * MAX_SURVEY_PAGES = 25,000 (a 30-day backfill is
// ~3,900 today). Unchunked, that is a ~100KB request line — and because the
// grant query throws on error, the failure would abort the entire backfill run
// rather than degrade.

const bigCohort = (n) => Array.from({ length: n }, (_, i) => lead(`lead${i}@example.com`));

test('findExclusions: a backfill-sized cohort is split across several grant queries', async () => {
  const client = stubClient(() => ({}));
  await findExclusions(bigCohort(250), 'day1', { client });

  const grants = grantQueries(client);
  assert.ok(grants.length > 1, 'a 250-address cohort must not travel in one URL');

  for (const q of grants) {
    const inFilter = q.filters.find((f) => f.op === 'in');
    assert.ok(inFilter, 'every grant query still filters by email_lc');
    assert.equal(inFilter.col, 'email_lc');
    assert.ok(
      inFilter.val.length <= 100,
      `chunk of ${inFilter.val.length} exceeds the URL-length budget`
    );
  }
});

test('findExclusions: chunking covers every address exactly once', async () => {
  const client = stubClient(() => ({}));
  const cohort = bigCohort(250);
  await findExclusions(cohort, 'day1', { client });

  const seen = grantQueries(client).flatMap((q) => q.filters.find((f) => f.op === 'in').val);
  assert.deepEqual(seen.slice().sort(), cohort.map((l) => l.email_lc).sort());
  assert.equal(new Set(seen).size, seen.length, 'no address is queried twice');
});

test('findExclusions: a hit in ANY chunk still excludes — results union across chunks', async () => {
  // The redeemed lead sits in the last chunk, so a bug that kept only the first
  // chunk's rows would let them through and send the duplicate 24h email.
  const cohort = bigCohort(250);
  const lateApplier = cohort[cohort.length - 1].email_lc;
  const client = stubClient((q) =>
    q.table === 'free_apply_grants' &&
    q.filters.find((f) => f.op === 'in').val.includes(lateApplier)
      ? { data: [{ email_lc: lateApplier }] }
      : {}
  );

  const excluded = await findExclusions(cohort, 'day1', { client });
  assert.equal(excluded.has(lateApplier), true);
  assert.equal(excluded.size, 1, 'and nobody else');
});

test('findExclusions: a small cohort still takes exactly one grant query', async () => {
  const client = stubClient(grantRespond);
  await findExclusions(COHORT, 'day1', { client });
  assert.equal(grantQueries(client).length, 1, 'chunking must not add round trips to a normal run');
});
