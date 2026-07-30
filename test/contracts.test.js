/**
 * Cross-module contract test.
 *
 * abandonment-job-email-2 shipped calling `sentTracker.getSentJobId(...)` — a
 * function that did not exist. Nothing caught it because nothing ever required
 * both modules together outside of a live cron run, and the crash was buried in
 * a Promise.all inside a serverless function nobody was reading logs for.
 *
 * This test walks every source file, extracts what each one imports and what it
 * calls on those imports, and asserts the target actually exports it. It is
 * deliberately dumb and static — it cannot be satisfied by a code path that
 * merely happens not to run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIRS = ['lib', 'abandonment-job-email', 'abandonment-job-email-2', 'api'];

function sourceFiles() {
  const out = [];
  for (const dir of SOURCE_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.js')) out.push(path.join(abs, name));
    }
  }
  return out;
}

const DESTRUCTURE_RE = /const\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
const NAMESPACE_RE = /const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function resolveFrom(file, spec) {
  return spec.startsWith('.') ? require.resolve(path.resolve(path.dirname(file), spec)) : spec;
}

test('every source file parses and loads', () => {
  for (const file of sourceFiles()) {
    assert.doesNotThrow(() => require(file), `failed to require ${path.relative(ROOT, file)}`);
  }
});

test('every destructured import exists on the target module', () => {
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    for (const match of src.matchAll(DESTRUCTURE_RE)) {
      const names = match[1]
        .split(',')
        .map((s) => s.split(':')[0].trim())
        .filter(Boolean);
      const target = require(resolveFrom(file, match[2]));
      for (const name of names) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(target, name) || target[name] !== undefined,
          `${rel} destructures "${name}" from "${match[2]}", which does not export it`
        );
      }
    }
  }
});

test('every method called on a namespace import exists and is a function', () => {
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    for (const match of src.matchAll(NAMESPACE_RE)) {
      const alias = match[1];
      const target = require(resolveFrom(file, match[2]));
      const usage = new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
      for (const call of src.matchAll(usage)) {
        const member = call[1];
        assert.equal(
          typeof target[member],
          'function',
          `${rel} calls ${alias}.${member}() but "${match[2]}" does not export that function`
        );
      }
    }
  }
});

// --- explicit entry-point shapes -------------------------------------------

test('both workers export run()', () => {
  assert.equal(typeof require('../abandonment-job-email/index.js').run, 'function');
  assert.equal(typeof require('../abandonment-job-email-2/index.js').run, 'function');
});

test('both api routes export a request handler', () => {
  assert.equal(typeof require('../api/abandonment-job-email.js'), 'function');
  assert.equal(typeof require('../api/abandonment-job-email-2.js'), 'function');
});

test('the shared libs export what the workers need', () => {
  const expectations = [
    ['../lib/supabase', ['getSupabase']],
    ['../lib/dry-run', ['isDryRun']],
    ['../lib/sanitize', ['sanitizeParam', 'sanitizeName']],
    ['../lib/magic-link', ['signEmailToken', 'buildMagicLink', 'b64urlEncode', 'trimBase', 'appUrl']],
    ['../lib/brevo', ['sendTransacEmail']],
    ['../lib/cron-auth', ['requireCronAuth']],
    ['../lib/concurrency', ['mapWithConcurrency', 'chunk']],
    ['../lib/claims', ['claimEmail1', 'releaseEmail1', 'claimEmail2', 'releaseEmail2']],
    ['../lib/eligibility', ['filterSendable', 'fetchNewestSurveyIds', 'hasBillingSignal', 'normalizeEmail']],
    ['../abandonment-job-email/queries', ['findEligibleUsers', 'findBestJobsForUsers']],
    ['../abandonment-job-email-2/queries', ['findEligibleUsers', 'findJobsAndMatchCounts']],
    ['../abandonment-job-email/match-reason', ['generateMatchReasons', 'fallbackReasons']],
    ['../abandonment-job-email/sent-tracker', ['hasBeenSent', 'markSent', 'getSentJobId', 'isKVConfigured']],
  ];
  for (const [mod, fns] of expectations) {
    const target = require(mod);
    for (const fn of fns) {
      assert.equal(typeof target[fn], 'function', `${mod} must export ${fn}()`);
    }
  }
});

test('the deleted Brevo SDK wrapper is gone and nothing imports @getbrevo/brevo', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'abandonment-job-email/brevo.js')), false);
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    // Comments may name it (lib/brevo.js documents what it replaced); an actual
    // require() of it may not exist anywhere.
    assert.equal(
      /require\(\s*['"]@getbrevo\/brevo['"]\s*\)/.test(src),
      false,
      `${path.relative(ROOT, file)} still requires the removed @getbrevo/brevo SDK`
    );
  }
  const pkg = require('../package.json');
  assert.equal('@getbrevo/brevo' in (pkg.dependencies || {}), false);
});
