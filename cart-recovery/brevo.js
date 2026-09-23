/**
 * brevo.js — one transactional send on a stage's template, tagged so Brevo
 * reporting can split the sequence by email.
 */
const brevo = require('@getbrevo/brevo');

let _api = null;
function getApi() {
  if (_api) return _api;
  if (!process.env.BREVO_API_KEY) throw new Error('Missing BREVO_API_KEY env var.');
  const api = new brevo.TransactionalEmailsApi();
  api.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);
  _api = api;
  return _api;
}

async function sendStageEmail({ templateId, to, params, tags }) {
  if (!Number.isFinite(templateId) || templateId <= 0) throw new Error('sendStageEmail: templateId required');
  const message = new brevo.SendSmtpEmail();
  message.templateId = templateId;
  message.to = to;
  message.params = params;
  if (tags && tags.length) message.tags = tags;
  const resp = await getApi().sendTransacEmail(message);
  return resp && resp.body ? resp.body.messageId : undefined;
}

module.exports = { sendStageEmail };
