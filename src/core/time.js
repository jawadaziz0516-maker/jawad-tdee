/**
 * time.js — calendar-date helpers.
 *
 * Days are identified by local-calendar ISO strings ("2026-08-04"), never by
 * timestamps. A body-weight reading belongs to the day you stepped on the
 * scale in your own timezone; UTC conversion would silently shift entries
 * across midnight and corrupt every rolling window downstream.
 *
 * @module core/time
 */

const MS_PER_DAY = 86400000;

/** Local calendar date of a Date object as "YYYY-MM-DD". */
export function toISODate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** "YYYY-MM-DD" → Date at local midnight. */
export function fromISODate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayISO() {
  return toISODate(new Date());
}

export function isValidISODate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return false;
  const d = fromISODate(iso);
  return Number.isFinite(d.getTime()) && toISODate(d) === iso;
}

/** Shift an ISO date by whole days (negative shifts backwards). */
export function addDays(iso, days) {
  const d = fromISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/**
 * Whole days from `a` to `b` (b − a). Computed on local midnights, so DST
 * transitions do not produce fractional days.
 */
export function daysBetween(a, b) {
  const da = fromISODate(a);
  const db = fromISODate(b);
  return Math.round((db - da) / MS_PER_DAY);
}

/** Inclusive list of every calendar date from `start` to `end`. */
export function enumerateDates(start, end) {
  const out = [];
  const n = daysBetween(start, end);
  for (let i = 0; i <= n; i++) out.push(addDays(start, i));
  return out;
}

/** Age in years on `onISO` for someone born on `birthISO`. */
export function ageOn(birthISO, onISO = todayISO()) {
  if (!isValidISODate(birthISO)) return null;
  const b = fromISODate(birthISO);
  const d = fromISODate(onISO);
  let age = d.getFullYear() - b.getFullYear();
  const beforeBirthday =
    d.getMonth() < b.getMonth() ||
    (d.getMonth() === b.getMonth() && d.getDate() < b.getDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** Monday-anchored ISO week key, e.g. "2026-W32". Used for weekly blocking. */
export function isoWeekKey(iso) {
  const d = fromISODate(iso);
  const day = (d.getDay() + 6) % 7;            // Mon = 0
  d.setDate(d.getDate() - day + 3);            // nearest Thursday
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  const fDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - fDay + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * MS_PER_DAY));
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Monday of the calendar week containing `iso`. */
export function startOfWeek(iso) {
  const d = fromISODate(iso);
  const day = (d.getDay() + 6) % 7;
  return addDays(iso, -day);
}

/** Short display form, e.g. "Tue 4 Aug". */
export function fmtDateShort(iso) {
  if (!isValidISODate(iso)) return '—';
  return fromISODate(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** Medium display form, e.g. "4 Aug 2026". */
export function fmtDateMedium(iso) {
  if (!isValidISODate(iso)) return '—';
  return fromISODate(iso).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** "Today" / "Yesterday" / short date. */
export function fmtDateRelative(iso) {
  const today = todayISO();
  if (iso === today) return 'Today';
  if (iso === addDays(today, -1)) return 'Yesterday';
  return fmtDateShort(iso);
}
