# Cross-repo verification of REVIEW20260730 — Section 6 answers

**Date:** 2026-07-30
**Verified against:** `Standout-Team/Standout-pro` @ `claude/standout-pro-email-workers-pu7qj1` (tip of main, post-#345/#346)
**Method:** three independent read-only verification passes over the product repo, including a live
crypto round-trip between the workers' token signer and a transcription of the server verifier.

This answers the 11 open questions in Section 6 of the 2026-07-30 scalability & security review
(`REVIEW20260730.md`, produced in a workers-only session), and records the follow-on decisions
implemented on this branch.

---

## Verdicts

### 1. `/api/auth/email-link` contract — ✅ MATCHES
Exists at `server/routes.ts:2439` (public by design, behind `authLimiter` 10 req/60s/IP). Parses
exactly `?uid=<id>&t=<token>`, verifies via `verifyEmailToken`, checks `payload.uid === uid`, then
mints a fresh Supabase magic link and 302s. Reachable in prod via the `/api/(.*) → /api/index`
rewrite; `middleware.ts` never intercepts it. `uid` keyspace = `profiles.id` on both sides.

### 2. HMAC signing scheme — ✅ EXACT, byte-for-byte
Workers' `signEmailToken` is a faithful port of `server/lib/email-token.ts`: payload `{uid,
redirect, exp}` (exp in unix **seconds**), `b64url(JSON)` + `.` + `b64url(HMAC-SHA256(payloadB64))`,
untruncated, same `EMAIL_LINK_SECRET` env var. Confirmed by executing the worker signer against a
transcription of the server verifier — round-trip verifies, uid check passes. Server enforces no
max TTL; the workers' 7-day exp is accepted (product drip uses 14). Tokens are replayable until
`exp` (no nonce) — do not lengthen the TTL.

⚠️ **For Thai:** `EMAIL_LINK_SECRET` is also the admin-auth root when `ADMIN_SESSION_SECRET` is
unset (`server/lib/admin-auth.ts:66-77`, namespaced sha256 derivation). Set `ADMIN_SESSION_SECRET`
explicitly in the product's Vercel env **before** copying `EMAIL_LINK_SECRET` into the workers
project — otherwise a leak from the workers env also compromises admin sessions.

### 3. Redirect allowlisting — ✅ defense-in-depth present (shape check, not a path list)
`server/routes.ts:2446-2472`: beyond the HMAC, `redirect` must be a root-relative path — single
leading `/`, no `//`, no backslash — else it falls back to login. **Hard contract for the workers:**
any future redirect value violating that shape fails *silently* to the fallback. Both current
redirects (`/dashboard?...`, `/matches?...`) pass. Final destination must also be on Supabase Auth's
redirect allow-list (`docs/EMAIL_AUTOLOGIN_MAGIC_LINK.md:29-36`).

### 4. `match_jobs_for_survey` RPC — ✅ VERIFIED
Single signature `(p_survey_id INT, p_limit INT DEFAULT 50, p_fresh_days INT DEFAULT 21)`; latest
definition `migrations/20260709_04_match_jobs_for_survey_closed_at.sql` (byte-identical to
`server/match/match_jobs_for_survey.sql`). Returns `job_id` and `total_score`; outer
`ORDER BY total_score DESC LIMIT p_limit` guarantees `matches[0]` is the top match. Caveats:
- Returns **zero rows silently** when `survey_embedding IS NULL` (a real window — "Adjust search"
  nulls the embedding until re-embed completes).
- The product's callers use the 21-day default; Email 1's `p_fresh_days: 3` means the featured job
  often differs from the dashboard's #1. Email 2's count used 30 days (overstates the dashboard) —
  **changed to 21 on this branch**.

### 5. Match-% formula — ✅ EXACT PARITY
`clamp(round(70 + total_score * 28), 70, 98)` is character-identical to `server/routes.ts:1489-1492`
and `server/marketing/match-digest.ts:15-17` (which carries a keep-in-sync regression test). The
client has no independent formula. Note: this is now the *third* copy; any product change to the
projection must be mirrored here.

### 6. Schemas — ✅ all columns exist; ❌ one real mismatch found and fixed
All selected columns on `profiles`, `surveys`, `jobs` exist with expected types (`resume_parsed` is
jsonb with a top-level `name`; `salary_min/max` are `NOT NULL DEFAULT 0`, the `> 0` guard is
correct). **But `surveys.user_id` is NOT unique** — multiple surveys per user are routine (re-run
onboarding, `linkSurveysToUser` bulk-claims by session). The product always resolves to the newest
survey with a non-null embedding; the workers were taking an arbitrary row. **Fixed on this branch:**
surveys query now orders `id desc`, filters `survey_embedding NOT NULL`, keeps first per user.

### 7. Subscription statuses — ⚠️ DRIFTED (real paying-customer hole), fixed
`['active','trialing']` matches the product's entitlement gate exactly — but `subscription_status`
stores the raw Stripe enum, so `incomplete` (mid-3DS, reachable within the 1-2h window), `past_due`,
`unpaid`, `paused` were all treated as "free". Worse, **pay-first guest checkouts**
(`migrations/20260722_02_pending_subscriptions.sql`) leave the profile at `subscription_status =
NULL` until claim — paying customers would receive abandonment emails. **Fixed on this branch:**
exclude any non-null subscription status, any non-null Stripe subscription id / non-free plan, and
any email with a `pending_subscriptions.status = 'paid'` row.

### 8. Existing indexes — `surveys(user_id)` ✅ exists / `profiles(created_at)` ❌ did not
`surveys_user_id_idx` exists (`supabase/migrations/20260506000000_...:55` — note: the *other*
migrations dir). `profiles` had only its PK + email unique → the hourly eligibility query was a full
seq scan, ~48×/day. **Added on the Standout-pro side of this branch:** plain btree
`profiles_created_at_idx`. Deliberately **not** partial on `resume_parsed IS NOT NULL`: the resume
builder's debounced autosave churns `resume_parsed`, and an index predicate on it would disqualify
HOT updates — the exact trap in CLAUDE.md's hot-index rule (2026-07-14 incident). `created_at` is
write-once, never in a SET clause: HOT-safe.

### 9. Canonical app domain — ⚠️ Worker 1's fallback was DEAD, fixed
`standout.jobs` appears **nowhere** in the product repo. Canonical is
`https://www.usestandout.today` (SEO canonicals, sitemap, robots — PRs #346/#350 moved everything to
www; apex redirects). **Fixed on this branch:** both workers fall back to the www canonical via a
shared module, and trailing slashes on `STANDOUT_APP_URL` are trimmed (an untrimmed trailing slash
produced `//api/...`, which the Vercel rewrite does not match — dead links). Verify
`STANDOUT_APP_URL` is actually set in the workers' Vercel project.

### 10. Brevo templates 39 / 40 — ⚠️ 39 real & documented; 40 UNVERIFIED
Template 39 ("Abandoned User Job Recommendation") is documented in
`docs/EMAIL_AUTOLOGIN_MAGIC_LINK.md` (which also notes the sender wasn't built yet — these workers
are that sender). **Template 40 has zero references anywhere in the product.**
**For Thai — confirm in the Brevo dashboard:** template 40 exists, is transactional, expects
Worker 2's params (`FIRST_NAME`, `JOB_TITLE`, `COMPANY_NAME`, `JOB_LOCATION`, `WORK_TYPE`,
`MATCH_COUNT`, `TIME_SINCE_SIGNUP`, `JOB_URL`, `MATCHES_URL`), and **both** templates carry the
`{{ unsubscribe }}` footer (the product's marketing-over-transactional rule — without it, opt-outs
from these emails are impossible and never reach `marketing_suppressions`). Template 39 must also
guard `SALARY_RANGE` with `{% if %}` — it is omitted for most jobs (salary defaults to 0). The
hardcoded `|| '40'` fallback has been removed; `BREVO_TEMPLATE_ID_2` must be set explicitly.
The Brevo webhook must point at the **www** host (apex 307s and Brevo won't follow on POST —
`docs/EMAIL_MARKETING_BREVO.md:189`) or unsubscribes from these emails vanish.

### 11. Suppression / bounce data — ❌ table exists, workers ignored it; fixed
`public.marketing_suppressions` (`migrations/20260603_02`) — email-keyed (lowercased+trimmed on
write), presence = never marketing-email, written only by the secret-gated Brevo webhook
(`unsubscribed`, `hard_bounce`, `spam`, `blocked`, `invalid_email`). Every product send path
anti-joins it; the workers did not. Because the workers send via `/v3/smtp/email` (transactional),
Brevo's own blacklist does NOT block them. **Fixed on this branch:** both workers filter eligibility
against `marketing_suppressions` with emails normalized (lowercase+trim) on both sides —
`profiles.email` is stored as-supplied, the suppression table lowercased.

---

## Additional findings beyond the original review

- **Email-stream collision:** a Sunday signup can receive 4+ emails in ~48h across two systems that
  don't know about each other — Brevo welcome automation (T+0), Worker 1 (T+1h), Worker 2 (T+25h,
  same job by design), then the Monday `match-queue-build` + every-2-day match drip, which draws
  from the *same RPC on the same survey* and will frequently lead with the same job again (and
  re-send it after the weekly queue rebuild resets `sent_at`). All lanes share the
  `hello.usestandout.today` sending subdomain — this is a deliverability risk, not just UX.
  Worth a deliberate sequencing decision (e.g. engagement/recency gates like
  `MATCH_DIGEST_ACTIVE_DAYS`, or excluding abandonment recipients from the first drip).
- **`match-reason.js` fallback never personalizes:** it reads `job.role_label` / `job.intent_label`,
  which are not selected (and `intent_label` isn't a `jobs` column at all — it's server-derived), so
  the fallback always degrades to the generic string. Cosmetic; left as-is.
- **`JOB_AGE` uses `first_seen_at`** while the RPC's freshness is `last_seen_at`; a long-lived
  posting re-seen today renders no badge. Intentional semantics ("posted", not "still listed") —
  left as-is, documented here so nobody "fixes" it into claiming old jobs were posted today.
- **`MATCH_COUNT` is structurally capped at 20** (`p_limit: 20`, `.length`) — users with hundreds of
  matches are told "20". A count-only RPC or a cached count on the survey row would fix it; out of
  scope for this branch.
- **Worker rate-limit interaction:** magic-link clicks hit `authLimiter` (10 req/60s per IP);
  corporate NAT or mail-scanner prefetch bursts can 429 into a JSON error rather than a redirect.
  Support-ticket source at volume; product-side concern.

## Decisions implemented on this branch (summary)

Dedup/eligibility moved from Vercel KV + moving time windows to **Postgres state columns** on
`profiles` (`abandonment_email_1_sent_at`, `abandonment_email_1_job_id`,
`abandonment_email_2_sent_at`; migration `20260730_01` in Standout-pro) with atomic
claim-before-send (`UPDATE ... WHERE col IS NULL`) and claim-release on send failure. This single
change resolves the review's C3/C4 (duplicate sends, in-memory fallback), S2 (cron-drift gaps and
overlaps — eligibility is now self-healing after outages), and the S1 data-loss mode (an unprocessed
user is simply picked up next hour). KV is retained read-only as a transition guard for users
emailed pre-migration; removable after ~2026-08-01. See README for the full operational picture.
