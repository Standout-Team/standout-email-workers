# Standout Email Workers

Standalone email automation workers for [Standout](https://standout.jobs). Each worker
lives in its own directory, reads from the production Supabase database (read-only), and
never touches the main Standout app codebase.

## Workers

`abandonment-anon-lead-email/` is the only worker with a live endpoint and cron. Three
older workers were retired on 2026-08-13 — their code is still in-tree but they no longer
run; see [Retired workers](#retired-workers).

### `abandonment-anon-lead-email/`

An hourly cron worker that re-engages **anonymous** leads: they uploaded a resume, opted
in to marketing, hit the paywall and left without ever creating an account. There is no
account to magic-link them into, so every CTA carries a signed 14-day lead token that
`/your-match` trades for their restored survey + resume and **one free apply**.

Audience: `surveys` with `marketing_opt_in`, `user_id IS NULL`, a parsed resume carrying a
plausible email, created inside the run's window (below). Excludes existing `profiles`,
`marketing_suppressions`, recent `paid` `pending_subscriptions`, and anyone with a
`free_apply_grants` row. A `created`-but-unpaid checkout is **not** an exclusion — that
lead abandoned too, and gets this email like any other abandoner. The featured job comes
from the production `match_jobs_for_survey` RPC and is dropped if it closed or went stale
(>3 days).

Dedup is **Vercel KV** (`anon_lead_sent:<email_lc>`, stored indefinitely — one send per
lead email, ever), matching `abandonment-job-email/`. Without `KV_REST_API_URL` /
`KV_REST_API_TOKEN` it falls back to an in-process `Set`: fine for a local dry run,
useless in serverless, where every cold start wipes it. **Zero writes to Supabase.**

##### Fail-closed dedup guard

Because that fallback is silent, the worker **refuses real sends it cannot dedup**. The
check runs at the top of `run()`, before any Supabase or Brevo work:

| Environment | `DRY_RUN` | KV bound? | Behaviour |
| --- | --- | --- | --- |
| Vercel (production **or** preview) | `false` | no | **Throws.** Nothing is queried, nothing is sent, the hourly cron fails loudly in Vercel observability. |
| Vercel | `true` | no | Warns with a `NON-DURABLE DEDUP` banner and runs, capped at **50**. |
| Local | either | no | Same banner + 50 cap — one process spans the run, so the `Set` is honest. |
| anywhere | either | yes | Normal. Cap untouched. |

The forced cap is `min(existing cap, 50)`, so an operator cap below 50 still wins, and it
applies to warn-mode dry runs too — a dry run predicts what a real run in that same
environment would send. Every run's start line and JSON summary carry
`dedup=durable|non-durable`.

Preview deployments are deliberately covered: the guard keys off `process.env.VERCEL`, not
`VERCEL_ENV`, because a preview carrying `DRY_RUN=false` and a live Brevo key mails real
people exactly as hard as production does.

Full spec + ops runbook: `docs/FREE_APPLY_LEADS.md` in the main `Standout-pro` repo.

#### Backfill procedure

By default the worker only looks at surveys created **1–2 hours ago** — an hourly cron
over a 1-hour-wide window, so each survey is considered exactly once and the audience
marches forward with the clock. To reach abandoners from *before* the worker went live,
set two env vars on the Vercel project. **The cron itself never changes.**

| Variable | Effect |
| --- | --- |
| `BACKFILL_DAYS` | Widens the window to `[now − N days, now − 1h]`. Integer **1–30**; out-of-range clamps, anything invalid logs a warning and runs the normal window. The backfill window is a *superset* of the normal one, so new abandoners keep being covered while the backlog drains. |
| `SEND_CAP` | Max real sends per run. Defaults to **50** in backfill mode, uncapped in normal mode. Candidates past the cap are left for the next hourly run. |

1. Set `BACKFILL_DAYS=14` (optionally `SEND_CAP`) with **`DRY_RUN=true`**, and redeploy.
2. Read the next hourly run's logs. It prints the mode, the exact window bounds, and the
   cohort — e.g. `312 eligible after exclusions — 0 already sent, 312 remaining, 50
   selected this run (cap=50, 262 left for later runs)` — then
   `[DRY RUN COMPLETE] Would send 50 of 312 eligible`. The cohort line lands *before* the
   per-lead work, so you get the count even if the dry run is slow.
3. Sanity-check the count and the token/`JOB_URL` self-check lines, then set
   `DRY_RUN=false` and redeploy.
4. The cron drains up to `SEND_CAP` per hour, **newest abandoner first** (freshest intent
   converts best; the tail drains over subsequent runs). Each run logs
   `N remaining after this run`.
5. Unset `BACKFILL_DAYS` (and `SEND_CAP`) once `remaining` reaches 0 — or once it stops
   falling: leads whose top match has gone stale are unmailable, not pending, so the
   number can plateau above 0.

Safe to run twice. Every send is recorded in KV before the next run reads it, and that
check now runs in dry-run mode too — so a dry run *after* a partial drain reports the true
remaining cohort instead of re-counting people who were already mailed. A backfill can
never drain with dedup quietly off: without the KV binding the worker refuses to send for
real on Vercel (see the fail-closed guard above). If a run times out, lower `SEND_CAP`.

#### Match fan-out and the run budget

The featured-job lookup is the expensive half of a run: `match_jobs_for_survey` is an HNSW
vector search, one lead can walk up to four of them (the 3 → 7 → 14 → 30 day freshness
ladder), and it runs against the **same** database that serves the live app's `/api/match`.
It used to fan the whole cohort out at once, which meant `SEND_CAP` concurrent vector
searches — the 18:00 UTC run on 2026-08-13 lost **44 of 50** leads to `canceling statement
due to statement timeout` and sent 6 emails. It is now a bounded worker pool with a
per-run time budget.

| Variable | Effect |
| --- | --- |
| `MATCH_CONCURRENCY` | Match RPCs in flight at once. Default **4**, clamped **1–10**, invalid falls back to the default with a warning. It is a pressure valve for a database incident — turn it *down*. |
| `RUN_BUDGET_MS` | How long the run may keep handing leads to the match stage, measured from the start of `run()`. Default **240000** (4 min), clamped **30000–280000**, invalid falls back to the default with a warning. Must stay under the function's `maxDuration` (300s, set in `vercel.json`). |

Leads the budget did not reach are **deferred, not skipped**: nothing marked them sent, so
the KV sent-tracker hands them back to the next hourly run. They show up as
`deferredByBudget` in the run summary and as one `RUN BUDGET reached …` warning.

A statement timeout is transient under load, so a timed-out match is retried **once** after
750ms — that one ladder step, not the whole ladder, and only for timeouts. Every other
error stays final. The stage closes with a single aggregate line instead of one error per
lead:

```
[queries] Match stage: matched 48, no-fresh-match 1, timed-out 1 (retried), deferred-by-budget 0 — 50 lead(s) in, 3 timeout retries, 0 other failure(s), concurrency=4, budget=240000ms, roleFanout=on, elapsed=71204ms.
```

#### Matcher mode — `MATCH_ROLE_FANOUT` (must match the main app)

`match_jobs_for_survey` takes a `p_balance` argument that selects **how** it
ranks: off is one ANN from the survey's single vector; on retrieves candidates
once *per role category* and interleaves them, so a survey naming 2+ categories
doesn't collapse into whichever field its vector landed nearest. This worker
passes `MATCH_ROLE_FANOUT` as that argument.

| Variable | Effect |
| --- | --- |
| `MATCH_ROLE_FANOUT` | `on` (trimmed, case-insensitive) enables multi-vector ranking. **Unset = off = single-vector**, and so is every other value — `true`, `1` and `yes` are all off, because the main app's flag reads exactly this way. |

> ⚠️ **Keep this equal to the main app's `MATCH_ROLE_FANOUT`.** The app ranks the
> in-app feed with its own value; this worker picks the emailed featured job with
> this one. When they diverge, the job in the email and the top job of the feed
> that email's CTA lands on are chosen by *different matchers* and can be
> different postings — measured on 2026-08-13, **5 of 6** recent surveys with 2+
> role categories got a different top job out of the two modes. Surveys with 0 or
> 1 categories are identical either way.

The app's value is set on the **main app's** Vercel project; this one is set
here. They are two separate projects, so nothing enforces the match — change both
in the same sitting and redeploy both. Every run states which mode it used, in
the start line (`roleFanout=on|off`), in the match-stage aggregate line, and as
`balanced` in the JSON run summary, so a divergence is diagnosable from logs
alone.

Cost, measured on prod at concurrency 4: **76 ms** single-vector vs **503 ms**
balanced on an 8-category survey — comfortably inside the 8 s `service_role`
statement timeout, but it is the reason the fan-out stays bounded.

Source of truth for the parser is `server/lib/feature-flags.ts` in the main
`Standout-pro` repo; `balancedRoleMatchEnabled` in `queries.js` is a deliberate
byte-identical twin and the two must be changed together.

#### Targeted send (QA/support)

`TARGET_EMAILS` narrows a run to a named list — for testing the live template end to end,
or resending to one lead who wrote in. It is a **filter, never a bypass**: exclusions, the
KV sent-tracker, `SEND_CAP`, `DRY_RUN` and the fail-closed dedup guard all still apply, and
the filter runs *before* the sent-tracker partition so every count in the log stays honest.

| Variable | Effect |
| --- | --- |
| `TARGET_EMAILS` | Comma-separated addresses. Lowercased, trimmed, deduped, and validated. While set, **only** these people can be emailed and every real lead in the window is withheld. Unset / empty / whitespace = off, normal behaviour. |

> ⚠️ **Leaving `TARGET_EMAILS` set silences the funnel.** Real leads are not queued or
> deferred — they are skipped, and the hourly window moves on without them. Every run logs
> `=== TARGETED MODE ACTIVE — … ; real leads are NOT being sent ===` as the alarm. Treat it
> the way you'd treat a maintenance page left up.

Procedure:

1. Set `TARGET_EMAILS=someone@example.com` on the Vercel project. If the lead's survey is
   older than ~1–2 hours it is outside the normal window, so **also** set `BACKFILL_DAYS`
   wide enough to reach it (see the table above) — the two compose, and targeting works
   identically in either window.
2. Redeploy.
3. Open `/api/abandonment-anon-lead-email` once to fire it immediately, or wait for the
   top of the hour. The response body is the run summary, including `targeted`,
   `targetCount` and `withheld`.
4. **Remove both `TARGET_EMAILS` and `BACKFILL_DAYS`, and redeploy.** This is the step that
   matters — until it lands, no real lead is being emailed.

If nothing sends, the logs name the reason rather than making you guess:

| Log line | Meaning |
| --- | --- |
| `TARGET NOT FOUND: <email>` | Not in the run's candidate set — their survey is outside the window (raise `BACKFILL_DAYS`) or they fail the audience criteria (opt-in, anonymous, parsed resume email). |
| `TARGETED MODE: N target(s) dropped by the exclusion set` | They have a profile, are suppressed, or have a paid checkout in the last 7 days. Holding a free-apply grant is **no longer** an exclusion (2026-08-21). |
| `TARGETED MODE: N target(s) dropped as international` | Their resume phone or location reads as outside the US. Canada counts as eligible. |
| `<email> converted since the cohort was built` | The send-time paid re-check caught a lead who paid between the cohort query and dispatch. Working as intended. |
| `TARGETED MODE: N target(s) were already mailed` | The sent-tracker is one-send-per-lead-email **forever**, and targeting does not reset it. |
| `No open matches within 30d for <email>` | No fresh, open job match — nothing to feature. |
| `TARGET_EMAILS parsed to ZERO valid addresses` | Every entry was junk. The run is fail-closed (it mails nobody), not open. |

---

## Retired workers

Retired **2026-08-13**, after the workers' creator confirmed they are no longer needed:

| Worker | Was scheduled | State at retirement |
| --- | --- | --- |
| `abandonment-job-email/` | hourly (`0 * * * *`) | Ran clean, **actively sending** — the 21:00 UTC run on 2026-08-13 found 2 users and sent 2 real emails |
| `abandonment-job-email-2/` | hourly (`0 * * * *`) | **Already broken** — 500 on every run with `TypeError: sentTracker.getSentJobId is not a function` at `abandonment-job-email-2/queries.js:63`, a casualty of the `sent.json` → Vercel KV migration (`sent-tracker.js` exports only `hasBeenSent` / `markSent`) |
| `abandonment-job-email-resume-trigger/` | every 10 min (`*/10 * * * *`) | Ran clean, same live audience as `abandonment-job-email/` (deduped separately) |

> **Spot checks showed "0 eligible users" — that was sampling, not an empty audience.**
> The shared audience ran ~24 eligible people/day (167 over the 7 days to 2026-08-13),
> and only about **half** of hourly windows contained anyone, so checking a few runs in a
> row could easily show none. These were retired because they duplicate the anon-lead
> worker's cohort and `-2` was dead — not because nobody was there.

### This is a coverage change, not a replacement

All three queried `profiles` and emailed **people who already have accounts**, minting
auto-login magic links. `abandonment-anon-lead-email/` deliberately targets the opposite
audience — it **excludes** anyone present in `profiles` — so it does not pick these people
up and never will. Retiring these three means that audience stops receiving these emails.
That was the intent.

Sized, over the 7 days to 2026-08-13: **167 people** were eligible (~24/day). **98** of
them had also been anonymous opted-in leads before signing up, so the anon-lead worker had
already emailed them — retiring these three only stops the *second* email for that group.
The other **69** (~10/day) signed up without ever being an anonymous lead, so nothing
emails them now. That is the real cost of this change.

### What was deleted, and why the entry point and not just the cron

Only the three `api/*.js` entry points, plus their three `vercel.json` cron entries in the
same commit.

**Removing a cron entry does not disable a worker.** There is no auth anywhere in this
repo — no `CRON_SECRET`, no `x-vercel-cron` check, no `Authorization` check — and each
`api/*.js` ran a real send on any `GET`. Unscheduling alone would have left three live,
unauthenticated URLs still capable of sending real marketing email to anyone who opened
them. Deleting the entry points is what actually turns them off: the endpoints are gone,
so they can no longer be triggered by URL.

### Restoring one

The three worker directories are **untouched** and still hold all their logic — that is
where reversibility lives. A restore is two small pieces:

1. Recreate `api/<worker-name>.js` re-exporting the worker:
   ```js
   module.exports = require('../abandonment-job-email/index.js');
   ```
   (`abandonment-job-email-2` used a longer handler calling its exported `run()`; recover
   the exact file from history — `git log --diff-filter=D --stat -- api/`.)
2. Add its entry back to the `crons` array in [`vercel.json`](./vercel.json), then redeploy.

`abandonment-job-email-2` also needs its `getSentJobId` bug fixed before it can do anything
but 500 — `sent-tracker.js` needs a reader that returns the stored `jobId`.

---

## Setup

```bash
git clone https://github.com/gregdavies-star/standout-email-workers.git
cd standout-email-workers/abandonment-anon-lead-email
npm install
cp .env.example .env   # then fill in the values
```

### Environment variables

These configure `abandonment-anon-lead-email/`, the only worker that still runs.
`abandonment-anon-lead-email/.env.example` is the full annotated list; the core ones:

| Variable                      | Purpose                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `SUPABASE_URL`                | Supabase project URL                                          |
| `SUPABASE_SERVICE_KEY`        | Service role key (read access is all that's needed)           |
| `BREVO_API_KEY`               | Brevo API key                                                 |
| `BREVO_TEMPLATE_ID_ANON_LEAD` | Brevo template for the **1h** email (stage `first`)           |
| `BREVO_TEMPLATE_ID_ANON_LEAD_24H` | Brevo template for the **24h** email (stage `day1`)       |
| `BREVO_TEMPLATE_ID_ANON_LEAD_48H` | Brevo template for the **48h** email (stage `day2`)       |
| `EMAIL_STAGE`                 | Which email this invocation sends: `first` (default), `day1`, `day2`. One cron entry per stage. An unknown value fails the run rather than guessing. |
| `KV_ENV_PREFIX`               | Namespaces the KV keyspace. **Leave unset in production. Set it in staging** — see below. |
| `ANTHROPIC_API_KEY`           | Anthropic key for match-pitch generation                      |
| `STANDOUT_APP_URL`            | Base URL for the `/your-match` landing page                   |
| `EMAIL_LINK_SECRET`           | HMAC secret for the lead token — must match the main app's    |
| `KV_REST_API_URL` / `_TOKEN`  | Vercel KV send-once dedup. **Required on Vercel** (fail-closed)|
| `DRY_RUN`                     | `true` (default) logs only; `false` sends live emails. Scoped to this worker alone — the retired workers read their own copies of it and no longer run. |

### The sequence, and running it in staging

One worker, three emails, selected by `EMAIL_STAGE`. Each stage sends to leads
whose survey settled `delayMs` ago — `first` at 1h, `day1` at 24h, `day2` at 48h
— so each hourly run considers exactly one one-hour slice of surveys per stage
and the cohorts never overlap. Stage definitions live in `stages.js`; adding an
email means adding an entry there plus its Brevo template. The 72h discount
email is deliberately absent: it is blocked on Stripe coupon infrastructure.

Two rails you should know about before touching this:

- **`stages.first.kvKey` is `anon_lead_sent`, not `anon_lead_1h_sent`.** The
  implementation spec says otherwise and the spec is wrong. Renaming it makes
  every lead ever mailed look unmailed, and the 1h email re-fires across the
  entire history on the next tick. `stages.test.js` asserts the exact string.
- **A real run refuses to start without a template for its stage.** A dry run
  warns instead, which is how you rehearse a stage before its template exists.

**Staging must set `KV_ENV_PREFIX`.** Vercel only fires crons on production
deployments, so a staging run is a manual invocation — and without an
environment prefix it writes into production's keyspace, marks real leads as
sent, and silently suppresses the production email they were owed. Nothing
downstream reports that; the lead simply never hears from us again. A staging
run should set `KV_ENV_PREFIX`, `DRY_RUN=true` and a `TARGET_EMAILS` allowlist.
The Supabase key is read-only, so pointing staging at production data is safe
once those three are in place.

```bash
EMAIL_STAGE=day1 KV_ENV_PREFIX=staging DRY_RUN=true \
  TARGET_EMAILS=qa@example.com node index.js
```

Tuning and operational vars (`BACKFILL_DAYS`, `SEND_CAP`, `MATCH_CONCURRENCY`,
`RUN_BUDGET_MS`, `MATCH_ROLE_FANOUT`, `TARGET_EMAILS`) are documented in their own sections
above.

---

## Run locally (dry run)

Dry run is the default. It logs every email it *would* send, makes **no** Brevo calls, and
does **not** touch KV:

```bash
cd abandonment-anon-lead-email
DRY_RUN=true node index.js
```

You'll see lines like:

```
[DRY RUN] Would send to: jane@example.com — Job: Sales Associate at Instacart (88% match, Posted 2 days ago)
[DRY RUN] Brevo params: { ... }
[DRY RUN COMPLETE] Would send 3 of 4 eligible
```

To send for real locally, set `DRY_RUN=false` in `.env`.

---

## Deploy to Vercel

The repo is Vercel-ready. The one remaining cron lives in [`vercel.json`](./vercel.json)
and runs hourly (`0 * * * *`), hitting the serverless handler at
`/api/abandonment-anon-lead-email` (given 300s of `maxDuration` by the `functions` block).

1. Import the repo into Vercel.
2. Add every variable from `abandonment-anon-lead-email/.env.example` under **Project →
   Settings → Environment Variables**. Keep `DRY_RUN=true` for the first deploys.
3. Deploy. The cron will appear under **Project → Cron Jobs**.

### Flip to live sends

When you're confident in the dry-run output, set `DRY_RUN=false` in the Vercel
environment variables and redeploy.

> **Note on dedup state:** dedup is **Vercel KV**, not a file — the old `sent.json` scheme
> did not survive Vercel's ephemeral filesystem. Bind `KV_REST_API_URL` /
> `KV_REST_API_TOKEN` before any live send; without them the worker fails closed on Vercel
> rather than re-mailing the same leads hourly (see the fail-closed dedup guard above).

---

## Error handling

- **Supabase query fails** → log and abort the run.
- **Match-pitch generation fails** → fall back to 3 generic reasons from the role/intent
  labels (no AI call).
- **Brevo send fails for one user** → log, skip that user, continue. A single user never
  crashes the whole run.

## File layout

```
standout-email-workers/
├── abandonment-anon-lead-email/          the one live worker
│   ├── index.js          entry point / orchestrator + Vercel handler export
│   ├── queries.js        all Supabase reads (audience, exclusions, matching)
│   ├── brevo.js          Brevo send logic
│   ├── sent-tracker.js   Vercel KV send-once dedup (no DB writes)
│   ├── lead-token.js     signed 14-day lead token minting
│   ├── match-reason.js   AI-generated match pitch with fallback
│   ├── *.test.js         node --test suites
│   ├── .env.example
│   └── package.json
├── abandonment-job-email/                retired 2026-08-13 — no endpoint, no cron
├── abandonment-job-email-2/              retired 2026-08-13 — no endpoint, no cron
├── abandonment-job-email-resume-trigger/ retired 2026-08-13 — no endpoint, no cron
├── api/
│   └── abandonment-anon-lead-email.js   Vercel serverless route → worker
├── vercel.json           cron schedule + function maxDuration
└── README.md
```
