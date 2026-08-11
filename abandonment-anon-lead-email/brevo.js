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

// payload: { templateId, to: [{ email, name }], params: {...} }
// The caller owns the template id; the env var is only the fallback so a stray
// send can't silently go out on another worker's template.
async function sendJobEmail(payload) {
  const templateId = Number(payload.templateId ?? process.env.BREVO_TEMPLATE_ID_ANON_LEAD);
  if (!Number.isFinite(templateId) || templateId <= 0) {
    throw new Error(
      'Missing Brevo template id — create the anon-lead template and set BREVO_TEMPLATE_ID_ANON_LEAD.'
    );
  }

  const api = getApi();
  const message = new brevo.SendSmtpEmail();
  message.templateId = templateId;
  message.to = payload.to;
  message.params = payload.params;

  const resp = await api.sendTransacEmail(message);
  const messageId = resp && resp.body ? resp.body.messageId : undefined;
  return messageId;
}

module.exports = { sendJobEmail };
