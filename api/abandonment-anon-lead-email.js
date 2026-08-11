// Vercel serverless entry point. The cron in vercel.json hits this path hourly.
module.exports = require('../abandonment-anon-lead-email/index.js');
