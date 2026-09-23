/**
 * kv.js — durable state for the cart-recovery sequence, namespace `cr1:`.
 *
 *   cr1:enr:<email_lc>        enrollment {sv, anchor, arm, at}; TTL 60 days.
 *                             One enrollment per address per 60 days: a later
 *                             upload does not restart the sequence.
 *   cr1:sent:<n>:<email_lc>   receipt for stage n; TTL 60 days.
 *   cr1:last:<email_lc>       time of the last send (min-spacing rule).
 *
 * KV_ENV_PREFIX namespaces everything per environment (set it in staging).
 * Without Vercel KV the store is in-memory and NON-DURABLE; the runner refuses
 * a live send in that state.
 */
const TTL_SECONDS = 60 * 24 * 60 * 60;

function prefix() {
  const raw = String(process.env.KV_ENV_PREFIX || '').trim();
  return `${raw ? `${raw}:` : ''}cr1:`;
}

const keys = {
  enrollment: (e) => `${prefix()}enr:${e}`,
  sent: (n, e) => `${prefix()}sent:${n}:${e}`,
  last: (e) => `${prefix()}last:${e}`,
};

function isDurable() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const memory = new Map();
let _kv = null;
function client() {
  if (!isDurable()) return null;
  if (!_kv) _kv = require('@vercel/kv').kv;
  return _kv;
}

async function get(key) {
  const kv = client();
  if (!kv) return memory.has(key) ? memory.get(key) : null;
  return kv.get(key);
}

async function set(key, value) {
  const kv = client();
  if (!kv) {
    memory.set(key, value);
    return;
  }
  await kv.set(key, value, { ex: TTL_SECONDS });
}

/** Set only if absent. Returns true when this call created the key. */
async function setNx(key, value) {
  const kv = client();
  if (!kv) {
    if (memory.has(key)) return false;
    memory.set(key, value);
    return true;
  }
  const r = await kv.set(key, value, { ex: TTL_SECONDS, nx: true });
  return r === 'OK';
}

function _resetMemory() {
  memory.clear();
}

module.exports = { keys, isDurable, get, set, setNx, TTL_SECONDS, _resetMemory };
