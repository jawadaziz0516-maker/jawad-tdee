/**
 * trendWeight.js — the weight signal the rest of the app is allowed to use.
 *
 * Body weight measured on a scale is a real number wrapped in about a kilogram
 * of noise. The noise is not random: it is driven by identifiable, loggable
 * things — glycogen (each gram binds ~3 g of water), sodium, alcohol,
 * inflammation from hard training, gut contents, cortisol from short sleep.
 *
 * This module does three things, in order:
 *
 *   1. Filters the daily series with a local linear trend model, which yields
 *      both a level and a *rate* with honest uncertainty.
 *   2. Learns, from your own history, how much of your day-to-day deviation is
 *      explained by those water-shifting covariates — and subtracts it.
 *   3. Re-filters the corrected series, giving a trend that a big carb refeed
 *      or a salty restaurant meal barely disturbs.
 *
 * Step 2 is what separates this from a smoothed weight app. The correction is
 * fitted on *your* data (a ridge regression, cross-validated), applied only
 * once there is enough of it, mean-centred so it can never shift your absolute
 * weight, and capped so it can never dominate a real change.
 *
 * @module model/trendWeight
 */

import { localLinearTrend, estimateObservationSigma, DEFAULT_TREND_PARAMS } from '../stats/kalman.js';
import { ridgeCV } from '../stats/regression.js';
import { median, mean } from '../stats/descriptive.js';
import { explainDeviation } from '../stats/outliers.js';
import { enumerateDates, daysBetween, addDays } from '../core/time.js';
import { Z_95 } from '../core/constants.js';

/** Minimum observations before the water-retention model is fitted at all. */
const MIN_DAYS_FOR_WATER_MODEL = 21;

/** Minimum cross-validated explanatory power before the correction is applied. */
const MIN_WATER_MODEL_R2 = 0.06;

/** Correction ceiling as a fraction of body mass. */
const MAX_CORRECTION_FRACTION = 0.015;

/**
 * Covariate definitions. Each returns a value for a given day, or null when it
 * cannot be computed — a day missing any covariate is dropped from the fit but
 * still receives a (zero) correction.
 */
const COVARIATES = [
  {
    id: 'carbLoad',
    label: 'Carbohydrate',
    unit: 'g above usual',
    explain: 'Glycogen storage binds roughly 3 g of water per gram.',
    value: (ctx) => {
      const today = ctx.day?.intake?.carbs;
      const yest = ctx.prev?.intake?.carbs;
      if (!Number.isFinite(today)) return null;
      const avg = Number.isFinite(yest) ? (today + yest) / 2 : today;
      return avg - (ctx.baselines.carbs ?? avg);
    },
  },
  {
    id: 'sodium',
    label: 'Sodium',
    unit: 'mg above usual',
    explain: 'Sodium load expands extracellular fluid for 24–48 h.',
    value: (ctx) => {
      const today = ctx.day?.sodiumMg;
      const yest = ctx.prev?.sodiumMg;
      if (!Number.isFinite(today)) return null;
      const avg = Number.isFinite(yest) ? (today + yest) / 2 : today;
      return avg - (ctx.baselines.sodiumMg ?? avg);
    },
  },
  {
    id: 'alcohol',
    label: 'Alcohol',
    unit: 'g',
    explain: 'Suppresses vasopressin acutely, then rebounds with fluid retention.',
    value: (ctx) => {
      const today = ctx.day?.intake?.alcohol ?? 0;
      const yest = ctx.prev?.intake?.alcohol ?? 0;
      return today + 0.5 * yest;
    },
  },
  {
    id: 'trainingLoad',
    label: 'Training load',
    unit: 'RPE·h, previous day',
    explain: 'Muscle damage and glycogen resynthesis both hold water for 24–72 h.',
    value: (ctx) => {
      const load = (d) =>
        (d?.exercise || []).reduce(
          (s, e) => s + ((e.rpe ?? 5) / 5) * ((e.minutes ?? 0) / 60),
          0,
        );
      return load(ctx.prev) + 0.5 * load(ctx.prev2);
    },
  },
  {
    id: 'sleepDeficit',
    label: 'Sleep deficit',
    unit: 'h below usual',
    explain: 'Short sleep raises cortisol and aldosterone, retaining fluid.',
    value: (ctx) => {
      const h = ctx.day?.sleepHours;
      if (!Number.isFinite(h)) return null;
      return Math.max(0, (ctx.baselines.sleepHours ?? h) - h);
    },
  },
  {
    id: 'stress',
    label: 'Stress',
    unit: 'points above usual',
    explain: 'Cortisol-mediated sodium and water retention.',
    value: (ctx) => {
      const s = ctx.day?.stress;
      if (!Number.isFinite(s)) return null;
      return s - (ctx.baselines.stress ?? s);
    },
  },
];

/**
 * Personal baselines, taken as medians so a single extreme day cannot define
 * "usual".
 */
export function computeBaselines(days) {
  const pick = (fn) => median(days.map(fn).filter((v) => Number.isFinite(v)));
  return {
    carbs: pick((d) => d.intake?.carbs),
    sodiumMg: pick((d) => d.sodiumMg),
    sleepHours: pick((d) => d.sleepHours),
    stress: pick((d) => d.stress),
    kcal: pick((d) => d.intake?.kcal),
    steps: pick((d) => d.steps),
    protein: pick((d) => d.intake?.protein),
  };
}

/**
 * @typedef {Object} TrendDay
 * @property {string}  date
 * @property {number}  index
 * @property {number|null} weightKg          as logged
 * @property {number|null} adjustedWeightKg  after the water correction
 * @property {number}  waterAdjustmentKg     positive = reading inflated by water
 * @property {number}  trendKg               causal (filtered) trend weight
 * @property {number}  trendSmoothKg         RTS-smoothed, for charts
 * @property {number}  slopeKgPerDay         causal rate
 * @property {number}  smoothSlopeKgPerDay
 * @property {number}  slopeSd
 * @property {boolean} isOutlier
 * @property {string[]} explanations
 *
 * @typedef {Object} TrendResult
 * @property {TrendDay[]} days
 * @property {Object} current
 * @property {Object} waterModel
 * @property {number} observationSigma
 * @property {Object} baselines
 */

/**
 * @param {Array<Object>} entries  day records, any order, must have `date`
 * @param {Object} [options]
 * @param {number} [options.halfLifeDays]        informational only; the Kalman
 *                                               parameters below control memory
 * @param {Object} [options.trendParams]         overrides for DEFAULT_TREND_PARAMS
 * @param {boolean} [options.applyWaterModel]
 * @returns {TrendResult|null}
 */
export function computeTrendWeight(entries, options = {}) {
  const withWeight = (entries || []).filter((d) => Number.isFinite(d.weightKg));
  if (!withWeight.length) return null;

  const sorted = [...(entries || [])].sort((a, b) => a.date.localeCompare(b.date));
  const startDate = sorted.find((d) => Number.isFinite(d.weightKg)).date;
  const endDate = options.endDate ?? sorted[sorted.length - 1].date;
  if (daysBetween(startDate, endDate) < 0) return null;

  const dates = enumerateDates(startDate, endDate);
  const byDate = new Map(sorted.map((d) => [d.date, d]));
  const baselines = computeBaselines(sorted);

  const rawSeries = dates.map((iso) => {
    const d = byDate.get(iso);
    return Number.isFinite(d?.weightKg) ? d.weightKg : null;
  });

  const trendParams = { ...DEFAULT_TREND_PARAMS, ...(options.trendParams || {}) };

  /* ---- pass 1: uncorrected filter, to obtain residuals ---- */
  const pass1 = localLinearTrend(rawSeries, trendParams);
  if (!pass1) return null;

  /* ---- fit the water-retention model on those residuals ---- */
  const waterModel = fitWaterModel({ dates, byDate, pass1, baselines, options });

  /* ---- build the corrected series ---- */
  const corrections = dates.map((iso, i) => {
    if (!waterModel.applied || rawSeries[i] == null) return 0;
    const row = covariateRow(iso, byDate, baselines);
    if (!row) return 0;
    const raw = waterModel.model.predict(row) - waterModel.centre;
    const cap = MAX_CORRECTION_FRACTION * rawSeries[i];
    return Math.max(-cap, Math.min(cap, raw));
  });

  const adjustedSeries = rawSeries.map((w, i) => (w == null ? null : w - corrections[i]));

  /* ---- pass 2: filter the corrected series ---- */
  const sigma2 = estimateObservationSigma(adjustedSeries) ?? pass1.observationSigma;
  const pass2 = localLinearTrend(adjustedSeries, { ...trendParams, observationSigma: sigma2 });
  const final = pass2 ?? pass1;

  const days = dates.map((iso, i) => {
    const p = final.points[i];
    const dayEntry = byDate.get(iso);
    const isOutlier = final.outlierIndices.includes(i);
    return {
      date: iso,
      index: i,
      weightKg: rawSeries[i],
      adjustedWeightKg: adjustedSeries[i],
      waterAdjustmentKg: corrections[i],
      trendKg: p.level,
      trendSmoothKg: p.smoothedLevel,
      slopeKgPerDay: p.slope,
      smoothSlopeKgPerDay: p.smoothedSlope,
      slopeSd: Math.sqrt(p.slopeVar),
      levelSd: Math.sqrt(p.levelVar),
      smoothLevelSd: Math.sqrt(p.smoothedLevelVar),
      innovationZ: p.innovationZ,
      isOutlier,
      explanations: isOutlier ? explainDeviation(dayEntry, baselines) : [],
    };
  });

  const last = days[days.length - 1];
  const slopeSd = last.slopeSd;

  return {
    days,
    baselines,
    observationSigma: final.observationSigma,
    waterModel,
    current: {
      date: last.date,
      trendKg: last.trendKg,
      trendSd: last.levelSd,
      slopeKgPerDay: last.slopeKgPerDay,
      slopeSd,
      weeklyRateKg: last.slopeKgPerDay * 7,
      weeklyRateCI: {
        lower: (last.slopeKgPerDay - Z_95 * slopeSd) * 7,
        upper: (last.slopeKgPerDay + Z_95 * slopeSd) * 7,
      },
      /** True when the 95% interval on the rate excludes zero. */
      rateIsSignificant: Math.abs(last.slopeKgPerDay) > Z_95 * slopeSd,
      lastWeighIn: [...days].reverse().find((d) => d.weightKg != null)?.date ?? null,
      nWeighIns: final.nObservations,
    },
  };
}

/* ============================================================
   WATER-RETENTION MODEL
   ============================================================ */

function covariateRow(iso, byDate, baselines) {
  const ctx = {
    day: byDate.get(iso),
    prev: byDate.get(addDays(iso, -1)),
    prev2: byDate.get(addDays(iso, -2)),
    baselines,
  };
  const row = [];
  for (const c of COVARIATES) {
    const v = c.value(ctx);
    if (v == null || !Number.isFinite(v)) return null;
    row.push(v);
  }
  return row;
}

function fitWaterModel({ dates, byDate, pass1, baselines, options }) {
  const disabled = options.applyWaterModel === false;
  const X = [];
  const y = [];

  for (let i = 0; i < dates.length; i++) {
    const point = pass1.points[i];
    if (point.observation == null || point.innovation == null) continue;
    const row = covariateRow(dates[i], byDate, baselines);
    if (!row) continue;
    // Target: how far this reading sat above the filter's prediction — i.e. the
    // part of today's weight the trend does not explain.
    X.push(row);
    y.push(point.innovation);
  }

  const base = {
    applied: false,
    available: false,
    n: X.length,
    minRequired: MIN_DAYS_FOR_WATER_MODEL,
    r2: null,
    lambda: null,
    centre: 0,
    model: null,
    terms: [],
    reason: null,
  };

  if (disabled) return { ...base, reason: 'Disabled in settings.' };
  if (X.length < MIN_DAYS_FOR_WATER_MODEL) {
    return {
      ...base,
      reason:
        `Needs ${MIN_DAYS_FOR_WATER_MODEL} days with weight plus sodium, carbs, sleep and stress ` +
        `logged — ${X.length} so far.`,
    };
  }

  const fit = ridgeCV(X, y);
  if (!fit) return { ...base, reason: 'Model did not converge on this data.' };

  const applied = fit.model.r2 >= MIN_WATER_MODEL_R2;
  const preds = X.map((row) => fit.model.predict(row));
  const centre = mean(preds) ?? 0;

  return {
    applied,
    available: true,
    n: X.length,
    minRequired: MIN_DAYS_FOR_WATER_MODEL,
    r2: fit.model.r2,
    cvError: fit.cvError,
    lambda: fit.lambda,
    centre,
    model: fit.model,
    residualSd: fit.model.residualSd,
    terms: COVARIATES.map((c, j) => ({
      id: c.id,
      label: c.label,
      unit: c.unit,
      explain: c.explain,
      kgPerUnit: fit.model.coefficients[j],
      standardised: fit.model.standardised[j],
    })).sort((a, b) => Math.abs(b.standardised) - Math.abs(a.standardised)),
    reason: applied
      ? null
      : `Covariates explain only ${(fit.model.r2 * 100).toFixed(1)}% of your daily variation — ` +
        'below the threshold to apply a correction, so raw weights are used.',
  };
}

/**
 * Weight change over a window, read off the smoothed trend rather than off two
 * scale readings. Using endpoints — even endpoints of a rolling average — is
 * how most tools compute this, and it discards everything in between.
 */
export function trendChangeOver(trend, days) {
  if (!trend?.days?.length) return null;
  const list = trend.days;
  const end = list[list.length - 1];
  const startIdx = Math.max(0, list.length - 1 - days);
  const start = list[startIdx];
  const span = end.index - start.index;
  if (span <= 0) return null;
  return {
    startDate: start.date,
    endDate: end.date,
    days: span,
    deltaKg: end.trendKg - start.trendKg,
    perDayKg: (end.trendKg - start.trendKg) / span,
    perWeekKg: ((end.trendKg - start.trendKg) / span) * 7,
  };
}
