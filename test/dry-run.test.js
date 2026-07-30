const test = require('node:test');
const assert = require('node:assert/strict');

const { isDryRun } = require('../lib/dry-run');

function withDryRun(value, fn) {
  const prev = process.env.DRY_RUN;
  if (value === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = prev;
  }
}

test('"false" means live sends', () => {
  withDryRun('false', () => assert.equal(isDryRun(), false));
  withDryRun('  FALSE  ', () => assert.equal(isDryRun(), false));
});

test('"true" means dry run', () => {
  withDryRun('true', () => assert.equal(isDryRun(), true));
  withDryRun('TRUE', () => assert.equal(isDryRun(), true));
});

test('unset or empty defaults safe (dry run)', () => {
  withDryRun(undefined, () => assert.equal(isDryRun(), true));
  withDryRun('', () => assert.equal(isDryRun(), true));
  withDryRun('   ', () => assert.equal(isDryRun(), true));
});

test('anything else throws rather than guessing', () => {
  for (const bad of ['0', '1', 'no', 'yes', 'FLASE', 'off']) {
    withDryRun(bad, () => assert.throws(() => isDryRun(), /Invalid DRY_RUN value/));
  }
});
