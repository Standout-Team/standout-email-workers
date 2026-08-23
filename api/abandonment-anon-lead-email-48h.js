// Vercel serverless entry point for the 48h email (stage `day2`).
// See the 24h entrypoint for why each stage gets its own file.
module.exports = require('../abandonment-anon-lead-email/index.js').createHandler('day2');
