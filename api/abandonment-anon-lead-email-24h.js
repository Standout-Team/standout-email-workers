// Vercel serverless entry point for the 24h email (stage `day1`).
//
// A separate file per stage, rather than one path taking ?stage=, because a
// Vercel cron entry carries only a path and a schedule — there are no
// per-cron environment variables, so three crons on one path would all run
// whatever EMAIL_STAGE happened to be set to. The stage is named here instead,
// where it cannot be misconfigured.
module.exports = require('../abandonment-anon-lead-email/index.js').createHandler('day1');
