/**
 * Coverage for the role-fanout matcher mode (2026-08-13): the `MATCH_ROLE_FANOUT`
 * parser and the `p_balance` argument it becomes on every match_jobs_for_survey
 * call.
 *
 * The bug this closes is a real divergence, not a hypothetical: the app passes
 * balancedRoleMatchEnabled() at all three of its call sites and the flag is ON in
 * production, while this worker called the RPC with three named args and let
 * `p_balance` fall back to its `DEFAULT false`. Measured against prod, 5 of 6
 * recent multi-category surveys got a DIFFERENT top job out of the two modes — so
 * the job we emailed and the top job of the feed that same click lands on were
 * chosen by different matchers.
 *
 * Two things are therefore asserted here, not one: that the parser is
 * byte-identical to the app's (`Standout-pro/server/lib/feature-flags.ts`), and
 * that the resolved value actually reaches the RPC payload — once per run, for
 * every lead in that run.
 *
 * No Supabase, no Brevo, no KV: the client is injected.
 *
 *   node --test            (from the repo root or this directory)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const queries = require('./queries');
// Captured BEFORE the module object is patched for the run() drives below, so
// these tests exercise the real implementation.
const { balancedRoleMatchEnabled, findFeaturedJobs } = queries;

// --- balancedRoleMatchEnabled: the parser -----------------------------------
//
// The sentinel is the literal string "on". Whitespace is trimmed and case is
// folded, and NOTHING else is true — deliberately, because the app's twin reads
// exactly this way and a worker that also accepted "true"/"1" would diverge from
// it on precisely the values an operator is most likely to reach for.

test('balancedRoleMatchEnabled: "on" in every casing and padding is true', () => {
  for (const raw of ['on', 'ON', 'On', 'oN', ' on', 'on ', ' on ', '\ton\n', '  ON  ']) {
    assert.equal(
      balancedRoleMatchEnabled({ MATCH_ROLE_FANOUT: raw }),
      true,
      `MATCH_ROLE_FANOUT=${JSON.stringify(raw)} should be on`
    );
  }
});

test('balancedRoleMatchEnabled: unset, empty and whitespace are off', () => {
  assert.equal(balancedRoleMatchEnabled({}), false, 'unset');
  for (const raw of ['', '   ', '\t', '\n', undefined, null]) {
    assert.equal(
      balancedRoleMatchEnabled({ MATCH_ROLE_FANOUT: raw }),
      false,
      `MATCH_ROLE_FANOUT=${JSON.stringify(raw)} should be off`
    );
  }
});

test('balancedRoleMatchEnabled: every other truthy-looking value is still off', () => {
  // "true"/"1"/"yes" are the tempting ones: they read as enabled and are NOT.
  // That is the app's semantics, and matching it is the whole point.
  for (const raw of ['true', 'TRUE', '1', 'yes', 'y', 'enabled', 'off', 'OFF', 'false', '0', 'no']) {
    assert.equal(
      balancedRoleMatchEnabled({ MATCH_ROLE_FANOUT: raw }),
      false,
      `MATCH_ROLE_FANOUT=${JSON.stringify(raw)} should be off`
    );
  }
});

test('balancedRoleMatchEnabled: "on" must be the WHOLE value, not a substring', () => {
  for (const raw of ['onx', 'xon', 'on on', 'on,off', 'once', 'only', 'no on']) {
    assert.equal(
      balancedRoleMatchEnabled({ MATCH_ROLE_FANOUT: raw }),
      false,
      `MATCH_ROLE_FANOUT=${JSON.stringify(raw)} should be off`
    );
  }
});

test('balancedRoleMatchEnabled: is pure — the argument wins over process.env', () => {
  const saved = process.env.MATCH_ROLE_FANOUT;
  try {
    process.env.MATCH_ROLE_FANOUT = 'on';
    assert.equal(balancedRoleMatchEnabled({}), false, 'an explicit env object is not process.env');
    assert.equal(balancedRoleMatchEnabled({ MATCH_ROLE_FANOUT: 'off' }), false);

    process.env.MATCH_ROLE_FANOUT = 'off';
    assert.equal(balancedRoleMatchEnabled({ MATCH_ROLE_FANOUT: 'on' }), true);
  } finally {
    if (saved === undefined) delete process.env.MATCH_ROLE_FANOUT;
    else process.env.MATCH_ROLE_FANOUT = saved;
  }
});

test('balancedRoleMatchEnabled: with no argument it reads process.env', () => {
  const saved = process.env.MATCH_ROLE_FANOUT;
  try {
    process.env.MATCH_ROLE_FANOUT = 'on';
    assert.equal(balancedRoleMatchEnabled(), true);

    delete process.env.MATCH_ROLE_FANOUT;
    assert.equal(balancedRoleMatchEnabled(), false, 'unset is the single-vector path');
  } finally {
    if (saved === undefined) delete process.env.MATCH_ROLE_FANOUT;
    else process.env.MATCH_ROLE_FANOUT = saved;
  }
});

// --- a stub Supabase --------------------------------------------------------

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

const hit = (surveyId) => ({
  data: [{ job_id: `job-${String(surveyId).replace('survey-', '')}`, total_score: 0.9 }],
  error: null,
});

function stubClient(onRpc = async (args) => hit(args.p_survey_id)) {
  const rpcCalls = [];
  return {
    rpcCalls,
    rpc: async (name, args) => {
      rpcCalls.push({ name, ...args });
      return onRpc(args, rpcCalls.length);
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
}

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

const MATCH_ENV = ['MATCH_ROLE_FANOUT'];

async function withEnv(overrides, fn) {
  const saved = Object.fromEntries(MATCH_ENV.map((k) => [k, process.env[k]]));
  for (const key of MATCH_ENV) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const key of MATCH_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// --- findFeaturedJobs: p_balance reaches the RPC ------------------------------

test('findFeaturedJobs: MATCH_ROLE_FANOUT=on puts p_balance:true on every RPC', async () => {
  const leads = [...Array(5).keys()].map(lead);
  const client = stubClient();

  await withEnv({ MATCH_ROLE_FANOUT: 'on' }, () =>
    quiet(() => findFeaturedJobs(leads, { client, concurrency: 2, runStartMs: Date.now(), budgetMs: 240000 }))
  );

  assert.equal(client.rpcCalls.length, 5);
  for (const call of client.rpcCalls) {
    assert.equal(call.name, 'match_jobs_for_survey');
    assert.equal(call.p_balance, true, `p_balance for ${call.p_survey_id}`);
  }
});

test('findFeaturedJobs: with MATCH_ROLE_FANOUT unset p_balance is sent, explicitly false', async () => {
  const leads = [...Array(3).keys()].map(lead);
  const client = stubClient();

  await withEnv({}, () =>
    quiet(() => findFeaturedJobs(leads, { client, concurrency: 2, runStartMs: Date.now(), budgetMs: 240000 }))
  );

  assert.equal(client.rpcCalls.length, 3);
  for (const call of client.rpcCalls) {
    // Present-and-false, not absent: letting the argument fall away would hand
    // the mode back to the RPC's own DEFAULT false, silently.
    assert.ok('p_balance' in call, 'p_balance is always sent');
    assert.equal(call.p_balance, false);
  }
});

test('findFeaturedJobs: an explicit options.balanced overrides the env', async () => {
  const onClient = stubClient();
  await withEnv({}, () =>
    quiet(() =>
      findFeaturedJobs([lead(0)], {
        client: onClient,
        balanced: true,
        concurrency: 1,
        runStartMs: Date.now(),
        budgetMs: 240000,
      })
    )
  );
  assert.equal(onClient.rpcCalls[0].p_balance, true);

  const offClient = stubClient();
  await withEnv({ MATCH_ROLE_FANOUT: 'on' }, () =>
    quiet(() =>
      findFeaturedJobs([lead(0)], {
        client: offClient,
        balanced: false,
        concurrency: 1,
        runStartMs: Date.now(),
        budgetMs: 240000,
      })
    )
  );
  assert.equal(offClient.rpcCalls[0].p_balance, false);
});

test('findFeaturedJobs: the mode is resolved once per run, not once per lead', async () => {
  const leads = [...Array(4).keys()].map(lead);
  // The env flips out from under the run after the first RPC. A per-lead read
  // would rank leads 2-4 the other way; a once-per-run read cannot.
  const client = stubClient(async (args, callNumber) => {
    if (callNumber === 1) delete process.env.MATCH_ROLE_FANOUT;
    return hit(args.p_survey_id);
  });

  await withEnv({ MATCH_ROLE_FANOUT: 'on' }, () =>
    quiet(() => findFeaturedJobs(leads, { client, concurrency: 1, runStartMs: Date.now(), budgetMs: 240000 }))
  );

  assert.equal(client.rpcCalls.length, 4);
  assert.deepEqual(
    client.rpcCalls.map((c) => c.p_balance),
    [true, true, true, true],
    'every lead in a run is ranked by the same matcher'
  );
});

test('findFeaturedJobs: every rung of the freshness ladder carries the same p_balance', async () => {
  const { FRESH_DAY_STEPS } = queries._internals;
  // The first two rungs come back empty, so this lead walks the ladder.
  const client = stubClient(async (args) => {
    if (args.p_fresh_days === FRESH_DAY_STEPS[0] || args.p_fresh_days === FRESH_DAY_STEPS[1]) {
      return { data: [], error: null };
    }
    return hit(args.p_survey_id);
  });

  await withEnv({ MATCH_ROLE_FANOUT: 'ON' }, () =>
    quiet(() => findFeaturedJobs([lead(0)], { client, concurrency: 1, runStartMs: Date.now(), budgetMs: 240000 }))
  );

  assert.deepEqual(
    client.rpcCalls.map((c) => c.p_fresh_days),
    [FRESH_DAY_STEPS[0], FRESH_DAY_STEPS[1], FRESH_DAY_STEPS[2]]
  );
  assert.deepEqual(client.rpcCalls.map((c) => c.p_balance), [true, true, true]);
});

test('findFeaturedJobs: the three existing RPC args are untouched', async () => {
  const client = stubClient();

  await withEnv({ MATCH_ROLE_FANOUT: 'on' }, () =>
    quiet(() => findFeaturedJobs([lead(7)], { client, concurrency: 1, runStartMs: Date.now(), budgetMs: 240000 }))
  );

  assert.deepEqual(client.rpcCalls[0], {
    name: 'match_jobs_for_survey',
    p_survey_id: 'survey-7',
    p_limit: 10,
    p_fresh_days: 3,
    p_balance: true,
  });
});

test('findFeaturedJobs: the aggregate line names the matcher mode', async () => {
  const on = await withEnv({ MATCH_ROLE_FANOUT: 'on' }, () =>
    quiet(() =>
      findFeaturedJobs([lead(0)], {
        client: stubClient(),
        concurrency: 1,
        runStartMs: Date.now(),
        budgetMs: 240000,
      })
    )
  );
  assert.ok(on.logs.some((l) => l.includes('Match stage:') && l.includes('roleFanout=on')));

  const off = await withEnv({}, () =>
    quiet(() =>
      findFeaturedJobs([lead(0)], {
        client: stubClient(),
        concurrency: 1,
        runStartMs: Date.now(),
        budgetMs: 240000,
      })
    )
  );
  assert.ok(off.logs.some((l) => l.includes('Match stage:') && l.includes('roleFanout=off')));
});

// --- run(): the flag is resolved once and threaded through -------------------
//
// Same technique as the other drives: patch the collaborators on their module
// objects BEFORE index.js is required, because index.js destructures at import.
// findFeaturedJobs is not replaced with a fake here — it delegates to the REAL
// one with a stub client, so these drives assert the whole chain from the run's
// env to the RPC payload.

const brevo = require('./brevo');
const sentTracker = require('./sent-tracker');
const matchReason = require('./match-reason');

const JOB = { ...jobFor(1), first_seen_at: new Date().toISOString(), salary_min: 0, salary_max: 0 };
const drive = { cohort: [], client: null, options: null, calls: 0 };

queries.findAnonLeads = async () => drive.cohort;
queries.findFeaturedJobs = async (leads, options) => {
  drive.calls++;
  drive.options = options;
  return findFeaturedJobs(leads, { ...options, client: drive.client });
};
brevo.sendJobEmail = async () => 'stub-message-id';
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
  'MATCH_ROLE_FANOUT',
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
    MATCH_CONCURRENCY: '1',
    ...overrides,
  });

  drive.calls = 0;
  drive.options = null;

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

test('run(): MATCH_ROLE_FANOUT=on reaches every lead\'s RPC as p_balance:true', async () => {
  drive.cohort = [...Array(3).keys()].map(fullLead);
  drive.client = stubClient();

  const { value: summary, logs } = await driveRun({ MATCH_ROLE_FANOUT: 'on' });

  assert.equal(summary.sent, 3);
  assert.equal(drive.calls, 1, 'the match stage is entered once per run');
  assert.equal(drive.options.balanced, true, 'and the run resolved the flag, not the RPC helper');
  assert.deepEqual(
    drive.client.rpcCalls.map((c) => c.p_balance),
    [true, true, true]
  );
  assert.ok(logs.some((l) => l.includes('Starting run') && l.includes('roleFanout=on')));
  assert.equal(summary.balanced, true, 'the summary carries it for the JSON handler response');
});

test('run(): with MATCH_ROLE_FANOUT unset the run is single-vector, and says so', async () => {
  drive.cohort = [...Array(3).keys()].map(fullLead);
  drive.client = stubClient();

  const { value: summary, logs } = await driveRun({});

  assert.equal(summary.sent, 3);
  assert.equal(drive.options.balanced, false);
  assert.deepEqual(
    drive.client.rpcCalls.map((c) => c.p_balance),
    [false, false, false]
  );
  assert.ok(logs.some((l) => l.includes('Starting run') && l.includes('roleFanout=off')));
  assert.equal(summary.balanced, false);
});

test('run(): the flag is read once per run, not once per lead', async () => {
  drive.cohort = [...Array(4).keys()].map(fullLead);
  // Flip the env out from under the run once the first RPC has been issued.
  drive.client = stubClient(async (args, callNumber) => {
    if (callNumber === 1) delete process.env.MATCH_ROLE_FANOUT;
    return hit(args.p_survey_id);
  });

  const { value: summary } = await driveRun({ MATCH_ROLE_FANOUT: 'on' });

  assert.deepEqual(
    drive.client.rpcCalls.map((c) => c.p_balance),
    [true, true, true, true],
    'one run ranks all of its leads the same way'
  );
  assert.equal(summary.balanced, true, 'and the summary reports the mode the run actually used');
});

test('run(): a value that is not "on" is off — no accidental half-enable', async () => {
  for (const raw of ['true', '1', 'yes', 'off', 'onx']) {
    drive.cohort = [fullLead(0)];
    drive.client = stubClient();

    const { value: summary, logs } = await driveRun({ MATCH_ROLE_FANOUT: raw });

    assert.equal(summary.balanced, false, `MATCH_ROLE_FANOUT=${raw}`);
    assert.equal(drive.client.rpcCalls[0].p_balance, false, `MATCH_ROLE_FANOUT=${raw}`);
    assert.ok(logs.some((l) => l.includes('roleFanout=off')), `MATCH_ROLE_FANOUT=${raw}`);
  }
});

test('run(): " On " is on — trimmed and case-folded, exactly like the app', async () => {
  drive.cohort = [fullLead(0)];
  drive.client = stubClient();

  const { value: summary } = await driveRun({ MATCH_ROLE_FANOUT: ' On ' });

  assert.equal(summary.balanced, true);
  assert.equal(drive.client.rpcCalls[0].p_balance, true);
});
