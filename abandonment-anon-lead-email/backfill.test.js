/**
 * Pure-function coverage for the backfill knobs: the survey window, the send
 * cap, and the newest-first cap slice. No Supabase, no Brevo, no KV — these
 * three take a clock / an env object / an array and return a value.
 *
 *   node --test            (from the repo root or this directory)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeWindow, resolveSendCap, selectForSend, _internals } = require('./queries');

const { MAX_BACKFILL_DAYS, DEFAULT_BACKFILL_SEND_CAP, NORMAL_LOOKBACK_MS, SETTLE_MS, ONE_DAY_MS } = _internals;

// Fixed clock so the assertions are exact: 2026-08-12T12:00:00.000Z.
const NOW = Date.parse('2026-08-12T12:00:00.000Z');

test('computeWindow: normal mode when BACKFILL_DAYS is unset', () => {
  const win = computeWindow(NOW, {});

  assert.equal(win.mode, 'normal');
  assert.equal(win.backfillDays, null);
  assert.equal(win.warning, null);
  assert.equal(win.startMs, NOW - NORMAL_LOOKBACK_MS);
  assert.equal(win.endMs, NOW - SETTLE_MS);
  assert.equal(win.startIso, '2026-08-12T10:00:00.000Z');
  assert.equal(win.endIso, '2026-08-12T11:00:00.000Z');
});

test('computeWindow: an empty or whitespace BACKFILL_DAYS is "unset", not invalid', () => {
  for (const raw of ['', '   ']) {
    const win = computeWindow(NOW, { BACKFILL_DAYS: raw });
    assert.equal(win.mode, 'normal');
    assert.equal(win.warning, null, `BACKFILL_DAYS=${JSON.stringify(raw)} should not warn`);
  }
});

test('computeWindow: BACKFILL_DAYS=14 looks back 14 days and keeps the 1h upper bound', () => {
  const win = computeWindow(NOW, { BACKFILL_DAYS: '14' });

  assert.equal(win.mode, 'backfill');
  assert.equal(win.backfillDays, 14);
  assert.equal(win.warning, null);
  assert.equal(win.startMs, NOW - 14 * ONE_DAY_MS);
  assert.equal(win.endMs, NOW - SETTLE_MS);
  assert.equal(win.startIso, '2026-07-29T12:00:00.000Z');
  assert.equal(win.endIso, '2026-08-12T11:00:00.000Z');
});

test('computeWindow: the backfill window is a superset of the normal one', () => {
  const normal = computeWindow(NOW, {});
  const backfill = computeWindow(NOW, { BACKFILL_DAYS: '14' });

  assert.ok(backfill.startMs < normal.startMs, 'backfill must start earlier');
  assert.equal(backfill.endMs, normal.endMs, 'same upper bound — new abandoners stay covered');
});

test('computeWindow: BACKFILL_DAYS is trimmed and accepts a leading +', () => {
  for (const raw of [' 14 ', '+14']) {
    const win = computeWindow(NOW, { BACKFILL_DAYS: raw });
    assert.equal(win.mode, 'backfill', `BACKFILL_DAYS=${JSON.stringify(raw)} should backfill`);
    assert.equal(win.backfillDays, 14);
  }
});

test('computeWindow: BACKFILL_DAYS=1 is the accepted minimum', () => {
  const win = computeWindow(NOW, { BACKFILL_DAYS: '1' });

  assert.equal(win.mode, 'backfill');
  assert.equal(win.backfillDays, 1);
  assert.equal(win.warning, null);
  assert.equal(win.startMs, NOW - ONE_DAY_MS);
});

test('computeWindow: BACKFILL_DAYS=0 warns and falls back to normal', () => {
  const win = computeWindow(NOW, { BACKFILL_DAYS: '0' });

  assert.equal(win.mode, 'normal');
  assert.equal(win.backfillDays, null);
  assert.equal(win.startMs, NOW - NORMAL_LOOKBACK_MS);
  assert.match(win.warning, /BACKFILL_DAYS=0/);
  assert.match(win.warning, /normal/);
});

test('computeWindow: a negative BACKFILL_DAYS warns and falls back to normal', () => {
  const win = computeWindow(NOW, { BACKFILL_DAYS: '-3' });

  assert.equal(win.mode, 'normal');
  assert.equal(win.startMs, NOW - NORMAL_LOOKBACK_MS);
  assert.match(win.warning, /below the minimum/);
});

test('computeWindow: BACKFILL_DAYS=45 clamps to the 30-day maximum and warns', () => {
  const win = computeWindow(NOW, { BACKFILL_DAYS: '45' });

  assert.equal(win.mode, 'backfill');
  assert.equal(win.backfillDays, MAX_BACKFILL_DAYS);
  assert.equal(win.startMs, NOW - MAX_BACKFILL_DAYS * ONE_DAY_MS);
  assert.match(win.warning, /clamped to 30/);
});

test('computeWindow: non-integer BACKFILL_DAYS warns and falls back to normal', () => {
  for (const raw of ['fourteen', '14.5', '14d', '2 weeks', 'true', '1e3']) {
    const win = computeWindow(NOW, { BACKFILL_DAYS: raw });
    assert.equal(win.mode, 'normal', `BACKFILL_DAYS=${JSON.stringify(raw)} should not backfill`);
    assert.equal(win.startMs, NOW - NORMAL_LOOKBACK_MS);
    assert.match(win.warning, /is not an integer/);
  }
});

test('resolveSendCap: normal mode is uncapped, backfill mode defaults to 50', () => {
  assert.deepEqual(resolveSendCap({}, 'normal'), { cap: null, warning: null });
  assert.deepEqual(resolveSendCap({}, 'backfill'), { cap: DEFAULT_BACKFILL_SEND_CAP, warning: null });
});

test('resolveSendCap: an explicit SEND_CAP wins in either mode', () => {
  assert.deepEqual(resolveSendCap({ SEND_CAP: '10' }, 'backfill'), { cap: 10, warning: null });
  assert.deepEqual(resolveSendCap({ SEND_CAP: ' 25 ' }, 'normal'), { cap: 25, warning: null });
});

test('resolveSendCap: a non-positive-integer SEND_CAP warns and uses the mode default', () => {
  for (const raw of ['0', '-5', 'lots', '2.5', '']) {
    const normal = resolveSendCap({ SEND_CAP: raw }, 'normal');
    const backfill = resolveSendCap({ SEND_CAP: raw }, 'backfill');
    assert.equal(normal.cap, null);
    assert.equal(backfill.cap, DEFAULT_BACKFILL_SEND_CAP);
    if (raw === '') {
      assert.equal(backfill.warning, null, 'unset is not a misconfiguration');
    } else {
      assert.match(backfill.warning, /not a positive integer/);
    }
  }
});

// --- cap slice + ordering ---------------------------------------------------

const lead = (survey_id, created_at) => ({ survey_id, created_at, email_lc: `${survey_id}@example.com` });

// Deliberately out of order on input.
const COHORT = [
  lead('c', '2026-08-10T09:00:00.000Z'),
  lead('a', '2026-08-12T09:00:00.000Z'),
  lead('d', '2026-07-30T09:00:00.000Z'),
  lead('b', '2026-08-11T09:00:00.000Z'),
];

test('selectForSend: orders newest-first and takes the cap', () => {
  const { selected, deferred } = selectForSend(COHORT, 2);

  assert.deepEqual(
    selected.map((l) => l.survey_id),
    ['a', 'b']
  );
  assert.equal(deferred, 2);
});

test('selectForSend: a null cap keeps everyone, still newest-first', () => {
  const { selected, deferred } = selectForSend(COHORT, null);

  assert.deepEqual(
    selected.map((l) => l.survey_id),
    ['a', 'b', 'c', 'd']
  );
  assert.equal(deferred, 0);
});

test('selectForSend: a cap at or above the cohort size defers nobody', () => {
  for (const cap of [4, 50]) {
    const { selected, deferred } = selectForSend(COHORT, cap);
    assert.equal(selected.length, 4);
    assert.equal(deferred, 0);
  }
});

test('selectForSend: does not mutate the input array', () => {
  const input = [...COHORT];
  selectForSend(input, 2);
  assert.deepEqual(
    input.map((l) => l.survey_id),
    ['c', 'a', 'd', 'b']
  );
});

test('selectForSend: created_at ties break on survey id, deterministically', () => {
  const tied = [
    lead('x', '2026-08-12T09:00:00.000Z'),
    lead('z', '2026-08-12T09:00:00.000Z'),
    lead('y', '2026-08-12T09:00:00.000Z'),
  ];

  assert.deepEqual(
    selectForSend(tied, 3).selected.map((l) => l.survey_id),
    ['z', 'y', 'x']
  );
});

test('selectForSend: an unparseable created_at sorts last instead of throwing', () => {
  const withJunk = [lead('junk', 'not-a-date'), ...COHORT];
  const { selected } = selectForSend(withJunk, 5);

  assert.equal(selected[selected.length - 1].survey_id, 'junk');
});

test('selectForSend: an empty cohort is a no-op', () => {
  assert.deepEqual(selectForSend([], 50), { selected: [], deferred: 0 });
});
