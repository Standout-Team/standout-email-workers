/**
 * audience.js — who is in the cart-recovery sequence.
 *
 * Everyone who uploaded a resume and opted in to marketing, then did not pay.
 * Deliberately NOT limited to people who reached checkout. Both kinds:
 *
 *   anonymous lead     surveys.user_id IS NULL; mailed at the resume's email.
 *   registered user    surveys.user_id set to a real (non-anonymous) profile
 *                      with an email; mailed at the account email.
 *
 * A survey owned by an ANONYMOUS profile (minted by an older email CTA) is
 * treated as an anonymous lead.
 *
 * Only surveys created at or after CART_RECOVERY_CUTOVER are eligible — no
 * backfill of history. One enrollment per address: the earliest eligible
 * survey in the lookback is the anchor.
 *
 * Exclusions (applied to the leads that have a stage due, then re-checked
 * right before each send): marketing_suppressions, any profile with that email
 * or the owning profile on an active/trialing subscription, and any paid
 * pending_subscriptions row for the email or session.
 */
const { getSupabase, _internals } = require('../abandonment-anon-lead-email/queries');

const { parseResume, escapeLike, isUsBasedLead } = _internals;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAID_SUB_STATUSES = ['active', 'trialing'];
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const DAY = 24 * 60 * 60 * 1000;
/** Oldest survey still inside the sequence: e6 deadline is ≤ day 7 + 48h. */
const LOOKBACK_MS = 8 * DAY;
const SETTLE_MS = 60 * 60 * 1000; // T = created_at + 1h

function firstName(name) {
  const t = typeof name === 'string' ? name.trim() : '';
  if (!t) return '';
  const f = t.split(/\s+/)[0];
  return f.charAt(0).toUpperCase() + f.slice(1);
}

async function fetchSurveys({ sinceIso, untilIso, client }) {
  const supabase = client || getSupabase();
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from('surveys')
      .select('id, session_id, user_id, resume_parsed, created_at')
      .eq('marketing_opt_in', true)
      .not('resume_parsed', 'is', null)
      .gte('created_at', sinceIso)
      .lte('created_at', untilIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`surveys query failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
  console.warn(`[cart-recovery] survey paging guard hit at ${rows.length} rows`);
  return rows;
}

async function fetchProfiles(ids, client) {
  const supabase = client || getSupabase();
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, is_anonymous, subscription_status')
      .in('id', chunk);
    if (error) throw new Error(`profiles query failed: ${error.message}`);
    for (const p of data || []) out.set(p.id, p);
  }
  return out;
}

/**
 * Surveys → one lead per address. Pure given rows + profiles; exported for tests.
 */
function buildLeads(rows, profilesById, { cutoverMs, usOnly }) {
  const byEmail = new Map();
  for (const row of rows) {
    const created = Date.parse(row.created_at);
    if (!Number.isFinite(created) || created < cutoverMs) continue;
    const parsed = parseResume(row.resume_parsed);
    if (!parsed) continue;

    let email = '';
    let registered = false;
    const owner = row.user_id ? profilesById.get(row.user_id) : null;
    if (row.user_id) {
      if (owner && PAID_SUB_STATUSES.includes(owner.subscription_status)) continue;
      if (owner && owner.is_anonymous !== true && owner.email) {
        email = String(owner.email).trim();
        registered = true;
      }
    }
    if (!email) email = typeof parsed.email === 'string' ? parsed.email.trim() : '';
    if (!EMAIL_RE.test(email)) continue;
    if (usOnly && !isUsBasedLead({ resume_parsed: parsed })) continue;

    const emailLc = email.toLowerCase();
    if (byEmail.has(emailLc)) continue; // rows are oldest-first: first one anchors
    byEmail.set(emailLc, {
      survey_id: row.id,
      session_id: row.session_id,
      user_id: row.user_id || null,
      registered,
      email,
      email_lc: emailLc,
      first_name: firstName(parsed.name),
      created_at_ms: created,
      anchor_ms: created + SETTLE_MS,
    });
  }
  return [...byEmail.values()];
}

async function findLeads({ nowMs, cutoverMs, usOnly, client }) {
  const since = Math.max(cutoverMs, nowMs - LOOKBACK_MS);
  const until = nowMs - SETTLE_MS;
  if (until <= since) return [];
  const rows = await fetchSurveys({
    sinceIso: new Date(since).toISOString(),
    untilIso: new Date(until).toISOString(),
    client,
  });
  const ownerIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  const profiles = ownerIds.length ? await fetchProfiles(ownerIds, client) : new Map();
  return buildLeads(rows, profiles, { cutoverMs, usOnly });
}

async function countIlike(table, emailLc, refine, supabase) {
  let q = supabase.from(table).select('id', { head: true, count: 'exact' }).ilike('email', escapeLike(emailLc));
  if (refine) q = refine(q);
  const { count, error } = await q;
  if (error) throw new Error(`${table} check failed: ${error.message}`);
  return count || 0;
}

/**
 * Should this lead NOT be mailed right now? Returns a reason string or null.
 * Throws on query failure — callers treat that as "defer", never "send".
 */
async function exclusionReason(lead, { client } = {}) {
  const supabase = client || getSupabase();

  const { data: sup, error: supErr } = await supabase
    .from('marketing_suppressions')
    .select('email')
    .eq('email', lead.email_lc)
    .limit(1);
  if (supErr) throw new Error(`marketing_suppressions check failed: ${supErr.message}`);
  if ((sup || []).length) return 'suppressed';

  if (await countIlike('profiles', lead.email_lc, (q) => q.in('subscription_status', PAID_SUB_STATUSES), supabase)) {
    return 'paid_profile';
  }
  if (lead.user_id) {
    const { data: owner, error } = await supabase
      .from('profiles')
      .select('subscription_status')
      .eq('id', lead.user_id)
      .limit(1);
    if (error) throw new Error(`owner profile check failed: ${error.message}`);
    if ((owner || []).some((p) => PAID_SUB_STATUSES.includes(p.subscription_status))) return 'paid_owner';
  }

  const since = new Date(lead.created_at_ms - DAY).toISOString();
  if (lead.session_id) {
    const { data, error } = await supabase
      .from('pending_subscriptions')
      .select('session_id')
      .eq('status', 'paid')
      .gt('created_at', since)
      .eq('session_id', lead.session_id)
      .limit(1);
    if (error) throw new Error(`pending_subscriptions check failed: ${error.message}`);
    if ((data || []).length) return 'paid_checkout';
  }
  if (
    await countIlike(
      'pending_subscriptions',
      lead.email_lc,
      (q) => q.eq('status', 'paid').gt('created_at', since),
      supabase
    )
  ) {
    return 'paid_checkout';
  }
  return null;
}

/** Has this address redeemed its free apply? Soft-fails to "unknown" (false). */
async function freeApplyUnused(lead, { client } = {}) {
  try {
    const supabase = client || getSupabase();
    const { data, error } = await supabase
      .from('free_apply_grants')
      .select('redeemed_at')
      .eq('email_lc', lead.email_lc)
      .limit(5);
    if (error) return false;
    // Every lead is entitled to one free application; a grant row with
    // redeemed_at set means it has been used.
    return !(data || []).some((r) => r.redeemed_at);
  } catch (_) {
    return false;
  }
}

module.exports = {
  findLeads,
  buildLeads,
  exclusionReason,
  freeApplyUnused,
  firstName,
  LOOKBACK_MS,
  SETTLE_MS,
  PAID_SUB_STATUSES,
};
