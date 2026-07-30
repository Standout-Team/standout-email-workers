/**
 * lib/sanitize.js
 *
 * Every string that reaches a Brevo template param or a recipient `name` goes
 * through here first.
 *
 * Two threats this closes:
 *   1. CRLF header injection — `to[].name` is rendered into a MIME header by
 *      Brevo. A name containing "\r\nBcc: attacker@evil.com" is a classic
 *      header-injection vector. Control characters never survive this file.
 *   2. Prompt-injection -> email HTML. Job titles/companies/descriptions are
 *      ingested from third-party ATS feeds, and the match reasons are LLM
 *      output derived from those feeds plus user-uploaded resume text. Neither
 *      is trusted. Stripping angle brackets means nothing we interpolate can
 *      open a tag inside the rendered template.
 *
 * Control characters become a single space (not "") so "Acme\nCorp" reads
 * "Acme Corp" rather than "AcmeCorp"; the collapse step then normalizes runs.
 */

const CONTROL_CHARS = /[\r\n\t\x00-\x1f\x7f]/g;
const ANGLE_BRACKETS = /[<>]/g;
const WHITESPACE_RUN = /\s+/g;

const DEFAULT_MAX_LEN = 300;
// Brevo caps the display name well under this; 100 also keeps a hostile
// resume-derived "name" from bloating the envelope.
const NAME_MAX_LEN = 100;

function sanitizeParam(value, maxLen = DEFAULT_MAX_LEN) {
  if (value === null || value === undefined) return '';
  const cap = Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : DEFAULT_MAX_LEN;

  const cleaned = String(value)
    .replace(CONTROL_CHARS, ' ')
    .replace(ANGLE_BRACKETS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();

  return cleaned.length > cap ? cleaned.slice(0, cap).trim() : cleaned;
}

// Recipient display name — same rules, tighter cap.
function sanitizeName(value) {
  return sanitizeParam(value, NAME_MAX_LEN);
}

module.exports = { sanitizeParam, sanitizeName, DEFAULT_MAX_LEN, NAME_MAX_LEN };
