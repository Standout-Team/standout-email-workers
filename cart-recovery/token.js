/**
 * token.js — signs the cart-recovery offer token.
 *
 * MUST stay byte-compatible with Standout-pro server/lib/recovery-token.ts:
 * base64url(JSON payload) + "." + base64url(HMAC-SHA256(payloadB64, secret)),
 * payload keys in this exact order: v, typ, sv, off, st, exp. The shared
 * secret is EMAIL_LINK_SECRET (same value in both projects). token.test.js
 * pins a vector produced by the TypeScript signer.
 */
const { createHmac } = require('node:crypto');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function signRecoveryToken({ sv, off, st, exp }, secret) {
  if (!secret) throw new Error('signRecoveryToken: EMAIL_LINK_SECRET is required');
  const payload = { v: 1, typ: 'recovery', sv, off, st, exp };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(payloadB64).digest());
  return `${payloadB64}.${sig}`;
}

module.exports = { signRecoveryToken };
