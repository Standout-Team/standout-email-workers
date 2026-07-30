/**
 * lib/brevo.js
 *
 * The single transactional-send choke point for both workers.
 *
 * Replaces:
 *   - abandonment-job-email/brevo.js, which used the @getbrevo/brevo SDK. That
 *     SDK transitively pulls the abandoned `request` library (deprecated since
 *     2020, open CVEs in its tough-cookie/form-data chain) for one HTTP POST.
 *   - abandonment-job-email-2's inline `fetch`, which had no timeout, no
 *     retries, and called res.json() on a body that is HTML on a 502.
 *
 * Same hand-rolled-fetch approach as the product's server/marketing/brevo.ts.
 *
 * Contract:
 *   - resolves to a messageId (or null when Brevo accepts without one)
 *   - throws a descriptive Error on final failure; callers catch PER USER so a
 *     single bad recipient never kills the batch
 *   - retries 429 / 5xx / network errors up to MAX_ATTEMPTS with exponential
 *     backoff + jitter, honoring a numeric Retry-After when Brevo sends one
 *   - fails fast on any other 4xx (bad template id, invalid recipient, revoked
 *     key) — retrying those just burns the cron's wall clock
 *   - NEVER logs recipient addresses. Callers log user ids.
 */

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

const TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000; // 1s, 2s, 4s
const MAX_JITTER_MS = 250;
const MAX_RETRY_AFTER_MS = 30000; // never let a hostile header park the cron

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  return BASE_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * MAX_JITTER_MS);
}

// Brevo returns JSON on success and on documented errors, but a proxy/CDN 5xx
// is HTML. Parse tolerantly — a body we can't read must never mask the status.
function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function truncate(s, max = 300) {
  const str = String(s || '');
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function retryAfterMs(res) {
  if (!res || !res.headers || typeof res.headers.get !== 'function') return null;
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null; // HTTP-date form — ignore
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * @param {object} args
 * @param {number|string} args.templateId  Brevo transactional template id
 * @param {Array<{email:string,name?:string}>} args.to
 * @param {object} [args.params]           template params (already sanitized)
 * @param {string} args.apiKey
 * @param {function} [args.fetchImpl]      test seam
 * @param {function} [args.sleep]          test seam
 * @returns {Promise<string|null>} messageId
 */
async function sendTransacEmail(args) {
  const { templateId, to, params, apiKey } = args || {};
  const doFetch = (args && args.fetchImpl) || globalThis.fetch;
  const sleep = (args && args.sleep) || defaultSleep;

  if (!apiKey) throw new Error('brevo: missing API key');
  const tid = Number(templateId);
  if (!Number.isInteger(tid) || tid <= 0) {
    throw new Error(`brevo: invalid templateId (${JSON.stringify(templateId)})`);
  }
  if (!Array.isArray(to) || to.length === 0 || !to[0] || !to[0].email) {
    throw new Error('brevo: missing recipient');
  }
  if (typeof doFetch !== 'function') throw new Error('brevo: no fetch implementation available');

  const body = JSON.stringify({
    templateId: tid,
    to,
    ...(params ? { params } : {}),
  });

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    let text;
    try {
      res = await doFetch(BREVO_URL, {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      // Network error, DNS failure, or the 10s abort.
      lastError = new Error(`brevo: request failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    const parsed = safeJsonParse(text);

    if (res.ok) {
      // 201 carries messageId; a bare 200/204 means accepted — treat the
      // missing id as success, NOT failure. Reporting failure here would make
      // the caller release its claim and re-send the same email next hour.
      const messageId =
        (parsed && (parsed.messageId || (Array.isArray(parsed.messageIds) ? parsed.messageIds[0] : null))) || null;
      return messageId;
    }

    if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS) {
      lastError = new Error(`brevo: HTTP ${res.status} — ${truncate(text)}`);
      const wait = retryAfterMs(res);
      await sleep(wait === null ? backoffMs(attempt) : wait);
      continue;
    }

    // Non-retryable 4xx, or a retryable status on the final attempt.
    throw new Error(
      `brevo: send failed with HTTP ${res.status} after ${attempt} attempt(s) — ${truncate(text)}`
    );
  }

  throw lastError || new Error('brevo: send failed');
}

module.exports = {
  sendTransacEmail,
  BREVO_URL,
  MAX_ATTEMPTS,
  TIMEOUT_MS,
  // exported for tests / callers that want the same parse behavior
  _internals: { safeJsonParse, backoffMs, retryAfterMs, isRetryableStatus },
};
