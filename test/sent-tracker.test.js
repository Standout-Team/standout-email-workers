/**
 * sent-tracker contract, in memory/dry-run mode.
 *
 * The bug this pins: abandonment-job-email-2 called
 * sentTracker.getSentJobId(), which was never exported. Email 2 threw on every
 * user from the day it shipped. getSentJobId must exist, and it must actually
 * return the job id markSent() stored.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Memory mode requires dry-run — the tracker refuses to fake dedup in a live
// run. Set before requiring anything that reads it.
process.env.DRY_RUN = 'true';
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const sentTracker = require('../abandonment-job-email/sent-tracker');

const USER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = 'ffffffff-0000-1111-2222-333333333333';

test('exports the full contract both workers rely on', () => {
  for (const fn of ['hasBeenSent', 'markSent', 'getSentJobId', 'isKVConfigured']) {
    assert.equal(typeof sentTracker[fn], 'function', `sent-tracker.${fn} must be a function`);
  }
});

test('markSent then getSentJobId returns the stored job id', async () => {
  sentTracker._resetMemory();
  await sentTracker.markSent(USER, 12345);
  assert.equal(await sentTracker.getSentJobId(USER), 12345);
});

test('markSent then hasBeenSent is true', async () => {
  sentTracker._resetMemory();
  await sentTracker.markSent(USER, 1);
  assert.equal(await sentTracker.hasBeenSent(USER), true);
});

test('unknown user: hasBeenSent false, getSentJobId null', async () => {
  sentTracker._resetMemory();
  await sentTracker.markSent(USER, 7);
  assert.equal(await sentTracker.hasBeenSent(OTHER), false);
  assert.equal(await sentTracker.getSentJobId(OTHER), null);
});

test('isKVConfigured is false without the KV env vars', () => {
  assert.equal(sentTracker.isKVConfigured(), false);
});

test('fails closed: memory mode is refused when DRY_RUN=false', async () => {
  const prev = process.env.DRY_RUN;
  process.env.DRY_RUN = 'false';
  try {
    await assert.rejects(() => sentTracker.hasBeenSent(USER), /KV is not configured/);
    await assert.rejects(() => sentTracker.markSent(USER, 1), /KV is not configured/);
    await assert.rejects(() => sentTracker.getSentJobId(USER), /KV is not configured/);
  } finally {
    process.env.DRY_RUN = prev;
  }
});
