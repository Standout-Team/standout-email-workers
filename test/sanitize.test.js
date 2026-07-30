const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeParam, sanitizeName } = require('../lib/sanitize');

test('sanitizeParam strips CRLF (Brevo header-injection guard)', () => {
  const out = sanitizeParam('Jane\r\nBcc: attacker@evil.com');
  assert.equal(out.includes('\r'), false);
  assert.equal(out.includes('\n'), false);
  assert.equal(out, 'Jane Bcc: attacker@evil.com');
});

test('sanitizeParam strips tabs, NULs and other control characters', () => {
  assert.equal(sanitizeParam('a\tb\u0000c\u007fd'), 'a b c d');
});

test('sanitizeParam removes angle brackets so nothing can open a tag', () => {
  assert.equal(sanitizeParam('<script>alert(1)</script>'), 'scriptalert(1)/script');
  assert.equal(sanitizeParam('Engineer <img src=x onerror=y>'), 'Engineer img src=x onerror=y');
});

test('sanitizeParam collapses whitespace runs and trims', () => {
  assert.equal(sanitizeParam('   Senior    Data   Analyst  '), 'Senior Data Analyst');
});

test('sanitizeParam caps at the default 300 chars', () => {
  assert.equal(sanitizeParam('x'.repeat(500)).length, 300);
});

test('sanitizeParam honors an explicit cap', () => {
  assert.equal(sanitizeParam('y'.repeat(500), 140).length, 140);
});

test('sanitizeParam coerces non-strings and handles null/undefined', () => {
  assert.equal(sanitizeParam(42), '42');
  assert.equal(sanitizeParam(null), '');
  assert.equal(sanitizeParam(undefined), '');
});

test('sanitizeName caps at 100 chars', () => {
  assert.equal(sanitizeName('z'.repeat(250)).length, 100);
});

test('sanitizeName strips CRLF from a resume-derived display name', () => {
  const out = sanitizeName('Jane\nX-Injected: 1');
  assert.equal(/[\r\n]/.test(out), false);
});
