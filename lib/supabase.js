/**
 * lib/supabase.js
 *
 * The single memoized service-role Supabase client. Previously duplicated in
 * abandonment-job-email/queries.js and abandonment-job-email-2/queries.js —
 * two clients meant two connection pools and two places to drift.
 *
 * The service key bypasses RLS, which is required: marketing_suppressions,
 * pending_subscriptions and profiles are all service-role-only tables.
 */

const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getSupabase() {
  if (_client) return _client;
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.');
  }
  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

// Test seam only — drops the memoized client so a test can swap env vars.
function _resetSupabase() {
  _client = null;
}

module.exports = { getSupabase, _resetSupabase };
