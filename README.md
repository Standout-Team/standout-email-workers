# Standout Email Workers

Standalone email automation workers for [Standout](https://standout.jobs). Each worker
lives in its own directory, reads from the production Supabase database (read-only), and
never touches the main Standout app codebase.

## Workers

`cart-recovery/` is the only worker with a live endpoint and cron (since 2026-09-23). Every
earlier flow, including `abandonment-anon-lead-email/` (4h/24h/48h/72h) and
`post-apply-followup-email/`, is switched off: their `api/` entry points and crons were
removed. Their code is still in-tree for reference; `cart-recovery/` reuses a few pure
helpers from `abandonment-anon-lead-email/queries.js`.

### `cart-recovery/`

One hourly cron (`/api/cart-recovery`, minute 5) runs a six-email discount sequence for
everyone who uploaded a resume and opted in to marketing but has not paid, whether or not
they reached checkout. Anonymous leads are mailed at their resume email; registered
(non-anonymous) accounts at their account email.

| Email | When (recipient local time) | Offer | Link expires |
| --- | --- | --- | --- |
| e1 | T = upload + 1h | $10 first month, then $40/mo | deadline1 |
| e2 | T + 5h | same | deadline1 |
| e3 | day 1, 10:00 | same | deadline1 |
| e4 | day 1, 17:00 | same | deadline1 |
| e5 | day 2, 17:00 ("ends tonight") | same | deadline1 = day 2, 23:59 |
| e6 | day 5, 16:00 | "9 months free": $40 first year, then $160/yr | deadline2 = e6 + 48h |

Every send is pushed out of 21:00–08:00, spaced at least 4h apart, retried for 3h, and
skipped if it can no longer go out before its deadline. Links go to
`/special-offer?t=<signed recovery token>` on the app, which prices from the token and
refuses expired links at checkout. Deterministic 15% holdout by email hash. One enrollment
per address per 60 days (KV namespace `cr1:`).

Env: `CART_RECOVERY_ENABLED` (must be `true`), `DRY_RUN` (anything but `false` counts
only), `CART_RECOVERY_CUTOVER` (ISO time; nothing created before it is eligible),
`EMAIL_LINK_SECRET` (same as the app), `BREVO_API_KEY`, `BREVO_TEMPLATE_ID_CR_E1..E6`,
`CRON_SECRET` (without it the endpoint only dry-runs), optional `CART_RECOVERY_TZ`
(default America/New_York), `CART_RECOVERY_HOLDOUT_PCT` (default 15),
`CART_RECOVERY_US_ONLY` (default off), `SEND_CAP` (default 500), `STANDOUT_APP_URL`.
Brevo params: `FIRSTNAME`, `OFFER_URL`, `DEADLINE`, `OFFER_FIRST_PRICE`,
`OFFER_RENEWAL_PRICE`, `FREE_APPLY_UNUSED`.

### `abandonment-anon-lead-email/`

An hourly cron worker that re-engages **anonymous** leads: they uploaded a resume, opted
in to marketing, hit the paywall and left without ever creating an account. There is no
account to magic-link them into, so every CTA carries a signed 14-day lead token that
`/your-match` trades for their restored survey + resume and **one free apply**.

Four emails, two of which sell a discount: the **4h** email offers 75% off the first month
of Pro Monthly, the **24h** email offers the free apply, the **48h** email shows the lead
their application already written, and the **72h** email offers 75% off the first year.
See [Two offers](#two-offers-4h-monthly-and-72h-annual).

Audience: `surveys` with `marketing_opt_in`, `user_id IS NULL`, a parsed resume carrying a
plausible email, created inside the run's window (below). Excludes existing `profiles`,
`marketing_suppressions`, and recent `paid` `pending_subscriptions`. A `created`-but-unpaid
checkout is **not** an exclusion — that lead abandoned too, and gets this email like any
other abandoner. The featured job comes from the production `match_jobs_for_survey` RPC and
is dropped if it closed or went stale (>3 days).

**Free-apply grants** are a stage-specific exclusion, and only one stage's:

| Grant state | `first` (4h) | `day1` (24h) | `day2` (48h) | `day3` (72h) |
| --- | --- | --- | --- | --- |
| No grant | sends | sends | sends | sends |
| Claimed, `redeemed_at IS NULL` | sends | sends | sends | sends |
| **Redeemed** (`redeemed_at IS NOT NULL`) | sends | **excluded** | sends | sends |

*Claiming* the free apply happens on `/your-match`, which is where the 4h email's own CTA
lands too, so it excludes nothing anywhere — **clicking the 4h email must not end the
sequence** (owner decision **2026-08-21**, which removed `free_apply_grants` as a blanket
exclusion; the 4h email's CTA changed on 2026-09-09 but the rule did not). Note that the
4h **offer** click does not claim the survey either: `/your-match?offer=monthly75` binds
`surveys.user_id` only when the lead actually **pays**, on the Stripe webhook. A lead who
clicks the offer and doesn't buy keeps `user_id IS NULL` and therefore stays in the `day1`
audience — which is the point, since the 24h email is the one that offers them the free
apply. A lead who *does* buy drops out of every later stage on the base `user_id IS NULL`
predicate, with the `profiles` exclusion and the pre-dispatch paid re-check behind it.
*Redeeming* it means the lead actually applied, and `post-apply-followup-email/` mails them
**template 42** 24–25h later with a pick-a-plan CTA. Template 43 would land beside it, so
the redeemed lead's 24h touch belongs to template 42 and `day1` stands down (owner
decision **2026-08-24**). `day2` is untouched, so an applier who still hasn't purchased
gets the 48h tailored nudge at its normal time, and so is `day3` — a lead who used their
free apply and still didn't buy is precisely the audience for the 72h offer.

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

By default each stage only looks at its own slice: the `spanMs`-wide window that ended
`delayMs` ago — **4–7 hours ago** for stage `first`, 24–27h for `day1`, and so on. An
hourly cron over a 3-hour-wide window means each survey is considered three times (the
retry budget in `stages.js`) and the KV sent-tracker is what keeps that to one email. To
reach abandoners from *before* the worker went live, set two env vars on the Vercel
project. **The cron itself never changes.**

| Variable | Effect |
| --- | --- |
| `BACKFILL_DAYS` | Widens the window to `[now − N days, now − delayMs]`. Integer **1–30**; out-of-range clamps, anything invalid logs a warning and runs the normal window. The backfill window is a *superset* of the normal one — same upper bound — so new abandoners keep being covered while the backlog drains. |
| `SEND_CAP` | Max real sends per run. Defaults to **50** in backfill mode, uncapped in normal mode. Candidates past the cap are left for the next hourly run. |

1. Set `BACKFILL_DAYS=14` (optionally `SEND_CAP`) with **`DRY_RUN=true`**, and redeploy.
2. Read the next hourly run's logs. It prints the mode, the exact window bounds, and the
   cohort — e.g. `312 eligible after exclusions — 0 already sent, 312 remaining, 50
   selected this run (cap=50, 262 left for later runs)` — then
   `[DRY RUN COMPLETE] Would send 50 of 312 eligible`. The cohort line lands *before* the
   per-lead work, so you get the count even if the dry run is slow.
3. Sanity-check the count and the self-check lines. Every dry run prints `JOB_URL`,
   `MATCHES_URL`, the decoded token payload and — on the two stages that carry an offer —
   `OFFER_URL`. On the 4h stage that line is the one to read closely: it is the only link
   in the sequence carrying both a lead token and an offer flag, so it must contain `t=`
   *and* `offer=monthly75`. Then set `DRY_RUN=false` and redeploy.
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
| `TARGETED MODE: N target(s) dropped by the exclusion set` | They have a profile, are suppressed, have bought through the 4h offer (which binds `surveys.user_id`, so their survey stops matching the audience at all), or have a paid checkout in the last 7 days — **and, on `day1` only**, they have already *redeemed* a free apply, whose 24h touch belongs to the post-apply follow-up (template 42) instead (2026-08-24). Merely *claiming* a grant is **not** an exclusion at any stage (2026-08-21), and `day2` still sends to appliers. The `day1` log line names the extra reason. |
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
| `BREVO_TEMPLATE_ID_ANON_LEAD` | Brevo template for the **4h** offer email (stage `first`) — **new template, set via `BREVO_TEMPLATE_ID_ANON_LEAD`**; 39 stays as the retired 1h free-apply email |
| `BREVO_TEMPLATE_ID_ANON_LEAD_24H` | Brevo template for the **24h** email (stage `day1`) — id **43** |
| `BREVO_TEMPLATE_ID_ANON_LEAD_48H` | Brevo template for the **48h** email (stage `day2`) — id **44** |
| `BREVO_TEMPLATE_ID_ANON_LEAD_72H` | Brevo template for the **72h** offer email (stage `day3`) — id **set when created**. Until it is set the stage refuses every real run, which is how it stays dark until the template exists. |
| `TAILORING_ENDPOINT_URL` / `_SECRET` | The 48h email's tailored bullets. **Required** for a real `day2` run; a dry run warns and continues. |
| `EMAIL_STAGE`                 | Fallback stage for the default entrypoint. **Normally unset** — each stage has its own `api/` file that names its stage directly (see below). Useful for a local run. An unknown value fails the run rather than guessing. |
| `KV_ENV_PREFIX`               | Namespaces the KV keyspace. **Leave unset in production. Set it in staging** — see below. |
| `ANTHROPIC_API_KEY`           | Anthropic key for match-pitch generation                      |
| `STANDOUT_APP_URL`            | Base URL for the `/your-match` landing page                   |
| `EMAIL_LINK_SECRET`           | HMAC secret for the lead token — must match the main app's    |
| `KV_REST_API_URL` / `_TOKEN`  | Vercel KV send-once dedup. **Required on Vercel** (fail-closed)|
| `DRY_RUN`                     | `true` (default) logs only; `false` sends live emails. Scoped to this worker alone — the retired workers read their own copies of it and no longer run. |

### Brevo templates

| Stage | Template | Subject |
| --- | --- | --- |
| `first` | **new template**, set via `BREVO_TEMPLATE_ID_ANON_LEAD` | the 4h "we found the best job for you" email, CTA = 75% off month one — see [Two offers](#two-offers-4h-monthly-and-72h-annual) |
| `day1` | **43** | Hey `{{FIRST_NAME}}`, `{{COMPANY_NAME}}` is looking for someone like you |
| `day2` | **44** | `{{FIRST_NAME}}`, your application to `{{COMPANY_NAME}}` is already written |
| `day3` | **set when created** (not built yet) | the 75%-off-first-year offer — see [Two offers](#two-offers-4h-monthly-and-72h-annual) |

**Template 39 is retired**, not repointed. It is the 1h free-apply email; the
4h email keeps its value prop but swaps its primary CTA for the monthly offer,
so it is a new template and `BREVO_TEMPLATE_ID_ANON_LEAD` must be pointed at
it. 39 stays in Brevo as the record of what the 1h email said — leave it alone.

43, 44 and the new 4h template are built from 39's own stylesheet so the
sequence reads as one system, and the 72h template should be too. Every
`{{ params.X }}` in them is a param `buildPayload` actually sends — a token the
worker does not send renders empty, silently, which is how a half-rendered
email ships. The offer params are:

| Param | 4h (`first`) | 72h (`day3`) |
| --- | --- | --- |
| `OFFER_PERCENT` | `75` | `75` |
| `OFFER_URL` | `/your-match?t=…&offer=monthly75&…` — **token-bearing** | `/comeback?…` — no token |
| `OFFER_FIRST_PRICE` | `$10` | *not sent* |
| `OFFER_RENEWAL_PRICE` | `$40/mo` | *not sent* |

`day1` and `day2` receive **none** of them — a stage without an offer sends no
`OFFER_*` param at all rather than an empty one, and that rule is per param, so
the 72h template must not reference the two price tokens it does not receive
(its annual figures are its own copy). Both offer templates still receive
`JOB_URL` / `MATCHES_URL` for the "see your match" link.

All of them carry the same footer, corrected 2026-08-21:

- **The privacy link.** 39 pointed at `standout.jobs/privacy` for an unknown
  length of time. The domain resolves but refuses connections, so every
  abandonment lead who clicked "Privacy Policy" got an error page. Now
  `www.usestandout.today/privacy`.
- **The consent line.** 39 said "you created a Standout account". These leads
  have no account — they uploaded a resume. All three now say that.

Both use `{{ unsubscribe }}`, Brevo's own token, rather than a param — an
unsubscribe URL passed as a param is only as reliable as the sender
remembering to pass it.

**Template 40** ("Abandonment Email 2 (24hr Nurture)", inactive) predates this
work and is NOT wired up. It expects `MATCH_COUNT`, `TIME_SINCE_SIGNUP` and
`UNSUBSCRIBE_URL` — none of which this worker sends, so its unsubscribe link
would render empty. Use 43.

### The sequence, and running it in staging

One worker, four emails, selected by `EMAIL_STAGE`. Each stage sends to leads
whose survey settled `delayMs` ago — `first` at 4h, `day1` at 24h, `day2` at
48h, `day3` at 72h — so each hourly run considers exactly one slice of surveys
per stage and the cohorts never overlap. Every stage's window is `spanMs` = 3h
wide, a retry budget rather than a cohort size: a lead a run defers is left
unmarked, so the next two hourly ticks can pick it up. Stage definitions live
in `stages.js`; adding an email means adding an entry there plus its Brevo
template. The 72h discount email was deliberately absent until 2026-08-27; its
coupon blocker is resolved by reusing the product's live retargeting offer
(below) rather than minting new coupon infrastructure.

Two rails you should know about before touching this:

- **`stages.first.kvKey` is `anon_lead_sent`, not `anon_lead_1h_sent`.** The
  implementation spec says otherwise and the spec is wrong. Renaming it makes
  every lead ever mailed look unmailed, and the first email re-fires across the
  entire history on the next tick. `stages.test.js` asserts the exact string.
  It survived the 4h cut-over unchanged, deliberately — see below.
- **A real run refuses to start without a template for its stage.** A dry run
  warns instead, which is how you rehearse a stage before its template exists.

#### Cut-over: 1h → 4h (stage `first`)

Stage `first` was the **1h** free-apply email until 2026-09-09. It is now the
**4h** monthly-offer email, on a new Brevo template, with `spanMs` widened from
1h to the 3h retry budget every other stage already had. Three things to know
on the deploy:

- **Leads already mailed under the 1h regime get nothing.** `kvKey` did not
  move, so their send-once receipt still dedupes them and no one receives a
  second first-stage email. This is the single reason that key is untouchable.
- **Leads younger than 1h at deploy get the 4h email** when they age into the
  new window. Nothing is lost at the boundary.
- **Set `SEND_CAP` for the first run.** Widening the span means everyone whose
  survey settled between 4h and 7h ago is in range at once — a one-off catch-up
  cohort of up to ~3× a normal hourly cohort, none of it deduped, because those
  leads aged past the old 1h-wide window while it was still 1h wide. From the
  second tick on, every survey in the window has already been seen and the KV
  receipt carries it, so the cap can come back off.

**One entrypoint per stage, and it has to be that way.** A Vercel cron entry
carries only a `path` and a `schedule` — there are **no per-cron environment
variables**. Four crons pointed at one path would therefore all run whatever
`EMAIL_STAGE` happened to be, silently mailing one stage's copy four times a
day instead of running the sequence. So each stage gets a thin file under
`api/` that names its stage in code, where it cannot be misconfigured:

| Cron path | Stage | Schedule |
| --- | --- | --- |
| `/api/abandonment-anon-lead-email` | `first` (4h) | `0 * * * *` |
| `/api/abandonment-anon-lead-email-72h` | `day3` (72h) | `10 * * * *` |
| `/api/abandonment-anon-lead-email-24h` | `day1` (24h) | `20 * * * *` |
| `/api/abandonment-anon-lead-email-48h` | `day2` (48h) | `40 * * * *` |

Staggered so the runs never contend for the same match RPCs — the vector search
is the shared resource, and the 2026-08-13 timeout incident is what a pile-up
looks like. `:00`, `:20` and `:40` were taken by the three original stages and
`:50` by `post-apply-followup-email`, so the 72h email takes `:10`, which keeps
the four match-RPC consumers at least ten minutes apart.

A manual invocation can also pass `?stage=day1`, which is how staging picks a
stage without a redeploy. An unknown value fails the request rather than
falling back to stage `first`.

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

### Two offers: 4h monthly and 72h annual

Two of the four emails carry a discount, and they are **not** the same offer.
Both happen to be 75% off a first term; they sell different cadences on
different landing pages, and each has its own parity rule.

| | **4h** (`first`) | **72h** (`day3`) |
| --- | --- | --- |
| Sells | 75% off the first **month** of Pro Monthly | 75% off the first **year** of the annual plan |
| Copy must say | "$10 for month one, then $40/mo" | "first year" ($40 year one, renewing at the $160 sticker) |
| Lands on | `/your-match` — the sequence's own landing page | `/comeback` — the live paid-retargeting page |
| Lead token | **yes** (`t=…`) | no |
| Flag the app reads | `offer=monthly75` | — (the page *is* the offer) |
| `utm_campaign` | `abandonment_4h_offer` | `abandonment_72h` |

Full 4h offer URL:

```
<STANDOUT_APP_URL>/your-match?t=<lead token>&offer=monthly75
  &utm_source=brevo&utm_medium=email&utm_campaign=abandonment_4h_offer&utm_content=first
```

#### Where each number lives

| Piece | Where it lives | What it does |
| --- | --- | --- |
| `stages.first.offer` | `abandonment-anon-lead-email/stages.js` | `{ percent: 75, path: '/your-match', tokenized: true, param: 'monthly75', firstTermPrice: '$10', renewalPrice: '$40/mo', cadence: 'month' }` — the only place this worker states the monthly figures |
| `stages.day3.offer` | same file | `{ percent: 75, path: '/comeback' }` — the only place it states the annual percent |
| `OFFER_PERCENT` / `OFFER_URL` / `OFFER_FIRST_PRICE` / `OFFER_RENEWAL_PRICE` | `buildPayload` in `index.js` | sent **only** for a stage carrying an `offer`, and only the params that stage actually states. `index.js` contains no percent and no price of its own |
| `LEAD_OFFER_DISCOUNT_PERCENT` | Standout-pro `shared/retarget-offer.ts` | `= 75`; `/your-match?offer=monthly75` renders the monthly offer from it, against the pro_monthly **Group A** sticker ($40/mo → $10 month one) |
| `RETARGET_DISCOUNT_PERCENT` | same file | `= 75`; `/comeback` renders its annual prices from it |
| `STRIPE_COUPON_LEAD_OFFER_75` | Standout-pro Vercel env (optional) | the Stripe coupon actually charged on the **monthly** path — "Brevo_Anon_Lead_75% off", id `b0XANPC4`, 75% off / `duration=once`. The env var only overrides it; unset, the checkout route uses that id. It **hard-fails (503)** rather than quietly charging full price if the var is set to an empty value |
| `STRIPE_COUPON_RETARGET_75` | Standout-pro Vercel env | the Stripe coupon actually charged on the **annual** path — a *different* coupon, so ending either campaign leaves the other alone. Both `/comeback` checkout routes **hard-fail (503)** when it is unset rather than quietly charging full price |

**Each percent is one number in three places, and they must not drift.** The
email advertises it, the landing page renders prices from it, Stripe charges
it. If `stages.first.offer.percent` diverges from `LEAD_OFFER_DISCOUNT_PERCENT`
or from the "Brevo_Anon_Lead_75% off" coupon's `percent_off` (or its prices
from the pro_monthly Group A sticker), or `stages.day3.offer.percent`
from `RETARGET_DISCOUNT_PERCENT` or `STRIPE_COUPON_RETARGET_75`'s
`percent_off`, the lead is shown one number and billed another — the failure
mode both codebases treat as unacceptable. Change all three in the same sitting
or none of them.

**The two rules are independent.** They share the number 75 today and are still
two parity rules against two different product surfaces — down to a Stripe
coupon each ("Brevo_Anon_Lead_75% off" for the 4h monthly offer,
`STRIPE_COUPON_RETARGET_75` for the 72h annual one). Do not collapse them
into one constant, in either repo, or one coupon in Stripe, or a change to the
monthly offer silently moves the annual one.

**The 4h link is the only tokenized offer link.** `/your-match` is the same page
the rest of the sequence's CTAs land on, so the offer click keeps the lead's
restored survey, resume and match on the screen — a warm click. The app reads
`offer=monthly75` off the query string to render the monthly offer there.
Buying binds `surveys.user_id` on the Stripe webhook, which is what drops the
lead out of every later stage; **clicking without buying binds nothing**, so a
non-payer stays in the `day1` audience and still gets the free-apply email at
24h.

**The 72h link carries no token.** `/comeback` does not consume one, so signing
a credential into a URL that cannot use it would be pointless. The
token-bearing `JOB_URL` / `MATCHES_URL` are in both payloads, so either
template can keep a secondary "see your match" CTA.

**Annual only, on the 72h path.** A 75%-off monthly term on the annual plan
would be a $10 charge on a plan that renews at $40, so the product pins the
plan to `pro_yearly` **server-side** on that checkout source and rejects
anything else. The 72h copy therefore has to say **"first year"**. (The 4h
offer *is* the monthly one, sold on its own checkout path — the two do not
share a source.)

Two tradeoffs on the 72h path, both accepted by the owner (2026-08-27) and
unchanged by the 4h offer:

- **`/comeback` is a cold funnel.** Unlike `/your-match`, it does not restore
  the lead's survey and resume — the buyer stays anonymous until `/welcome/:sid`
  after checkout, where the account-claim path binds the subscription. So the
  offer click loses the personalised context the rest of the sequence carries.
  The alternative was building a token-aware variant of a live, converting
  page; reusing it as-is is what makes this a workers-only change. (The 4h
  offer does not have this problem — it lands on the warm page.)
- **Checkout attribution shares the paid-retargeting source.** Both this email
  and the retargeting ads land on the same `retarget_offer` checkout source, so
  Stripe-side they look alike. Email traffic is still separable in analytics by
  `utm_campaign=abandonment_72h`, which no ad uses.

#### UTMs

Every CTA in every email carries `utm_source=brevo&utm_medium=email`, its
stage's own `utm_campaign`, and `utm_content=<stage id>`. Until 2026-09-09 all
four stages shared a single `anon_lead` campaign, so the sequence reported as
one undifferentiated blob and only the 72h `OFFER_URL` was separable; two
stages now sell different things, which makes per-stage attribution the point.

| Stage | `utm_campaign` | `utm_content` |
| --- | --- | --- |
| `first` | `abandonment_4h_offer` | `first` |
| `day1` | `anon_lead_24h` | `day1` |
| `day2` | `anon_lead_48h` | `day2` |
| `day3` | `abandonment_72h` | `day3` |

`abandonment_72h` is deliberately the value it already was, so the separability
claim above keeps holding. `utm_content` is additive and nothing parses it.

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
[DRY RUN] JOB_URL: https://www.usestandout.today/your-match?t=<token>&utm_source=brevo&utm_medium=email&utm_campaign=abandonment_4h_offer&utm_content=first
[DRY RUN] MATCHES_URL: https://www.usestandout.today/your-match?t=<token>&utm_source=brevo&utm_medium=email&utm_campaign=abandonment_4h_offer&utm_content=first&next=matches
[DRY RUN] OFFER_URL: https://www.usestandout.today/your-match?t=<token>&offer=monthly75&utm_source=brevo&utm_medium=email&utm_campaign=abandonment_4h_offer&utm_content=first
[DRY RUN] token payload: {"v":1,"typ":"lead","sv":4242,"jb":99001,"exp":1790169361}
[DRY RUN] Brevo params: { ... }
[DRY RUN COMPLETE] Would send 3 of 4 eligible
```

The `OFFER_URL` line appears only on the two stages that carry an offer. On the
4h stage it is the one to read: it must carry both `t=` and `offer=monthly75`.

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
├── api/                                  one thin entrypoint per stage
│   ├── abandonment-anon-lead-email.js       `first` (4h offer)
│   ├── abandonment-anon-lead-email-24h.js   `day1`  (24h)
│   ├── abandonment-anon-lead-email-48h.js   `day2`  (48h)
│   └── abandonment-anon-lead-email-72h.js   `day3`  (72h offer)
├── vercel.json           cron schedule + function maxDuration
└── README.md
```
