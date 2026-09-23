const test = require('node:test');
const assert = require('node:assert/strict');

const { computeSchedule, formatDeadline, isInSendWindow, localParts, MIN_GAP_MS } = require('./schedule');
const { signRecoveryToken } = require('./token');
const { STAGES, OFFERS } = require('./stages');
const { buildLeads } = require('./audience');
const store = require('./kv');
const worker = require('./index');
const { dueStage, armFor, preflight, buildParams } = worker._internals;

const TZ = 'America/New_York';
const HOUR = 3600e3;

test('token matches the Standout-pro TypeScript signer byte for byte', () => {
  assert.equal(
    signRecoveryToken({ sv: 12345, off: 'm75', st: 3, exp: 1790000000 }, 'vector-secret'),
    'eyJ2IjoxLCJ0eXAiOiJyZWNvdmVyeSIsInN2IjoxMjM0NSwib2ZmIjoibTc1Iiwic3QiOjMsImV4cCI6MTc5MDAwMDAwMH0.PG4IYQKXMdNbuFFBX3EWawW1yBFvnyfSHE66XsIthFA'
  );
  assert.equal(
    signRecoveryToken({ sv: 7, off: 'a75', st: 6, exp: 1790500000 }, 'vector-secret'),
    'eyJ2IjoxLCJ0eXAiOiJyZWNvdmVyeSIsInN2Ijo3LCJvZmYiOiJhNzUiLCJzdCI6NiwiZXhwIjoxNzkwNTAwMDAwfQ.V2uEZWqeLPTC5ibV_V5O0gdTIDGfqkIqPW3U_-sEqOE'
  );
});

test('offer terms match the approved pricing', () => {
  assert.equal(OFFERS.m75.firstPrice, '$10');
  assert.equal(OFFERS.m75.renewalPrice, '$40/month');
  assert.equal(OFFERS.a75.firstPrice, '$40');
  assert.equal(OFFERS.a75.renewalPrice, '$160/year');
  assert.deepEqual(STAGES.map((s) => s.offer), ['m75', 'm75', 'm75', 'm75', 'm75', 'a75']);
});

const anchors = [];
for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) anchors.push(Date.parse('2026-10-28T00:30:00-04:00') + (d * 24 + h) * HOUR);

test('every schedule respects quiet hours, spacing, order and deadlines (incl. DST week)', () => {
  for (const T of anchors) {
    const s = computeSchedule(T, TZ);
    const live = STAGES.map((st) => s.stages[st.id]).filter(Boolean);
    assert.ok(s.deadlines.deadline1 - T >= 48 * HOUR, 'deadline1 at least 48h after T');
    assert.ok(s.stages.e1 && s.stages.e5 && s.stages.e6, 'e1, e5 and e6 always fit');
    for (let i = 0; i < live.length; i++) {
      assert.ok(isInSendWindow(live[i].dueMs, TZ), 'inside 08:00–21:00');
      assert.ok(live[i].dueMs >= T, 'not before T');
      assert.ok(live[i].dueMs < live[i].expMs, 'before its deadline');
      if (i) assert.ok(live[i].dueMs - live[i - 1].dueMs >= MIN_GAP_MS, 'at least 4h apart');
    }
    const d1 = localParts(s.deadlines.deadline1, TZ);
    assert.deepEqual([d1.h, d1.mi], [23, 59]);
    assert.equal(s.stages.e6.expMs - s.stages.e6.dueMs, 48 * HOUR);
    // e5 is "ends tonight": same local date as deadline1
    assert.equal(localParts(s.stages.e5.dueMs, TZ).d, d1.d);
  }
});

test('afternoon upload: the approved example timeline', () => {
  const T = Date.parse('2026-09-23T14:30:00-04:00');
  const s = computeSchedule(T, TZ);
  const f = (id) => formatDeadline(s.stages[id].dueMs, TZ);
  assert.equal(f('e1'), 'Wednesday, Sep 23 at 2:30 PM EDT');
  assert.equal(f('e2'), 'Wednesday, Sep 23 at 7:30 PM EDT');
  assert.equal(f('e3'), 'Thursday, Sep 24 at 10:00 AM EDT');
  assert.equal(f('e4'), 'Thursday, Sep 24 at 5:00 PM EDT');
  assert.equal(f('e5'), 'Friday, Sep 25 at 5:00 PM EDT');
  assert.equal(f('e6'), 'Monday, Sep 28 at 4:00 PM EDT');
  assert.equal(formatDeadline(s.deadlines.deadline1, TZ), 'Friday, Sep 25 at 11:59 PM EDT');
  assert.equal(formatDeadline(s.deadlines.deadline2, TZ), 'Wednesday, Sep 30 at 4:00 PM EDT');
});

test('dueStage: one stage at a time, 3h retry window, then skipped', () => {
  const s = computeSchedule(Date.parse('2026-09-23T14:30:00-04:00'), TZ);
  assert.equal(dueStage(s, s.stages.e1.dueMs - 1).status, 'none');
  assert.equal(dueStage(s, s.stages.e1.dueMs).stage.id, 'e1');
  assert.equal(dueStage(s, s.stages.e1.dueMs + 2.9 * HOUR).stage.id, 'e1');
  assert.equal(dueStage(s, s.stages.e1.dueMs + 3 * HOUR).status, 'none');
  assert.equal(dueStage(s, s.stages.e6.dueMs + HOUR).stage.id, 'e6');
  assert.equal(dueStage(s, s.stages.e6.dueMs + 4 * HOUR).status, 'finished');
});

test('holdout is deterministic and near the configured share', () => {
  assert.equal(armFor('a@b.com', 15), armFor('a@b.com', 15));
  let h = 0;
  for (let i = 0; i < 10000; i++) if (armFor(`u${i}@x.com`, 15) === 'holdout') h++;
  assert.ok(h > 1300 && h < 1700, `holdout ${h}`);
  assert.equal(armFor('a@b.com', 0), 'treatment');
});

test('preflight: disabled by default, refuses without cutover, refuses live without KV/templates', () => {
  assert.equal(preflight({}).status, 'disabled');
  assert.equal(preflight({ CART_RECOVERY_ENABLED: 'true', EMAIL_LINK_SECRET: 'x' }).status, 'refused');
  const dry = preflight({ CART_RECOVERY_ENABLED: 'true', EMAIL_LINK_SECRET: 'x', CART_RECOVERY_CUTOVER: '2026-09-24T00:00:00Z' });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  const live = preflight({ CART_RECOVERY_ENABLED: 'true', DRY_RUN: 'false', EMAIL_LINK_SECRET: 'x', CART_RECOVERY_CUTOVER: '2026-09-24T00:00:00Z' });
  assert.equal(live.status, 'refused');
  assert.ok(live.problems.some((p) => p.includes('KV')));
  assert.ok(live.problems.some((p) => p.includes('BREVO_TEMPLATE_ID_CR_E1')));
});

test('buildLeads: cutover, consent owner email, paid owners, one anchor per address', () => {
  const cutoverMs = Date.parse('2026-09-24T00:00:00Z');
  const resume = (email, name = 'maya patel') => JSON.stringify({ email, name });
  const rows = [
    { id: 1, session_id: 's1', user_id: null, resume_parsed: resume('old@x.com'), created_at: '2026-09-23T10:00:00Z' },
    { id: 2, session_id: 's2', user_id: null, resume_parsed: resume('Anon@X.com'), created_at: '2026-09-24T10:00:00Z' },
    { id: 3, session_id: 's3', user_id: null, resume_parsed: resume('anon@x.com'), created_at: '2026-09-24T12:00:00Z' },
    { id: 4, session_id: 's4', user_id: 'u-real', resume_parsed: resume('resume@x.com'), created_at: '2026-09-24T10:00:00Z' },
    { id: 5, session_id: 's5', user_id: 'u-paid', resume_parsed: resume('paid@x.com'), created_at: '2026-09-24T10:00:00Z' },
    { id: 6, session_id: 's6', user_id: 'u-anon', resume_parsed: resume('lead@x.com'), created_at: '2026-09-24T10:00:00Z' },
    { id: 7, session_id: 's7', user_id: null, resume_parsed: resume('not-an-email'), created_at: '2026-09-24T10:00:00Z' },
  ];
  const profiles = new Map([
    ['u-real', { id: 'u-real', email: 'Account@X.com', is_anonymous: false, subscription_status: null }],
    ['u-paid', { id: 'u-paid', email: 'paid@x.com', is_anonymous: false, subscription_status: 'active' }],
    ['u-anon', { id: 'u-anon', email: null, is_anonymous: true, subscription_status: null }],
  ]);
  const leads = buildLeads(rows, profiles, { cutoverMs, usOnly: false });
  const byEmail = Object.fromEntries(leads.map((l) => [l.email_lc, l]));
  assert.deepEqual(Object.keys(byEmail).sort(), ['account@x.com', 'anon@x.com', 'lead@x.com']);
  assert.equal(byEmail['anon@x.com'].survey_id, 2, 'earliest survey anchors');
  assert.equal(byEmail['account@x.com'].registered, true);
  assert.equal(byEmail['lead@x.com'].registered, false);
  assert.equal(byEmail['anon@x.com'].first_name, 'Maya');
  assert.equal(byEmail['anon@x.com'].anchor_ms, Date.parse('2026-09-24T11:00:00Z'));
});

test('buildParams: link carries a verifiable token that expires at the offer deadline', () => {
  const env = { EMAIL_LINK_SECRET: 'vector-secret' };
  const s = computeSchedule(Date.parse('2026-09-23T14:30:00-04:00'), TZ);
  const lead = { survey_id: 9, first_name: 'Maya' };
  const p5 = buildParams({ lead, stage: STAGES[4], slot: s.stages.e5, tz: TZ, env, freeApplyUnused: true });
  const p6 = buildParams({ lead, stage: STAGES[5], slot: s.stages.e6, tz: TZ, env, freeApplyUnused: false });
  const u5 = new URL(p5.OFFER_URL);
  assert.equal(u5.origin + u5.pathname, 'https://www.usestandout.today/special-offer');
  assert.equal(u5.searchParams.get('utm_campaign'), 'cart_recovery_v2');
  assert.equal(u5.searchParams.get('utm_content'), 'e5');
  const payload = JSON.parse(Buffer.from(u5.searchParams.get('t').split('.')[0], 'base64url').toString());
  assert.deepEqual(payload, { v: 1, typ: 'recovery', sv: 9, off: 'm75', st: 5, exp: Math.floor(s.deadlines.deadline1 / 1000) });
  assert.equal(p5.DEADLINE, 'Friday, Sep 25 at 11:59 PM EDT');
  assert.equal(p5.FREE_APPLY_UNUSED, true);
  const payload6 = JSON.parse(Buffer.from(new URL(p6.OFFER_URL).searchParams.get('t').split('.')[0], 'base64url').toString());
  assert.equal(payload6.off, 'a75');
  assert.equal(payload6.exp, Math.floor(s.deadlines.deadline2 / 1000));
  assert.equal(p6.FREE_APPLY_UNUSED, '');
});

function fakeLeads(n, anchorMs) {
  return Array.from({ length: n }, (_, i) => ({
    survey_id: 100 + i, session_id: `s${i}`, user_id: null, registered: false,
    email: `lead${i}@example.com`, email_lc: `lead${i}@example.com`, first_name: 'Sam',
    created_at_ms: anchorMs - HOUR, anchor_ms: anchorMs,
  }));
}

test('run: dry run counts, sends nothing, writes nothing', async () => {
  store._resetMemory();
  const anchor = Date.parse('2026-09-24T10:00:00-04:00');
  let sends = 0;
  const env = { CART_RECOVERY_ENABLED: 'true', EMAIL_LINK_SECRET: 'x', CART_RECOVERY_CUTOVER: '2026-09-24T00:00:00Z' };
  const r = await worker.run({
    env, nowMs: anchor + 10 * 60e3,
    deps: { findLeads: async () => fakeLeads(200, anchor), exclusionReason: async () => null, freeApplyUnused: async () => false, send: async () => { sends++; } },
  });
  assert.equal(r.dry_run, true);
  assert.equal(sends, 0);
  assert.equal(r.due, 200);
  const would = r.would_send.e1 || 0;
  const held = r.holdout.e1 || 0;
  assert.equal(would + held, 200);
  assert.ok(held > 10 && held < 60);
  assert.equal(await store.get(store.keys.sent(1, 'lead0@example.com')), null);
});

test('run: live mode sends once per stage, honors exclusions and spacing', async () => {
  store._resetMemory();
  const anchor = Date.parse('2026-09-24T10:00:00-04:00');
  const sent = [];
  const env = {
    CART_RECOVERY_ENABLED: 'true', DRY_RUN: 'false', EMAIL_LINK_SECRET: 'x', BREVO_API_KEY: 'k',
    CART_RECOVERY_CUTOVER: '2026-09-24T00:00:00Z', CART_RECOVERY_HOLDOUT_PCT: '0',
    BREVO_TEMPLATE_ID_CR_E1: '1', BREVO_TEMPLATE_ID_CR_E2: '2', BREVO_TEMPLATE_ID_CR_E3: '3',
    BREVO_TEMPLATE_ID_CR_E4: '4', BREVO_TEMPLATE_ID_CR_E5: '5', BREVO_TEMPLATE_ID_CR_E6: '6',
  };
  // Pretend KV is durable for this test (memory store is shared per process).
  const prevUrl = process.env.KV_REST_API_URL;
  const origDurable = store.isDurable;
  store.isDurable = () => true;
  try {
    const leads = fakeLeads(3, anchor);
    const deps = {
      findLeads: async () => leads,
      exclusionReason: async (l) => (l.email_lc === 'lead2@example.com' ? 'paid_checkout' : null),
      freeApplyUnused: async () => true,
      send: async (m) => { sent.push(m); return 'mid'; },
    };
    const t1 = anchor + 5 * 60e3;
    await worker.run({ env, nowMs: t1, deps });
    await worker.run({ env, nowMs: t1 + HOUR, deps }); // retry window: must not resend
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((m) => m.templateId), [1, 1]);
    assert.equal(sent[0].params.FREE_APPLY_UNUSED, true);
    const s = computeSchedule(anchor, TZ);
    await worker.run({ env, nowMs: s.stages.e2.dueMs + 60e3, deps });
    assert.equal(sent.length, 4);
    assert.deepEqual(sent.slice(2).map((m) => m.templateId), [2, 2]);
  } finally {
    store.isDurable = origDurable;
    if (prevUrl === undefined) delete process.env.KV_REST_API_URL;
  }
});
