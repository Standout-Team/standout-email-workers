/**
 * lib/magic-link.js
 *
 * Email auto-login magic links, ported byte-for-byte from the product's
 * server/lib/email-token.ts (signEmailToken) and server/marketing/links.ts
 * (emailAuthRedirectUrl + trimBase).
 *
 * DO NOT CHANGE THE TOKEN FORMAT. The product's verifyEmailToken() is the only
 * consumer; any drift here silently breaks every link in every email already
 * in inboxes. test/magic-link.test.js pins the format by re-implementing the
 * server's verifier and round-tripping against it.
 *
 *   token   = base64url(JSON payload) + "." + base64url(HMAC-SHA256(payloadB64))
 *   payload = { uid, redirect, exp }   // exp is unix SECONDS
 *
 * The redirect path lives inside the signed payload (not a query param) so it
 * can't be repointed — open-redirect protection.
 */

const { createHmac } = require('node:crypto');

// standout.jobs is dead; www.usestandout.today is the canonical origin.
const DEFAULT_APP_URL = 'https://www.usestandout.today';

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Mirrors trimBase() in server/marketing/links.ts — a trailing slash on the
// env var would otherwise mint "https://host//dashboard?…".
function trimBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function appUrl() {
  const configured = process.env.STANDOUT_APP_URL;
  return trimBase(configured && configured.trim() ? configured.trim() : DEFAULT_APP_URL);
}

function signEmailToken(payload, secret) {
  if (!secret) throw new Error('signEmailToken: secret is required');
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

/**
 * Mint a signed auto-login URL that routes through /api/auth/email-link.
 * On click the server verifies the token, mints a FRESH one-time Supabase
 * magic link, and lands the user signed-in on `redirect`.
 *
 * Falls back to a plain (non-authenticating) link when EMAIL_LINK_SECRET is
 * unset, so a missing secret degrades to "user must log in" rather than
 * breaking the send.
 *
 * NOTE: the returned URL is a bearer credential. Never log it.
 */
function buildMagicLink(baseUrl, userId, redirect) {
  const base = trimBase(baseUrl);
  const secret = process.env.EMAIL_LINK_SECRET;
  if (!secret) return `${base}${redirect}`;
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const token = signEmailToken({ uid: userId, redirect, exp }, secret);
  const params = new URLSearchParams({ uid: userId, t: token });
  return `${base}/api/auth/email-link?${params.toString()}`;
}

module.exports = {
  b64urlEncode,
  signEmailToken,
  buildMagicLink,
  trimBase,
  appUrl,
  DEFAULT_APP_URL,
  TOKEN_TTL_SECONDS,
};
