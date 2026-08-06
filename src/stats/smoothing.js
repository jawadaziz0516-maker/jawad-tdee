/**
 * smoothing.js — exponential smoothing.
 *
 * @module stats/smoothing
 */

/**
 * Convert a half-life in days to the EWMA decay factor α.
 *
 * Half-life is the parameter to expose to users: "a reading loses half its
 * influence after N days" is interpretable, whereas α = 0.0669 is not.
 *
 *   α = 1 − exp(−ln2 / halfLife)
 */
export function alphaFromHalfLife(halfLifeDays) {
  if (!(halfLifeDays > 0)) return 1;
  return 1 - Math.exp(-Math.LN2 / halfLifeDays);
}

/** Inverse of the above — for showing the effective memory of a given α. */
export function halfLifeFromAlpha(alpha) {
  if (!(alpha > 0) || alpha >= 1) return 0;
  return -Math.LN2 / Math.log(1 - alpha);
}

/**
 * Exponentially weighted moving average over an evenly spaced series.
 *
 * The level is seeded with the first observation rather than with zero, so
 * there is no startup bias to correct — the alternative (seeding at zero and
 * dividing by the accumulated weight) gives identical output after the first
 * point but a wildly wrong first point.
 *
 * Nulls hold the level rather than being skipped, so gaps do not silently
 * compress the timeline.
 *
 * @param {(number|null)[]} xs
 * @param {number} alpha
 * @param {{ initial?: number }} [options]
 * @returns {(number|null)[]}
 */
export function ewma(xs, alpha, options = {}) {
  let level = Number.isFinite(options.initial) ? options.initial : null;
  const out = [];
  for (const x of xs) {
    if (Number.isFinite(x)) {
      level = level == null ? x : alpha * x + (1 - alpha) * level;
    }
    out.push(level);
  }
  return out;
}

/**
 * Time-aware EWMA: weights decay by *elapsed days*, not by position in the
 * array. Necessary when weigh-ins are irregular — three readings in a row
 * after a two-week gap should not be treated as three consecutive days.
 *
 * @param {Array<{t: number, y: number}>} points  t in days, ascending
 * @param {number} halfLifeDays
 * @returns {Array<{t: number, level: number}>}
 */
export function ewmaIrregular(points, halfLifeDays) {
  const out = [];
  let level = null;
  let lastT = null;
  for (const { t, y } of points) {
    if (!Number.isFinite(y)) continue;
    if (level == null) {
      level = y;
    } else {
      const dt = Math.max(0, t - lastT);
      const w = 1 - Math.exp((-Math.LN2 * dt) / halfLifeDays); // decay over the gap
      level = w * y + (1 - w) * level;
    }
    lastT = t;
    out.push({ t, level });
  }
  return out;
}

/**
 * Holt's linear (double exponential) smoothing — level plus trend.
 * Retained as a lightweight alternative to the Kalman filter for callers that
 * want a trend without covariance bookkeeping.
 *
 * @param {(number|null)[]} xs
 * @param {number} alpha  level smoothing
 * @param {number} beta   trend smoothing
 */
export function holt(xs, alpha, beta) {
  let level = null;
  let trend = 0;
  const out = [];
  for (const x of xs) {
    if (Number.isFinite(x)) {
      if (level == null) {
        level = x;
      } else {
        const prevLevel = level;
        level = alpha * x + (1 - alpha) * (level + trend);
        trend = beta * (level - prevLevel) + (1 - beta) * trend;
      }
    } else if (level != null) {
      level += trend; // project through the gap
    }
    out.push(level == null ? null : { level, trend });
  }
  return out;
}
