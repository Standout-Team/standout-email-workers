/**
 * The offer emails' payload contract — stage `first` (4h) and stage `day3` (72h).
 *
 * The sequence carries two discounts, and they are NOT the same shape:
 *
 *   `first` (4h)  75% off the FIRST MONTH of Pro Monthly — $10 for month one,
 *                 renewing at $40/mo. It lands on `/your-match`, the same
 *                 token-bearing page the rest of the sequence uses, so the
 *                 offer link carries the lead token AND `offer=monthly75`,
 *                 which is the flag the main app reads to render the offer.
 *   `day3` (72h)  75% off the FIRST YEAR of the annual plan — it lands on
 *                 `/comeback`, a cold page that consumes no token.
 *
 * Each number is one figure in three places: the email advertises it, the
 * landing page renders prices from it, Stripe charges it. What is asserted
 * here is that the worker states no figure of its own — every OFFER_* param
 * comes off the stage — and that a stage without an offer sends none of the
 * params at all, since a template referencing an absent OFFER_PERCENT would
 * render an empty discount.
 *
 * buildPayload is pure apart from the two env vars it reads, so this suite
 * needs no stubs — unlike stage-drive.test.js, nothing here reaches Supabase,
 * Brevo or KV.
 *
 *   node --test            (from the repo root or this directory)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('./index');
const { EMAIL_STAGES, STAGE_ORDER } = require('./stages');

const { buildPayload, appBaseUrl } = _internals;

const LEAD = { email: 'Lead@Example.com', email_lc: 'lead@example.com', name: 'Jordan Reyes' };
const JOB = {
  id: 5150,
  title: 'Account Executive',
  company: 'examplecorp',
  location: 'Austin, TX',
  work_type: 'remote',
  first_seen_at: new Date().toISOString(),
};
const REASONS = ['reason one', 'reason two', 'reason three'];
const LINKS = {
  token: 'stub-token',
  jobUrl: 'https://app.example.com/your-match?t=stub-token',
  matchesUrl: 'https://app.example.com/your-match?t=stub-token&next=matches',
};

const GUARDED_ENV = [
  'STANDOUT_APP_URL',
  'BREVO_TEMPLATE_ID_ANON_LEAD',
  'BREVO_TEMPLATE_ID_ANON_LEAD_72H',
];
let saved;

test.beforeEach(() => {
  saved = Object.fromEntries(GUARDED_ENV.map((k) => [k, process.env[k]]));
  process.env.STANDOUT_APP_URL = 'https://app.example.com';
});

test.afterEach(() => {
  for (const key of GUARDED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const payloadFor = (stage) => buildPayload(LEAD, JOB, 91, REASONS, LINKS, stage, null);

// --- The 4h monthly offer (stage `first`) ----------------------------------

test('first sends the whole monthly-offer param set', () => {
  const { params } = payloadFor(EMAIL_STAGES.first);

  assert.equal(params.OFFER_PERCENT, 75);
  assert.equal(params.OFFER_FIRST_PRICE, '$10');
  assert.equal(params.OFFER_RENEWAL_PRICE, '$40/mo');
});

test('the 4h offer URL is the exact contract the main app reads', () => {
  // Byte-for-byte, because the other half of this contract is being built in
  // Standout-pro against the same string. Param order is part of it only
  // insofar as it is what the worker actually produces; `t` and `offer` are
  // what the app parses.
  const { params } = payloadFor(EMAIL_STAGES.first);

  assert.equal(
    params.OFFER_URL,
    'https://app.example.com/your-match?t=stub-token&offer=monthly75' +
      '&utm_source=brevo&utm_medium=email&utm_campaign=abandonment_4h_offer&utm_content=first'
  );
});

test('the 4h offer URL is TOKENIZED — unlike the 72h one', () => {
  // This is the structural difference between the two offers. /your-match
  // cannot restore the lead's survey + resume without the token, so an offer
  // click that dropped it would land the warmest cohort in the sequence on a
  // cold page.
  const { params } = payloadFor(EMAIL_STAGES.first);
  const query = new URL(params.OFFER_URL).searchParams;
  assert.equal(query.get('t'), LINKS.token, "the offer link carries the run's own lead token");
  assert.ok(params.OFFER_URL.includes('t='), 'and it is literally spelled `t=` in the URL');
});

test('the 4h offer URL carries the flag the main app switches on', () => {
  const { params } = payloadFor(EMAIL_STAGES.first);
  assert.ok(params.OFFER_URL.includes('offer=monthly75'));
  assert.ok(
    params.OFFER_URL.includes(`offer=${EMAIL_STAGES.first.offer.param}`),
    'read off the stage, not written twice'
  );
});

test('the 4h offer URL carries its own campaign and content', () => {
  const { params } = payloadFor(EMAIL_STAGES.first);
  assert.ok(params.OFFER_URL.includes('utm_campaign=abandonment_4h_offer'));
  assert.ok(params.OFFER_URL.includes('utm_content=first'));
  assert.ok(!params.OFFER_URL.includes('utm_campaign=anon_lead&'), 'the shared campaign is gone');
});

test('the advertised monthly figures are the stage offer, not second literals', () => {
  // The one place this worker states the percent and the two prices. Reading
  // them from the stage is what keeps them equal to the main app's lead-offer
  // constants and to what Stripe charges.
  const { params } = payloadFor(EMAIL_STAGES.first);
  const { offer } = EMAIL_STAGES.first;
  assert.equal(params.OFFER_PERCENT, offer.percent);
  assert.equal(params.OFFER_FIRST_PRICE, offer.firstTermPrice);
  assert.equal(params.OFFER_RENEWAL_PRICE, offer.renewalPrice);
});

test('the token-bearing match links survive alongside the 4h offer', () => {
  // The 4h template keeps the "we found the best job for you" value prop, so
  // the match CTAs are still in the payload beside the offer.
  const { params } = payloadFor(EMAIL_STAGES.first);
  assert.equal(params.JOB_URL, LINKS.jobUrl);
  assert.equal(params.MATCHES_URL, LINKS.matchesUrl);
});

// --- The 72h annual offer (stage `day3`), unchanged ------------------------

test('day3 still carries the offer percent and a /comeback URL', () => {
  const { params } = payloadFor(EMAIL_STAGES.day3);

  assert.equal(params.OFFER_PERCENT, 75);
  assert.equal(
    params.OFFER_URL,
    'https://app.example.com/comeback?utm_source=brevo&utm_medium=email' +
      '&utm_campaign=abandonment_72h&utm_content=day3'
  );
});

test('day3 keeps the campaign that separates it from the retargeting ads', () => {
  // Both this email and the paid ads land on the same `retarget_offer`
  // checkout source, so Stripe-side they look alike. `abandonment_72h` — which
  // no ad uses — is what keeps email traffic separable in analytics, and it
  // must not drift. `utm_content` was added alongside it (2026-09-09) so both
  // offers report the same way; it is additive and nothing parses it.
  const { params } = payloadFor(EMAIL_STAGES.day3);
  assert.ok(params.OFFER_URL.includes('utm_campaign=abandonment_72h'));
});

test('day3 states no prices, so it sends no price params', () => {
  // The annual figures ($40 year one, renewing at the $160 sticker) are the
  // template's copy, not the worker's. The "no param unless the stage has
  // one" rule is per param, not per block.
  const { params } = payloadFor(EMAIL_STAGES.day3);
  assert.ok(!('OFFER_FIRST_PRICE' in params), 'must omit the key, not send it empty');
  assert.ok(!('OFFER_RENEWAL_PRICE' in params));
});

test('the 72h offer URL carries no lead token', () => {
  // /comeback does not consume one — it is a cold page, and the lead's
  // restored context comes from the account-claim path after checkout.
  // Signing a token into it would leak a credential into a link that cannot
  // use it. The contrast with the 4h link above is deliberate.
  //
  // Asserted by parsing rather than substring-matching: `utm_content=day3`
  // contains the literal "t=", which is exactly the sort of thing a loose
  // check gets wrong.
  const { params } = payloadFor(EMAIL_STAGES.day3);
  const query = new URL(params.OFFER_URL).searchParams;
  assert.ok(!query.has('t'), 'no token param');
  assert.ok(!params.OFFER_URL.includes(LINKS.token), 'and not the token value either');
});

test('the token-bearing links survive alongside the 72h offer', () => {
  // The template keeps a secondary "see your match" CTA, so day3 sends both.
  const { params } = payloadFor(EMAIL_STAGES.day3);
  assert.equal(params.JOB_URL, LINKS.jobUrl);
  assert.equal(params.MATCHES_URL, LINKS.matchesUrl);
});

// --- The stages that carry no offer ----------------------------------------

test('day1 sends no OFFER_* params at all — it keeps the free apply', () => {
  // The 24h email is unchanged by the 4h cut-over. A stray OFFER_PERCENT here
  // would advertise a discount its template has no copy for.
  const { params } = payloadFor(EMAIL_STAGES.day1);
  for (const key of ['OFFER_PERCENT', 'OFFER_URL', 'OFFER_FIRST_PRICE', 'OFFER_RENEWAL_PRICE']) {
    assert.ok(!(key in params), `day1 must omit ${key}, not send it empty`);
  }
});

test('day2 sends no OFFER_* params either', () => {
  const { params } = payloadFor(EMAIL_STAGES.day2);
  for (const key of ['OFFER_PERCENT', 'OFFER_URL', 'OFFER_FIRST_PRICE', 'OFFER_RENEWAL_PRICE']) {
    assert.ok(!(key in params), `day2 must omit ${key}`);
  }
});

test('exactly two stages in the sequence carry an offer', () => {
  const offering = STAGE_ORDER.filter((id) => 'OFFER_URL' in payloadFor(EMAIL_STAGES[id]).params);
  assert.deepEqual(offering, ['first', 'day3']);
});

test('an un-passed stage is stage `first`, so it carries the monthly offer', () => {
  // The default resolves to the same stage it always did; what that stage
  // sends is what changed.
  const { params } = buildPayload(LEAD, JOB, 91, REASONS, LINKS, undefined, null);
  assert.equal(params.OFFER_PERCENT, 75);
  assert.ok(params.OFFER_URL.includes('offer=monthly75'));
});

// --- The app base the URLs are built from ----------------------------------

test('both offer URLs are built from the same app base as the token links', () => {
  process.env.STANDOUT_APP_URL = 'https://www.usestandout.today';
  assert.ok(
    payloadFor(EMAIL_STAGES.first).params.OFFER_URL.startsWith(
      'https://www.usestandout.today/your-match?'
    )
  );
  assert.ok(
    payloadFor(EMAIL_STAGES.day3).params.OFFER_URL.startsWith(
      'https://www.usestandout.today/comeback?'
    )
  );
});

test('a trailing slash or stray whitespace cannot produce a double-slash URL', () => {
  for (const raw of ['https://app.example.com/', 'https://app.example.com//', '  https://app.example.com  ']) {
    process.env.STANDOUT_APP_URL = raw;
    for (const [id, path] of [['first', '/your-match'], ['day3', '/comeback']]) {
      const { params } = payloadFor(EMAIL_STAGES[id]);
      assert.ok(
        params.OFFER_URL.startsWith(`https://app.example.com${path}?`),
        `${JSON.stringify(raw)} produced ${params.OFFER_URL}`
      );
    }
  }
});

test('an unset STANDOUT_APP_URL falls back to the production origin', () => {
  delete process.env.STANDOUT_APP_URL;
  assert.equal(appBaseUrl(), 'https://www.usestandout.today');
  assert.ok(
    payloadFor(EMAIL_STAGES.day3).params.OFFER_URL.startsWith('https://www.usestandout.today/comeback?')
  );
  assert.ok(
    payloadFor(EMAIL_STAGES.first).params.OFFER_URL.startsWith('https://www.usestandout.today/your-match?')
  );
});

// --- Template selection ----------------------------------------------------

test("day3 resolves its own Brevo template, never a sibling stage's", () => {
  process.env.BREVO_TEMPLATE_ID_ANON_LEAD_72H = '45';
  assert.equal(payloadFor(EMAIL_STAGES.day3).templateId, 45);

  delete process.env.BREVO_TEMPLATE_ID_ANON_LEAD_72H;
  assert.equal(
    payloadFor(EMAIL_STAGES.day3).templateId,
    null,
    'a real run refuses at this point rather than sending the wrong copy'
  );
});

test('first resolves BREVO_TEMPLATE_ID_ANON_LEAD — now the 4h offer template', () => {
  // The env var did not move; the template behind it did. 39 is the retired
  // 1h free-apply email and must not be what this points at after the deploy.
  process.env.BREVO_TEMPLATE_ID_ANON_LEAD = '46';
  assert.equal(payloadFor(EMAIL_STAGES.first).templateId, 46);

  delete process.env.BREVO_TEMPLATE_ID_ANON_LEAD;
  assert.equal(payloadFor(EMAIL_STAGES.first).templateId, null);
});

// --- Per-stage UTMs on every CTA -------------------------------------------
//
// Until 2026-09-09 all four stages shared one `anon_lead` campaign, so the
// sequence reported as one undifferentiated blob and only the 72h OFFER_URL
// was separable. Two stages now sell different things.

test('buildLinks gives each stage its own campaign and stamps its id as content', () => {
  const saved = process.env.EMAIL_LINK_SECRET;
  process.env.EMAIL_LINK_SECRET = 'test-secret';
  try {
    const expected = {
      first: 'abandonment_4h_offer',
      day1: 'anon_lead_24h',
      day2: 'anon_lead_48h',
      day3: 'abandonment_72h',
    };
    for (const id of STAGE_ORDER) {
      const links = _internals.buildLinks({ survey_id: 7 }, JOB, EMAIL_STAGES[id]);
      for (const url of [links.jobUrl, links.matchesUrl]) {
        assert.ok(url.includes(`utm_campaign=${expected[id]}`), `${id}: ${url}`);
        assert.ok(url.includes(`utm_content=${id}`), `${id}: ${url}`);
        assert.ok(!url.includes('utm_campaign=anon_lead&'), `${id} must not use the old campaign`);
        assert.ok(url.includes('utm_source=brevo&utm_medium=email'), 'source/medium are shared');
      }
      assert.ok(links.matchesUrl.endsWith('&next=matches'), 'next= stays last');
    }
  } finally {
    if (saved === undefined) delete process.env.EMAIL_LINK_SECRET;
    else process.env.EMAIL_LINK_SECRET = saved;
  }
});

test('utmFor falls back to the pre-2026-09-09 campaign for an unmapped stage', () => {
  // A new stage should show up as unattributed-but-present in analytics rather
  // than emitting links with no campaign at all.
  const utm = _internals.utmFor({ id: 'day9' });
  assert.equal(utm.utm_campaign, 'anon_lead');
  assert.equal(utm.utm_content, 'day9');
});

test('every stage in the sequence has a campaign of its own', () => {
  const campaigns = STAGE_ORDER.map((id) => _internals.utmFor(EMAIL_STAGES[id]).utm_campaign);
  assert.equal(new Set(campaigns).size, campaigns.length, 'two stages sharing one is unreportable');
  assert.ok(!campaigns.includes('anon_lead'), 'nothing may still be on the shared fallback');
});
