// Vercel serverless entry point for the 72h offer email (stage `day3`) — the
// 75%-off-first-year comeback offer, which links to the product's /comeback
// page rather than the token-bearing /your-match landing page.
//
// A separate file per stage, rather than one path taking ?stage=, because a
// Vercel cron entry carries only a path and a schedule — there are no
// per-cron environment variables, so four crons on one path would all run
// whatever EMAIL_STAGE happened to be set to. The stage is named here instead,
// where it cannot be misconfigured.
module.exports = require('../abandonment-anon-lead-email/index.js').createHandler('day3');
