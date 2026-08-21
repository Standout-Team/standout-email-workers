/**
 * Stubbed drives of run() for the two rails added with the email sequence:
 *
 *   1. A stage will not send without its own Brevo template.
 *   2. A lead who paid between cohort-build and dispatch is not mailed.
 *
 * Same technique as dedup-guard.test.js: collaborators are patched on their
 * module objects BEFORE index.js is required, because index.js destructures
 * them at import time. node --test gives each file its own process, so these
 * stubs cannot leak into the other suites.
 *
 *   node --test            (from the repo root or this directory)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const queries = require('./queries');
const brevo = require('./brevo');
const sentTracker = require('./sent-tracker');
const matchReason = require('./match-reason');
const { EMAIL_STAGES } = require('./stages');

const LEAD = {
  email: 'Lead@Example.com',
  email_lc: 'lead@example.com',
  survey_id: 4242,
  session_id: 'sess-1',
  resume_parsed: { location: 'Austin, TX', phone: '(512) 555-0100' },
};
const JOB = {
  id: 99001,
  title: 'Staff Engineer',
  company: 'examplecorp',
  location: 'Austin, TX',
  work_type: 'remote',
  salary_min: 180000,
  salary_max: 220000,
  first_seen_at: new Date().toISOString(),
};

// Controlled per test.
const stub = { unpaid: true, unpaidThrows: false };
const calls = { send: 0, marked: [] };

queries.findAnonLeads = async () => [LEAD];
queries.findFeaturedJobs = async () => ({
  matched: [{ lead: LEAD, job: JOB, pct: 97 }],
  noFreshMatch: 0,
  timedOut: 0,
  retried: 0,
  failed: 0,
  deferredByBudget: 0,
});
queries.isStillUnpaid = async () => {
  if (stub.unpaidThrows) throw new Error('supabase blip');
  return stub.unpaid;
};
brevo.sendJobEmail = async () => {
  calls.send++;
  return 'stub-message-id';
};
sentTracker.hasBeenSent = async () => false;
sentTracker.markSent = async (emailLc, jobId, stage) => {
  calls.marked.push({ emailLc, jobId, stageId: stage && stage.id });
};
sentTracker.isDurable = () => true;
matchReason.generateMatchReasons = async () => ['a', 'b', 'c'];

const { run } = require('./index');

const GUARDED_ENV = [
  'EMAIL_STAGE',
  'BREVO_TEMPLATE_ID_ANON_LEAD',
  'BREVO_TEMPLATE_ID_ANON_LEAD_24H',
  'BREVO_TEMPLATE_ID_ANON_LEAD_48H',
  'DRY_RUN',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'VERCEL',
  'EMAIL_LINK_SECRET',
  'BACKFILL_DAYS',
  'SEND_CAP',
];

async function drive(overrides, fn) {
  const saved = Object.fromEntries(GUARDED_ENV.map((k) => [k, process.env[k]]));
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  const warnings = [];

  for (const key of GUARDED_ENV) delete process.env[key];
  // Every drive needs a signable link, durable dedup, and a real (non-dry) send
  // path unless the test says otherwise.
  process.env.EMAIL_LINK_SECRET = 'test-secret';
  process.env.KV_REST_API_URL = 'https://kv.example.com';
  process.env.KV_REST_API_TOKEN = 'stub-token';
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;

  console.log = () => {};
  console.warn = (...args) => warnings.push(args.join(' '));
  console.error = () => {};

  calls.send = 0;
  calls.marked = [];
  stub.unpaid = true;
  stub.unpaidThrows = false;

  try {
    return { result: await fn(), warnings };
  } finally {
    Object.assign(console, quiet);
    for (const key of GUARDED_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// --- Rail 1: no template, no send -----------------------------------------

test('run(): a real run refuses to start without a template for its stage', async () => {
  await assert.rejects(
    () => drive({ EMAIL_STAGE: 'day1', DRY_RUN: 'false' }, () => run()),
    /Stage "day1" \(24h\) has no Brevo template — set BREVO_TEMPLATE_ID_ANON_LEAD_24H/
  );
  assert.equal(calls.send, 0, 'nothing may be sent when the template is missing');
});

test('run(): the 1h template does not satisfy a later stage', async () => {
  // The failure mode this prevents: shipping a new cron that inherits Email 1's
  // template and mails Email 1's copy on Email 2's schedule.
  await assert.rejects(
    () => drive({ EMAIL_STAGE: 'day2', DRY_RUN: 'false', BREVO_TEMPLATE_ID_ANON_LEAD: '39' }, () => run()),
    /set BREVO_TEMPLATE_ID_ANON_LEAD_48H/
  );
});

test('run(): a dry run without a template warns and continues', async () => {
  // This is how you rehearse a new stage before its Brevo template exists.
  const { warnings } = await drive({ EMAIL_STAGE: 'day2', DRY_RUN: 'true' }, () => run());
  assert.ok(
    warnings.some((w) => /has no Brevo template/.test(w) && /Dry run continues/.test(w)),
    'the dry run must say which env var is missing'
  );
  assert.equal(calls.send, 0, 'a dry run never sends');
});

test('run(): an unset EMAIL_STAGE is the 1h email, exactly as before the sequence', async () => {
  const { result } = await drive({ DRY_RUN: 'false', BREVO_TEMPLATE_ID_ANON_LEAD: '39' }, () => run());
  assert.equal(calls.send, 1);
  assert.equal(result.sent, 1);
  assert.equal(calls.marked[0].stageId, 'first', 'the default stage marks the launch keyspace');
});

test('run(): the send is marked against its own stage', async () => {
  await drive(
    { EMAIL_STAGE: 'day1', DRY_RUN: 'false', BREVO_TEMPLATE_ID_ANON_LEAD_24H: '41' },
    () => run()
  );
  assert.equal(calls.send, 1);
  assert.deepEqual(calls.marked, [{ emailLc: 'lead@example.com', jobId: JOB.id, stageId: 'day1' }]);
});

// --- Rail 2: the send-time paid re-check ----------------------------------

test('run(): a lead who paid since the cohort was built is not mailed', async () => {
  await drive({ DRY_RUN: 'false', BREVO_TEMPLATE_ID_ANON_LEAD: '39' }, async () => {
    stub.unpaid = false;
    return run();
  });
  assert.equal(calls.send, 0, 'the whole point of the re-check');
  assert.equal(calls.marked.length, 0, 'and they must not be marked, either');
});

test('run(): a failed paid re-check defers rather than sends', async () => {
  const { warnings } = await drive({ DRY_RUN: 'false', BREVO_TEMPLATE_ID_ANON_LEAD: '39' }, async () => {
    stub.unpaidThrows = true;
    return run();
  });
  assert.equal(calls.send, 0, 'fail closed — a Supabase blip must not mail a paying customer');
  assert.equal(calls.marked.length, 0, 'unmarked, so the next hourly run retries them');
  assert.ok(warnings.some((w) => /paid re-check failed/.test(w)));
});

test('run(): an unpaid lead still sends — the re-check is not a blanket block', async () => {
  const { result } = await drive({ DRY_RUN: 'false', BREVO_TEMPLATE_ID_ANON_LEAD: '39' }, () => run());
  assert.equal(calls.send, 1);
  assert.equal(result.sent, 1);
});

test('run(): a dry run does not consult the paid re-check at all', async () => {
  // Dry runs short-circuit before the send block, so a stubbed-out re-check
  // cannot mask a dry-run regression.
  await drive({ DRY_RUN: 'true', BREVO_TEMPLATE_ID_ANON_LEAD: '39' }, async () => {
    stub.unpaidThrows = true; // would throw if it were reached
    return run();
  });
  assert.equal(calls.send, 0);
});

// --- Stage plumbing --------------------------------------------------------

test('run(): each stage resolves its own template env var', () => {
  assert.equal(EMAIL_STAGES.first.templateEnv, 'BREVO_TEMPLATE_ID_ANON_LEAD');
  assert.equal(EMAIL_STAGES.day1.templateEnv, 'BREVO_TEMPLATE_ID_ANON_LEAD_24H');
  assert.equal(EMAIL_STAGES.day2.templateEnv, 'BREVO_TEMPLATE_ID_ANON_LEAD_48H');
});

test('run(): an unknown EMAIL_STAGE fails the run instead of guessing', async () => {
  await assert.rejects(
    () => drive({ EMAIL_STAGE: 'day7', DRY_RUN: 'false' }, () => run()),
    /Unknown email stage "day7"/
  );
});
