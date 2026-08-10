const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5-20251001';

let _client = null;

function getAnthropic() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Deterministic fallback derived from role/intent labels — no AI call.
function fallbackReasons(job) {
  const role = job.role_label || job.role_category || job.title || 'this role';
  const intent = job.intent_label || 'your current job search';
  return [
    `Your background lines up with ${role}, which is exactly the kind of work this position centres on.`,
    `The responsibilities here map closely to ${intent}, so the day-to-day would feel familiar from day one.`,
    `At ${job.company || 'this company'}, the experience on your resume gives you a head start on what they need most.`,
  ];
}

function coerceToThree(reasons, job) {
  const fb = fallbackReasons(job);
  const out = [];
  for (let i = 0; i < 3; i++) {
    const r = reasons && reasons[i];
    out.push(typeof r === 'string' && r.trim() ? r.trim() : fb[i]);
  }
  return out;
}

async function generateMatchReasons(resumeParsed, job) {
  const client = getAnthropic();
  if (!client) {
    console.warn('[match-reason] ANTHROPIC_API_KEY not set — using fallback reasons.');
    return fallbackReasons(job);
  }

  const description = (job.description || '').slice(0, 1000);
  const prompt =
    `Given this user's resume: ${JSON.stringify(resumeParsed)}\n` +
    `And this job posting: ${job.title} at ${job.company} — ${description}\n\n` +
    `Write exactly 3 short, specific bullet points (1-2 sentences each) explaining why this person is a strong match for this role.\n` +
    `- Address the candidate directly using "you" and "your" — never refer to them in the third person\n` +
    `- Be specific to their actual experience, not generic\n` +
    `- Reference real things from their resume\n` +
    `- Connect their background to specific aspects of the job\n` +
    `- Do NOT use phrases like "strong match" or "perfect fit"\n` +
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

module.exports = { generateMatchReasons, fallbackReasons };
