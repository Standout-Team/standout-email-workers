const Anthropic = require('@anthropic-ai/sdk');
const { sanitizeParam } = require('../lib/sanitize');

const MODEL = 'claude-haiku-4-5-20251001';

// The resume JSON is user-uploaded and unbounded — a 200-page PDF parses into a
// blob that would dominate the prompt (and the bill). 4k chars is plenty for
// three bullet points.
const MAX_RESUME_CHARS = 4000;
const MAX_DESCRIPTION_CHARS = 1000;
// Model output is untrusted (it is derived from a third-party job description
// plus a user-uploaded resume — both prompt-injection surfaces) and lands in
// email HTML. Cap each bullet hard.
const MAX_REASON_CHARS = 140;
// Interpolated job/role labels inside the deterministic fallbacks.
const MAX_LABEL_CHARS = 60;

let _client = null;

function getAnthropic() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Deterministic fallback derived from role/intent labels — no AI call.
// The interpolated values come from the jobs table (third-party ATS feeds), so
// they get sanitized even though no model was involved.
function fallbackReasons(job) {
  const j = job || {};
  const role = sanitizeParam(j.role_label || j.role_category || j.title || 'this role', MAX_LABEL_CHARS) || 'this role';
  const intent = sanitizeParam(j.intent_label || 'your current job search', MAX_LABEL_CHARS) || 'your current job search';
  const company = sanitizeParam(j.company || 'this company', MAX_LABEL_CHARS) || 'this company';
  return [
    `Your background lines up with ${role}, which is exactly the kind of work this position centres on.`,
    `The responsibilities here map closely to ${intent}, so the day-to-day would feel familiar from day one.`,
    `At ${company}, the experience on your resume gives you a head start on what they need most.`,
  ];
}

/**
 * Validate + sanitize model output down to exactly three usable bullets.
 * Anything that isn't a non-empty string after sanitization is dropped, and
 * the shortfall is filled from the deterministic fallbacks — so a model that
 * returns nulls, objects, or an injected "<script>…" payload degrades to
 * generic-but-safe copy rather than shipping it into the email.
 */
function coerceToThree(reasons, job) {
  const cleaned = [];
  for (const raw of Array.isArray(reasons) ? reasons : []) {
    if (typeof raw !== 'string') continue;
    const value = sanitizeParam(raw, MAX_REASON_CHARS);
    if (value) cleaned.push(value);
    if (cleaned.length === 3) break;
  }

  if (cleaned.length < 3) {
    const fb = fallbackReasons(job);
    while (cleaned.length < 3) cleaned.push(fb[cleaned.length]);
  }

  return cleaned.slice(0, 3);
}

async function generateMatchReasons(resumeParsed, job) {
  const client = getAnthropic();
  if (!client) {
    console.warn('[match-reason] ANTHROPIC_API_KEY not set — using fallback reasons.');
    return fallbackReasons(job);
  }

  const resumeBlob = JSON.stringify(resumeParsed == null ? {} : resumeParsed).slice(0, MAX_RESUME_CHARS);
  const description = (job.description || '').slice(0, MAX_DESCRIPTION_CHARS);
  const prompt =
    `Given this user's resume: ${resumeBlob}\n` +
    `And this job posting: ${job.title} at ${job.company} — ${description}\n\n` +
    `Write exactly 3 short, specific bullet points (1-2 sentences each) explaining why this person is a strong match for this role.\n` +
    `- Address the candidate directly using "you" and "your" — never refer to them in the third person\n` +
    `- Be specific to their actual experience, not generic\n` +
    `- Reference real things from their resume\n` +
    `- Connect their background to specific aspects of the job\n` +
    `- Do NOT use phrases like "strong match" or "perfect fit"\n` +
    `- Keep each bullet under ${MAX_REASON_CHARS} characters\n` +
    `- Format: plain text, no markdown, no bullet symbols (return as JSON array of 3 strings)`;

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const parsed = parseReasons(text);
    return coerceToThree(parsed, job);
  } catch (err) {
    console.error('[match-reason] AI generation failed, using fallback:', err.message);
    return fallbackReasons(job);
  }
}

function parseReasons(text) {
  if (!text) return null;
  // Direct JSON array.
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {
    /* fall through */
  }
  // JSON array embedded in surrounding prose.
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {
      /* fall through */
    }
  }
  return null;
}

module.exports = { generateMatchReasons, fallbackReasons, coerceToThree, MAX_REASON_CHARS };
