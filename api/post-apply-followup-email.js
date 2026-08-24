// Vercel serverless entry point. The cron in vercel.json hits this path hourly.
module.exports = require('../post-apply-followup-email/index.js');
