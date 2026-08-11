/**
 * lead-token.js
 *
 * JS twin of server/lib/lead-token.ts in the main repo. A lead token says
 * "this email belongs to survey <sv>, featuring job <jb>" — it's what lets the
 * /your-match landing page restore an anonymous lead's survey + resume without
 * an account (they signed up before we ever minted one).
 *
 * Format:  base64url(JSON payload) + "." + base64url(HMAC-SHA256(payloadB64))
 * Payload: { v:1, typ:"lead", sv, jb, exp }   exp = unix SECONDS, 14-day TTL.
 *
 * `typ:"lead"` is the domain separator — the main app's verifyEmailToken
 * rejects payloads without uid/redirect, and verifyLeadToken rejects anything
 * that isn't typ:"lead" with integer sv/jb.
 */

const { createHmac } = require('node:crypto');

const TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days

function b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function signLeadToken({ sv, jb }, secret) {
  if (!secret) throw new Error('signLeadToken: secret is required');
  const payload = {
    v: 1,
    typ: 'lead',
    sv,
    jb,
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  };
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

/**
 * Payload half only, no signature check — for the dry-run self-check log.
 * The main app's verifyLeadToken is the real gate. Returns null on anything
 * malformed.
 */
function decodeLeadToken(token) {
  const dot = String(token || '').indexOf('.');
  if (dot <= 0) return null;
  try {
    return JSON.parse(b64urlDecode(String(token).slice(0, dot)).toString('utf8'));
  } catch (_) {
    return null;
  }
}

module.exports = { signLeadToken, decodeLeadToken, TTL_SECONDS };
