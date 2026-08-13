# Standout Email Workers

Standalone email automation workers for [Standout](https://standout.jobs). Each worker
lives in its own directory, reads from the production Supabase database (read-only), and
never touches the main Standout app codebase.

## Workers

### `abandonment-job-email/`

An hourly cron worker that re-engages free users who signed up but went quiet. It:

1. Finds free users (no active/trialing subscription) who registered **1+ hour ago** and
   have a parsed resume.
2. Picks the single **best untouched job match** for each from their existing match queue
   — highest `pct`, excluding the rank 0/1/2 jobs already shown in-app, and only jobs seen
   in the last 7 days.
3. Generates 3 specific "why you match" bullet points with Claude Haiku (with a graceful
   non-AI fallback).
4. Sends a transactional email via a Brevo template.

State is tracked **only** in a local `sent.json` file — the worker performs **zero writes
to Supabase**.

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
| `TARGETED MODE: N target(s) dropped by the exclusion set` | They have a profile, are suppressed, have a paid checkout in the last 7 days, or already hold a free-apply grant. |
| `TARGETED MODE: N target(s) were already mailed` | The sent-tracker is one-send-per-lead-email **forever**, and targeting does not reset it. |
| `No open matches within 30d for <email>` | No fresh, open job match — nothing to feature. |
| `TARGET_EMAILS parsed to ZERO valid addresses` | Every entry was junk. The run is fail-closed (it mails nobody), not open. |

---

## Setup

```bash
git clone https://github.com/gregdavies-star/standout-email-workers.git
cd standout-email-workers/abandonment-job-email
npm install
cp .env.example .env   # then fill in the values
```

### Environment variables

| Variable               | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `SUPABASE_URL`         | Supabase project URL                                           |
| `SUPABASE_SERVICE_KEY` | Service role key (read access is all that's needed)            |
| `BREVO_API_KEY`        | Brevo API key                                                  |
| `BREVO_TEMPLATE_ID`    | ID of the Brevo transactional template (placeholder until made)|
| `ANTHROPIC_API_KEY`    | Anthropic key for match-pitch generation                       |
| `STANDOUT_APP_URL`     | Base URL for job/matches links (default `https://standout.jobs`)|
| `DRY_RUN`              | `true` (default) logs only; `false` sends live emails          |

> The Brevo template does not exist yet. Leave `BREVO_TEMPLATE_ID` as a placeholder while
> testing in dry-run mode — the worker fails with a clear error if a live send is attempted
> without it.

---

## Run locally (dry run)

Dry run is the default. It logs every email it *would* send, makes **no** Brevo calls, and
does **not** write to `sent.json`:

```bash
cd abandonment-job-email
DRY_RUN=true node index.js
```

You'll see lines like:

```
[DRY RUN] Would send to: jane@example.com — Job: Sales Associate at Instacart (rank 5, 88% match, Posted 2 days ago)
[DRY RUN] Brevo params: { ... }
[DRY RUN COMPLETE] Would have sent 3 emails (1 skipped).
```

To send for real locally, set `DRY_RUN=false` in `.env`.

---

## Deploy to Vercel

The repo is Vercel-ready. The cron schedule lives in [`vercel.json`](./vercel.json) and
runs hourly (`0 * * * *`), hitting the serverless handler at
`/api/abandonment-job-email`.

1. Import the repo into Vercel.
2. Add every variable from `.env.example` under **Project → Settings → Environment
   Variables**. Keep `DRY_RUN=true` for the first deploys.
3. Deploy. The cron will appear under **Project → Cron Jobs**.

### Flip to live sends

When you're confident in the dry-run output, set `DRY_RUN=false` in the Vercel
environment variables and redeploy.

> **Note on dedup state:** `sent.json` is local to the running instance and is gitignored.
> On Vercel's ephemeral filesystem it will not persist reliably across invocations, so it
> is suitable for local runs and early testing. The intended long-term migration is to
> track sends in the database via an `abandonment_email_sent_at` column on `profiles`,
> replacing the `sent-tracker.js` file logic with a Supabase read/write.

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
├── abandonment-job-email/
│   ├── index.js          entry point / orchestrator + Vercel handler export
│   ├── queries.js        all Supabase reads
│   ├── brevo.js          Brevo send logic
│   ├── sent-tracker.js   local file-based dedup (no DB writes)
│   ├── match-reason.js   AI-generated match pitch with fallback
│   ├── .env.example
│   └── package.json
├── api/
│   └── abandonment-job-email.js   Vercel serverless route → worker
├── vercel.json           cron schedule
└── README.md
```
