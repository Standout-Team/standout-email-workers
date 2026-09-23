/**
 * schedule.js — pure, deterministic send schedule for one enrollment.
 *
 * T = the enrollment anchor: survey created_at + 1 hour (the "still unpaid an
 * hour after upload" abandonment point). The whole schedule is a function of
 * T and the recipient's timezone, so every hourly run recomputes the same due
 * times and retries can never move them.
 *
 *   e1  T
 *   e2  T + 5h                      (≥ 4h after e1)
 *   e3  day 1, 10:00 local          (≥ 4h after e2)
 *   e4  day 1, 17:00 local          (≥ 4h after e3)
 *   e5  day 2, 17:00 local          (≥ 4h after e4)
 *   deadline1  day 2, 23:59:59 local — end of the $10 offer (≥ 48h after T)
 *   e6  day 5, 16:00 local
 *   deadline2  e6 + 48h — end of the "9 months free" offer
 *
 * "day N" = N calendar days after T's local date. Every due time is pushed
 * out of quiet hours (before 08:00 → 08:00 same day; 21:00 or later → 08:00
 * next day). A stage whose due time lands at or after its offer's deadline is
 * dropped (null) rather than compressed.
 */

const HOUR = 60 * 60 * 1000;
const MIN_GAP_MS = 4 * HOUR;
const QUIET_START = 21; // local hour, exclusive end of the send window
const QUIET_END = 8; // local hour, start of the send window

/** Local wall-clock parts of an instant in `tz`. */
function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** UTC ms for a local wall-clock time in `tz` (handles DST by iteration). */
function zonedTimeToUtc(y, mo, d, h, mi, s, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, tz);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    const want = Date.UTC(y, mo - 1, d, h, mi, s);
    const diff = want - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/** Local calendar date `days` after the local date of `ms`. */
function addLocalDays(ms, days, tz) {
  const p = localParts(ms, tz);
  const base = new Date(Date.UTC(p.y, p.mo - 1, p.d + days));
  return { y: base.getUTCFullYear(), mo: base.getUTCMonth() + 1, d: base.getUTCDate() };
}

function atLocal(dateParts, h, mi, s, tz) {
  return zonedTimeToUtc(dateParts.y, dateParts.mo, dateParts.d, h, mi, s, tz);
}

/** Push an instant out of quiet hours. */
function clampToSendWindow(ms, tz) {
  const p = localParts(ms, tz);
  if (p.h < QUIET_END) return atLocal({ y: p.y, mo: p.mo, d: p.d }, QUIET_END, 0, 0, tz);
  if (p.h >= QUIET_START) return atLocal(addLocalDays(ms, 1, tz), QUIET_END, 0, 0, tz);
  return ms;
}

function isInSendWindow(ms, tz) {
  const h = localParts(ms, tz).h;
  return h >= QUIET_END && h < QUIET_START;
}

function computeSchedule(anchorMs, tz) {
  const day = (n) => addLocalDays(anchorMs, n, tz);
  const deadline1 = atLocal(day(2), 23, 59, 59, tz);

  const due = {};
  due.e1 = clampToSendWindow(anchorMs, tz);
  due.e2 = clampToSendWindow(Math.max(anchorMs + 5 * HOUR, due.e1 + MIN_GAP_MS), tz);
  due.e3 = clampToSendWindow(Math.max(atLocal(day(1), 10, 0, 0, tz), due.e2 + MIN_GAP_MS), tz);
  due.e4 = clampToSendWindow(Math.max(atLocal(day(1), 17, 0, 0, tz), due.e3 + MIN_GAP_MS), tz);
  due.e5 = clampToSendWindow(Math.max(atLocal(day(2), 17, 0, 0, tz), due.e4 + MIN_GAP_MS), tz);
  due.e6 = clampToSendWindow(atLocal(day(5), 16, 0, 0, tz), tz);
  const deadline2 = due.e6 + 48 * HOUR;

  const deadlines = { deadline1, deadline2 };
  const stages = {};
  for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) {
    stages[id] = due[id] < deadline1 ? { dueMs: due[id], expMs: deadline1 } : null;
  }
  stages.e6 = { dueMs: due.e6, expMs: deadline2 };
  return { anchorMs, tz, deadlines, stages };
}

/**
 * Human deadline for email copy, e.g. "Friday, Sep 25 at 11:59 PM EDT".
 */
function formatDeadline(ms, tz) {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(new Date(ms));
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms));
  return `${date} at ${time}`;
}

module.exports = {
  HOUR,
  MIN_GAP_MS,
  computeSchedule,
  clampToSendWindow,
  isInSendWindow,
  formatDeadline,
  localParts,
};
