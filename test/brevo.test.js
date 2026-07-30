/**
 * lib/brevo.js retry/backoff behavior, driven entirely by an injected fake
 * fetch. Zero network, zero real timers (sleep is injected too).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { sendTransacEmail, BREVO_URL, MAX_ATTEMPTS } = require('../lib/brevo');

const API_KEY = 'test-key';
const TO = [{ email: 'user@example.com', name: 'Jane' }];

function response({ status = 200, body = '{}', headers = {} } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    text: async () => body,
  };
}

// Returns { fetchImpl, sleep, calls, sleeps }
function harness(responses) {
  const calls = [];
  const sleeps = [];
  const queue = [...responses];
  return {
    calls,
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (typeof next === 'function') return next();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('sends once on 201 and returns the messageId', async () => {
  const h = harness([response({ status: 201, body: JSON.stringify({ messageId: '<abc@brevo>' }) })]);

  const id = await sendTransacEmail({
    templateId: 39,
    to: TO,
    params: { FIRST_NAME: 'Jane' },
    apiKey: API_KEY,
    fetchImpl: h.fetchImpl,
    sleep: h.sleep,
  });

  assert.equal(id, '<abc@brevo>');
  assert.equal(h.calls.length, 1);
  assert.equal(h.sleeps.length, 0);

  const { url, init } = h.calls[0];
  assert.equal(url, BREVO_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['api-key'], API_KEY);
  const body = JSON.parse(init.body);
  assert.equal(body.templateId, 39);
  assert.deepEqual(body.to, TO);
  assert.deepEqual(body.params, { FIRST_NAME: 'Jane' });
});

test('retries a 429 then succeeds', async () => {
  const h = harness([
    response({ status: 429, body: '{"message":"rate limited"}' }),
    response({ status: 201, body: JSON.stringify({ messageId: 'ok' }) }),
  ]);

  const id = await sendTransacEmail({
    templateId: 39,
    to: TO,
    apiKey: API_KEY,
    fetchImpl: h.fetchImpl,
    sleep: h.sleep,
  });

  assert.equal(id, 'ok');
  assert.equal(h.calls.length, 2);
  assert.equal(h.sleeps.length, 1);
  assert.ok(h.sleeps[0] >= 1000 && h.sleeps[0] < 1300, `unexpected backoff ${h.sleeps[0]}`);
});

test('honors a numeric Retry-After header', async () => {
  const h = harness([
    response({ status: 429, body: '{}', headers: { 'Retry-After': '5' } }),
    response({ status: 201, body: JSON.stringify({ messageId: 'ok' }) }),
  ]);

  await sendTransacEmail({ templateId: 39, to: TO, apiKey: API_KEY, fetchImpl: h.fetchImpl, sleep: h.sleep });
  assert.deepEqual(h.sleeps, [5000]);
});

test('ignores a non-numeric (HTTP-date) Retry-After and uses backoff', async () => {
  const h = harness([
    response({ status: 503, body: 'nope', headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } }),
    response({ status: 201, body: JSON.stringify({ messageId: 'ok' }) }),
  ]);

  await sendTransacEmail({ templateId: 39, to: TO, apiKey: API_KEY, fetchImpl: h.fetchImpl, sleep: h.sleep });
  assert.equal(h.sleeps.length, 1);
  assert.ok(h.sleeps[0] >= 1000);
});

test('fails fast on a 400 — no retry', async () => {
  const h = harness([response({ status: 400, body: '{"code":"invalid_parameter"}' })]);

  await assert.rejects(
    () => sendTransacEmail({ templateId: 39, to: TO, apiKey: API_KEY, fetchImpl: h.fetchImpl, sleep: h.sleep }),
    /HTTP 400/
  );
  assert.equal(h.calls.length, 1);
  assert.equal(h.sleeps.length, 0);
});

test('fails fast on a 401 — a revoked key is not a transient error', async () => {
  const h = harness([response({ status: 401, body: 'unauthorized' })]);
  await assert.rejects(
    () => sendTransacEmail({ templateId: 39, to: TO, apiKey: API_KEY, fetchImpl: h.fetchImpl, sleep: h.sleep }),
    /HTTP 401/
  );
  assert.equal(h.calls.length, 1);
});

test('gives up after MAX_ATTEMPTS of 5xx', async () => {
  const h = harness([
    response({ status: 500, body: 'boom' }),
    response({ status: 502, body: '<html>bad gateway</html>' }),
    response({ status: 500, body: 'boom' }),
  ]);

  await assert.rejects(
    () => sendTransacEmail({ templateId: 39, to: TO, apiKey: API_KEY, fetchImpl: h.fetchImpl, sleep: h.sleep }),
    /HTTP 500/
  );
  assert.equal(h.calls.length, MAX_ATTEMPTS);
  assert.equal(h.sleeps.length, MAX_ATTEMPTS - 1);
  // exponential: ~1s then ~2s
  assert.ok(h.sleeps[0] >= 1000 && h.sleeps[0] < 1300);
  assert.ok(h.sleeps[1] >= 2000 && h.sleeps[1] < 2300);
});

test('retries network errors then rethrows a descriptive error', async () => {
  const h = harness([new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET')]);

  await assert.rejects(
    () => sendTransacEmail({ templateId: 39, to: TO, apiKey: API_KEY, fetchImpl: h.fetchImpl, sleep: h.sleep }),
    /request failed .*ECONNRESET/
  );
  assert.equal(h.calls.length, MAX_ATTEMPTS);
});

test('tolerates a non-JSON success body (accepted, no messageId)', async () => {
  const h = harness([response({ status: 204, body: '' })]);
  const id = await sendTransacEmail({
    templateId: 39,
    to: TO,
    apiKey: API_KEY,
    fetchImpl: h.fetchImpl,
    sleep: h.sleep,
  });
  assert.equal(id, null);
});

test('rejects bad input before any network call', async () => {
  const h = harness([]);
  const base = { to: TO, apiKey: API_KEY, fetchImpl: h.fetchImpl, sleep: h.sleep };

  await assert.rejects(() => sendTransacEmail({ ...base, templateId: 39, apiKey: '' }), /missing API key/);
  await assert.rejects(() => sendTransacEmail({ ...base, templateId: undefined }), /invalid templateId/);
  await assert.rejects(() => sendTransacEmail({ ...base, templateId: 'forty' }), /invalid templateId/);
  await assert.rejects(() => sendTransacEmail({ ...base, templateId: 39, to: [] }), /missing recipient/);
  assert.equal(h.calls.length, 0);
});
