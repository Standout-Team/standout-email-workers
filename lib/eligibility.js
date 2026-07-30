/**
 * lib/eligibility.js
 *
 * Shared audience selection for both abandonment workers. Every rule that
 * decides "may we email this person?" lives here exactly once — the two
 * workers previously had two divergent copies (worker 1 excluded
 * active/trialing, worker 2 excluded active/trialing with a different
 * null-handling bug, and neither honored the suppression list at all).
 *
 * Three exclusion layers:
 *
 *   1. BILLING SIGNAL (client-side, off the profile row). Within 24–96h of
 *      signup, ANY non-null subscription_status means the user engaged with
 *      billing — including `incomplete` (mid-3DS), `past_due` and `unpaid`
 *      (dunning). Emailing "you never finished setting up" to somebody whose
 *      card is being retried is the worst possible send. Same for a non-null
 *      stripe_subscription_id, or a plan that isn't 'free'.
 *
 *   2. PAY-FIRST GUEST CHECKOUTS. The pay-first split test (migration
 *      20260722_02) lets a visitor pay via Stripe Checkout BEFORE creating an
 *      account; the profile is created later and reads NULL for every billing
 *      column until server/lib/billing-claim.ts claims the row. Those users are
 *      paying customers whose profile looks abandoned. Match on
 *      pending_subscriptions.email where status = 'paid'.
 *
 *   3. MARKETING SUPPRESSIONS. Unsubscribes, hard bounces and spam complaints,
 *      mirrored from Brevo's webhook (migration 20260603_02). Every product
 *      send path filters on this table; these crons did not, which meant we
 *      were mailing people who had explicitly opted out. The table is keyed on
 *      a lowercased+trimmed email, so both sides are normalized before compare.
 */

const { chunk } = require('./concurrency');

// PostgREST puts `.in()` values in the query string; keep each round trip well
// clear of the URL length limit.
const IN_CHUNK_SIZE = 200;

// Columns both workers read off `profiles`. Every one exists in the product's
// shared/schema.ts profiles table.
const PROFILE_COLUMNS = [
  'id',
  'email',
  'resume_parsed',
  'created_at',
  'plan',
  'subscription_status',
  'stripe_subscription_id',
  // Selected for diagnostics only — a customer id alone is NOT an exclusion
  // signal (Stripe mints one the moment a Checkout session opens, including
  // for people who bounce off the payment page).
  'stripe_customer_id',
  'abandonment_email_1_sent_at',
  'abandonment_email_1_job_id',
  'abandonment_email_2_sent_at',
].join(', ');

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * True when the profile row itself shows any billing engagement.
 * Deliberately broader than the old ['active','trialing'] check.
 */
function hasBillingSignal(profile) {
  if (!profile) return false;
  if (profile.subscription_status != null && String(profile.subscription_status).trim() !== '') return true;
  if (profile.stripe_subscription_id != null && String(profile.stripe_subscription_id).trim() !== '') return true;
  const plan = profile.plan == null ? '' : String(profile.plan).trim().toLowerCase();
  if (plan && plan !== 'free') return true;
  return false;
}

// Batched `.in()` over one column, concatenating rows across chunks.
async function selectIn(supabase, table, columns, column, values) {
  const rows = [];
  for (const part of chunk(values, IN_CHUNK_SIZE)) {
    if (part.length === 0) continue;
    const { data, error } = await supabase.from(table).select(columns).in(column, part);
    if (error) throw new Error(`${table} query failed: ${error.message}`);
    if (data) rows.push(...data);
  }
  return rows;
}

/**
 * Emails (normalized) with a paid pay-first guest checkout.
 *
 * Unlike marketing_suppressions, pending_subscriptions.email is stored exactly
 * as Stripe supplied it on the hosted checkout page — it is NOT lowercased on
 * write. PostgREST's `.in()` is case-sensitive, so we query BOTH the raw and
 * the normalized form and normalize again when comparing the rows back.
 */
async function fetchPaidPendingEmails(supabase, emails) {
  const lookups = new Set();
  for (const raw of emails || []) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (trimmed) lookups.add(trimmed);
    const norm = normalizeEmail(raw);
    if (norm) lookups.add(norm);
  }
  if (lookups.size === 0) return new Set();

  const rows = await selectIn(
    supabase,
    'pending_subscriptions',
    'email, status',
    'email',
    [...lookups]
  );
  const paid = new Set();
  for (const row of rows) {
    if (row && row.status === 'paid') {
      const e = normalizeEmail(row.email);
      if (e) paid.add(e);
    }
  }
  return paid;
}

/** Emails (normalized) on the marketing suppression list. */
async function fetchSuppressedEmails(supabase, emails) {
  const normalized = emails.map(normalizeEmail).filter(Boolean);
  if (normalized.length === 0) return new Set();
  const rows = await selectIn(supabase, 'marketing_suppressions', 'email', 'email', normalized);
  const out = new Set();
  for (const row of rows) {
    const e = normalizeEmail(row && row.email);
    if (e) out.add(e);
  }
  return out;
}

/**
 * Apply all three exclusion layers to a candidate profile list.
 * Returns { users, stats } — `users` is the sendable set, `stats` is
 * count-only (never addresses) and safe to log.
 */
async function filterSendable(supabase, profiles, label) {
  const candidates = (profiles || []).filter((p) => p && normalizeEmail(p.email));
  const noEmail = (profiles || []).length - candidates.length;

  const withoutBilling = candidates.filter((p) => !hasBillingSignal(p));
  const billing = candidates.length - withoutBilling.length;

  // Pass the RAW addresses: fetchPaidPendingEmails needs both cases (that
  // table isn't lowercased on write); fetchSuppressedEmails normalizes itself.
  const rawEmails = withoutBilling.map((p) => p.email);
  const [paidPending, suppressed] = await Promise.all([
    fetchPaidPendingEmails(supabase, rawEmails),
    fetchSuppressedEmails(supabase, rawEmails),
  ]);

  let pending = 0;
  let suppressedCount = 0;
  const users = [];
  for (const p of withoutBilling) {
    const email = normalizeEmail(p.email);
    if (paidPending.has(email)) {
      pending++;
      continue;
    }
    if (suppressed.has(email)) {
      suppressedCount++;
      continue;
    }
    users.push(p);
  }

  const stats = {
    candidates: (profiles || []).length,
    excluded_no_email: noEmail,
    excluded_billing: billing,
    excluded_pending_paid: pending,
    excluded_suppressed: suppressedCount,
    sendable: users.length,
  };

  if (label) console.log(`[${label}] audience`, stats);

  return { users, stats };
}

/**
 * userId -> newest survey id that actually has an embedding.
 *
 * surveys.user_id is NOT unique (a user can re-take onboarding), and the RPC
 * hard-requires an embedding. The old code took whichever row PostgREST
 * happened to return last and never checked survey_embedding, so a re-taken
 * survey could route the match query at a stale or unembedded row. Ordering by
 * id DESC and keeping the FIRST row per user mirrors what the product does
 * (newest embedded survey wins).
 */
async function fetchNewestSurveyIds(supabase, userIds) {
  const byUser = new Map();
  for (const part of chunk(userIds, IN_CHUNK_SIZE)) {
    if (part.length === 0) continue;
    const { data, error } = await supabase
      .from('surveys')
      .select('id, user_id')
      .in('user_id', part)
      .not('survey_embedding', 'is', null)
      .order('id', { ascending: false });
    if (error) throw new Error(`surveys query failed: ${error.message}`);
    for (const row of data || []) {
      if (!row || row.user_id == null) continue;
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, row.id); // first == newest
    }
  }
  return byUser;
}

module.exports = {
  PROFILE_COLUMNS,
  IN_CHUNK_SIZE,
  normalizeEmail,
  hasBillingSignal,
  fetchPaidPendingEmails,
  fetchSuppressedEmails,
  filterSendable,
  fetchNewestSurveyIds,
  selectIn,
};
