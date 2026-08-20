/**
 * Pure-function coverage for the geography filter: is a lead plausibly
 * US-based? No Supabase, no Brevo, no KV — isUsBasedLead takes a lead object
 * and returns a boolean.
 *
 * The interesting cases are not the obvious ones ("Mumbai, India" → false).
 * They are the collisions: country names that live inside US place names
 * ('india' in "Indiana", 'uk' in "Sauk Rapids") and country names that ARE US
 * place names ("Brazil, IN"; "Peru, IN"; "Santa Fe, New Mexico"). A substring
 * match gets all of those wrong and silently suppresses real US leads, so most
 * of this file is regression cover for them.
 *
 *   node --test            (from the repo root or this directory)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('./queries');

const {
  isUsBasedLead,
  NON_US_PHONE_PREFIXES,
  INTL_LOCATION_MARKERS,
  INTL_TAIL_ONLY_MARKERS,
  US_STATE_RE,
} = _internals;

// The shape leadFromSurvey builds, trimmed to what the filter reads.
const lead = (location, phone) => ({
  email_lc: 'lead@example.com',
  resume_parsed: { phone: phone || '', location: location || '' },
});

// --- Signal A: phone country code ----------------------------------------

test('isUsBasedLead: an Indian phone prefix (+91) drops the lead', () => {
  assert.equal(isUsBasedLead(lead('', '+91-9999999999')), false);
});

test('isUsBasedLead: a German phone prefix (+49) drops the lead', () => {
  assert.equal(isUsBasedLead(lead('Kaiserslautern, Germany', '+49 1523 1499323')), false);
});

test('isUsBasedLead: a 3-digit prefix (+971 UAE) drops the lead', () => {
  assert.equal(isUsBasedLead(lead('', '+971 50 123 4567')), false);
});

test('isUsBasedLead: separators inside the number do not hide the prefix', () => {
  assert.equal(isUsBasedLead(lead('', '+91 (987) 654-3210')), false, 'spaces, parens and dashes are stripped before the compare');
});

test('isUsBasedLead: a bracketed country code is still a signal', () => {
  // "(+90) 5301417879" — the '+' is checked after the separators are stripped,
  // so a leading paren cannot hide it.
  assert.equal(isUsBasedLead(lead('Istanbul', '(+90) 5301417879')), false);
});

test('isUsBasedLead: a digit-spaced country code is still a signal', () => {
  assert.equal(isUsBasedLead(lead('Istanbul', '+9 0 5 3 9 2 3 3 1 7 1 1')), false);
});

test('isUsBasedLead: a US number with separators is not a signal', () => {
  assert.equal(isUsBasedLead(lead('', '(555) 123-4567')), true, 'no leading + once stripped → not Signal A');
});

test('isUsBasedLead: the phone signal beats an ambiguous location', () => {
  assert.equal(isUsBasedLead(lead('Remote', '+55 11 91234-5678')), false);
});

test('isUsBasedLead: a number stored without "+" is not a signal', () => {
  // "48 531 399 985" is Polish, but a bare leading 48 is indistinguishable from
  // a US extension. No location either → fail open.
  assert.equal(isUsBasedLead(lead('', '48 531 399 985')), true);
});

test('isUsBasedLead: a +1 number is never an international signal', () => {
  // NANP covers the US and Canada; '+1' is deliberately not a prefix.
  assert.equal(isUsBasedLead(lead('Toronto, ON', '+1 416 555 0100')), true);
});

// --- Signal B: location, international markers ----------------------------

test('isUsBasedLead: country name in the location drops the lead', () => {
  assert.equal(isUsBasedLead(lead('Mumbai, India')), false);
});

test('isUsBasedLead: the country-name check is case-insensitive', () => {
  assert.equal(isUsBasedLead(lead('Navi Mumbai, INDIA')), false);
});

test('isUsBasedLead: a localised country name still drops ("Brasil")', () => {
  assert.equal(isUsBasedLead(lead('Taubaté, São Paulo, Brasil')), false);
});

test('isUsBasedLead: a bare country name with no city drops', () => {
  assert.equal(isUsBasedLead(lead('Egypt')), false, 'tail-only markers also match the whole string');
});

// --- Signal B: the Indian "City, State, IN" postal format ------------------

test('isUsBasedLead: "Rajkot, GJ, IN" is India, not Indiana', () => {
  assert.equal(isUsBasedLead(lead('Rajkot, GJ, IN')), false);
});

test('isUsBasedLead: "Pune, MH, IN" is India, not Indiana', () => {
  assert.equal(isUsBasedLead(lead('Pune, MH, IN')), false);
});

test('isUsBasedLead: "Columbus, IN" is a real Indiana town and is kept', () => {
  assert.equal(isUsBasedLead(lead('Columbus, IN')), true, 'one comma, so the two-comma India format cannot match');
});

test('isUsBasedLead: the India format is checked before the US city markers', () => {
  // Salem is a city in Tamil Nadu and also in Oregon/Massachusetts. In this
  // shape it is India, which is why the ordering matters.
  assert.equal(isUsBasedLead(lead('Salem, Tamil Nadu, IN')), false);
});

// --- Signal B: US markers -------------------------------------------------

test('isUsBasedLead: a US state abbreviation keeps the lead', () => {
  assert.equal(isUsBasedLead(lead('Austin, TX')), true);
});

test('isUsBasedLead: "United States" keeps the lead', () => {
  assert.equal(isUsBasedLead(lead('Remote — United States')), true);
});

// --- Collisions: country name INSIDE a US place name ----------------------
// Each of these is a real US lead that a bare substring match drops.

test('isUsBasedLead: "Hobart, Indiana" is not India', () => {
  assert.equal(isUsBasedLead(lead('Hobart, Indiana')), true, "'india' must not match inside 'Indiana'");
});

test('isUsBasedLead: "Indianapolis, IN" is not India', () => {
  assert.equal(isUsBasedLead(lead('Indianapolis, IN')), true);
});

test('isUsBasedLead: "Sauk Rapids, MN" is not the UK', () => {
  assert.equal(isUsBasedLead(lead('Sauk Rapids, MN')), true, "'uk' must not match inside 'Sauk'");
});

test('isUsBasedLead: "Kaukauna, Wisconsin" is not the UK', () => {
  assert.equal(isUsBasedLead(lead('Kaukauna, Wisconsin')), true);
});

test('isUsBasedLead: "Milwaukee, WI" is not the UK', () => {
  assert.equal(isUsBasedLead(lead('Milwaukee, WI')), true);
});

test('isUsBasedLead: "Wausau, WI" is not "USA" matching mid-word', () => {
  // Harmless direction (it is kept either way) but proves US_CITY_RE is bounded.
  assert.equal(isUsBasedLead(lead('Wausau, WI')), true);
});

test('isUsBasedLead: "Russiaville, IN" is not Russia', () => {
  assert.equal(isUsBasedLead(lead('Russiaville, IN')), true);
});

test('isUsBasedLead: a genuine ", UK" still drops', () => {
  assert.equal(isUsBasedLead(lead('Gloucestershire, UK')), false, 'the word-bounded marker must still do its job');
});

// --- Collisions: country name that IS a US place name ---------------------
// Word boundaries are not enough for these; they only count in the country
// position (final comma-segment, or the whole string).

test('isUsBasedLead: "Brazil, IN" is Indiana', () => {
  assert.equal(isUsBasedLead(lead('Brazil, IN')), true);
});

test('isUsBasedLead: "São Paulo, Brazil" still drops', () => {
  assert.equal(isUsBasedLead(lead('São Paulo, Brazil')), false);
});

test('isUsBasedLead: "Peru, IN" is Indiana', () => {
  assert.equal(isUsBasedLead(lead('Peru, IN')), true);
});

test('isUsBasedLead: "Lima, Peru" still drops', () => {
  assert.equal(isUsBasedLead(lead('Lima, Peru')), false);
});

test('isUsBasedLead: "Santa Fe, New Mexico" is New Mexico', () => {
  assert.equal(isUsBasedLead(lead('Santa Fe, New Mexico')), true, "'mexico' in the tail must not eat 'New Mexico'");
});

test('isUsBasedLead: "Guadalajara, Mexico" still drops', () => {
  assert.equal(isUsBasedLead(lead('Guadalajara, Mexico')), false);
});

test('isUsBasedLead: "China Grove, NC" is North Carolina', () => {
  assert.equal(isUsBasedLead(lead('China Grove, NC')), true);
});

test('isUsBasedLead: "Shanghai, China" still drops', () => {
  assert.equal(isUsBasedLead(lead('Shanghai, China')), false);
});

// --- Indian region names without the word "India" -------------------------
// The largest single leak the country-name check left open.

test('isUsBasedLead: "Chennai, Tamil Nadu" drops without the word India', () => {
  assert.equal(isUsBasedLead(lead('Chennai, Tamil Nadu')), false);
});

test('isUsBasedLead: "Pune, Maharashtra" drops without the word India', () => {
  assert.equal(isUsBasedLead(lead('Pune, Maharashtra')), false);
});

test('isUsBasedLead: "Hyderabad, Telangana" drops', () => {
  assert.equal(isUsBasedLead(lead('Hyderabad, Telangana')), false);
});

test('isUsBasedLead: the spaceless "hyderabad,telangana" still drops', () => {
  assert.equal(isUsBasedLead(lead('hyderabad,telangana')), false);
});

test('isUsBasedLead: "Bengaluru, Karnataka" drops', () => {
  assert.equal(isUsBasedLead(lead('Bengaluru, Karnataka')), false);
});

test('isUsBasedLead: "Gurugram, Haryana" drops', () => {
  assert.equal(isUsBasedLead(lead('Gurugram, Haryana')), false);
});

test('isUsBasedLead: "New Delhi" drops anywhere in the string', () => {
  assert.equal(isUsBasedLead(lead('Sangam Vihar, New Delhi, 110080')), false);
});

test('isUsBasedLead: bare "Delhi" in the country position drops', () => {
  assert.equal(isUsBasedLead(lead('C-20A Pandav Nagar, Delhi')), false);
});

test('isUsBasedLead: "Delhi, NY" is a real US town and is KEPT', () => {
  assert.equal(isUsBasedLead(lead('Delhi, NY')), true, "'delhi' is tail-only precisely for this");
});

// --- Spelled-out US state names -------------------------------------------

test('isUsBasedLead: "Cincinnati, Ohio" is a positive US signal', () => {
  assert.equal(isUsBasedLead(lead('Cincinnati, Ohio')), true);
});

test('isUsBasedLead: "Denton, Texas" is a positive US signal', () => {
  assert.equal(isUsBasedLead(lead('Denton, Texas')), true);
});

test('isUsBasedLead: "Aliso Viejo, California" is a positive US signal', () => {
  assert.equal(isUsBasedLead(lead('Aliso Viejo, California')), true);
});

test('isUsBasedLead: a spelled-out state does not override an intl marker', () => {
  // The international checks run first, so a resume naming both loses the
  // state — "Washington" here is the DC-area claim of someone in Bengaluru.
  assert.equal(isUsBasedLead(lead('Bengaluru, Karnataka / Washington')), false);
});

test('isUsBasedLead: "Tbilisi, Georgia" is KEPT — the fail-open bargain', () => {
  // The country Georgia is deliberately in no marker list, because no textual
  // rule separates it from Atlanta. Documented, accepted, asserted.
  assert.equal(isUsBasedLead(lead('Tbilisi, Georgia')), true);
});

// --- Canada: deliberately eligible (owner override 2026-08-20) ------------

test('isUsBasedLead: a Canadian lead with a country name is KEPT', () => {
  assert.equal(isUsBasedLead(lead('Toronto, ON, Canada')), true);
});

test('isUsBasedLead: a Canadian province code alone is KEPT', () => {
  assert.equal(isUsBasedLead(lead('Vancouver, BC')), true);
});

test('isUsBasedLead: "Montreal, QC, Canada" is KEPT', () => {
  assert.equal(isUsBasedLead(lead('Montreal, QC, Canada')), true);
});

test('isUsBasedLead: bare "Canada" is KEPT', () => {
  assert.equal(isUsBasedLead(lead('Canada')), true);
});

test('the Canada override is locked in as data, not just behaviour', () => {
  assert.ok(!INTL_LOCATION_MARKERS.includes('canada'), "'canada' must stay out of the anywhere-markers");
  assert.ok(!INTL_TAIL_ONLY_MARKERS.includes('canada'), "'canada' must stay out of the tail-only markers");
  assert.ok(!NON_US_PHONE_PREFIXES.has('+1'), "'+1' is the US AND Canada — it must never be a drop signal");
});

test('no Canadian province code is readable as a US state', () => {
  // Canadian leads must reach the fail-open branch, not a false US signal.
  for (const pc of ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']) {
    assert.equal(US_STATE_RE.test(`Somewhere, ${pc}`), false, `${pc} must not match US_STATE_RE`);
  }
});

// --- Fail-open ------------------------------------------------------------

test('isUsBasedLead: bare "Remote" fails open', () => {
  assert.equal(isUsBasedLead(lead('Remote')), true, 'unrecognised could be either — send rather than suppress a US lead');
});

test('isUsBasedLead: no phone and no location fails open', () => {
  assert.equal(isUsBasedLead(lead('', '')), true);
});

test('isUsBasedLead: a null resume_parsed fails open', () => {
  // Defensive only — leadFromSurvey cannot produce this — so it is called direct.
  assert.equal(isUsBasedLead({ email_lc: 'x@example.com', resume_parsed: null }), true);
});

test('isUsBasedLead: a non-object resume_parsed fails open', () => {
  assert.equal(isUsBasedLead({ email_lc: 'x@example.com', resume_parsed: 'not-an-object' }), true);
});

test('isUsBasedLead: a missing lead fails open rather than throwing', () => {
  assert.equal(isUsBasedLead({}), true);
});

// --- Purity ---------------------------------------------------------------

test('isUsBasedLead: is pure — same input, same answer, no mutation', () => {
  const l = lead('Mumbai, India', '+91-9999999999');
  const snapshot = JSON.parse(JSON.stringify(l));
  assert.equal(isUsBasedLead(l), false);
  assert.equal(isUsBasedLead(l), false);
  assert.deepEqual(l, snapshot, 'the lead must come back untouched');
});
