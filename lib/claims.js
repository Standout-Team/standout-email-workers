/**
 * lib/claims.js
 *
 * Atomic "this user has been emailed" claims on `profiles`.
 *
 * This replaces the Vercel-KV tracker as the dedup mechanism. Same pattern the
 * product uses for brevo_synced_at / posthog_signed_up_at:
 *
 *     UPDATE profiles
 *        SET abandonment_email_N_sent_at = now()
 *      WHERE id = $1 AND abandonment_email_N_sent_at IS NULL
 *  RETURNING id
 *
 * Postgres serializes the two UPDATEs, so exactly one of N concurrent runs gets
 * a row back. An empty result means somebody else claimed it — skip, do not
 * send. This is what makes overlapping cron invocations, a manual POST, and a
 * Vercel retry all safe.
 *
 * The claim is taken BEFORE the Anthropic call and before the Brevo call. That
 * ordering is deliberate: it means a crash mid-send can at worst DROP one
 * email, never duplicate one — and it stops us burning LLM tokens generating
 * copy for a user another run already has.
 *
 * If the send then fails we RELEASE the claim so the next hourly run retries.
 * Release is the only place these columns go back to NULL.
 */

async function claimEmail1(supabase, userId, jobId) {
  const { data, error } = await supabase
    .from('profiles')
    .update({
      abandonment_email_1_sent_at: new Date().toISOString(),
      abandonment_email_1_job_id: jobId == null ? null : Number(jobId),
    })
    .eq('id', userId)
    .is('abandonment_email_1_sent_at', null)
    .select('id');

  if (error) throw new Error(`email 1 claim failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

async function releaseEmail1(supabase, userId) {
  const { error } = await supabase
    .from('profiles')
    .update({ abandonment_email_1_sent_at: null, abandonment_email_1_job_id: null })
    .eq('id', userId);
  if (error) throw new Error(`email 1 claim release failed: ${error.message}`);
}

async function claimEmail2(supabase, userId) {
  const { data, error } = await supabase
    .from('profiles')
    .update({ abandonment_email_2_sent_at: new Date().toISOString() })
    .eq('id', userId)
    .is('abandonment_email_2_sent_at', null)
    .select('id');

  if (error) throw new Error(`email 2 claim failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

async function releaseEmail2(supabase, userId) {
  const { error } = await supabase
    .from('profiles')
    .update({ abandonment_email_2_sent_at: null })
    .eq('id', userId);
  if (error) throw new Error(`email 2 claim release failed: ${error.message}`);
}

module.exports = { claimEmail1, releaseEmail1, claimEmail2, releaseEmail2 };
