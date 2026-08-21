/**
 * tailoring.js
 *
 * The 48h email shows the lead their application already written — two or
 * three resume bullets actually tailored to the matched job — rather than
 * offering them something. Generating those bullets is an LLM call that writes
 * to the `tailoring_plans` cache, and this repo is read-only against Supabase
 * (see README: "Zero writes to Supabase"), so the worker cannot do it itself.
 * It asks the main app, which owns both the write and the
 * (resume_hash, job_hash, prompt_version) cache the main repo's CLAUDE.md
 * requires of any tailoring call path.
 *
 * FAILURE IS A SKIP, NEVER A DEGRADED SEND (owner decision 2026-08-21). The
 * whole premise of this email is showing finished work; a version without the
 * bullets is a worse email than the one it replaced. So every failure here —
 * endpoint down, timeout, malformed body, no bullets returned — returns null,
 * the caller leaves the lead unmarked, and the next hourly run tries again.
 * That retry is only real because the 48h stage spans three hours; with a
 * one-hour span the window would have moved past them. See stages.js.
 *
 * The timeout is not optional. This runs inside the same 280s budget as the
 * match fan-out, once per recipient. One hung request without a deadline would
 * spend the whole run's budget and defer everyone behind it.
 */

// Per-request deadline. Generous enough for a cold cache (the main app may
// have to extract the job profile AND run the tailor), tight enough that a
// stalled endpoint costs one lead rather than the run.
const TAILORING_TIMEOUT_MS = 20000;

// Fewer than this and the email has nothing to show, so it is not worth
// sending — treat it exactly like a failure and let the lead retry.
const MIN_BULLETS = 2;
const MAX_BULLETS = 3;

/**
 * Is the tailoring endpoint configured? Pure. The 48h stage refuses to run a
 * real send without it, the same way it refuses without a Brevo template —
 * a missing endpoint is a deploy mistake, and discovering it once per lead
 * buries the cause in a cohort of identical failures.
 */
function tailoringConfigured(env = process.env) {
  return !!(env.TAILORING_ENDPOINT_URL && env.TAILORING_ENDPOINT_SECRET);
}

/**
 * Tailored bullets for one lead/job pair, or null.
 *
 * Never throws: the caller's contract is "null means skip this lead", and an
 * exception here would abort the whole run over one unlucky request.
 */
async function fetchTailoredBullets(lead, job, env = process.env) {
  if (!tailoringConfigured(env)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TAILORING_TIMEOUT_MS);

  try {
    const res = await fetch(env.TAILORING_ENDPOINT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.TAILORING_ENDPOINT_SECRET}`,
      },
      body: JSON.stringify({ surveyId: lead.survey_id, jobId: job.id }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(
        `[tailoring] ${lead.email_lc}: endpoint returned ${res.status} — deferring this lead.`
      );
      return null;
    }

    const body = await res.json();
    const bullets = Array.isArray(body && body.bullets)
      ? body.bullets.filter((b) => typeof b === 'string' && b.trim()).map((b) => b.trim())
      : [];

    if (bullets.length < MIN_BULLETS) {
      console.warn(
        `[tailoring] ${lead.email_lc}: ${bullets.length} usable bullet(s), need ${MIN_BULLETS} — ` +
          'deferring rather than sending a thinner email than the one this replaced.'
      );
      return null;
    }

    return bullets.slice(0, MAX_BULLETS);
  } catch (err) {
    // AbortError included: a timeout is a deferral like any other failure.
    const reason = err && err.name === 'AbortError' ? `timed out after ${TAILORING_TIMEOUT_MS}ms` : err.message;
    console.warn(`[tailoring] ${lead.email_lc}: ${reason} — deferring this lead.`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  fetchTailoredBullets,
  tailoringConfigured,
  TAILORING_TIMEOUT_MS,
  MIN_BULLETS,
  MAX_BULLETS,
};
