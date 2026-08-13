/**
 * Coverage for TARGET_EMAILS — the QA/support targeted-send mode: the pure
 * parser, the pure candidate filter, and a stubbed drive of run() proving that
 * a targeted run mails only the target, announces itself, reports itself, and
 * still obeys every rail — and that an inactive run is unchanged.
 *
 *   node --test            (from the repo root or this directory)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseTargetEmails, filterToTargets } = require('./queries');

// --- parseTargetEmails: unset / empty / whitespace are INACTIVE -------------

test('parseTargetEmails: unset is inactive', () => {
  assert.deepEqual(parseTargetEmails({}), { targets: [], invalid: [], active: false });
});

test('parseTargetEmails: empty and whitespace-only are inactive, not invalid', () => {
  for (const raw of ['', '   ', '\t\n ']) {
    assert.deepEqual(
      parseTargetEmails({ TARGET_EMAILS: raw }),
      { targets: [], invalid: [], active: false },
      `TARGET_EMAILS=${JSON.stringify(raw)} should be inactive`
    );
  }
});

test('parseTargetEmails: null and undefined are inactive', () => {
  assert.equal(parseTargetEmails({ TARGET_EMAILS: undefined }).active, false);
  assert.equal(parseTargetEmails({ TARGET_EMAILS: null }).active, false);
});

// --- parseTargetEmails: the happy paths ------------------------------------

test('parseTargetEmails: a single address activates targeting', () => {
  const parsed = parseTargetEmails({ TARGET_EMAILS: 'qa@example.com' });

  assert.equal(parsed.active, true);
  assert.deepEqual(parsed.targets, ['qa@example.com']);
  assert.deepEqual(parsed.invalid, []);
});

test('parseTargetEmails: normalises case and whitespace', () => {
  const parsed = parseTargetEmails({ TARGET_EMAILS: '  QA@Example.COM ,\tSupport@Standout.Test\n' });

  assert.deepEqual(parsed.targets, ['qa@example.com', 'support@standout.test']);
  assert.deepEqual(parsed.invalid, []);
});

test('parseTargetEmails: dedupes case-insensitively, keeping first-seen order', () => {
  const parsed = parseTargetEmails({
    TARGET_EMAILS: 'b@example.com, A@example.com, a@example.com, B@EXAMPLE.COM, a@example.com',
  });

  assert.deepEqual(parsed.targets, ['b@example.com', 'a@example.com']);
});

test('parseTargetEmails: empty list slots from stray commas are skipped, not flagged', () => {
  const parsed = parseTargetEmails({ TARGET_EMAILS: 'qa@example.com,,  , qa2@example.com,' });

  assert.deepEqual(parsed.targets, ['qa@example.com', 'qa2@example.com']);
  assert.deepEqual(parsed.invalid, []);
});

// --- parseTargetEmails: junk ------------------------------------------------

test('parseTargetEmails: mixed junk and valid keeps the valid, reports the junk', () => {
  const parsed = parseTargetEmails({
    TARGET_EMAILS: 'qa@example.com, not-an-email, ok@standout.test, bad@nodot, @nolocal.com, a b@c.com',
  });

  assert.equal(parsed.active, true);
  assert.deepEqual(parsed.targets, ['qa@example.com', 'ok@standout.test']);
  assert.deepEqual(parsed.invalid, ['not-an-email', 'bad@nodot', '@nolocal.com', 'a b@c.com']);
});

test('parseTargetEmails: junk is reported as typed, not lowercased', () => {
  const parsed = parseTargetEmails({ TARGET_EMAILS: 'Not An Email' });

  assert.deepEqual(parsed.invalid, ['Not An Email'], 'the operator has to recognise what they typed');
});

test('parseTargetEmails: an all-junk list stays ACTIVE and targets nobody', () => {
  // Fail closed. If a typo read as "unset", the fix for a mis-set targeted run
  // would be to silently mail the entire real cohort.
  const parsed = parseTargetEmails({ TARGET_EMAILS: 'qa@exampl' });

  assert.equal(parsed.active, true, 'a typo must not reopen the funnel');
  assert.deepEqual(parsed.targets, []);
  assert.deepEqual(parsed.invalid, ['qa@exampl']);
});

test('parseTargetEmails: is pure — reads the argument, not process.env', () => {
  const saved = process.env.TARGET_EMAILS;
  process.env.TARGET_EMAILS = 'leaked@example.com';
  try {
    assert.equal(parseTargetEmails({}).active, false, 'the decision comes from the argument');
  } finally {
    if (saved === undefined) delete process.env.TARGET_EMAILS;
    else process.env.TARGET_EMAILS = saved;
  }
});

test('parseTargetEmails: same input, same output', () => {
  const env = { TARGET_EMAILS: 'a@example.com, junk, A@example.com' };
  assert.deepEqual(parseTargetEmails(env), parseTargetEmails(env));
});

// --- filterToTargets --------------------------------------------------------

const lead = (emailLc, created_at) => ({
  survey_id: emailLc.split('@')[0],
  email: emailLc,
  email_lc: emailLc,
  created_at,
});

const COHORT = [
  lead('a@example.com', '2026-08-13T09:00:00.000Z'),
  lead('qa@example.com', '2026-08-13T08:00:00.000Z'),
  lead('c@example.com', '2026-08-13T07:00:00.000Z'),
];

test('filterToTargets: keeps the intersection and drops everyone else', () => {
  const { selected, dropped, missing } = filterToTargets(COHORT, ['qa@example.com']);

  assert.deepEqual(
    selected.map((l) => l.email_lc),
    ['qa@example.com']
  );
  assert.deepEqual(
    dropped.map((l) => l.email_lc),
    ['a@example.com', 'c@example.com']
  );
  assert.deepEqual(missing, []);
});

test('filterToTargets: preserves the cohort order for a multi-target list', () => {
  const { selected } = filterToTargets(COHORT, ['c@example.com', 'a@example.com']);

  assert.deepEqual(
    selected.map((l) => l.email_lc),
    ['a@example.com', 'c@example.com'],
    'newest-first cohort order survives; the target list order is not a sort key'
  );
});

test('filterToTargets: an empty intersection selects nobody and reports every target missing', () => {
  const { selected, dropped, missing } = filterToTargets(COHORT, ['nobody@example.com']);

  assert.deepEqual(selected, []);
  assert.equal(dropped.length, 3);
  assert.deepEqual(missing, ['nobody@example.com']);
});

test('filterToTargets: reports only the targets that are actually absent', () => {
  const { selected, missing } = filterToTargets(COHORT, ['qa@example.com', 'ghost@example.com']);

  assert.deepEqual(
    selected.map((l) => l.email_lc),
    ['qa@example.com']
  );
  assert.deepEqual(missing, ['ghost@example.com']);
});

test('filterToTargets: an empty target list selects nobody', () => {
  const { selected, dropped, missing } = filterToTargets(COHORT, []);

  assert.deepEqual(selected, []);
  assert.equal(dropped.length, 3);
  assert.deepEqual(missing, []);
});

test('filterToTargets: an empty cohort is a no-op that still names the missing target', () => {
  const { selected, dropped, missing } = filterToTargets([], ['qa@example.com']);

  assert.deepEqual(selected, []);
  assert.deepEqual(dropped, []);
  assert.deepEqual(missing, ['qa@example.com']);
});

test('filterToTargets: does not mutate the input cohort', () => {
  const input = [...COHORT];
  filterToTargets(input, ['qa@example.com']);

  assert.deepEqual(
    input.map((l) => l.email_lc),
    ['a@example.com', 'qa@example.com', 'c@example.com']
  );
});

// --- stubbed drive of run() -------------------------------------------------
//
// Same technique as dedup-guard.test.js: patch the collaborators on their
// module objects BEFORE index.js is required, because index.js destructures
// them at import time. Nothing below touches Supabase, Brevo, KV or Anthropic.

const queries = require('./queries');
const brevo = require('./brevo');
const sentTracker = require('./sent-tracker');
const matchReason = require('./match-reason');

const JOB = {
  id: 'job-1',
  title: 'Sales Associate',
  company: 'Instacart',
  location: 'Remote',
  work_type: 'Full-time',
  salary_min: 60000,
  salary_max: 80000,
  first_seen_at: new Date().toISOString(),
};

// Reset per run by resetStubs().
const stubs = {
  cohort: [],
  durable: true,
  sentAlready: new Set(),
  sentTo: [],
  marked: [],
  targetingSeen: null,
  findAnonLeadsCalls: 0,
};

queries.findAnonLeads = async (_win, targeting) => {
  stubs.findAnonLeadsCalls++;
  stubs.targetingSeen = targeting;
  return stubs.cohort;
};
// findFeaturedJobs returns { matched, ...counters } — see match-fanout.test.js.
queries.findFeaturedJobs = async (leads) => ({
  matched: leads.map((l) => ({ lead: l, job: JOB, pct: 88 })),
  noFreshMatch: 0,
  timedOut: 0,
  retried: 0,
  failed: 0,
  deferredByBudget: 0,
});
brevo.sendJobEmail = async (payload) => {
  stubs.sentTo.push(payload.to[0].email);
  return 'stub-message-id';
};
sentTracker.isDurable = () => stubs.durable;
sentTracker.hasBeenSent = async (emailLc) => stubs.sentAlready.has(emailLc);
sentTracker.markSent = async (emailLc) => {
  stubs.marked.push(emailLc);
};
matchReason.generateMatchReasons = async () => ['reason one', 'reason two', 'reason three'];

const { run } = require('./index');

const fullLead = (emailLc, created_at) => ({
  survey_id: `survey-${emailLc.split('@')[0]}`,
  session_id: `session-${emailLc.split('@')[0]}`,
  email: emailLc,
  email_lc: emailLc,
  name: 'Test Person',
  resume_parsed: { email: emailLc, name: 'Test Person' },
  created_at,
  marketing_opt_in_at: created_at,
});

// The same three leads for every drive, so "targeted" and "inactive" runs are
// compared on identical input.
const DRIVE_COHORT = [
  fullLead('real-a@example.com', '2026-08-13T09:00:00.000Z'),
  fullLead('qa@example.com', '2026-08-13T08:00:00.000Z'),
  fullLead('real-c@example.com', '2026-08-13T07:00:00.000Z'),
];

const GUARDED_ENV = [
  'TARGET_EMAILS',
  'BACKFILL_DAYS',
  'SEND_CAP',
  'DRY_RUN',
  'VERCEL',
  'VERCEL_ENV',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'EMAIL_LINK_SECRET',
  'STANDOUT_APP_URL',
  'BREVO_TEMPLATE_ID_ANON_LEAD',
  'ANTHROPIC_API_KEY',
];

// A real (non-dry) send with durable dedup, so the send path is genuinely
// exercised and the targeted filter is the only thing deciding who gets mail.
const LIVE_ENV = {
  DRY_RUN: 'false',
  EMAIL_LINK_SECRET: 'test-secret',
  BREVO_TEMPLATE_ID_ANON_LEAD: '39',
};

function resetStubs(overrides = {}) {
  stubs.cohort = DRIVE_COHORT;
  stubs.durable = true;
  stubs.sentAlready = new Set();
  stubs.sentTo = [];
  stubs.marked = [];
  stubs.targetingSeen = null;
  stubs.findAnonLeadsCalls = 0;
  Object.assign(stubs, overrides);
}

// Captures the log instead of silencing it — the banner is an assertion target.
async function drive(overrides, fn) {
  const saved = Object.fromEntries(GUARDED_ENV.map((k) => [k, process.env[k]]));
  const real = { log: console.log, warn: console.warn, error: console.error };
  const logs = [];
  const capture = (level) => (...args) => logs.push(`${level} ${args.join(' ')}`);

  for (const key of GUARDED_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  console.log = capture('log');
  console.warn = capture('warn');
  console.error = capture('error');

  try {
    const summary = await fn();
    return { summary, logs };
  } finally {
    Object.assign(console, real);
    for (const key of GUARDED_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const hasLine = (logs, needle) => logs.some((line) => line.includes(needle));

test('run(): a targeted run mails the target and nobody else', async () => {
  resetStubs();
  const { summary } = await drive({ ...LIVE_ENV, TARGET_EMAILS: 'qa@example.com' }, run);

  assert.deepEqual(stubs.sentTo, ['qa@example.com'], 'only the target is mailed');
  assert.deepEqual(stubs.marked, ['qa@example.com'], 'and only the target is recorded as sent');
  assert.equal(summary.sent, 1);
  assert.equal(summary.eligible, 1, 'the cohort is narrowed before the tracker and the cap');
  assert.equal(summary.withheld, 2, 'the two real leads are withheld, not mailed');
});

test('run(): the targeted run logs the unmissable banner', async () => {
  resetStubs();
  const { logs } = await drive({ ...LIVE_ENV, TARGET_EMAILS: 'qa@example.com' }, run);

  assert.ok(hasLine(logs, 'TARGETED MODE ACTIVE'), 'the banner must be logged');
  assert.ok(hasLine(logs, 'qa@example.com can be emailed'), 'the banner names the list');
  assert.ok(hasLine(logs, 'real leads are NOT being sent'), 'the banner states the consequence');
  assert.ok(hasLine(logs, 'UNSET TARGET_EMAILS AND REDEPLOY'), 'the banner says how to undo it');
});

test('run(): the summary and the start line carry the targeted fields', async () => {
  resetStubs();
  const { summary, logs } = await drive(
    { ...LIVE_ENV, TARGET_EMAILS: 'qa@example.com, ok@standout.test' },
    run
  );

  assert.equal(summary.targeted, true);
  assert.equal(summary.targetCount, 2);
  assert.ok(hasLine(logs, 'targeted=true (2 target(s))'), 'the start line reports it too');
});

test('run(): targeting is forwarded to findAnonLeads for its exclusion diagnostics', async () => {
  resetStubs();
  await drive({ ...LIVE_ENV, TARGET_EMAILS: 'qa@example.com' }, run);

  assert.equal(stubs.targetingSeen.active, true);
  assert.deepEqual(stubs.targetingSeen.targets, ['qa@example.com']);
});

test('run(): a target that is not a candidate warns by name, with the window and the hints', async () => {
  resetStubs();
  const { summary, logs } = await drive({ ...LIVE_ENV, TARGET_EMAILS: 'ghost@example.com' }, run);

  assert.deepEqual(stubs.sentTo, [], 'an empty intersection sends to nobody');
  assert.equal(summary.eligible, 0);
  assert.equal(summary.selected, 0);
  assert.equal(summary.sent, 0);
  assert.ok(hasLine(logs, 'TARGET NOT FOUND: ghost@example.com'), 'the missing target is named');
  assert.ok(hasLine(logs, 'raise BACKFILL_DAYS'), 'the window hint is there');
  assert.ok(hasLine(logs, 'audience criteria'), 'the audience hint is there');
});

test('run(): invalid TARGET_EMAILS entries are warned about and send to nobody', async () => {
  resetStubs();
  const { summary, logs } = await drive({ ...LIVE_ENV, TARGET_EMAILS: 'qa@exampl, nope' }, run);

  assert.equal(summary.targeted, true, 'a typo does not reopen the funnel');
  assert.equal(summary.targetCount, 0);
  assert.deepEqual(stubs.sentTo, []);
  assert.ok(hasLine(logs, 'qa@exampl, nope'), 'the invalid entries are listed');
  assert.ok(hasLine(logs, 'ZERO valid addresses'), 'and the dead run is called out');
});

// --- rails: a targeted run bypasses nothing ---------------------------------

test('run(): the sent-tracker still blocks a target that was already mailed, by name', async () => {
  resetStubs({ sentAlready: new Set(['qa@example.com']) });
  const { summary, logs } = await drive({ ...LIVE_ENV, TARGET_EMAILS: 'qa@example.com' }, run);

  assert.deepEqual(stubs.sentTo, [], 'one send per lead email, ever — targeting is not a reset');
  assert.equal(summary.alreadySent, 1);
  assert.equal(summary.sent, 0);
  assert.ok(hasLine(logs, 'already mailed and will not be mailed again — qa@example.com'));
});

test('run(): DRY_RUN still suppresses the Brevo call in targeted mode', async () => {
  resetStubs();
  const { summary } = await drive(
    { ...LIVE_ENV, DRY_RUN: 'true', TARGET_EMAILS: 'qa@example.com' },
    run
  );

  assert.deepEqual(stubs.sentTo, [], 'no Brevo call');
  assert.deepEqual(stubs.marked, [], 'and no tracker write');
  assert.equal(summary.dryRun, true);
  assert.equal(summary.targeted, true);
});

test('run(): SEND_CAP still bounds a targeted run', async () => {
  resetStubs();
  const { summary } = await drive(
    { ...LIVE_ENV, SEND_CAP: '1', TARGET_EMAILS: 'qa@example.com, real-a@example.com' },
    run
  );

  assert.equal(summary.eligible, 2);
  assert.equal(summary.selected, 1, 'the cap applies to targets exactly as it does to real leads');
  assert.equal(summary.deferred, 1);
  assert.deepEqual(stubs.sentTo, ['real-a@example.com'], 'newest-first ordering is unchanged');
});

test('run(): the fail-closed dedup guard still refuses a targeted real send on Vercel', async () => {
  resetStubs({ durable: false });
  await drive({ ...LIVE_ENV, VERCEL: '1', TARGET_EMAILS: 'qa@example.com' }, async () => {
    await assert.rejects(() => run(), /non-durable dedup/i);
  });

  assert.equal(stubs.findAnonLeadsCalls, 0, 'targeting does not get it past the guard');
  assert.deepEqual(stubs.sentTo, []);
});

test('run(): targeting composes with a backfill window — mechanics unchanged', async () => {
  resetStubs();
  const { summary } = await drive(
    { ...LIVE_ENV, BACKFILL_DAYS: '14', TARGET_EMAILS: 'qa@example.com' },
    run
  );

  assert.equal(summary.mode, 'backfill', 'the window is still whatever BACKFILL_DAYS says');
  assert.equal(summary.backfillDays, 14);
  assert.equal(summary.cap, 50, "and backfill's own default cap still applies");
  assert.equal(summary.targeted, true);
  assert.deepEqual(stubs.sentTo, ['qa@example.com']);
});

// --- inactive mode is byte-identical ---------------------------------------

test('run(): with TARGET_EMAILS unset the run is unchanged — every count as before', async () => {
  resetStubs();
  const { summary, logs } = await drive(LIVE_ENV, run);

  assert.deepEqual(
    stubs.sentTo,
    ['real-a@example.com', 'qa@example.com', 'real-c@example.com'],
    'the whole cohort is mailed, newest-first'
  );

  // Every field that existed before TARGET_EMAILS, at the value it had before.
  assert.deepEqual(
    {
      mode: summary.mode,
      backfillDays: summary.backfillDays,
      cap: summary.cap,
      dedup: summary.dedup,
      eligible: summary.eligible,
      alreadySent: summary.alreadySent,
      remaining: summary.remaining,
      selected: summary.selected,
      deferred: summary.deferred,
      sent: summary.sent,
      skipped: summary.skipped,
      dryRun: summary.dryRun,
    },
    {
      mode: 'normal',
      backfillDays: null,
      cap: null,
      dedup: 'durable',
      eligible: 3,
      alreadySent: 0,
      remaining: 3,
      selected: 3,
      deferred: 0,
      sent: 3,
      skipped: 0,
      dryRun: false,
    }
  );

  assert.equal(summary.targeted, false);
  assert.equal(summary.targetCount, 0);
  assert.equal(summary.withheld, 0);
  assert.ok(!hasLine(logs, 'TARGETED MODE'), 'no banner, no targeted noise');
  assert.ok(hasLine(logs, 'targeted=false'), 'the start line still states it');
});

test('run(): an empty TARGET_EMAILS is unset, not "target nobody"', async () => {
  for (const raw of ['', '   ']) {
    resetStubs();
    const { summary } = await drive({ ...LIVE_ENV, TARGET_EMAILS: raw }, run);

    assert.equal(summary.targeted, false, `TARGET_EMAILS=${JSON.stringify(raw)} should be inactive`);
    assert.equal(summary.sent, 3, 'the real cohort still goes out');
  }
});
