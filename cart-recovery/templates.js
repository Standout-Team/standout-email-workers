/**
 * templates.js — Brevo template source for the six cart-recovery emails.
 *
 * Copy is the approved plan (Standout Abandon-Cart Email Plan, v2). Testimonials
 * and stats are verified. Brevo syntax: {{ params.X }}, {% if %}…{% endif %},
 * {{ unsubscribe }} for the one-click unsubscribe link (Brevo records it, the
 * app's Brevo webhook writes marketing_suppressions).
 *
 * scripts/create-brevo-templates.js creates these as INACTIVE templates and
 * prints the ids for BREVO_TEMPLATE_ID_CR_E1..E6.
 */

const LOGO = 'https://www.usestandout.today/brand/standout-lockup-dark.png';
const INK = '#0A2716';
const GREEN = '#0B3D2E';
const MUTED = '#5B6B62';
const BG = '#F3EDE0';

const hi = `<p style="margin:0 0 16px">Hi {{ params.FIRSTNAME | default : "there" }},</p>`;
const p = (t) => `<p style="margin:0 0 16px">${t}</p>`;
const h1 = (t) =>
  `<h1 style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:30px;line-height:1.15;color:${INK}">${t}</h1>`;
const h2 = (t) => `<p style="margin:24px 0 8px;font-weight:700">${t}</p>`;
const ul = (items) =>
  `<ul style="margin:0 0 16px;padding-left:20px">${items.map((i) => `<li style="margin:0 0 6px">${i}</li>`).join('')}</ul>`;
const ol = (items) =>
  `<ol style="margin:0 0 16px;padding-left:20px">${items.map((i) => `<li style="margin:0 0 8px">${i}</li>`).join('')}</ol>`;
const quote = (text, who) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td style="border-left:3px solid ${GREEN};padding:4px 0 4px 16px;font-style:italic">&ldquo;${text}&rdquo;<br><span style="font-style:normal;color:${MUTED};font-size:14px">${who}</span></td></tr></table>`;
const cta = (label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="background:${GREEN};border-radius:999px"><a href="{{ params.OFFER_URL }}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-weight:700;text-decoration:none;font-size:16px">${label}</a></td></tr></table>`;
const sub = (t) => `<p style="margin:0 0 8px;font-size:12px;color:${MUTED}">${t}</p>`;
const sign = p('The Standout team');

function layout({ preview, body }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Standout</title></head>
<body style="margin:0;padding:0;background:${BG}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preview}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px">
<tr><td style="padding:28px 32px 8px"><img src="${LOGO}" width="140" alt="Standout" style="display:block;border:0;height:auto"></td></tr>
<tr><td style="padding:8px 32px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:${INK}">
${body}
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px"><tr><td style="padding:16px 32px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:${MUTED};text-align:center">
You're getting this because you uploaded your resume to Standout and opted in to emails.<br>
<a href="{{ unsubscribe }}" style="color:${MUTED}">Unsubscribe</a>
</td></tr></table>
</td></tr></table>
</body></html>`;
}

const TEMPLATES = [
  {
    n: 1,
    name: 'CR v2 E1: the offer ($10 month 1)',
    subject: "Your resume's in. Start Standout for $10.",
    altSubject: '75% off your first month is waiting',
    preview: "You're one step away. We took 75% off your first month.",
    body: [
      hi,
      p("Your resume is uploaded and your matches are ready. You're one step away from putting Standout to work, and we've taken 75% off your first month."),
      h2("Here's what you get:"),
      ul([
        'Daily matches from 500k+ open roles, each with the reason it fits',
        'A tailored, ATS-clean resume for every role',
        'Cover letters that sound like you wrote them',
        'Applications completed in about 60 seconds, with your approval before every send',
        'Every recruiter reply tracked in one inbox',
      ]),
      p('<strong>$10 for your first month</strong> instead of $40. Cancel anytime.'),
      p('Offer ends {{ params.DEADLINE }}.'),
      cta('Get my first month for $10'),
      sign,
      sub('Renews at $40/month after your first month unless you cancel.'),
    ],
  },
  {
    n: 2,
    name: 'CR v2 E2: how it works',
    subject: "Here's how Standout works",
    altSubject: 'From resume to submitted in 60 seconds',
    preview: 'Set your goals once. Standout does the repetitive part.',
    body: [
      h1('Welcome to Standout'),
      p('Most of a job search is repeat work. You edit the same resume and fill out the same forms for every role. Standout does that part for you.'),
      h2('How it works'),
      ol([
        '<strong>Set your goals once.</strong> Roles, locations, level, work authorization, pay floor.',
        '<strong>Get ranked matches.</strong> Every role is scored, with an explanation of why it was picked.',
        '<strong>Approve and apply.</strong> Standout tailors your resume, writes the cover letter, and fills out the application on 200+ platforms, from Greenhouse to Workday.',
      ]),
      p('The average application takes 60 seconds from resume to submit.'),
      p('<strong>$10 for your first month</strong> (75% off), then $40/month. Cancel anytime. Ends {{ params.DEADLINE }}.'),
      cta('Start for $10'),
      sub('Renews at $40/month after your first month unless you cancel.'),
    ],
  },
  {
    n: 3,
    name: 'CR v2 E3: objections',
    subject: "Still on the fence? Here's the low-risk version",
    preview: 'You stay in control of every application.',
    body: [
      hi,
      p("Not sure yet if it's worth it? Here's what changes when Standout handles your applications."),
      h2('Does any of this sound familiar?'),
      ul([
        '<strong>Sending the same resume everywhere?</strong> Standout tailors one for every role, with no keyword stuffing. Users see a 3.2x higher recruiter reply rate than with spray-and-pray applying.',
        '<strong>Not sure which jobs are worth your time?</strong> Every match is scored and explained, so you can see where you rank.',
        '<strong>Losing evenings to Workday forms?</strong> Standout fills them out for you.',
        '<strong>Worried about a bot applying to the wrong jobs?</strong> Nothing is submitted until you approve it.',
      ]),
      p("<strong>Why it's low-risk:</strong> It's month-to-month. You approve every application. Cancel anytime.{% if params.FREE_APPLY_UNUSED %} And your first application is still free.{% endif %}"),
      p('<strong>$10 for your first month</strong> instead of $40. About a day left: ends {{ params.DEADLINE }}.'),
      cta('Get my first month for $10'),
      sign,
      sub('Renews at $40/month after your first month unless you cancel.'),
    ],
  },
  {
    n: 4,
    name: 'CR v2 E4: one step left',
    subject: "You're one step away",
    altSubject: 'You already did the hard part',
    preview: "Your resume's in. Your first month is $10.",
    body: [
      h1('One step left'),
      p("You uploaded your resume and told us what you're looking for. That was the hard part."),
      p("All that's left is picking your plan."),
      quote(
        'The match scores are the thing. I stopped second-guessing whether I was wasting my time on a role I had no shot at.',
        'Jordan W., new grad software engineer, now at Notion'
      ),
      p('<strong>$10 for your first month</strong>, then $40/month. Cancel anytime. Offer ends tomorrow night, {{ params.DEADLINE }}.'),
      cta('Start for $10'),
      sub('Renews at $40/month after your first month unless you cancel.'),
    ],
  },
  {
    n: 5,
    name: 'CR v2 E5: last call',
    subject: 'Your $10 first month ends tonight',
    altSubject: 'Last chance: 75% off ends at midnight',
    preview: "After 11:59 PM, it's back to regular pricing.",
    body: [
      h1('Last chance to save'),
      p('Your 75%-off offer ends <strong>tonight at 11:59 PM {{ params.TZ }}</strong>.'),
      p('Start Standout for <strong>$10 for your first month</strong> instead of $40. No long-term commitment. Cancel anytime.'),
      cta('Get my first month for $10'),
      quote(
        'Watching the agent fill the Workday form in real time was the moment I trusted it. The cover letter actually sounded like me.',
        'Priya R., staff engineer, now at Stripe'
      ),
      sub('Renews at $40/month after your first month unless you cancel.'),
    ],
  },
  {
    n: 6,
    name: 'CR v2 E6: 9 months free (Annual $40)',
    subject: 'Get 9 months of Standout free',
    altSubject: 'A full year of Standout for $40',
    preview: 'A full year of Standout for the price of one month.',
    body: [
      h1('Apply to the jobs that fit'),
      p('A lot of auto-apply tools send one resume to hundreds of listings. Standout sends fewer applications, only to jobs that fit, with a resume tailored to each one. Nothing goes out until you approve it.'),
      quote(
        "I'd been applying to 80 roles a week with the same resume. Standout cut that to 12 tailored ones, and I got three first-rounds in the first ten days.",
        'Maya P., senior PM, now at Ramp'
      ),
      p('<strong>Our biggest offer: 9 months free.</strong> A full year of Standout for <strong>$40</strong>, the same price as one regular month. That\'s 75% off the $160 Annual plan.'),
      p('Available for 48 hours, until {{ params.DEADLINE }}.'),
      cta('Get 9 months free'),
      p("This is the last offer you'll get from us for a while."),
      sign,
      sub('$40 for your first year, then renews at $160/year unless you cancel.'),
    ],
  },
].map((t) => ({ ...t, html: layout({ preview: t.preview, body: t.body.join('\n') }) }));

module.exports = { TEMPLATES, layout };
