#!/usr/bin/env node
/**
 * Creates the six cart-recovery templates in Brevo as INACTIVE and prints the
 * env lines for BREVO_TEMPLATE_ID_CR_E1..E6. Activate them in Brevo (or via
 * PUT isActive=true) only when going live.
 *
 *   BREVO_API_KEY=… SENDER_EMAIL=… SENDER_NAME=Standout node cart-recovery/scripts/create-brevo-templates.js
 */
const { TEMPLATES } = require('../templates');

async function main() {
  const key = process.env.BREVO_API_KEY;
  const senderEmail = process.env.SENDER_EMAIL;
  if (!key || !senderEmail) throw new Error('BREVO_API_KEY and SENDER_EMAIL are required');
  for (const t of TEMPLATES) {
    const res = await fetch('https://api.brevo.com/v3/smtp/templates', {
      method: 'POST',
      headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        templateName: t.name,
        subject: t.subject,
        htmlContent: t.html,
        sender: { email: senderEmail, name: process.env.SENDER_NAME || 'Standout' },
        isActive: false,
        tag: 'cart_recovery_v2',
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`E${t.n}: ${res.status} ${JSON.stringify(body)}`);
    console.log(`BREVO_TEMPLATE_ID_CR_E${t.n}=${body.id}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
