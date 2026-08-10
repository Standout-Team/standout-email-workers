const brevo = require('@getbrevo/brevo');

let _api = null;

function getApi() {
  if (_api) return _api;
  if (!process.env.BREVO_API_KEY) {
    throw new Error('Missing BREVO_API_KEY env var.');
  }
  const api = new brevo.TransactionalEmailsApi();
  api.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);
  _api = api;
  return _api;
}

// payload: { to: [{ email, name }], params: {...} }
async function sendJobEmail(payload) {
  const templateId = process.env.BREVO_TEMPLATE_ID;
  if (!templateId) {
    throw new Error('Missing BREVO_TEMPLATE_ID env var — create the template in Brevo and set its ID.');
  }

  const api = getApi();
  const message = new brevo.SendSmtpEmail();
  message.templateId = Number(templateId);
  message.to = payload.to;
  message.params = payload.params;

  const resp = await api.sendTransacEmail(message);
  const messageId = resp && resp.body ? resp.body.messageId : undefined;
  return messageId;
}

module.exports = { sendJobEmail };
