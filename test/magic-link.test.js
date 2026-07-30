/**
 * Pins the magic-link token format against the product's verifier.
 *
 * verifyEmailToken below is a faithful CommonJS reimplementation of
 * Standout-pro's server/lib/email-token.ts. If lib/magic-link.js ever drifts
 * (different JSON shape, different HMAC input, different base64url handling),
 * this round-trip fails — which is the only automated protection we have
 * against silently breaking every link already sitting in inboxes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, timingSafeEqual } = require('node:crypto');

const { signEmailToken, buildMagicLink, trimBase, appUrl, DEFAULT_APP_URL } = require('../lib/magic-link');

// ---- local reimplementation of server/lib/email-token.ts -------------------

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function hmac(payloadB64, secret) {
  return createHmac('sha256', secret).update(payloadB64).digest();
}

function verifyEmailToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!token || !secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const expected = hmac(payloadB64, secret);
  let provided;
  try {
    provided = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.uid !== 'string' ||
    typeof payload.redirect !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }
  if (payload.exp <= nowSeconds) return null;
  return payload;
}

// ---- tests -----------------------------------------------------------------

const SECRET = 'test-email-link-secret';
const UID = '11111111-2222-3333-4444-555555555555';

test('signed token round-trips through the product verifier', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = { uid: UID, redirect: '/dashboard?job=7', exp };
  const token = signEmailToken(payload, SECRET);

  const verified = verifyEmailToken(token, SECRET);
  assert.notEqual(verified, null);
  assert.deepEqual(verified, payload);
});

test('token is exactly two base64url segments joined by a dot', () => {
  const token = signEmailToken({ uid: UID, redirect: '/matches', exp: 2000000000 }, SECRET);
  const parts = token.split('.');
  assert.equal(parts.length, 2);
  for (const part of parts) {
    assert.match(part, /^[A-Za-z0-9_-]+$/); // base64url, unpadded
  }
});

test('verifier rejects a token signed with a different secret', () => {
  const token = signEmailToken({ uid: UID, redirect: '/matches', exp: 2000000000 }, SECRET);
  assert.equal(verifyEmailToken(token, 'other-secret'), null);
});

test('verifier rejects an expired token', () => {
  const exp = Math.floor(Date.now() / 1000) - 1;
  const token = signEmailToken({ uid: UID, redirect: '/matches', exp }, SECRET);
  assert.equal(verifyEmailToken(token, SECRET), null);
});

test('verifier rejects a tampered payload', () => {
  const token = signEmailToken({ uid: UID, redirect: '/matches', exp: 2000000000 }, SECRET);
  const [, sig] = token.split('.');
  const forged = Buffer.from(
    JSON.stringify({ uid: UID, redirect: '/admin', exp: 2000000000 }),
    'utf8'
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(verifyEmailToken(`${forged}.${sig}`, SECRET), null);
});

test('signEmailToken requires a secret', () => {
  assert.throws(() => signEmailToken({ uid: UID, redirect: '/x', exp: 1 }, ''), /secret is required/);
});

test('buildMagicLink mints a verifiable /api/auth/email-link URL', () => {
  const prev = process.env.EMAIL_LINK_SECRET;
  process.env.EMAIL_LINK_SECRET = SECRET;
  try {
    const url = new URL(buildMagicLink('https://www.usestandout.today', UID, '/dashboard?job=9'));
    assert.equal(url.origin, 'https://www.usestandout.today');
    assert.equal(url.pathname, '/api/auth/email-link');
    assert.equal(url.searchParams.get('uid'), UID);

    const verified = verifyEmailToken(url.searchParams.get('t'), SECRET);
    assert.notEqual(verified, null);
    assert.equal(verified.uid, UID);
    assert.equal(verified.redirect, '/dashboard?job=9');
  } finally {
    if (prev === undefined) delete process.env.EMAIL_LINK_SECRET;
    else process.env.EMAIL_LINK_SECRET = prev;
  }
});

test('buildMagicLink falls back to a plain link without a secret', () => {
  const prev = process.env.EMAIL_LINK_SECRET;
  delete process.env.EMAIL_LINK_SECRET;
  try {
    assert.equal(
      buildMagicLink('https://www.usestandout.today', UID, '/matches'),
      'https://www.usestandout.today/matches'
    );
  } finally {
    if (prev !== undefined) process.env.EMAIL_LINK_SECRET = prev;
  }
});

test('trailing slashes on the base URL are trimmed (no double slash)', () => {
  const prev = process.env.EMAIL_LINK_SECRET;
  delete process.env.EMAIL_LINK_SECRET;
  try {
    assert.equal(trimBase('https://www.usestandout.today///'), 'https://www.usestandout.today');
    assert.equal(
      buildMagicLink('https://www.usestandout.today/', UID, '/matches'),
      'https://www.usestandout.today/matches'
    );
  } finally {
    if (prev !== undefined) process.env.EMAIL_LINK_SECRET = prev;
  }
});

test('appUrl defaults to the canonical domain, not the dead one', () => {
  const prev = process.env.STANDOUT_APP_URL;
  delete process.env.STANDOUT_APP_URL;
  try {
    assert.equal(appUrl(), DEFAULT_APP_URL);
    assert.equal(DEFAULT_APP_URL, 'https://www.usestandout.today');
  } finally {
    if (prev !== undefined) process.env.STANDOUT_APP_URL = prev;
  }
});
