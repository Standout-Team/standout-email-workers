/**
 * Coverage for the fail-closed dedup guard (PR #1 review): the pure decision
 * function, the cap it forces on the surviving non-durable path, and a stubbed
 * drive of run() proving the throw lands before any Supabase or Brevo work.
 *
 *   node --test            (from the repo root or this directory)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateDedupSafety, capForDedupAction, _internals } = require('./queries');

const { NON_DURABLE_SEND_CAP } = _internals;

// --- evaluateDedupSafety: every branch of (durable × dryRun × onVercel) -----

test('evaluateDedupSafety: durable is ok — real send on Vercel', () => {
  const { action } = evaluateDedupSafety({ durable: true, dryRun: false, onVercel: true });
  assert.equal(action, 'ok');
});

test('evaluateDedupSafety: durable is ok — dry run too', () => {
  for (const onVercel of [true, false]) {
    const { action } = evaluateDedupSafety({ durable: true, dryRun: true, onVercel });
    assert.equal(action, 'ok', `durable + dry + onVercel=${onVercel} should be ok`);
  }
});

test('evaluateDedupSafety: non-durable real send on Vercel throws', () => {
  const { action, reason } = evaluateDedupSafety({ durable: false, dryRun: false, onVercel: true });

  assert.equal(action, 'throw');
  // The reason has to be actionable on its own: it is what the cron failure says.
  assert.match(reason, /KV_REST_API_URL/);
  assert.match(reason, /KV_REST_API_TOKEN/);
  assert.match(reason, /every hourly run/);
  assert.match(reason, /real people/);
});

test('evaluateDedupSafety: non-durable dry run on Vercel only warns', () => {
  const { action, reason } = evaluateDedupSafety({ durable: false, dryRun: true, onVercel: true });

  assert.equal(action, 'warn');
  assert.match(reason, /per-process only/);
  assert.match(reason, /refuse to run/);
});

test('evaluateDedupSafety: non-durable real send off Vercel only warns', () => {
  const { action, reason } = evaluateDedupSafety({ durable: false, dryRun: false, onVercel: false });

  assert.equal(action, 'warn');
  assert.match(reason, /per-process only/);
  assert.match(reason, /refuse to run/);
});

test('evaluateDedupSafety: non-durable dry run off Vercel only warns', () => {
  const { action } = evaluateDedupSafety({ durable: false, dryRun: true, onVercel: false });
  assert.equal(action, 'warn');
});

test('evaluateDedupSafety: only the Vercel real-send corner throws', () => {
  const thrown = [];
  for (const durable of [true, false]) {
    for (const dryRun of [true, false]) {
      for (const onVercel of [true, false]) {
        const { action } = evaluateDedupSafety({ durable, dryRun, onVercel });
        if (action === 'throw') thrown.push({ durable, dryRun, onVercel });
      }
    }
  }

  assert.deepEqual(thrown, [{ durable: false, dryRun: false, onVercel: true }]);
});

test('evaluateDedupSafety: is pure — same input, same output, no env reads', () => {
  const saved = process.env.KV_REST_API_URL;
  process.env.KV_REST_API_URL = 'https://kv.example.com';
  try {
    const { action } = evaluateDedupSafety({ durable: false, dryRun: false, onVercel: true });
    assert.equal(action, 'throw', 'the decision comes from the argument, not the environment');
  } finally {
    if (saved === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = saved;
  }
});

// --- capForDedupAction: the belt-and-suspenders cap on the warn path --------

test('capForDedupAction: warn with no explicit cap forces 50', () => {
  assert.equal(capForDedupAction(null, 'warn'), NON_DURABLE_SEND_CAP);
  assert.equal(capForDedupAction(undefined, 'warn'), NON_DURABLE_SEND_CAP);
  assert.equal(capForDedupAction(Infinity, 'warn'), NON_DURABLE_SEND_CAP);
});

test('capForDedupAction: warn narrows a larger explicit cap to 50', () => {
  assert.equal(capForDedupAction(200, 'warn'), NON_DURABLE_SEND_CAP);
});

test('capForDedupAction: warn leaves a smaller explicit cap alone', () => {
  assert.equal(capForDedupAction(10, 'warn'), 10);
  assert.equal(capForDedupAction(NON_DURABLE_SEND_CAP, 'warn'), NON_DURABLE_SEND_CAP);
});

test('capForDedupAction: ok leaves the cap untouched, uncapped included', () => {
  assert.equal(capForDedupAction(null, 'ok'), null);
  assert.equal(capForDedupAction(200, 'ok'), 200);
  assert.equal(capForDedupAction(10, 'ok'), 10);
});

// --- stubbed drive of run() -------------------------------------------------
//
// The collaborators are patched on their module objects BEFORE index.js is
// required, because index.js destructures them at import time. That makes the
// call counters below a real proof of ordering: run() cannot have queried
// Supabase or called Brevo without incrementing one of them.

const queries = require('./queries');
const brevo = require('./brevo');

const calls = { findAnonLeads: 0, findFeaturedJobs: 0, send: 0 };

queries.findAnonLeads = async () => {
  calls.findAnonLeads++;
  return [];
};
queries.findFeaturedJobs = async () => {
  calls.findFeaturedJobs++;
  return { matched: [], noFreshMatch: 0, timedOut: 0, retried: 0, failed: 0, deferredByBudget: 0 };
};
brevo.sendJobEmail = async () => {
  calls.send++;
  return 'stub-message-id';
};

const { run } = require('./index');

const GUARDED_ENV = [
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'VERCEL',
  'VERCEL_ENV',
  'DRY_RUN',
  'BACKFILL_DAYS',
  'SEND_CAP',
];

// run() reads all of these at call time, so setting them here beats whatever
// dotenv may have loaded at import.
async function withEnv(overrides, fn) {
  const saved = Object.fromEntries(GUARDED_ENV.map((k) => [k, process.env[k]]));
  const quiet = { log: console.log, warn: console.warn, error: console.error };

  for (const key of GUARDED_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  calls.findAnonLeads = 0;
  calls.findFeaturedJobs = 0;
  calls.send = 0;

  try {
    return await fn();
  } finally {
    Object.assign(console, quiet);
    for (const key of GUARDED_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('run(): a real send on Vercel without KV throws before any Supabase or Brevo call', async () => {
  await withEnv({ VERCEL: '1', DRY_RUN: 'false' }, async () => {
    await assert.rejects(() => run(), /non-durable dedup/i);
    assert.equal(calls.findAnonLeads, 0, 'must not query Supabase');
    assert.equal(calls.findFeaturedJobs, 0, 'must not look up jobs');
    assert.equal(calls.send, 0, 'must not send');
  });
});

test('run(): a Vercel preview counts as Vercel — VERCEL alone arms the guard', async () => {
  // No VERCEL_ENV=production anywhere: a preview with DRY_RUN=false and a live
  // Brevo key mails real people exactly as hard as production does.
  await withEnv({ VERCEL: '1', VERCEL_ENV: 'preview', DRY_RUN: 'false' }, async () => {
    await assert.rejects(() => run(), /non-durable dedup/i);
    assert.equal(calls.send, 0);
  });
});

test('run(): a dry run without KV proceeds, reports non-durable, and is capped at 50', async () => {
  const summary = await withEnv({ VERCEL: '1', DRY_RUN: 'true' }, () => run());

  assert.equal(summary.dedup, 'non-durable');
  assert.equal(summary.cap, NON_DURABLE_SEND_CAP, 'the forced cap shows in the dry-run prediction');
  assert.equal(summary.dryRun, true);
  assert.equal(calls.findAnonLeads, 1, 'the dry run still does the read');
  assert.equal(calls.send, 0);
});

test('run(): the forced cap does not raise an operator cap that is already lower', async () => {
  const summary = await withEnv({ DRY_RUN: 'true', SEND_CAP: '10' }, () => run());

  assert.equal(summary.dedup, 'non-durable');
  assert.equal(summary.cap, 10);
});

test('run(): with KV configured the cap is untouched and dedup reports durable', async () => {
  const summary = await withEnv(
    {
      KV_REST_API_URL: 'https://kv.example.com',
      KV_REST_API_TOKEN: 'stub-token',
      VERCEL: '1',
      DRY_RUN: 'false',
    },
    () => run()
  );

  assert.equal(summary.dedup, 'durable');
  assert.equal(summary.cap, null, 'normal mode stays uncapped when dedup is durable');
  assert.equal(calls.findAnonLeads, 1);
});

test('run(): a durable backfill keeps its own 50 cap, not the guard\'s', async () => {
  const summary = await withEnv(
    {
      KV_REST_API_URL: 'https://kv.example.com',
      KV_REST_API_TOKEN: 'stub-token',
      DRY_RUN: 'true',
      BACKFILL_DAYS: '14',
      SEND_CAP: '200',
    },
    () => run()
  );

  assert.equal(summary.dedup, 'durable');
  assert.equal(summary.cap, 200, 'an explicit cap survives when dedup is durable');
});
