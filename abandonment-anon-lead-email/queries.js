const { createClient } = require('@supabase/supabase-js');

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const FRESH_DAY_STEPS = [3, 7, 14, 30];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// Only a completed payment moves a lead into the pay-then-setup recovery flow
// that owns them. A `created` (started-but-unpaid) Stripe checkout is still an
// abandoner and gets this email exactly like every other abandoner — owner
// decision 2026-08-12.
const PAID_CHECKOUT_STATUSES = ['paid'];
// Per-email ilike counts are one request each; keep the fan-out polite.
const ILIKE_CHUNK = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Window / backfill configuration -------------------------------------
// Leads get one quiet hour before we mail them; that upper bound never moves,
// in either mode.
const SETTLE_MS = ONE_HOUR_MS;
// Normal mode looks back exactly one hour further, so the hourly cron considers
// every survey exactly once.
const NORMAL_LOOKBACK_MS = 2 * ONE_HOUR_MS;
const MIN_BACKFILL_DAYS = 1;
const MAX_BACKFILL_DAYS = 30;
// Backfill cohorts are large; bound the real sends per run so one invocation
// can't fire a fortnight of email at Brevo (or outrun the function timeout).
const DEFAULT_BACKFILL_SEND_CAP = 50;
// Belt-and-suspenders bound for the one non-durable path still allowed to send
// for real (a local drain, where the process outlives the run). Normal mode is
// otherwise uncapped, so a dedup slip there would mail the whole cohort.
const NON_DURABLE_SEND_CAP = 50;
// Strict: digits with an optional sign. "14.5", "14d" and "" are all invalid.
const INTEGER_RE = /^[+-]?\d+$/;

// --- Match fan-out bounds ---------------------------------------------------
// One match_jobs_for_survey call is an HNSW vector search, and a single lead can
// walk the whole FRESH_DAY_STEPS ladder — up to 4 of them, sequentially. Fanning
// the entire cohort out at once therefore put ~SEND_CAP concurrent vector
// searches on the database: the 18:00 UTC run on 2026-08-13 lost 44 of 50 leads
// to `canceling statement due to statement timeout` and sent 6 emails. The same
// Postgres serves the live app's /api/match, so bounding this is a production
// load rail, not only a throughput fix.
const MATCH_CONCURRENCY = 4;
const MIN_MATCH_CONCURRENCY = 1;
const MAX_MATCH_CONCURRENCY = 10;
// A bounded pool trades width for wall clock, and the platform kills the
// invocation at maxDuration (300s, set in vercel.json). Stop handing leads to
// the pool once the run has spent this much time and let the next hourly run
// take the rest — nothing is marked sent, so the KV dedup re-offers them.
const RUN_BUDGET_MS = 240000;
const MIN_RUN_BUDGET_MS = 30000;
const MAX_RUN_BUDGET_MS = 280000;
// A statement timeout is what an overloaded pgvector search returns, and it is
// transient. Retry that one step once, after a beat, then give up.
const MATCH_RETRY_DELAY_MS = 750;
// Postgres reports a cancelled statement as SQLSTATE 57014; PostgREST surfaces
// the text. Match either, case-insensitively.
const TIMEOUT_RE = /statement timeout|\b57014\b/i;
// PostgREST caps a single response; a 30-day backfill can exceed it, so page.
const SURVEY_PAGE_SIZE = 1000;
const MAX_SURVEY_PAGES = 25;

// --- Geography filter (US-only sends) ------------------------------------
// The featured job comes from US ATS boards, so a lead outside the US gets an
// email whose CTA cannot help them. That mismatch — not the copy — is what
// drives the unsubscribes, so the fix is to keep those leads out of the flow
// rather than to re-rank the job. Owner decision 2026-08-20.
//
// Two signals, in strict order: the resume's phone country code, then its
// location string. Both are advisory, and the whole filter FAILS OPEN — no
// signal, or a signal we do not recognise, keeps the lead. A wrongly dropped
// US lead costs a conversion; a wrongly kept international lead costs one
// email, so the asymmetry is deliberate.
//
// CANADA IS DELIBERATELY ELIGIBLE (owner override 2026-08-20, reversing the
// original spec's "most US ATS jobs require US work auth"). That is why
// 'canada' appears in neither marker list and '+1' appears in no prefix set:
// NANP covers the US and Canada alike. Canadian leads are kept by the
// fail-open branch rather than by a positive US signal — if anyone ever
// tightens fail-open, Canada breaks silently. Re-read this comment first.
const NON_US_PHONE_PREFIXES = new Set([
  '+7',   // Russia / Kazakhstan
  '+20',  // Egypt
  '+27',  // South Africa
  '+30',  // Greece
  '+31',  // Netherlands
  '+32',  // Belgium
  '+33',  // France
  '+34',  // Spain
  '+36',  // Hungary
  '+39',  // Italy
  '+40',  // Romania
  '+41',  // Switzerland
  '+43',  // Austria
  '+44',  // UK
  '+45',  // Denmark
  '+46',  // Sweden
  '+47',  // Norway
  '+48',  // Poland
  '+49',  // Germany
  '+51',  // Peru
  '+52',  // Mexico
  '+54',  // Argentina
  '+55',  // Brazil
  '+56',  // Chile
  '+57',  // Colombia
  '+58',  // Venezuela
  '+60',  // Malaysia
  '+61',  // Australia
  '+62',  // Indonesia
  '+63',  // Philippines
  '+64',  // New Zealand
  '+65',  // Singapore
  '+66',  // Thailand
  '+81',  // Japan
  '+82',  // South Korea
  '+84',  // Vietnam
  '+86',  // China
  '+90',  // Turkey
  '+91',  // India
  '+92',  // Pakistan
  '+94',  // Sri Lanka
  '+98',  // Iran
  '+212', // Morocco
  '+213', // Algeria
  '+216', // Tunisia
  '+220', // Gambia
  '+221', // Senegal
  '+225', // Ivory Coast
  '+233', // Ghana
  '+234', // Nigeria
  '+254', // Kenya
  '+256', // Uganda
  '+263', // Zimbabwe
  '+351', // Portugal
  '+353', // Ireland
  '+358', // Finland
  '+380', // Ukraine
  '+420', // Czech Republic
  '+421', // Slovakia
  '+880', // Bangladesh
  '+971', // UAE
  '+972', // Israel
  '+974', // Qatar
  '+977', // Nepal
]);

// Longest-first so a prefix can never be shadowed by a shorter one that is its
// own prefix. Defensive today — every entry returns the same verdict, so order
// cannot change the answer — and load-bearing the day anyone adds a NANP
// country code like '+1876'. Computed once at module load, never per call.
const NON_US_PHONE_PREFIXES_DESC = [...NON_US_PHONE_PREFIXES].sort((a, b) => b.length - a.length);

// Country names that mean "not US" ANYWHERE in the location string. Matched
// WORD-BOUNDED, not by substring: bare .includes() reads 'india' inside
// "Hobart, Indiana" and 'uk' inside "Sauk Rapids, MN" / "Kaukauna, Wisconsin",
// each of which silently suppressed a real US lead (3 in the 2,693-survey
// corpus measured 2026-08-20). 'canada' is deliberately absent — see above.
const INTL_LOCATION_MARKERS = [
  'india', 'brasil', 'germany', 'deutschland', 'france', 'spain', 'españa',
  'italia', 'portugal', 'netherlands', 'belgium', 'belgique', 'polska',
  'ukraine', 'russia', 'japan', 'korea', 'pakistan', 'bangladesh', 'nigeria',
  'kenya', 'ghana', 'australia', 'new zealand', 'singapore', 'malaysia',
  'indonesia', 'philippines', 'vietnam', 'thailand', 'colombia', 'argentina',
  'venezuela', 'ecuador', 'bolivia', 'paraguay', 'uruguay', 'uk',
  'united kingdom', 'ireland', 'sweden', 'finland', 'austria', 'czech',
  'romania', 'hungary', 'slovakia', 'israel', 'uae', 'united arab emirates',
  'saudi', 'qatar', 'kuwait', 'bahrain', 'iran', 'iraq', 'sri lanka', 'nepal',
  // Indian states and union territories. India is the single largest cohort
  // here, and a large share of those resumes give a city and a state but never
  // write "India" — "Chennai, Tamil Nadu", "Pune, Maharashtra". Measured
  // 2026-08-20: 44 such leads were still being mailed by the country-name
  // check alone. None of these names collides with a US place name.
  'andhra pradesh', 'arunachal', 'assam', 'bihar', 'chhattisgarh', 'goa',
  'gujarat', 'haryana', 'himachal', 'jharkhand', 'karnataka', 'kerala',
  'madhya pradesh', 'maharashtra', 'manipur', 'meghalaya', 'mizoram',
  'nagaland', 'odisha', 'punjab', 'rajasthan', 'sikkim', 'tamil nadu',
  'tamilnadu', 'telangana', 'tripura', 'uttar pradesh', 'uttarakhand',
  'west bengal', 'puducherry', 'chandigarh', 'new delhi',
];

// Country names that are ALSO the names of real US towns and regions: Brazil
// IN, Peru IN, Mexico MO, China Grove NC, Poland OH, Wales WI, Norway MI,
// Denmark SC, Holland MI, New England, Switzerland FL. A word boundary is not
// enough for these — "Brazil, IN" is word-bounded 'brazil' and is Indiana. So
// they only count in the COUNTRY position: the final comma-segment, or the
// whole string. "São Paulo, Brazil" drops; "Brazil, IN" falls through to the
// state regex and is kept.
const INTL_TAIL_ONLY_MARKERS = [
  'mexico', 'china', 'brazil', 'italy', 'egypt', 'poland', 'turkey', 'chile',
  'wales', 'scotland', 'norway', 'denmark', 'holland', 'england', 'peru',
  'switzerland',
  // Delhi NY and Delhi CA are real US towns, so bare 'delhi' only counts in the
  // country position ("Palam, Delhi"). "New Delhi" is unambiguous and is in the
  // anywhere-list above.
  'delhi',
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const INTL_LOCATION_RE = new RegExp(`\\b(?:${INTL_LOCATION_MARKERS.map(escapeRe).join('|')})\\b`, 'i');
// Final comma-segment, or the entire string ("Canada" / "Egypt" on their own).
const INTL_TAIL_RE = new RegExp(`(?:^|,)\\s*(?:${INTL_TAIL_ONLY_MARKERS.map(escapeRe).join('|')})\\.?\\s*$`, 'i');

// Indian postal format "City, State, IN", where IN is the ISO country code and
// not Indiana. TWO commas are required, so one-comma "Columbus, IN" — a real
// Indiana town — never matches. Runs BEFORE the US city markers on purpose:
// Salem is both an Indian city and a US one, and in this shape it is India.
// Accepted limitation: a US location written "Fort Wayne, Allen County, IN"
// has the same shape and is dropped. County-form locations are rare enough in
// parsed resumes to accept; the alternative is misreading every Indian address.
const INDIA_COUNTRY_CODE_RE = /,.+,\s+IN\s*$/i;

// Major US cities and country identifiers. Word-bounded for the same reason as
// above — bare 'usa' matches "Wausau, WI".
const US_CITY_MARKERS = [
  'united states', 'usa', 'u.s.a',
  'new york', 'los angeles', 'chicago', 'houston', 'phoenix', 'philadelphia',
  'san antonio', 'san diego', 'dallas', 'san jose', 'austin', 'jacksonville',
  'fort worth', 'columbus', 'charlotte', 'indianapolis', 'san francisco',
  'seattle', 'denver', 'nashville', 'boston', 'detroit', 'memphis', 'portland',
  'las vegas', 'louisville', 'baltimore', 'milwaukee', 'albuquerque', 'tucson',
  'fresno', 'sacramento', 'mesa', 'kansas city', 'atlanta', 'omaha', 'raleigh',
  'miami', 'minneapolis', 'cleveland', 'wichita', 'arlington', 'tampa',
];
const US_CITY_RE = new RegExp(`\\b(?:${US_CITY_MARKERS.map(escapeRe).join('|')})\\b`, 'i');

// Two-letter state code after a comma. Fires only AFTER the international
// checks, so the codes that double as country abbreviations (IN = Indiana and
// India) are already defused. Verified 2026-08-20: no Canadian province code
// (AB BC MB NB NL NS NT NU ON PE QC SK YT) collides with any entry here, so a
// Canadian location reaches the fail-open branch rather than being read as US.
const US_STATE_RE = /,\s+(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/i;

// The same 50 states spelled out. Plenty of resumes write "Cincinnati, Ohio"
// rather than "Cincinnati, OH", and without this they land on the fail-open
// branch — kept, but by luck rather than by signal (53 such leads on
// 2026-08-20). Runs AFTER every international check, which is what makes
// 'georgia' safe to include: the country Georgia is in no marker list, so
// "Tbilisi, Georgia" is kept by this line. That is the fail-open bargain
// working as designed, not a misread — the alternative drops Atlanta.
const US_STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine',
  'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'west virginia', 'wisconsin', 'wyoming',
];
const US_STATE_NAME_RE = new RegExp(`\\b(?:${US_STATE_NAMES.map(escapeRe).join('|')})\\b`, 'i');

let _client = null;

function getSupabase() {
  if (_client) return _client;
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.');
  }
  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  return _client;
}

/**
 * The survey `created_at` window, in both modes. Pure — takes the clock and the
 * env, returns bounds plus a `warning` string for the caller to log (never logs
 * itself, so it stays unit-testable and can't double-warn).
 *
 *   normal    [now − 2h, now − 1h]              (BACKFILL_DAYS unset/invalid)
 *   backfill  [now − BACKFILL_DAYS d, now − 1h] (1–30, clamped)
 *
 * The backfill window is a strict superset of the normal one — same upper
 * bound — so new abandoners keep being covered while a backfill drains.
 * Anything that isn't a plain integer ≥ 1 falls back to normal mode with a
 * warning; a value above the maximum is clamped rather than rejected.
 */
function computeWindow(nowMs, env = process.env) {
  const endMs = nowMs - SETTLE_MS;
  const normal = {
    mode: 'normal',
    backfillDays: null,
    startMs: nowMs - NORMAL_LOOKBACK_MS,
    endMs,
    warning: null,
  };
  const withIso = (win) => ({
    ...win,
    startIso: new Date(win.startMs).toISOString(),
    endIso: new Date(win.endMs).toISOString(),
  });

  const raw = env.BACKFILL_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return withIso(normal);

  const text = String(raw).trim();
  if (!INTEGER_RE.test(text)) {
    return withIso({
      ...normal,
      warning: `BACKFILL_DAYS="${text}" is not an integer — falling back to the normal 1–2h window.`,
    });
  }

  const requested = Number(text);
  if (requested < MIN_BACKFILL_DAYS) {
    return withIso({
      ...normal,
      warning:
        `BACKFILL_DAYS=${requested} is below the minimum of ${MIN_BACKFILL_DAYS} — ` +
        'falling back to the normal 1–2h window.',
    });
  }

  const days = Math.min(requested, MAX_BACKFILL_DAYS);
  return withIso({
    mode: 'backfill',
    backfillDays: days,
    startMs: nowMs - days * ONE_DAY_MS,
    endMs,
    warning:
      days === requested
        ? null
        : `BACKFILL_DAYS=${requested} exceeds the maximum of ${MAX_BACKFILL_DAYS} — clamped to ${days}.`,
  });
}

/**
 * Max real sends per run. Pure, same warning contract as computeWindow.
 * Explicit SEND_CAP wins in either mode; otherwise backfill runs get the
 * default cap and normal mode is uncapped (`null`) because hourly cohorts are
 * small. Anything that isn't a positive integer falls back to the default.
 */
function resolveSendCap(env = process.env, mode = 'normal') {
  const fallback = mode === 'backfill' ? DEFAULT_BACKFILL_SEND_CAP : null;
  const raw = env.SEND_CAP;
  if (raw === undefined || raw === null || String(raw).trim() === '') return { cap: fallback, warning: null };

  const text = String(raw).trim();
  if (!INTEGER_RE.test(text) || Number(text) < 1) {
    return {
      cap: fallback,
      warning:
        `SEND_CAP="${text}" is not a positive integer — using ` +
        `${fallback === null ? 'no cap' : `the default of ${fallback}`}.`,
    };
  }

  return { cap: Number(text), warning: null };
}

/**
 * How many match RPCs may be in flight at once. Pure, same warning contract as
 * resolveSendCap: takes an env object, returns a value plus a string for the
 * caller to log, never logs itself.
 *
 * Anything that isn't a positive integer falls back to the default; a value
 * above the ceiling is clamped rather than rejected (the same split
 * computeWindow makes for BACKFILL_DAYS). The ceiling exists because this fans
 * out onto the *production* database — the knob is there to turn the pressure
 * down during an incident, not up.
 */
function resolveMatchConcurrency(env = process.env) {
  const raw = env.MATCH_CONCURRENCY;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { concurrency: MATCH_CONCURRENCY, warning: null };
  }

  const text = String(raw).trim();
  if (!INTEGER_RE.test(text) || Number(text) < MIN_MATCH_CONCURRENCY) {
    return {
      concurrency: MATCH_CONCURRENCY,
      warning:
        `MATCH_CONCURRENCY="${text}" is not a positive integer — using the default of ` +
        `${MATCH_CONCURRENCY}.`,
    };
  }

  const requested = Number(text);
  if (requested > MAX_MATCH_CONCURRENCY) {
    return {
      concurrency: MAX_MATCH_CONCURRENCY,
      warning:
        `MATCH_CONCURRENCY=${requested} exceeds the maximum of ${MAX_MATCH_CONCURRENCY} — ` +
        `clamped to ${MAX_MATCH_CONCURRENCY}.`,
    };
  }

  return { concurrency: requested, warning: null };
}

/**
 * How long the match stage may keep scheduling leads, measured from the start of
 * run(). Pure, same warning contract as resolveSendCap.
 *
 * Not a positive integer → the default. In range → itself. Outside the sane
 * range → clamped to the nearer bound, with a warning: a budget under 30s can't
 * finish a useful slice of the cohort, and one over 280s races the platform's
 * own 300s kill, which is the failure this budget exists to prevent.
 */
function resolveRunBudgetMs(env = process.env) {
  const raw = env.RUN_BUDGET_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { budgetMs: RUN_BUDGET_MS, warning: null };
  }

  const text = String(raw).trim();
  if (!INTEGER_RE.test(text) || Number(text) < 1) {
    return {
      budgetMs: RUN_BUDGET_MS,
      warning:
        `RUN_BUDGET_MS="${text}" is not a positive integer — using the default of ` +
        `${RUN_BUDGET_MS}ms.`,
    };
  }

  const requested = Number(text);
  if (requested < MIN_RUN_BUDGET_MS) {
    return {
      budgetMs: MIN_RUN_BUDGET_MS,
      warning:
        `RUN_BUDGET_MS=${requested} is below the minimum of ${MIN_RUN_BUDGET_MS}ms — ` +
        `clamped to ${MIN_RUN_BUDGET_MS}.`,
    };
  }
  if (requested > MAX_RUN_BUDGET_MS) {
    return {
      budgetMs: MAX_RUN_BUDGET_MS,
      warning:
        `RUN_BUDGET_MS=${requested} exceeds the maximum of ${MAX_RUN_BUDGET_MS}ms — ` +
        `clamped to ${MAX_RUN_BUDGET_MS}.`,
    };
  }

  return { budgetMs: requested, warning: null };
}

/**
 * Multi-vector role matching — the `p_balance` argument to
 * match_jobs_for_survey. When a survey carries 2+ role categories the RPC
 * retrieves candidates once PER category and interleaves them, instead of a
 * single ANN from the survey vector that collapses into whichever field it
 * landed nearest. Surveys with 0 or 1 categories are identical either way.
 *
 * SOURCE OF TRUTH: `Standout-pro/server/lib/feature-flags.ts`
 * (`balancedRoleMatchEnabled`). This is a deliberate byte-for-byte twin of it —
 * trim, lowercase, compare against the literal "on" — and the two MUST be kept
 * in sync, in the code AND in the two Vercel projects' env. The app ranks the
 * in-app feed with this setting and this worker picks the emailed featured job
 * with it; if they disagree, a lead's email and their feed can name a different
 * top job (measured 2026-08-13: 5 of 6 recent multi-category surveys).
 *
 * Pure, same contract as the resolvers above: takes an env object, returns a
 * value, never logs. Unset is false — the single-vector path, which is what a
 * worker with no MATCH_ROLE_FANOUT set has always done.
 */
function balancedRoleMatchEnabled(env = process.env) {
  return String(env.MATCH_ROLE_FANOUT ?? '').trim().toLowerCase() === 'on';
}

/**
 * Map over `items` with at most `limit` calls to `fn` in flight at once.
 * Resolves to the results in INPUT ORDER — the pool is a scheduling detail, not
 * an ordering one.
 *
 * Pure in the sense the other helpers here are: no env, no network, no logging,
 * and the input array is read, never mutated or reordered.
 *
 * A rejected `fn` lands as `null` in its slot and the pool keeps going — one
 * lead's failure must not cancel the other 49, which mirrors what the per-lead
 * path already does by returning null. A caller that needs the error must catch
 * inside `fn` (findFeaturedJobs does, so it can log once and count it).
 *
 * Workers pull from a shared cursor rather than running fixed batches, so one
 * slow item never idles the rest of the pool behind a barrier.
 */
async function mapWithConcurrency(items, limit, fn) {
  const list = [...items];
  const results = new Array(list.length).fill(null);
  if (list.length === 0) return results;

  const requested = Math.trunc(Number(limit));
  const width = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 1, list.length);

  let cursor = 0;
  const worker = async () => {
    // Single-threaded read-then-increment: no two workers can claim one index.
    while (cursor < list.length) {
      const index = cursor++;
      try {
        results[index] = await fn(list[index], index);
      } catch (_) {
        results[index] = null;
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

/**
 * Did this error come from a cancelled statement? Pure. Accepts a Supabase
 * error object (code / message / details) or a bare string.
 */
function isTimeoutError(error) {
  if (!error) return false;
  if (typeof error === 'string') return TIMEOUT_RE.test(error);
  return TIMEOUT_RE.test(`${error.code || ''} ${error.message || ''} ${error.details || ''}`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is it safe to send with the dedup state we actually have? Pure — takes three
 * booleans the caller has already resolved and returns a decision plus the
 * reason to log or throw with. No env reads, no network, no logging.
 *
 *   durable                        → 'ok'    KV is configured; dedup survives cold starts.
 *   !durable, real send, on Vercel → 'throw' the dangerous one. Serverless resets the
 *                                            in-memory Set per instance and per cold
 *                                            start, so dedup is simply off — and normal
 *                                            mode is uncapped, so the whole cohort gets
 *                                            re-mailed every hour, silently.
 *   !durable, anything else        → 'warn'  a dry run anywhere, or a real send off
 *                                            Vercel (a local drain), where one process
 *                                            spans the run and the fallback is honest.
 *
 * `onVercel` must be `!!process.env.VERCEL`, which is set on production *and*
 * preview deployments — a preview carrying DRY_RUN=false and a real Brevo key
 * mails real people exactly as hard as production does.
 */
function evaluateDedupSafety({ durable, dryRun, onVercel }) {
  if (durable) {
    return {
      action: 'ok',
      reason: 'KV_REST_API_URL / KV_REST_API_TOKEN are set — send-once dedup is durable.',
    };
  }

  if (!dryRun && onVercel) {
    return {
      action: 'throw',
      reason:
        'KV_REST_API_URL / KV_REST_API_TOKEN are not set, so send-once dedup falls back to an ' +
        'in-memory Set that every serverless instance and cold start resets. Sending for real ' +
        'from a Vercel deployment in that state re-sends this marketing email to the same real ' +
        'people on every hourly run, with nothing in the logs to say so. Configure the KV ' +
        'binding on this project, or set DRY_RUN=true.',
    };
  }

  return {
    action: 'warn',
    reason:
      'KV_REST_API_URL / KV_REST_API_TOKEN are not set — send-once dedup is an in-memory Set, ' +
      'per-process only, so nothing this run records is visible to the next one. Sends are ' +
      `capped at ${NON_DURABLE_SEND_CAP} for this run, and a real send from a Vercel ` +
      'deployment will refuse to run until the KV binding is configured.',
  };
}

/**
 * The send cap actually used, given the dedup decision. Pure; `null` means
 * uncapped. Only the 'warn' path narrows it — to NON_DURABLE_SEND_CAP, or to
 * whatever the operator already asked for if that is lower.
 *
 * Applied in warn-mode dry runs too, so a dry run predicts what a real run in
 * that same environment would actually send.
 */
function capForDedupAction(cap, action) {
  if (action !== 'warn') return cap;
  if (cap === null || cap === undefined || !Number.isFinite(cap)) return NON_DURABLE_SEND_CAP;
  return Math.min(cap, NON_DURABLE_SEND_CAP);
}

/**
 * TARGET_EMAILS — the QA/support targeted-send list. Pure; same contract as the
 * other env helpers (takes an env object, returns a value, never logs).
 *
 * A comma-separated list, normalised to lowercase + trimmed, deduped, and
 * validated against the same EMAIL_RE the audience uses. Returns
 * `{ targets, invalid, active }`.
 *
 * Unset, empty, or whitespace-only is INACTIVE — the worker behaves exactly as
 * it does today, with zero change.
 *
 * Anything else is ACTIVE, including a value whose every entry is junk. That is
 * deliberate and fail-closed: an operator who fat-fingers `TARGET_EMAILS=qa@exampl`
 * gets a run that can mail nobody (targets is empty, so the candidate filter
 * keeps nothing) plus a loud warning — not a run that quietly mails the entire
 * real cohort because the typo read as "unset".
 */
function parseTargetEmails(env = process.env) {
  const raw = env.TARGET_EMAILS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { targets: [], invalid: [], active: false };
  }

  const targets = [];
  const invalid = [];
  const seen = new Set();

  for (const piece of String(raw).split(',')) {
    const entry = piece.trim();
    if (entry === '') continue; // a trailing or doubled comma is sloppiness, not a typo
    const emailLc = entry.toLowerCase();
    if (!EMAIL_RE.test(emailLc)) {
      invalid.push(entry);
      continue;
    }
    if (seen.has(emailLc)) continue;
    seen.add(emailLc);
    targets.push(emailLc);
  }

  return { targets, invalid, active: true };
}

/**
 * Narrow a candidate cohort to the targeted-send list. Pure; never mutates the
 * input and preserves the cohort's existing newest-first order.
 *
 * `missing` is the reason this returns three things instead of one: a target
 * that never reaches the send loop is the whole diagnostic question of a
 * targeted run, and the caller can only name it by diffing the ask against the
 * cohort.
 */
function filterToTargets(candidates, targets) {
  const wanted = new Set(targets);
  const selected = [];
  const dropped = [];

  for (const lead of candidates) {
    if (wanted.has(lead.email_lc)) selected.push(lead);
    else dropped.push(lead);
  }

  const found = new Set(selected.map((l) => l.email_lc));
  return { selected, dropped, missing: targets.filter((t) => !found.has(t)) };
}

// Newest abandoner first — freshest intent converts best, and it keeps paging
// stable (survey id breaks created_at ties).
function byCreatedAtDesc(a, b) {
  const ta = new Date(a.created_at).getTime() || 0;
  const tb = new Date(b.created_at).getTime() || 0;
  if (tb !== ta) return tb - ta;
  return String(b.survey_id ?? '').localeCompare(String(a.survey_id ?? ''));
}

/**
 * Order a cohort newest-first and take the run's slice. Pure; never mutates the
 * input. `cap` of null/undefined/Infinity means uncapped. Everything past the
 * cap is `deferred` — the next hourly run picks it up, and the persistent
 * sent-tracker keeps the already-mailed head out of that run's cohort.
 */
function selectForSend(candidates, cap) {
  const ordered = [...candidates].sort(byCreatedAtDesc);
  if (cap === null || cap === undefined || !Number.isFinite(cap)) {
    return { selected: ordered, deferred: 0 };
  }
  const take = Math.max(0, Math.min(Math.trunc(cap), ordered.length));
  return { selected: ordered.slice(0, take), deferred: ordered.length - take };
}

/**
 * surveys.resume_parsed is a JSON-encoded text blob written by the resume
 * parser. Some PDFs smuggle NULs through, which Postgres stores escaped and
 * JSON.parse then chokes on — strip both forms before parsing (the SQL twin
 * does regexp_replace(..., E'\\u0000', '', 'g')). Unparseable = no lead.
 */
function parseResume(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const cleaned = String(raw).replace(/\u0000/g, '').replace(/\\u0000/g, '');
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function leadFromSurvey(row) {
  const parsed = parseResume(row.resume_parsed);
  if (!parsed) return null;

  const email = typeof parsed.email === 'string' ? parsed.email.trim() : '';
  if (!EMAIL_RE.test(email)) return null; // implausible / missing — not a lead

  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';

  return {
    survey_id: row.id,
    session_id: row.session_id,
    email,
    email_lc: email.toLowerCase(),
    name,
    resume_parsed: parsed,
    created_at: row.created_at,
    marketing_opt_in_at: row.marketing_opt_in_at,
  };
}

// Consent recency: marketing_opt_in_at is the durable receipt, created_at the
// fallback for rows stamped before that column existed.
function optInTime(lead) {
  const stamp = lead.marketing_opt_in_at || lead.created_at;
  const t = stamp ? new Date(stamp).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

/**
 * Two-signal heuristic: is this lead plausibly US-based?
 *
 * Signal A — phone country code. Only a leading '+' is trusted; a bare
 *   "91-9999999999" proves nothing next to a US extension or an 800 number, so
 *   those fall through to Signal B. Any known non-US code is a hard drop.
 * Signal B — location string, checked in this exact order:
 *   1. International country name (word-bounded, anywhere) → not US.
 *   2. International country name in the country position (final segment or
 *      whole string), for names that are also US towns → not US.
 *   3. Indian "City, State, IN" postal format → not US.
 *   4. US city name or "United States" / "USA" → US.
 *   5. US state abbreviation (", TX") → US.
 *   6. US state spelled out ("Cincinnati, Ohio") → US.
 *   7. Location present but unrecognised ("Remote", "Worldwide") → fail open.
 *
 * Fail-open rule: no phone signal AND no usable location → treat as US-based
 * and send. See the constants block above for why the asymmetry is deliberate,
 * and for why Canada rides this branch by design.
 *
 * Pure: no env, no network, no logging, does not mutate the lead.
 */
function isUsBasedLead(lead) {
  const rp = lead && lead.resume_parsed;
  // Defensive only — leadFromSurvey never emits a lead without a parsed object.
  if (!rp || typeof rp !== 'object') return true;

  // Signal A: phone country code. Strip the separators resumes sprinkle through
  // a number first, so "+91 (987)…", "+91-987…", "(+91) 987…" and even the
  // digit-spaced "+9 1 9 8 7…" all compare the same as "+91987…". The '+' is
  // checked AFTER stripping, because a leading "(" would otherwise hide it.
  const phone = typeof rp.phone === 'string' ? rp.phone.trim() : '';
  const compact = phone.replace(/[\s().-]/g, '');
  if (compact.startsWith('+')) {
    if (NON_US_PHONE_PREFIXES_DESC.some((p) => compact.startsWith(p))) return false;
  }

  // Signal B: location string.
  const loc = typeof rp.location === 'string' ? rp.location.trim() : '';
  if (loc) {
    if (INTL_LOCATION_RE.test(loc)) return false;
    if (INTL_TAIL_RE.test(loc)) return false;
    if (INDIA_COUNTRY_CODE_RE.test(loc)) return false;
    if (US_CITY_RE.test(loc)) return true;
    if (US_STATE_RE.test(loc)) return true;
    if (US_STATE_NAME_RE.test(loc)) return true;
    return true; // present but unrecognised — fail open
  }

  return true; // no signal at all — fail open
}

// PostgREST hands the pattern straight to ilike, so a stray % or _ inside an
// address would widen the match. Over-matching here only ever suppresses a
// send, but it costs nothing to neutralise.
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Case-insensitive "is this email present?" against a table with an `id` PK.
 * One head+count request per email, fanned out ILIKE_CHUNK at a time.
 * `refine` optionally adds filters to each query.
 */
async function emailsPresentIn(table, emailsLc, refine) {
  const supabase = getSupabase();
  const hits = new Set();

  for (let i = 0; i < emailsLc.length; i += ILIKE_CHUNK) {
    const chunk = emailsLc.slice(i, i + ILIKE_CHUNK);
    await Promise.all(
      chunk.map(async (emailLc) => {
        let query = supabase
          .from(table)
          .select('id', { head: true, count: 'exact' })
          .ilike('email', escapeLike(emailLc));
        if (refine) query = refine(query);

        const { count, error } = await query;
        if (error) throw new Error(`${table} email check failed: ${error.message}`);
        if ((count || 0) > 0) hits.add(emailLc);
      })
    );
  }

  return hits;
}

/**
 * Emails we must not mail, unioned from four sources:
 *   a) profiles          — they already have an account (case-insensitive)
 *   b) marketing_suppressions — unsubscribed / bounced / complained
 *   c) pending_subscriptions  — recent *paid* checkout, by session or email
 *   d) free_apply_grants      — already granted a free apply
 */
async function findExclusions(candidates) {
  const supabase = getSupabase();
  const emailsLc = candidates.map((l) => l.email_lc);
  const sessionIds = candidates.map((l) => l.session_id).filter(Boolean);
  const emailBySession = new Map(candidates.map((l) => [l.session_id, l.email_lc]));
  const excluded = new Set();

  const inProfiles = await emailsPresentIn('profiles', emailsLc);
  for (const e of inProfiles) excluded.add(e);

  // Suppressions are stored lowercase — a plain IN is enough.
  const { data: suppressed, error: suppressError } = await supabase
    .from('marketing_suppressions')
    .select('email')
    .in('email', emailsLc);
  if (suppressError) throw new Error(`marketing_suppressions query failed: ${suppressError.message}`);
  for (const row of suppressed || []) excluded.add(String(row.email).toLowerCase());

  const checkoutSince = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
  const refineCheckout = (q) => q.in('status', PAID_CHECKOUT_STATUSES).gt('created_at', checkoutSince);

  if (sessionIds.length > 0) {
    const { data: pending, error: pendingError } = await supabase
      .from('pending_subscriptions')
      .select('session_id')
      .in('status', PAID_CHECKOUT_STATUSES)
      .gt('created_at', checkoutSince)
      .in('session_id', sessionIds);
    if (pendingError) throw new Error(`pending_subscriptions query failed: ${pendingError.message}`);
    for (const row of pending || []) {
      const emailLc = emailBySession.get(row.session_id);
      if (emailLc) excluded.add(emailLc);
    }
  }

  // Stripe reports the email late, so the session join above can miss a
  // checkout the lead started from another tab.
  const inCheckout = await emailsPresentIn('pending_subscriptions', emailsLc, refineCheckout);
  for (const e of inCheckout) excluded.add(e);

  // Ships with the main-repo migration; until then treat as "no grants yet".
  const { data: granted, error: grantError } = await supabase
    .from('free_apply_grants')
    .select('email_lc')
    .in('email_lc', emailsLc);
  if (grantError) {
    console.warn(`[queries] free_apply_grants unavailable (${grantError.message}) — skipping that exclusion.`);
  } else {
    for (const row of granted || []) excluded.add(String(row.email_lc).toLowerCase());
  }

  return excluded;
}

/**
 * Every opted-in anonymous survey in the window, newest first. Paged, because a
 * long backfill window can hold more rows than PostgREST returns in one
 * response — silently truncating would wedge the drain (the newest page would
 * always come back already-sent and the tail would never be reached).
 */
async function fetchSurveyRows(win) {
  const supabase = getSupabase();
  const rows = [];

  for (let page = 0; page < MAX_SURVEY_PAGES; page++) {
    const from = page * SURVEY_PAGE_SIZE;
    const { data, error } = await supabase
      .from('surveys')
      .select('id, session_id, resume_parsed, created_at, marketing_opt_in_at')
      .eq('marketing_opt_in', true)
      .is('user_id', null)
      .not('resume_parsed', 'is', null)
      .gte('created_at', win.startIso)
      .lte('created_at', win.endIso)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false }) // total order — stable paging across ties
      .range(from, from + SURVEY_PAGE_SIZE - 1);

    if (error) throw new Error(`surveys query failed: ${error.message}`);

    const batch = data || [];
    rows.push(...batch);
    if (batch.length < SURVEY_PAGE_SIZE) return rows;
  }

  console.warn(
    `[queries] survey paging hit the ${MAX_SURVEY_PAGES}-page guard at ${rows.length} row(s) — ` +
      'lower BACKFILL_DAYS and drain in slices.'
  );
  return rows;
}

/**
 * The audience: anonymous, opted-in surveys with a parsed resume that carries a
 * plausible email, in one of two windows (see computeWindow):
 *
 *   normal mode   — created 1–2 hours ago. Hourly cron × 1-hour-wide window =
 *                   every survey is considered exactly once.
 *   backfill mode — BACKFILL_DAYS is set: created between BACKFILL_DAYS ago and
 *                   1 hour ago, i.e. a superset of the normal window, so the
 *                   forward-marching hourly cohort is still covered while the
 *                   backlog drains. Surveys are then reconsidered on every run;
 *                   the persistent sent-tracker (KV) is what makes that
 *                   idempotent, and SEND_CAP is what keeps one run bounded.
 *
 * Everything downstream is age-independent and unchanged in both modes: the
 * exclusion set, the 3-day job-freshness gate, and the send-time token mint.
 * Returned newest-first. Pass `windowOverride` (from computeWindow) when the
 * caller has already resolved and logged the window.
 *
 * `targetingOverride` (from parseTargetEmails) is diagnostics only — it never
 * changes which leads are returned. The targeted filter itself lives in run();
 * what this function owns is the one drop the caller cannot see, because the
 * exclusion set is discarded here.
 */
async function findAnonLeads(windowOverride, targetingOverride) {
  const win = windowOverride || computeWindow(Date.now(), process.env);
  if (!windowOverride && win.warning) console.warn(`[queries] ${win.warning}`);
  const targeting = targetingOverride || parseTargetEmails(process.env);

  const rows = await fetchSurveyRows(win);

  // One lead per lower(email) — latest consent wins.
  const byEmail = new Map();
  for (const row of rows) {
    const lead = leadFromSurvey(row);
    if (!lead) continue;
    const prev = byEmail.get(lead.email_lc);
    if (!prev || optInTime(lead) >= optInTime(prev)) byEmail.set(lead.email_lc, lead);
  }

  const candidates = [...byEmail.values()].sort(byCreatedAtDesc);
  console.log(
    `[queries] mode=${win.mode} window=${win.startIso} → ${win.endIso}: ` +
      `${rows.length} opted-in anonymous survey(s) → ${candidates.length} candidate lead(s).`
  );
  if (candidates.length === 0) return [];

  const excluded = await findExclusions(candidates);
  const kept = candidates.filter((lead) => !excluded.has(lead.email_lc));

  // Geography gate: the featured job comes from a US ATS board, so an
  // international lead gets an email it cannot act on. Fails open — see
  // isUsBasedLead. Canadian leads are deliberately kept (owner, 2026-08-20).
  const usLeads = kept.filter((lead) => isUsBasedLead(lead));
  const intlDropped = kept.length - usLeads.length;
  console.log(
    `[queries] ${excluded.size} candidate(s) excluded → ${kept.length} remain → ` +
      `${intlDropped} dropped as international → ${usLeads.length} lead(s) eligible.`
  );

  // The exclusion set is counted, never named, and then thrown away — so an
  // excluded lead is indistinguishable downstream from one that was never in
  // the window at all. That ambiguity is harmless for a real run and fatal for
  // a targeted one, where "nothing sent" is the entire result and QA has to be
  // able to explain it. Name the targets the exclusions ate.
  if (targeting.active && excluded.size > 0) {
    const excludedTargets = targeting.targets.filter((t) => excluded.has(t));
    if (excludedTargets.length > 0) {
      console.warn(
        `[queries] TARGETED MODE: ${excludedTargets.length} target(s) dropped by the exclusion ` +
          `set — ${excludedTargets.join(', ')}. That means they already have a profile, are in ` +
          'marketing_suppressions, have a paid checkout in the last 7 days, or already hold a ' +
          'free_apply_grants row. This is a rail, not a bug: it fires in targeted mode too.'
      );
    }
  }

  // Same diagnostic duty as the block above: in targeted mode a silent drop is
  // the entire mystery, so name the targets geography ate. The keptSet guard
  // stops a target the exclusion set already removed being reported twice.
  if (targeting.active && intlDropped > 0) {
    const keptSet = new Set(kept.map((l) => l.email_lc));
    const usSet = new Set(usLeads.map((l) => l.email_lc));
    const intlTargets = targeting.targets.filter((t) => keptSet.has(t) && !usSet.has(t));
    if (intlTargets.length > 0) {
      console.warn(
        `[queries] TARGETED MODE: ${intlTargets.length} target(s) dropped as international — ` +
          `${intlTargets.join(', ')}. Their resume phone or location reads as outside the US. ` +
          'This is a rail, not a bug: it fires in targeted mode too.'
      );
    }
  }

  return usLeads;
}

/**
 * Featured job per lead, via the same production RPC the in-app matches feed
 * uses (HNSW vector search + structured boosts). It progressively relaxes the
 * freshness window until it finds a non-closed match.
 *
 * Bounded: at most `concurrency` leads are in flight at once (default
 * MATCH_CONCURRENCY). This used to be a bare Promise.all over the whole cohort,
 * which meant SEND_CAP concurrent vector searches against the production
 * database — see the MATCH_CONCURRENCY comment for what that cost on 2026-08-13.
 *
 * Bounded in time as well: leads picked up after `runStartMs + budgetMs` are not
 * attempted at all. They are reported as `deferredByBudget`, not failed —
 * nothing marks them sent, so the next hourly run offers them again.
 *
 * `options.balanced` is the matcher MODE (`p_balance`), and it must be the same
 * one the app ranks the in-app feed with — see balancedRoleMatchEnabled. It is
 * resolved ONCE here (or by the caller, once per run), never per lead: every
 * lead in a run has to be ranked the same way for the run to mean anything.
 *
 * `options` also carries three seams production never sets: `client`, `now` and
 * `sleep`, so the retry, the budget and the pool are testable without Supabase
 * and without real time passing.
 *
 * Returns { matched: [{ lead, job, pct }] in input order, ...counters }.
 */
async function findFeaturedJobs(leads, options = {}) {
  const {
    runStartMs = Date.now(),
    budgetMs = resolveRunBudgetMs(process.env).budgetMs,
    concurrency = resolveMatchConcurrency(process.env).concurrency,
    balanced = balancedRoleMatchEnabled(process.env),
    client = null,
    now = Date.now,
    sleep = delay,
  } = options;

  const supabase = client || getSupabase();
  const deadlineMs = runStartMs + budgetMs;
  const stats = { noFreshMatch: 0, timedOut: 0, retried: 0, failed: 0, deferredByBudget: 0 };

  /**
   * One rung of the freshness ladder. A statement timeout under load is
   * transient, so that single step is retried once after a beat — not the whole
   * ladder, and not any other class of error, which stays as final as it was.
   */
  const runMatchStep = async (lead, freshDays) => {
    for (let attempt = 0; ; attempt++) {
      const { data, error } = await supabase.rpc('match_jobs_for_survey', {
        p_survey_id: lead.survey_id,
        p_limit: 10,
        p_fresh_days: freshDays,
        // Always sent explicitly, in both states. Omitting it would let the
        // RPC's own `DEFAULT false` decide the mode, which is exactly the
        // silent single-vector fallback this argument exists to close.
        p_balance: balanced,
      });

      if (!error) return { matches: data, error: null, timedOut: false };

      const timedOut = isTimeoutError(error);
      if (timedOut && attempt === 0) {
        // Deliberately silent: the whole point of this run's post-mortem was 44
        // identical error lines. The aggregate line at the end carries the count.
        stats.retried++;
        await sleep(MATCH_RETRY_DELAY_MS);
        continue;
      }

      return { matches: null, error, timedOut };
    }
  };

  const featureOne = async (lead) => {
    // Checked as each lead is picked up rather than only at batch boundaries: a
    // worker pool has no batches, and per-lead is strictly tighter than one.
    if (now() >= deadlineMs) {
      stats.deferredByBudget++;
      return null;
    }

    for (const freshDays of FRESH_DAY_STEPS) {
      const { matches, error: rpcError, timedOut } = await runMatchStep(lead, freshDays);

      if (rpcError) {
        if (timedOut) stats.timedOut++;
        else stats.failed++;
        console.error(
          `[queries] match_jobs_for_survey failed for ${lead.email_lc}: ${rpcError.message}` +
            (timedOut ? ' (retried once after a statement timeout)' : '')
        );
        return null;
      }
      if (!matches || matches.length === 0) {
        console.log(`[queries] No matches within ${freshDays}d for ${lead.email_lc}; trying next window.`);
        continue;
      }

      // Hydrate the whole window's matches in ONE round trip rather than up
      // to 10 sequential .single() calls. The ladder means the worst case per
      // lead was 4 windows x 10 fetches = 40 round trips, and every lead's
      // ladder used to run at once — the leads that reach the widest windows
      // are exactly what a backfill run is made of. A row that is missing
      // simply isn't in the map, which lands on the same `continue` the
      // per-row error did.
      const { data: jobRows, error: jobError } = await supabase
        .from('jobs')
        .select(
          'id, title, company, location, salary_min, salary_max, work_type, source_url, description, role_category, first_seen_at, last_seen_at, ats_provider, closed_at'
        )
        .in(
          'id',
          matches.map((m) => m.job_id)
        );

      if (jobError) {
        stats.failed++;
        console.error(`[queries] job fetch failed for ${lead.email_lc}: ${jobError.message}`);
        return null;
      }
      const jobsById = new Map((jobRows || []).map((j) => [j.id, j]));

      // Iterate MATCHES, not jobsById — the RPC returns rows ordered by
      // total_score DESC and `.in()` gives no ordering guarantee, so the map
      // lookup is what preserves "best match first".
      for (const match of matches) {
        const job = jobsById.get(match.job_id);
        if (!job) {
          console.error(`[queries] job ${match.job_id} missing from the batch fetch — skipping.`);
          continue;
        }
        if (job.closed_at) {
          console.log(`[queries] Job ${job.id} is closed — trying next match for ${lead.email_lc}.`);
          continue;
        }

        // Mirrors visibleMatchPct in the main repo (server/marketing/match-digest.ts).
        const pct = Math.max(70, Math.min(98, Math.round(70 + match.total_score * 28)));

        console.log(
          `[queries] ${lead.email_lc} → "${job.title}" at ${job.company} ` +
            `(${pct}% match, score=${match.total_score.toFixed(3)}, freshness=${freshDays}d)`
        );

        return { lead, job, pct };
      }

      console.log(
        `[queries] No open matches within ${freshDays}d for ${lead.email_lc}; trying next window.`
      );
    }

    stats.noFreshMatch++;
    console.log(`[queries] No open matches within 30d for ${lead.email_lc} — skipping.`);
    return null;
  };

  // The pool already turns a rejection into a null so one lead can't cancel the
  // other 49 — but it does that silently. Catch here as well so an unexpected
  // throw is still named once, and counted, instead of vanishing.
  const results = await mapWithConcurrency(leads, concurrency, async (lead) => {
    try {
      return await featureOne(lead);
    } catch (err) {
      stats.failed++;
      console.error(`[queries] featured-job lookup threw for ${lead.email_lc}: ${err.message}`);
      return null;
    }
  });
  const matched = results.filter(Boolean);

  // One aggregate line per run. Every count above it is per-lead and at most one
  // line per distinct failure; this is the line that says what the stage did.
  console.log(
    `[queries] Match stage: matched ${matched.length}, no-fresh-match ${stats.noFreshMatch}, ` +
      `timed-out ${stats.timedOut} (retried), deferred-by-budget ${stats.deferredByBudget} — ` +
      `${leads.length} lead(s) in, ${stats.retried} timeout retr${stats.retried === 1 ? 'y' : 'ies'}, ` +
      `${stats.failed} other failure(s), concurrency=${concurrency}, budget=${budgetMs}ms, ` +
      `roleFanout=${balanced ? 'on' : 'off'}, elapsed=${now() - runStartMs}ms.`
  );

  return { matched, ...stats };
}

module.exports = {
  getSupabase,
  computeWindow,
  resolveSendCap,
  resolveMatchConcurrency,
  resolveRunBudgetMs,
  balancedRoleMatchEnabled,
  mapWithConcurrency,
  selectForSend,
  evaluateDedupSafety,
  capForDedupAction,
  parseTargetEmails,
  filterToTargets,
  findAnonLeads,
  findFeaturedJobs,
  findExclusions,
  MATCH_CONCURRENCY,
  RUN_BUDGET_MS,
  _internals: {
    parseResume,
    leadFromSurvey,
    isUsBasedLead,
    NON_US_PHONE_PREFIXES,
    INTL_LOCATION_MARKERS,
    INTL_TAIL_ONLY_MARKERS,
    INDIA_COUNTRY_CODE_RE,
    US_CITY_MARKERS,
    US_STATE_RE,
    US_STATE_NAMES,
    US_STATE_NAME_RE,
    optInTime,
    escapeLike,
    byCreatedAtDesc,
    isTimeoutError,
    MIN_BACKFILL_DAYS,
    MAX_BACKFILL_DAYS,
    DEFAULT_BACKFILL_SEND_CAP,
    NON_DURABLE_SEND_CAP,
    NORMAL_LOOKBACK_MS,
    SETTLE_MS,
    ONE_DAY_MS,
    MIN_MATCH_CONCURRENCY,
    MAX_MATCH_CONCURRENCY,
    MIN_RUN_BUDGET_MS,
    MAX_RUN_BUDGET_MS,
    MATCH_RETRY_DELAY_MS,
    FRESH_DAY_STEPS,
  },
};
