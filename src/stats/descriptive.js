/**
 * descriptive.js — summary statistics and rolling windows.
 *
 * Every function tolerates nulls and NaNs by skipping them, because real logs
 * have gaps and a single missing weigh-in must not poison a window.
 *
 * @module stats/descriptive
 */

import { MAD_TO_SIGMA, Z_95 } from '../core/constants.js';

/** Finite numbers only. */
export const clean = (xs) => (xs || []).filter((x) => typeof x === 'number' && Number.isFinite(x));

export function mean(xs) {
  const v = clean(xs);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

export function sum(xs) {
  return clean(xs).reduce((s, x) => s + x, 0);
}

export function median(xs) {
  const v = clean(xs).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function quantile(xs, q) {
  const v = clean(xs).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? v[lo] : v[lo] + (pos - lo) * (v[hi] - v[lo]);
}

/** Sample standard deviation (n−1). */
export function stdev(xs) {
  const v = clean(xs);
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

export function variance(xs) {
  const s = stdev(xs);
  return s == null ? null : s * s;
}

/** Standard error of the mean. */
export function sem(xs) {
  const v = clean(xs);
  const s = stdev(v);
  return s == null ? null : s / Math.sqrt(v.length);
}

/**
 * Median absolute deviation, scaled to be a consistent estimator of σ.
 * Preferred over the standard deviation anywhere an outlier could appear —
 * which, for daily body weight, is most days.
 */
export function mad(xs) {
  const v = clean(xs);
  if (v.length < 2) return null;
  const m = median(v);
  return MAD_TO_SIGMA * median(v.map((x) => Math.abs(x - m)));
}

/** 95% confidence interval for a mean. */
export function meanCI(xs, z = Z_95) {
  const m = mean(xs);
  const e = sem(xs);
  if (m == null || e == null) return null;
  return { mean: m, lower: m - z * e, upper: m + z * e, halfWidth: z * e };
}

/**
 * Trailing rolling mean. Emits null until `minPeriods` values are available,
 * so the caller can distinguish "no estimate yet" from "estimate of zero".
 */
export function rollingMean(xs, window, minPeriods = Math.ceil(window / 2)) {
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    const slice = clean(xs.slice(Math.max(0, i - window + 1), i + 1));
    out.push(slice.length >= minPeriods ? mean(slice) : null);
  }
  return out;
}

/** Centred rolling mean — for charts only, never for the live estimate
 *  (it peeks at the future). */
export function centredRollingMean(xs, window) {
  const half = Math.floor(window / 2);
  return xs.map((_, i) => {
    const slice = clean(xs.slice(Math.max(0, i - half), Math.min(xs.length, i + half + 1)));
    return slice.length ? mean(slice) : null;
  });
}

export function rollingSum(xs, window) {
  return xs.map((_, i) => sum(xs.slice(Math.max(0, i - window + 1), i + 1)));
}

/** Pearson correlation over pairwise-complete observations. */
export function correlation(xs, ys) {
  const pairs = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pairs.push([xs[i], ys[i]]);
  }
  if (pairs.length < 3) return null;
  const mx = mean(pairs.map((p) => p[0]));
  const my = mean(pairs.map((p) => p[1]));
  let num = 0, dx = 0, dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : num / den;
}

/**
 * Ordinary least squares slope and intercept of y on x, with the standard
 * error of the slope. Used for quick trend checks; the Kalman filter in
 * stats/kalman.js is the production estimator because it handles gaps,
 * changing rates and outliers, none of which OLS does.
 */
export function linearRegression(xs, ys) {
  const pairs = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pairs.push([xs[i], ys[i]]);
  }
  const n = pairs.length;
  if (n < 3) return null;
  const mx = mean(pairs.map((p) => p[0]));
  const my = mean(pairs.map((p) => p[1]));
  let sxy = 0, sxx = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  let sst = 0;
  for (const [x, y] of pairs) {
    sse += (y - (intercept + slope * x)) ** 2;
    sst += (y - my) ** 2;
  }
  const residualVar = sse / (n - 2);
  return {
    slope,
    intercept,
    slopeSe: Math.sqrt(residualVar / sxx),
    n,
    r2: sst > 0 ? 1 - sse / sst : null,
  };
}

/**
 * Theil–Sen slope: the median of all pairwise slopes. Breaks down only when
 * more than 29% of points are outliers, versus a single bad point being enough
 * to move an OLS line. Used as a cross-check on the Kalman rate.
 */
export function theilSen(xs, ys) {
  const pts = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pts.push([xs[i], ys[i]]);
  }
  if (pts.length < 3) return null;
  const slopes = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j][0] - pts[i][0];
      if (dx !== 0) slopes.push((pts[j][1] - pts[i][1]) / dx);
    }
  }
  const slope = median(slopes);
  const intercept = median(pts.map(([x, y]) => y - slope * x));
  return { slope, intercept, n: pts.length, slopeIqr: quantile(slopes, 0.75) - quantile(slopes, 0.25) };
}

/** Standardise to zero mean, unit SD. Returns nulls where input was missing. */
export function zScores(xs) {
  const m = mean(xs);
  const s = stdev(xs);
  if (m == null || !s) return xs.map(() => null);
  return xs.map((x) => (Number.isFinite(x) ? (x - m) / s : null));
}
