# Standout Email Workers

Two Vercel cron workers that re-engage users who signed up for
[Standout](https://www.usestandout.today), uploaded a resume, and then went
quiet. Both read the production Supabase Postgres (owned by the `Standout-pro`
repo) and send through Brevo transactional templates.

This repo owns **no** schema. It reads `profiles`, `surveys`, `jobs`,
`marketing_suppressions` and `pending_subscriptions`, and writes exactly three
columns on `profiles` — the abandonment send markers described below.

---

## The two workers

| Worker | Cron | Route | What it sends |
| --- | --- | --- | --- |
| `abandonment-job-email/` | `0 * * * *` (hourly, on the hour) | `/api/abandonment-job-email` | **Email 1** — "here's your best match", 1–24h after signup. Picks the best fresh job via the production `match_jobs_for_survey()` RPC and generates three "why you match" bullets with Claude Haiku. |
| `abandonment-job-email-2/` | `30 * * * *` (hourly, on the half hour) | `/api/abandonment-job-email-2` | **Email 2** — 24h loss-aversion nurture. Re-surfaces the *same* job Email 1 featured, plus a live match count. |

The crons are staggered so the two workers never contend for the same Postgres
connections or the same `match_jobs_for_survey()` capacity.

### Email 1 flow

1. Select profiles created 1–24h ago with `resume_parsed IS NOT NULL` and
   `abandonment_email_1_sent_at IS NULL`.
2. Drop anyone with a billing signal, a paid pay-first checkout, or a marketing
   suppression (see [Exclusions](#exclusions)).
3. Resolve each user's **newest survey that has an embedding**, call
   `match_jobs_for_survey(survey_id, limit 10, fresh_days 3)` at a concurrency
   of 4, then batch-fetch every top-match job row in one query.
4. Per user: claim atomically, generate the match reasons, send, log.

### Email 2 flow

1. Select profiles where `abandonment_email_1_sent_at <= now() - 24h`,
   `abandonment_email_2_sent_at IS NULL`, and `created_at >= now() - 96h`.
2. Same exclusions as Email 1.
3. The featured job comes straight from `abandonment_email_1_job_id` — one
   batched `jobs` fetch, no per-user round trips, no KV dependency. A user with
   a NULL job id is skipped.
4. Match count via `match_jobs_for_survey(survey_id, limit 20, fresh_days 21)` —
   21 days is the product's sendable-job window, so the number in the email
   matches what the dashboard shows when they click through.

---

## Eligibility is Postgres state, not a time window

Both workers used to select on a **moving window** (`created_at` between 1–2h
ago; between 25–26h ago). That is fragile in both directions: one slow, failed
or skipped run dropped that hour's cohort forever, and any schedule change
silently double-sent.

Eligibility is now *state*, held in three columns on `profiles` (declared in
`Standout-pro/shared/schema.ts`, written only by these workers):

| Column | Meaning |
| --- | --- |
| `abandonment_email_1_sent_at` (timestamptz) | Email 1 send marker. `NULL` = never sent. |
| `abandonment_email_1_job_id` (integer) | The `jobs.id` featured in Email 1, so Email 2 (and support) can reference the same job. |
| `abandonment_email_2_sent_at` (timestamptz) | Email 2 send marker. `NULL` = never sent. |

A missed run simply catches up on the next one. The 24h (Email 1) and 96h
(Email 2) backstops exist only so the first deploy of the state-based query
doesn't mail the entire historical backlog of never-emailed users.

### The atomic claim

Dedup is a conditional UPDATE, the same pattern the product uses for
`brevo_synced_at` and `posthog_signed_up_at`:

```sql
UPDATE profiles
   SET abandonment_email_1_sent_at = now(),
       abandonment_email_1_job_id  = $job
 WHERE id = $user
   AND abandonment_email_1_sent_at IS NULL
RETURNING id;
```

Postgres serializes concurrent UPDATEs, so exactly one of N racing runs gets a
row back. **No row returned = someone else owns this user = skip.** This makes
overlapping crons, manual triggers and Vercel retries all safe.

Two properties worth keeping in mind if you change the send loop
(`lib/claims.js`):

- The claim is taken **before** the Anthropic call and **before** the Brevo
  call. A crash mid-send can therefore *drop* an email but never *duplicate*
  one — and we never burn LLM tokens writing copy for a user another run
  already has.
- If the send then fails, the claim is **released** (both columns back to
  `NULL`) so the next hourly run retries. Release is the only thing that ever
  nulls these columns. If the release itself fails, the log says `CLAIM STUCK`
  with the user id — that user needs a manual clear.

---

## Exclusions

Shared by both workers, in `lib/eligibility.js`. Every rule lives once.

**1. Billing engagement (off the profile row).** Excluded if *any* of:
`subscription_status` is non-null, `stripe_subscription_id` is non-null, or
`plan` is set and isn't `free`. Deliberately broader than the old
`['active','trialing']` check: within 24–96h of signup, *any* Stripe status
means the user engaged with billing — including `incomplete` (mid-3DS) and
`past_due` / `unpaid` (dunning). "You never finished setting up" is the worst
possible email to send someone whose card is being retried. A
`stripe_customer_id` on its own is **not** an exclusion signal — Stripe mints
one the moment a Checkout session opens.

**2. Pay-first guest checkouts.** The pay-first split test lets a visitor pay
*before* creating an account, so their profile reads NULL for every billing
column until `billing-claim.ts` claims it. Both workers batch-query
`pending_subscriptions` by email and exclude any row with `status = 'paid'`.
These are paying customers whose profile looks abandoned.

**3. Marketing suppressions.** Unsubscribes, hard bounces and spam complaints,
mirrored from Brevo's webhook into `marketing_suppressions`. Every product send
path filters on this table; these crons did not, which meant they were emailing
people who had explicitly opted out. Emails are lowercased + trimmed on both
sides to match how the table stores them.

---

## Authentication

Both routes require `Authorization: Bearer $CRON_SECRET`. Set `CRON_SECRET` in
**Vercel → Project → Settings → Environment Variables**; Vercel Cron then sends
it automatically on every scheduled invocation.

- Wrong or missing token → `401 {"ok":false}`
- `CRON_SECRET` not set at all → `500` and the run does **not** execute
  (fails closed — a missing env var must never republish the endpoint to the
  internet)
- Method other than GET/POST → `405`

Errors return a generic `{"ok":false,"error":"Internal error"}`. The real error
goes to the Vercel logs only — `err.message` on a public endpoint leaks table
names, column names and env-var names.

Manual trigger:

```bash
curl -X POST https://<deployment>/api/abandonment-job-email \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

## DRY_RUN

Parsing is **strict** (`lib/dry-run.js`):

| Value | Behavior |
| --- | --- |
| `false` | Live sends. |
| `true` | Log only — no Brevo call, no Anthropic call, **no DB writes and no claims**. |
| unset / empty | Treated as `true`, with a `console.warn` that it defaulted safe. |
| anything else | The run **throws**. |

The old check was `String(process.env.DRY_RUN) !== 'false'`, which swallowed
`DRY_RUN=FLASE`, `DRY_RUN=0` and `DRY_RUN=no` as "dry run" — an operator who
meant to go live would have seen months of green "sent N emails" dashboards
with zero real sends.

Relatedly, `run()` returns **separate counters** so a dry run can't be mistaken
for a live one:

```json
{ "eligible": 12, "matched": 9, "sent": 0, "wouldSend": 9, "skipped": 3, "failed": 0, "dryRun": true }
```

In a dry run `sent` is always `0` and `wouldSend` carries the count.

---

## Logging

Structured to be safe to read and safe to leave on:

- **Logged:** user ids (UUIDs), job ids, counts, sanitized job titles.
- **Never logged:** email addresses, minted magic-link URLs (they are bearer
  credentials — anyone with the log line can sign in as that user), full Brevo
  param objects, resume content.

Dry-run lines look like:

```
[DRY RUN] would send to user 8f3e1c2a-… — job 41822 "Data Analyst" (88%)
```

---

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Supabase project URL (`https://<project>.supabase.co`). |
| `SUPABASE_SERVICE_KEY` | yes | Service-role key. Required, not optional: `profiles`, `marketing_suppressions` and `pending_subscriptions` are all RLS-locked to the service role, and the workers write the claim columns. |
| `BREVO_API_KEY` | yes | Brevo API key. `BREVO_KEY` is accepted as a legacy alias. |
| `BREVO_TEMPLATE_ID` | yes | Email 1 template id (`39`). |
| `BREVO_TEMPLATE_ID_2` | yes | Email 2 template id. **No default** — Worker 2 refuses to start without it (it used to fall back to a hardcoded `40`). |
| `ANTHROPIC_API_KEY` | no | Match-reason generation for Email 1. Unset → deterministic non-AI fallback copy. |
| `STANDOUT_APP_URL` | no | Link origin. Defaults to `https://www.usestandout.today`. Trailing slashes are trimmed. (`standout.jobs` is dead — do not use it.) |
| `EMAIL_LINK_SECRET` | no | Shared with the product's `server/lib/email-token.ts`. Signs the auto-login magic links. Unset → links degrade to plain, non-authenticating URLs. |
| `CRON_SECRET` | yes | Cron authentication (see above). Set in Vercel project settings; Vercel sends it as `Authorization: Bearer …`. |
| `KV_REST_API_URL` | legacy | Vercel KV — transition guard only, see below. |
| `KV_REST_API_TOKEN` | legacy | Vercel KV — transition guard only, see below. |
| `DRY_RUN` | yes in prod | `true` / `false`, strict parsing (see above). |

Both workers validate `BREVO_API_KEY` and their template id at the top of
`run()` — **including in dry runs**, on the grounds that a dry run whose
template id is missing isn't validating the thing it claims to validate. Use a
dummy key locally; no network call is made in a dry run.

Copy [`.env.example`](./.env.example) to `.env` for local runs. `.env*` is
gitignored except the example.

---

## Legacy Vercel KV (delete after ~2026-08-01)

`abandonment-job-email/sent-tracker.js` is the old KV-backed dedup store. It is
retained for **one** purpose: users who were emailed *before* the Postgres
columns existed have a NULL `abandonment_email_1_sent_at` and would otherwise
look eligible again. On each run Worker 1 checks KV, back-fills the DB column
from it, and skips the send.

It is no longer written to, and Worker 2 no longer touches it at all. Once
every KV-tracked user is more than 24h past the Email 1 window, delete
`sent-tracker.js`, the `consumeLegacySend()` helper in
`abandonment-job-email/index.js`, the `@vercel/kv` dependency, and the two
`KV_REST_API_*` env vars.

Two fixes went in while it lives:

- `getSentJobId()` now **exists**. Worker 2 called it and it was never
  exported, so Email 2 threw `sentTracker.getSentJobId is not a function` for
  every user on every run since the day it shipped — it has never successfully
  sent an email.
- The tracker **fails closed**. It used to fall back to an in-memory `Set` when
  KV wasn't configured, which on serverless (fresh process per invocation) is a
  dedup no-op that silently promised protection it couldn't deliver. Memory
  mode is now allowed only in dry-run/local; a live run without KV throws.

---

## Local development

```bash
npm install
cp .env.example .env   # fill in the values; keep DRY_RUN=true
npm test

# dry run a worker directly
node abandonment-job-email/index.js
node abandonment-job-email-2/index.js
```

Tests are `node:test`, zero network, zero extra dependencies:

| File | Covers |
| --- | --- |
| `test/contracts.test.js` | Every module loads; every destructured import and every `namespace.method()` call actually exists on the target. This is the class of bug that shipped Email 2 dead. |
| `test/magic-link.test.js` | Round-trips a signed token through a local reimplementation of the product's `verifyEmailToken`. Pins the token format so links already in inboxes can't be broken. |
| `test/brevo.test.js` | Retry/backoff against an injected fake fetch: 429-then-success, `Retry-After`, 400 fails fast, network errors, non-JSON bodies. |
| `test/sanitize.test.js` | CRLF, `<script>`, whitespace collapsing, length caps. |
| `test/payload.test.js` | Both workers' payload builders emit no control characters or angle brackets, and leave the self-minted URLs alone. |
| `test/sent-tracker.test.js` | The legacy tracker's contract, including `getSentJobId` and the fail-closed behavior. |
| `test/lib.test.js` | Concurrency limiter, cron auth, billing/suppression predicates. |
| `test/dry-run.test.js` | Strict `DRY_RUN` parsing. |

---

## Deploy

The repo is Vercel-ready; [`vercel.json`](./vercel.json) holds both cron
schedules and the function config.

1. Import the repo into Vercel.
2. Add every variable from `.env.example` under **Project → Settings →
   Environment Variables**, including `CRON_SECRET`. Keep `DRY_RUN=true` for
   the first deploys.
3. Deploy. Both crons appear under **Project → Cron Jobs**.
4. When the dry-run output looks right, set `DRY_RUN=false` and redeploy.

> **`maxDuration`:** `vercel.json` sets `300` seconds for `api/*.js`. That
> requires a **Pro** plan — the **Hobby** plan caps functions at **60s** and a
> deploy will fail with a config error if you leave `300` on Hobby. Lower it to
> `60` there (and expect large cohorts to need more than one run to drain,
> which the state-based eligibility handles correctly).

---

## Error handling

- **Supabase query fails** → the run aborts; the route logs the real error and
  returns a generic 500.
- **A user has no fresh match** → skipped silently, no claim, no state change.
- **Match-reason generation fails** → falls back to three deterministic
  reasons derived from the role/intent labels (no AI call).
- **Brevo send fails for one user** → the claim is released, that user is
  counted in `failed`, and the run continues. A single recipient never kills
  the batch. `lib/brevo.js` retries 429/5xx/network errors up to 3 times with
  exponential backoff + jitter (honoring a numeric `Retry-After`), and fails
  fast on other 4xx.

---

## File layout

```
standout-email-workers/
├── lib/                        shared, no extra dependencies
│   ├── supabase.js             memoized service-role client
│   ├── eligibility.js          audience selection + all three exclusion layers
│   ├── claims.js               atomic send claims / releases
│   ├── brevo.js                hardened transactional sender (raw fetch, retries)
│   ├── magic-link.js           signed auto-login links (format pinned by tests)
│   ├── sanitize.js             param + recipient-name sanitization
│   ├── cron-auth.js            CRON_SECRET bearer check (fails closed)
│   ├── concurrency.js          bounded parallel map (RPC_CONCURRENCY = 4)
│   └── dry-run.js              strict DRY_RUN parsing
├── abandonment-job-email/      Email 1
│   ├── index.js                orchestrator + send loop
│   ├── queries.js              eligibility + best-match selection
│   ├── match-reason.js         Claude Haiku bullets, with fallbacks
│   └── sent-tracker.js         LEGACY KV transition guard — delete ~2026-08-01
├── abandonment-job-email-2/    Email 2
│   ├── index.js
│   └── queries.js
├── api/                        Vercel routes (method check + CRON_SECRET + run())
├── test/                       node:test, no network
├── vercel.json                 cron schedules + maxDuration
└── .env.example
```
