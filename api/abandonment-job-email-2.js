/**
 * Vercel serverless entry point for Email 2. The cron in vercel.json hits this
 * path hourly at :30 (staggered off Email 1) with
 * `Authorization: Bearer $CRON_SECRET`.
 */

const { requireCronAuth } = require('../lib/cron-auth');
const { run } = require('../abandonment-job-email-2/index.js');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!requireCronAuth(req, res)) return; // 401/500 already sent

  try {
    const result = await run();
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[api/abandonment-job-email-2] Unhandled error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
};
