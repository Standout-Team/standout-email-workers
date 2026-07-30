/**
 * lib/cron-auth.js
 *
 * Both /api/* routes were world-callable. Anyone who guessed the path could
 * drive live Brevo sends, burn Anthropic tokens, and (before the Postgres
 * claim columns) re-send to every user in the window on every hit.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on every scheduled
 * invocation when CRON_SECRET is set in project settings. We require it.
 *
 * FAILS CLOSED: an unset CRON_SECRET is a 500, never an open door. A missing
 * env var must not silently republish the endpoint to the internet.
 */

function requireCronAuth(req, res) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    console.error('[cron-auth] CRON_SECRET is not set — refusing to run (fail closed).');
    res.status(500).json({ ok: false, error: 'Internal error' });
    return false;
  }

  const provided = req && req.headers ? req.headers.authorization : undefined;
  if (provided !== `Bearer ${secret}`) {
    console.error('[cron-auth] Rejected unauthenticated invocation.');
    res.status(401).json({ ok: false });
    return false;
  }

  return true;
}

module.exports = { requireCronAuth };
