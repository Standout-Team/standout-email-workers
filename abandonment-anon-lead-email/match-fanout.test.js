/**
 * Coverage for the bounded match fan-out (2026-08-13): the pure worker pool, the
 * two new env knobs, the per-run time budget, and the one retry a statement
 * timeout gets. The bug this covers is a real one — the 18:00 UTC run fanned
 * ~50 pgvector searches at the production database with a bare Promise.all, lost
 * 44 of 50 leads to `canceling statement due to statement timeout`, and sent 6
 * emails.
 *
 * No Supabase, no Brevo, no KV, no real waiting: the client, the clock and the
 * retry sleep are all injected.
 *
 *   node --test            (from the repo root or this directory)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapWithConcurrency,
  resolveMatchConcurrency,
  resolveRunBudgetMs,
  findFeaturedJobs,
  MATCH_CONCURRENCY,
  RUN_BUDGET_MS,
  _internals,
} = require('./queries');

const {
  isTimeoutError,
  MIN_MATCH_CONCURRENCY,
  MAX_MATCH_CONCURRENCY,
  MIN_RUN_BUDGET_MS,
  MAX_RUN_BUDGET_MS,
  MATCH_RETRY_DELAY_MS,
  FRESH_DAY_STEPS,
} = _internals;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Counts what is genuinely in flight, so "bounded" is measured rather than
// assumed: increment on entry, decrement in a finally, remember the peak.
function inFlightMeter() {
  let live = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    async around(fn) {
      live++;
      if (live > peak) peak = live;
      try {
        return await fn();
      } finally {
        live--;
      }
    },
  };
}

// --- mapWithConcurrency -----------------------------------------------------

test('mapWithConcurrency: results come back in INPUT order, not completion order', async () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7];
  const done = [];

  const results = await mapWithConcurrency(items, 3, async (n) => {
    // Reverse-staggered: the later an item is, the faster it finishes.
    await delay((items.length - n) * 2);
    done.push(n);
    return `item-${n}`;
  });

  assert.deepEqual(results, items.map((n) => `item-${n}`));
  assert.notDeepEqual(done, items, 'the completion order really did differ from the input order');
});

test('mapWithConcurrency: never exceeds the limit', async () => {
  for (const limit of [1, 2, 3, 5]) {
    const meter = inFlightMeter();

    await mapWithConcurrency([...Array(30).keys()], limit, (n) =>
      meter.around(async () => {
        await delay(2);
        return n;
      })
    );

    assert.ok(meter.peak <= limit, `peak ${meter.peak} exceeded the limit of ${limit}`);
    assert.equal(meter.peak, limit, 'and it does use the whole width it is given');
  }
});

test('mapWithConcurrency: a limit of 1 is genuinely serial', async () => {
  const meter = inFlightMeter();
  const order = [];

  await mapWithConcurrency([0, 1, 2, 3], 1, (n) =>
    meter.around(async () => {
      await delay(1);
      order.push(n);
    })
  );

  assert.equal(meter.peak, 1);
  assert.deepEqual(order, [0, 1, 2, 3], 'serial means in order, one at a time');
});

test('mapWithConcurrency: a rejected item does not abort the pool', async () => {
  const attempted = [];

  const results = await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (n) => {
    attempted.push(n);
    await delay(1);
    if (n === 2) throw new Error('boom');
    return n * 10;
  });

  assert.deepEqual(results, [0, 10, null, 30, 40], 'the rejection is null in ITS slot only');
  assert.deepEqual(
    attempted.sort((a, b) => a - b),
    [0, 1, 2, 3, 4],
    'every item was still attempted — one lead failing must not cancel the other 49'
  );
});

test('mapWithConcurrency: every item rejecting is still an all-null result, not a throw', async () => {
  const results = await mapWithConcurrency([1, 2, 3], 2, async () => {
    throw new Error('everything is on fire');
  });

  assert.deepEqual(results, [null, null, null]);
});

test('mapWithConcurrency: empty input resolves to an empty array without calling fn', async () => {
  let calls = 0;
  const results = await mapWithConcurrency([], 4, async () => {
    calls++;
  });

  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test('mapWithConcurrency: a limit above the item count runs everything, once each', async () => {
  const meter = inFlightMeter();

  const results = await mapWithConcurrency([1, 2], 10, (n) =>
    meter.around(async () => {
      await delay(2);
      return n * 2;
    })
  );

  assert.deepEqual(results, [2, 4]);
  assert.equal(meter.peak, 2, 'the pool is never wider than the work it has');
});

test('mapWithConcurrency: does not mutate or reorder the input', async () => {
  const items = [3, 1, 2];
  await mapWithConcurrency(items, 2, async (n) => {
    await delay(n);
    return n;
  });

  assert.deepEqual(items, [3, 1, 2]);
});

test('mapWithConcurrency: fn receives the item and its index', async () => {
  const seen = [];
  await mapWithConcurrency(['a', 'b', 'c'], 1, async (item, index) => {
    seen.push([item, index]);
  });

  assert.deepEqual(seen, [
    ['a', 0],
    ['b', 1],
    ['c', 2],
  ]);
});

test('mapWithConcurrency: a junk limit degrades to serial rather than unbounded', async () => {
  for (const limit of [0, -3, NaN, undefined]) {
    const meter = inFlightMeter();
    const results = await mapWithConcurrency([1, 2, 3], limit, (n) =>
      meter.around(async () => {
        await delay(1);
        return n;
      })
    );

    assert.deepEqual(results, [1, 2, 3], `limit=${limit} should still map correctly`);
    assert.equal(meter.peak, 1, `limit=${limit} must not fan out`);
  }
});

// --- resolveMatchConcurrency ------------------------------------------------

test('resolveMatchConcurrency: unset is the default, with no warning', () => {
  assert.deepEqual(resolveMatchConcurrency({}), { concurrency: MATCH_CONCURRENCY, warning: null });
  assert.equal(MATCH_CONCURRENCY, 4, 'the shipped default');
});

test('resolveMatchConcurrency: empty and whitespace are "unset", not invalid', () => {
  for (const raw of ['', '   ', '\t\n ']) {
    assert.deepEqual(resolveMatchConcurrency({ MATCH_CONCURRENCY: raw }), {
      concurrency: MATCH_CONCURRENCY,
      warning: null,
    });
  }
});

test('resolveMatchConcurrency: an explicit value in range wins, trimmed', () => {
  assert.deepEqual(resolveMatchConcurrency({ MATCH_CONCURRENCY: '2' }), { concurrency: 2, warning: null });
  assert.deepEqual(resolveMatchConcurrency({ MATCH_CONCURRENCY: ' 8 ' }), { concurrency: 8, warning: null });
  assert.deepEqual(resolveMatchConcurrency({ MATCH_CONCURRENCY: '+1' }), {
    concurrency: MIN_MATCH_CONCURRENCY,
    warning: null,
  });
  assert.deepEqual(resolveMatchConcurrency({ MATCH_CONCURRENCY: '10' }), {
    concurrency: MAX_MATCH_CONCURRENCY,
    warning: null,
  });
});

test('resolveMatchConcurrency: above the ceiling clamps and warns', () => {
  const { concurrency, warning } = resolveMatchConcurrency({ MATCH_CONCURRENCY: '50' });

  assert.equal(concurrency, MAX_MATCH_CONCURRENCY);
  assert.match(warning, /exceeds the maximum of 10/);
  assert.match(warning, /clamped to 10/);
});

test('resolveMatchConcurrency: anything that is not a positive integer falls back and warns', () => {
  for (const raw of ['0', '-4', 'four', '2.5', '1e1', 'true', '4x']) {
    const { concurrency, warning } = resolveMatchConcurrency({ MATCH_CONCURRENCY: raw });

    assert.equal(concurrency, MATCH_CONCURRENCY, `MATCH_CONCURRENCY=${raw} should use the default`);
    assert.match(warning, /not a positive integer/);
    assert.match(warning, /default of 4/);
  }
});

test('resolveMatchConcurrency: is pure — reads the argument, not process.env', () => {
  const saved = process.env.MATCH_CONCURRENCY;
  process.env.MATCH_CONCURRENCY = '9';
  try {
    assert.equal(resolveMatchConcurrency({}).concurrency, MATCH_CONCURRENCY);
  } finally {
    if (saved === undefined) delete process.env.MATCH_CONCURRENCY;
    else process.env.MATCH_CONCURRENCY = saved;
  }
});

// --- resolveRunBudgetMs -----------------------------------------------------

test('resolveRunBudgetMs: unset is the 4-minute default, with no warning', () => {
  assert.deepEqual(resolveRunBudgetMs({}), { budgetMs: RUN_BUDGET_MS, warning: null });
  assert.equal(RUN_BUDGET_MS, 240000, 'the shipped default');
  assert.ok(RUN_BUDGET_MS < 300000, 'and it must leave room under the 300s maxDuration');
});

test('resolveRunBudgetMs: empty and whitespace are "unset", not invalid', () => {
  for (const raw of ['', '  ']) {
    assert.deepEqual(resolveRunBudgetMs({ RUN_BUDGET_MS: raw }), { budgetMs: RUN_BUDGET_MS, warning: null });
  }
});

test('resolveRunBudgetMs: an explicit in-range value wins, trimmed', () => {
  assert.deepEqual(resolveRunBudgetMs({ RUN_BUDGET_MS: '120000' }), { budgetMs: 120000, warning: null });
  assert.deepEqual(resolveRunBudgetMs({ RUN_BUDGET_MS: ' 30000 ' }), {
    budgetMs: MIN_RUN_BUDGET_MS,
    warning: null,
  });
  assert.deepEqual(resolveRunBudgetMs({ RUN_BUDGET_MS: '280000' }), {
    budgetMs: MAX_RUN_BUDGET_MS,
    warning: null,
  });
});

test('resolveRunBudgetMs: below the floor clamps up and warns', () => {
  const { budgetMs, warning } = resolveRunBudgetMs({ RUN_BUDGET_MS: '5000' });

  assert.equal(budgetMs, MIN_RUN_BUDGET_MS);
  assert.match(warning, /below the minimum of 30000ms/);
  assert.match(warning, /clamped to 30000/);
});

test('resolveRunBudgetMs: above the ceiling clamps down and warns', () => {
  const { budgetMs, warning } = resolveRunBudgetMs({ RUN_BUDGET_MS: '600000' });

  assert.equal(budgetMs, MAX_RUN_BUDGET_MS);
  assert.match(warning, /exceeds the maximum of 280000ms/);
  assert.match(warning, /clamped to 280000/);
});

test('resolveRunBudgetMs: anything that is not a positive integer falls back and warns', () => {
  for (const raw of ['0', '-1000', '4 minutes', '240_000', '2.5', 'lots']) {
    const { budgetMs, warning } = resolveRunBudgetMs({ RUN_BUDGET_MS: raw });

    assert.equal(budgetMs, RUN_BUDGET_MS, `RUN_BUDGET_MS=${raw} should use the default`);
    assert.match(warning, /not a positive integer/);
    assert.match(warning, /default of 240000ms/);
  }
});

test('resolveRunBudgetMs: is pure — reads the argument, not process.env', () => {
  const saved = process.env.RUN_BUDGET_MS;
  process.env.RUN_BUDGET_MS = '31000';
  try {
    assert.equal(resolveRunBudgetMs({}).budgetMs, RUN_BUDGET_MS);
  } finally {
    if (saved === undefined) delete process.env.RUN_BUDGET_MS;
    else process.env.RUN_BUDGET_MS = saved;
  }
});

// --- isTimeoutError ---------------------------------------------------------

test('isTimeoutError: recognises the message prod actually returned', () => {
  assert.equal(isTimeoutError({ message: 'canceling statement due to statement timeout' }), true);
  assert.equal(isTimeoutError('canceling statement due to STATEMENT TIMEOUT'), true, 'case-insensitive');
  assert.equal(isTimeoutError({ code: '57014', message: 'query cancelled' }), true, 'by SQLSTATE too');
  assert.equal(isTimeoutError({ details: 'statement timeout after 8s' }), true);
});

test('isTimeoutError: everything else is final', () => {
  assert.equal(isTimeoutError(null), false);
  assert.equal(isTimeoutError(undefined), false);
  assert.equal(isTimeoutError({ message: 'permission denied for function match_jobs_for_survey' }), false);
  assert.equal(isTimeoutError({ code: '42883', message: 'function does not exist' }), false);
  assert.equal(isTimeoutError({ code: '57014000', message: 'not really' }), false, 'not a substring match');
});

// --- findFeaturedJobs: a stub Supabase ---------------------------------------

const lead = (n) => ({
  survey_id: `survey-${n}`,
  email: `lead${n}@example.com`,
  email_lc: `lead${n}@example.com`,
  name: `Lead ${n}`,
});

const jobFor = (n) => ({
  id: `job-${n}`,
  title: 'Sales Associate',
  company: 'Instacart',
  location: 'Remote',
  work_type: 'Full-time',
  closed_at: null,
});

/**
 * The two calls findFeaturedJobs makes: rpc('match_jobs_for_survey', …) and
 * from('jobs').select(…).in('id', …). `onRpc` decides what each RPC returns, so
 * a test can time out, fail, or come back empty at will.
 */
function stubClient(onRpc, { meter = null } = {}) {
  const rpcCalls = [];
  const client = {
    rpcCalls,
    rpc: async (name, args) => {
      rpcCalls.push({ name, ...args });
      const run = () => onRpc(args, rpcCalls.length);
      return meter ? meter.around(run) : run();
    },
    from: () => ({
      select: () => ({
        in: async (_col, ids) => ({
          data: ids.map((id) => jobFor(id.replace('job-', ''))),
          error: null,
        }),
      }),
    }),
  };
  return client;
}

// A hit for lead N, keyed so the job id is traceable back to the lead.
const hit = (surveyId) => ({
  data: [{ job_id: `job-${String(surveyId).replace('survey-', '')}`, total_score: 0.9 }],
  error: null,
});

const quiet = async (fn) => {
  const real = { log: console.log, warn: console.warn, error: console.error };
  const logs = [];
  console.log = (...a) => logs.push(`log ${a.join(' ')}`);
  console.warn = (...a) => logs.push(`warn ${a.join(' ')}`);
  console.error = (...a) => logs.push(`error ${a.join(' ')}`);
  try {
    return { value: await fn(), logs };
  } finally {
    Object.assign(console, real);
  }
};

// --- findFeaturedJobs: the pool ---------------------------------------------

test('findFeaturedJobs: a 50-lead cohort never exceeds the concurrency limit', async () => {
  const leads = [...Array(50).keys()].map(lead);
  const meter = inFlightMeter();
  const client = stubClient(async (args) => {
    await delay(3); // long enough that an unbounded fan-out would show up
    return hit(args.p_survey_id);
  }, { meter });

  const { value } = await quiet(() =>
    findFeaturedJobs(leads, { client, concurrency: 4, runStartMs: Date.now(), budgetMs: 240000 })
  );

  assert.equal(meter.peak, 4, `peak in-flight was ${meter.peak}, limit is 4`);
  assert.equal(value.matched.length, 50, 'and every lead is still matched');
  assert.equal(client.rpcCalls.length, 50, 'one RPC each — the first rung hit for all of them');
  assert.deepEqual(
    value.matched.map((m) => m.lead.email_lc),
    leads.map((l) => l.email_lc),
    'input order survives the pool'
  );
});

test('findFeaturedJobs: the default concurrency is 4, not the cohort size', async () => {
  const leads = [...Array(20).keys()].map(lead);
  const meter = inFlightMeter();
  const client = stubClient(async (args) => {
    await delay(3);
    return hit(args.p_survey_id);
  }, { meter });

  await quiet(() => findFeaturedJobs(leads, { client, runStartMs: Date.now(), budgetMs: 240000 }));

  assert.equal(meter.peak, MATCH_CONCURRENCY);
});

test('findFeaturedJobs: one lead failing does not take the cohort down with it', async () => {
  const leads = [...Array(6).keys()].map(lead);
  const client = stubClient(async (args) => {
    if (args.p_survey_id === 'survey-3') return { data: null, error: { message: 'permission denied' } };
    return hit(args.p_survey_id);
  });

  const { value } = await quiet(() =>
    findFeaturedJobs(leads, { client, concurrency: 3, runStartMs: Date.now(), budgetMs: 240000 })
  );

  assert.equal(value.matched.length, 5);
  assert.equal(value.failed, 1);
  assert.ok(!value.matched.some((m) => m.lead.survey_id === 'survey-3'));
});

test('findFeaturedJobs: an unexpected throw is named once and does not stop the pool', async () => {
  const leads = [...Array(4).keys()].map(lead);
  const client = stubClient(async (args) => hit(args.p_survey_id));
  const realFrom = client.from;
  client.from = () => ({
    select: () => ({
      in: async (_col, ids) => {
        if (ids.includes('job-2')) throw new Error('socket hang up');
        return realFrom().select().in(_col, ids);
      },
    }),
  });

  const { value, logs } = await quiet(() =>
    findFeaturedJobs(leads, { client, concurrency: 2, runStartMs: Date.now(), budgetMs: 240000 })
  );

  assert.equal(value.matched.length, 3, 'the other three still come back');
  assert.equal(value.failed, 1);
  const errors = logs.filter((l) => l.includes('socket hang up'));
  assert.equal(errors.length, 1, 'named once, not swallowed by the pool');
});

test('findFeaturedJobs: the aggregate line reports the stage in one line', async () => {
  const leads = [...Array(3).keys()].map(lead);
  const client = stubClient(async (args) =>
    args.p_survey_id === 'survey-1' ? { data: [], error: null } : hit(args.p_survey_id)
  );

  const { logs } = await quiet(() =>
    findFeaturedJobs(leads, { client, concurrency: 2, runStartMs: Date.now(), budgetMs: 240000 })
  );

  const aggregate = logs.filter((l) => l.includes('Match stage:'));
  assert.equal(aggregate.length, 1, 'exactly one aggregate line per run');
  assert.match(aggregate[0], /matched 2, no-fresh-match 1, timed-out 0 \(retried\), deferred-by-budget 0/);
  assert.match(aggregate[0], /concurrency=2/);
});

// --- findFeaturedJobs: the run budget ---------------------------------------

test('findFeaturedJobs: the budget stops scheduling and defers the remainder', async () => {
  const leads = [...Array(6).keys()].map(lead);
  const client = stubClient(async (args) => hit(args.p_survey_id));

  // Stubbed clock: 30ms per reading against a 100ms budget from t=0, so leads
  // 0–3 are picked up in time and 4–5 are not.
  let tick = 0;
  const now = () => tick++ * 30;

  const { value, logs } = await quiet(() =>
    findFeaturedJobs(leads, { client, concurrency: 1, runStartMs: 0, budgetMs: 100, now })
  );

  assert.equal(value.deferredByBudget, 2, 'the remainder is deferred, by count');
  assert.equal(value.matched.length, 4);
  assert.deepEqual(
    value.matched.map((m) => m.lead.survey_id),
    ['survey-0', 'survey-1', 'survey-2', 'survey-3']
  );
  assert.equal(client.rpcCalls.length, 4, 'the deferred leads cost the database nothing');
  assert.deepEqual(
    { noFreshMatch: value.noFreshMatch, timedOut: value.timedOut, failed: value.failed },
    { noFreshMatch: 0, timedOut: 0, failed: 0 },
    'a budget cut is not a failure'
  );
  assert.ok(
    logs.some((l) => l.includes('deferred-by-budget 2')),
    'and the aggregate line says so'
  );
});

test('findFeaturedJobs: a budget already spent before the stage starts defers everyone', async () => {
  const leads = [...Array(4).keys()].map(lead);
  const client = stubClient(async (args) => hit(args.p_survey_id));

  const { value } = await quiet(() =>
    findFeaturedJobs(leads, { client, concurrency: 2, runStartMs: 0, budgetMs: 1000, now: () => 5000 })
  );

  assert.equal(value.deferredByBudget, 4);
  assert.deepEqual(value.matched, []);
  assert.equal(client.rpcCalls.length, 0, 'not one RPC is issued past the budget');
});

test('findFeaturedJobs: a budget with time left defers nobody', async () => {
  const leads = [...Array(4).keys()].map(lead);
  const client = stubClient(async (args) => hit(args.p_survey_id));

  const { value } = await quiet(() =>
    findFeaturedJobs(leads, { client, concurrency: 2, runStartMs: 0, budgetMs: 240000, now: () => 1000 })
  );

  assert.equal(value.deferredByBudget, 0);
  assert.equal(value.matched.length, 4);
});

// --- findFeaturedJobs: the timeout retry ------------------------------------

test('findFeaturedJobs: a timed-out match is retried once and the lead is matched', async () => {
  const client = stubClient(async (args, callNumber) => {
    if (callNumber === 1) {
      return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    }
    return hit(args.p_survey_id);
  });

  let slept = 0;
  const { value, logs } = await quiet(() =>
    findFeaturedJobs([lead(0)], {
      client,
      concurrency: 1,
      runStartMs: Date.now(),
      budgetMs: 240000,
      sleep: async (ms) => {
        slept = ms;
      },
    })
  );

  assert.equal(value.matched.length, 1, 'the retry rescued the lead');
  assert.equal(client.rpcCalls.length, 2, 'exactly one retry');
  assert.equal(value.retried, 1);
  assert.equal(value.timedOut, 0, 'a rescued timeout is not a failure');
  assert.equal(slept, MATCH_RETRY_DELAY_MS, 'and it waited a beat first');
  assert.equal(MATCH_RETRY_DELAY_MS, 750);
  assert.ok(!logs.some((l) => l.startsWith('error')), 'a rescued timeout logs no error line');
});

test('findFeaturedJobs: a timeout on both attempts gives up, once, loudly enough', async () => {
  const client = stubClient(async () => ({
    data: null,
    error: { message: 'canceling statement due to statement timeout' },
  }));

  const { value, logs } = await quiet(() =>
    findFeaturedJobs([lead(0)], {
      client,
      concurrency: 1,
      runStartMs: Date.now(),
      budgetMs: 240000,
      sleep: async () => {},
    })
  );

  assert.equal(client.rpcCalls.length, 2, 'retried once, then final');
  assert.deepEqual(value.matched, []);
  assert.equal(value.timedOut, 1);
  assert.equal(value.retried, 1);

  const errors = logs.filter((l) => l.startsWith('error'));
  assert.equal(errors.length, 1, 'one error line per lead, not one per attempt');
  assert.match(errors[0], /retried once after a statement timeout/);
});

test('findFeaturedJobs: a non-timeout error is NOT retried', async () => {
  const client = stubClient(async () => ({
    data: null,
    error: { code: '42501', message: 'permission denied for function match_jobs_for_survey' },
  }));

  const { value, logs } = await quiet(() =>
    findFeaturedJobs([lead(0)], {
      client,
      concurrency: 1,
      runStartMs: Date.now(),
      budgetMs: 240000,
      sleep: async () => {
        throw new Error('must not sleep — this error is final');
      },
    })
  );

  assert.equal(client.rpcCalls.length, 1, "today's behaviour: other errors are final");
  assert.equal(value.retried, 0);
  assert.equal(value.timedOut, 0);
  assert.equal(value.failed, 1);
  assert.deepEqual(value.matched, []);
  assert.ok(logs.some((l) => l.includes('permission denied')));
  assert.ok(!logs.some((l) => l.includes('retried once')));
});

test('findFeaturedJobs: the retry is per ladder step, not per lead', async () => {
  // 3d comes back empty (a ladder step, not an error), 7d times out once, then
  // succeeds: 3 calls total, and the 3d rung is never re-run.
  const client = stubClient(async (args, callNumber) => {
    if (args.p_fresh_days === FRESH_DAY_STEPS[0]) return { data: [], error: null };
    if (callNumber === 2) {
      return { data: null, error: { message: 'canceling statement due to statement timeout' } };
    }
    return hit(args.p_survey_id);
  });

  const { value } = await quiet(() =>
    findFeaturedJobs([lead(0)], {
      client,
      concurrency: 1,
      runStartMs: Date.now(),
      budgetMs: 240000,
      sleep: async () => {},
    })
  );

  assert.equal(value.matched.length, 1);
  assert.deepEqual(
    client.rpcCalls.map((c) => c.p_fresh_days),
    [FRESH_DAY_STEPS[0], FRESH_DAY_STEPS[1], FRESH_DAY_STEPS[1]],
    'the ladder is not restarted — only the failed rung is retried'
  );
});

test('findFeaturedJobs: 44-of-50 timing out is survivable now — the retry rescues them', async () => {
  // The shape of the real 18:00 UTC run, replayed: every lead times out on its
  // first attempt. Before this change all 44 were lost; now they come back.
  const leads = [...Array(50).keys()].map(lead);
  const firstAttempt = new Set();
  const client = stubClient(async (args) => {
    if (!firstAttempt.has(args.p_survey_id)) {
      firstAttempt.add(args.p_survey_id);
      return { data: null, error: { message: 'canceling statement due to statement timeout' } };
    }
    return hit(args.p_survey_id);
  });

  const { value } = await quiet(() =>
    findFeaturedJobs(leads, {
      client,
      concurrency: 4,
      runStartMs: Date.now(),
      budgetMs: 240000,
      sleep: async () => {},
    })
  );

  assert.equal(value.matched.length, 50);
  assert.equal(value.retried, 50);
  assert.equal(value.timedOut, 0);
});

// --- run(): the budget count reaches the summary ----------------------------
//
// Same technique as the other drives: patch the collaborators on their module
// objects BEFORE index.js is required, because index.js destructures at import.

const queries = require('./queries');
const brevo = require('./brevo');
const sentTracker = require('./sent-tracker');
const matchReason = require('./match-reason');

const JOB = { ...jobFor(1), first_seen_at: new Date().toISOString(), salary_min: 0, salary_max: 0 };
const drive = { cohort: [], deferredByBudget: 0, matchLeads: 0, sentTo: [] };

queries.findAnonLeads = async () => drive.cohort;
queries.findFeaturedJobs = async (leads) => {
  const taken = leads.slice(0, leads.length - drive.deferredByBudget);
  drive.matchLeads = leads.length;
  return {
    matched: taken.map((l) => ({ lead: l, job: JOB, pct: 88 })),
    noFreshMatch: 0,
    timedOut: 0,
    retried: 0,
    failed: 0,
    deferredByBudget: drive.deferredByBudget,
  };
};
brevo.sendJobEmail = async (payload) => {
  drive.sentTo.push(payload.to[0].email);
  return 'stub-message-id';
};
sentTracker.isDurable = () => true;
sentTracker.hasBeenSent = async () => false;
sentTracker.markSent = async () => {};
matchReason.generateMatchReasons = async () => ['one', 'two', 'three'];

const { run } = require('./index');

const RUN_ENV = [
  'DRY_RUN',
  'VERCEL',
  'BACKFILL_DAYS',
  'SEND_CAP',
  'TARGET_EMAILS',
  'MATCH_CONCURRENCY',
  'RUN_BUDGET_MS',
  'EMAIL_LINK_SECRET',
  'BREVO_TEMPLATE_ID_ANON_LEAD',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
];

async function driveRun(overrides) {
  const saved = Object.fromEntries(RUN_ENV.map((k) => [k, process.env[k]]));
  for (const key of RUN_ENV) delete process.env[key];
  Object.assign(process.env, {
    DRY_RUN: 'false',
    EMAIL_LINK_SECRET: 'test-secret',
    BREVO_TEMPLATE_ID_ANON_LEAD: '39',
    ...overrides,
  });

  try {
    return await quiet(() => run());
  } finally {
    for (const key of RUN_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const fullLead = (n) => ({
  ...lead(n),
  session_id: `session-${n}`,
  resume_parsed: { email: `lead${n}@example.com`, name: `Lead ${n}` },
  created_at: new Date(Date.now() - (n + 1) * 60000).toISOString(),
  marketing_opt_in_at: new Date(Date.now() - (n + 1) * 60000).toISOString(),
});

test('run(): budget-deferred leads are reported, not sent, and not counted as skipped', async () => {
  drive.cohort = [...Array(5).keys()].map(fullLead);
  drive.deferredByBudget = 2;
  drive.sentTo = [];

  const { value: summary, logs } = await driveRun({});

  assert.equal(summary.deferredByBudget, 2, 'the summary carries the count');
  assert.equal(summary.sent, 3);
  assert.equal(summary.skipped, 0, 'deferred is not skipped — those leads are still pending');
  assert.equal(drive.sentTo.length, 3, 'and the deferred leads got no email');
  assert.ok(logs.some((l) => l.includes('RUN BUDGET reached')), 'the run logs one budget summary line');
  assert.ok(logs.some((l) => l.includes('3 lead(s) processed, 2 deferred')));
});

test('run(): with no budget cut the summary reports zero deferred and nothing changes', async () => {
  drive.cohort = [...Array(5).keys()].map(fullLead);
  drive.deferredByBudget = 0;
  drive.sentTo = [];

  const { value: summary, logs } = await driveRun({});

  assert.equal(summary.deferredByBudget, 0);
  assert.equal(summary.sent, 5);
  assert.equal(summary.skipped, 0);
  assert.ok(!logs.some((l) => l.includes('RUN BUDGET reached')), 'no budget noise on a healthy run');
});

test('run(): the knobs are resolved, announced, and warn when misconfigured', async () => {
  drive.cohort = [];
  drive.deferredByBudget = 0;

  const clean = await driveRun({ MATCH_CONCURRENCY: '2', RUN_BUDGET_MS: '120000' });
  assert.ok(clean.logs.some((l) => l.includes('matchConcurrency=2, budget=120000ms')));

  const junk = await driveRun({ MATCH_CONCURRENCY: 'lots', RUN_BUDGET_MS: '9' });
  assert.ok(junk.logs.some((l) => l.includes('MATCH_CONCURRENCY="lots" is not a positive integer')));
  assert.ok(junk.logs.some((l) => l.includes('RUN_BUDGET_MS=9 is below the minimum')));
  assert.ok(
    junk.logs.some((l) => l.includes(`matchConcurrency=${MATCH_CONCURRENCY}, budget=${MIN_RUN_BUDGET_MS}ms`)),
    'the run falls back to the default concurrency and the clamped budget'
  );
});
