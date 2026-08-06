/**
 * outliers.js — robust outlier detection.
 *
 * The philosophy here is down-weighting, not deletion. A 1.4 kg overnight jump
 * after a high-sodium meal is not bad data — it is real water, and it carries
 * genuine (if diluted) information about the underlying trend. Deleting it
 * throws that away and biases the record; down-weighting keeps it honest.
 *
 * Hard rejection is reserved for readings that cannot be true: a weight
 * entered in the wrong units, a typo'd digit, someone else on the scale.
 *
 * @module stats/outliers
 */

import { median, mad } from './descriptive.js';

/**
 * Modified z-score using the median and MAD.
 * Ref: Iglewicz B, Hoaglin DC. How to Detect and Handle Outliers. ASQC; 1993.
 * They suggest |z| > 3.5 as the flag threshold.
 */
export function modifiedZScores(values) {
  const m = median(values);
  const s = mad(values);
  if (m == null || !s) return values.map(() => null);
  return values.map((v) => (Number.isFinite(v) ? (v - m) / s : null));
}

/**
 * Hampel filter: flag points that deviate from a *local* median by more than
 * `nSigmas` local MADs. Local rather than global, so a genuine multi-month
 * trend is not mistaken for a field of outliers.
 *
 * @param {(number|null)[]} values
 * @param {number} windowRadius  days either side
 * @param {number} nSigmas
 * @returns {{index:number, value:number, z:number, localMedian:number}[]}
 */
export function hampel(values, windowRadius = 7, nSigmas = 3) {
  const flags = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const window = values
      .slice(Math.max(0, i - windowRadius), Math.min(values.length, i + windowRadius + 1))
      .filter(Number.isFinite);
    if (window.length < 5) continue;
    const m = median(window);
    const s = mad(window);
    if (!s) continue;
    const z = (v - m) / s;
    if (Math.abs(z) > nSigmas) flags.push({ index: i, value: v, z, localMedian: m });
  }
  return flags;
}

/**
 * Huber weight in [0, 1]: full weight inside k SDs, decaying as 1/|z| beyond.
 * This is the weight function the Kalman filter applies via variance inflation.
 */
export function huberWeight(z, k = 2.0) {
  const a = Math.abs(z);
  if (!Number.isFinite(a)) return 0;
  return a <= k ? 1 : k / a;
}

/**
 * Implausibility checks that do not depend on the rest of the series — the
 * kind of error that comes from a mis-typed digit or a units mix-up.
 *
 * @param {number} weightKg
 * @param {number|null} previousKg
 * @param {number} daysSincePrevious
 */
export function plausibilityCheck(weightKg, previousKg, daysSincePrevious = 1) {
  const issues = [];
  if (!Number.isFinite(weightKg)) return { ok: false, issues: ['Not a number.'], severity: 'error' };

  if (weightKg < 25 || weightKg > 350) {
    issues.push('Outside any plausible human range — check the units on your scale.');
    return { ok: false, issues, severity: 'error' };
  }

  if (Number.isFinite(previousKg) && daysSincePrevious > 0) {
    const delta = weightKg - previousKg;
    const perDay = Math.abs(delta) / daysSincePrevious;

    // The units check runs FIRST. A pound-for-kilogram slip also trips the
    // rate check below, but "you typed pounds" is a diagnosis the user can act
    // on, where "that's a big jump" is not.
    const ratio = weightKg / previousKg;
    if (ratio > 2.0 && ratio < 2.4) {
      issues.push('This looks like pounds entered into a kilogram field.');
      return { ok: false, issues, severity: 'error' };
    }
    if (ratio > 0.42 && ratio < 0.5) {
      issues.push('This looks like kilograms entered into a pounds field.');
      return { ok: false, issues, severity: 'error' };
    }

    // ~2.5 kg in a day is achievable through gut contents and water after a
    // large carbohydrate load; beyond that, suspect the entry.
    if (perDay > 2.5) {
      issues.push(
        `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)} kg in ` +
          `${daysSincePrevious} day${daysSincePrevious === 1 ? '' : 's'} — larger than ` +
          'water and gut contents usually explain. Worth a second look.',
      );
      return { ok: false, issues, severity: 'warn' };
    }
  }
  return { ok: true, issues, severity: null };
}

/**
 * Contextual explanation for a large positive deviation, built from the same
 * day's log. Shown next to a flagged reading so the user understands why the
 * trend barely moved: the point was down-weighted for a reason.
 *
 * @param {Object} day
 * @param {Object} baselines  habitual sodium/carb/etc. for comparison
 */
export function explainDeviation(day, baselines = {}) {
  const reasons = [];
  if (!day) return reasons;

  const carbs = day.intake?.carbs;
  if (Number.isFinite(carbs) && Number.isFinite(baselines.carbs) && carbs > baselines.carbs * 1.5) {
    reasons.push(
      `carbohydrate ${Math.round(carbs)} g vs your usual ${Math.round(baselines.carbs)} g — ` +
        'each gram of glycogen binds ~3 g of water',
    );
  }
  if (Number.isFinite(day.sodiumMg) && Number.isFinite(baselines.sodiumMg) && day.sodiumMg > baselines.sodiumMg * 1.5) {
    reasons.push(`sodium ${Math.round(day.sodiumMg)} mg vs your usual ${Math.round(baselines.sodiumMg)} mg`);
  }
  if (Number.isFinite(day.intake?.alcohol) && day.intake.alcohol > 20) {
    reasons.push('alcohol intake');
  }
  if (Number.isFinite(day.sleepHours) && day.sleepHours < 6) {
    reasons.push(`${day.sleepHours.toFixed(1)} h sleep — cortisol-driven fluid retention`);
  }
  if (Number.isFinite(day.stress) && day.stress >= 4) {
    reasons.push('high stress');
  }
  const hardTraining = (day.exercise || []).some((e) => (e.rpe ?? 0) >= 8 || (e.minutes ?? 0) >= 90);
  if (hardTraining) {
    reasons.push('hard training — muscle inflammation and glycogen resynthesis both hold water');
  }
  return reasons;
}
