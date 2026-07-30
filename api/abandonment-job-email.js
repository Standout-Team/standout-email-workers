/**
 * Vercel serverless entry point for Email 1. The cron in vercel.json hits this
 * path hourly at :00 with `Authorization: Bearer $CRON_SECRET`.
 *
 * This used to be `module.exports = require('../abandonment-job-email/index.js')`
 * with no method check and no auth — a world-callable endpoint that drove live
 * Brevo sends and Anthropic spend for anyone who guessed the path.
 */

const { requireCronAuth } = require('../lib/cron-auth');
const { run } = require('../abandonment-job-email/index.js');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!requireCronAuth(req, res)) return; // 401/500 already sent

  try {
    const result = await run();
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    // Real error to the logs; a generic string to the caller. err.message here
    // leaks table names, column names and env-var names to the public internet.
    console.error('[api/abandonment-job-email] Unhandled error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
};
