// Vercel serverless entry point — TEST VARIANT.
// Uses resume_uploaded_at as the eligibility trigger instead of created_at.
// Cron runs every 10 minutes for faster testing. Template #41 (copy of #39).
module.exports = require('../abandonment-job-email-resume-trigger/index.js');
