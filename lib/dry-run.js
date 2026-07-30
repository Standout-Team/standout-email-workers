/**
 * lib/dry-run.js
 *
 * Strict DRY_RUN parsing.
 *
 * The old implementation was `String(process.env.DRY_RUN).toLowerCase() !== 'false'`,
 * which is safe-by-default but silently swallowed typos: `DRY_RUN=FLASE`,
 * `DRY_RUN=0`, `DRY_RUN=no` all read as "dry run", so an operator who *meant*
 * to go live would see months of green "sent N emails" dashboards with zero
 * real sends. The inverse mistake is worse, so we still default to dry-run when
 * unset — but we shout about it, and we refuse to guess at anything else.
 *
 *   'false'        -> false (live sends)
 *   'true'         -> true  (dry run)
 *   unset / empty  -> true  + console.warn
 *   anything else  -> throw
 */

function isDryRun() {
  const raw = process.env.DRY_RUN;

  if (raw === undefined || raw === null || String(raw).trim() === '') {
    console.warn('[dry-run] DRY_RUN is not set — defaulting to DRY RUN (no emails will be sent).');
    return true;
  }

  const value = String(raw).trim().toLowerCase();
  if (value === 'false') return false;
  if (value === 'true') return true;

  throw new Error(
    `Invalid DRY_RUN value "${raw}". Must be exactly "true" or "false" (or unset, which means true).`
  );
}

module.exports = { isDryRun };
