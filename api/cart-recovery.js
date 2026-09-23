// Vercel serverless entry point for the cart-recovery discount sequence.
// The hourly cron in vercel.json hits this path. See cart-recovery/index.js.
module.exports = require('../cart-recovery/index.js');
