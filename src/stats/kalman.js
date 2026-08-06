/**
 * kalman.js — local linear trend filter and RTS smoother.
 *
 * WHY THIS RATHER THAN A ROLLING AVERAGE
 *
 * A 7-day moving average of body weight has three defects that matter for
 * estimating energy balance:
 *
 *   1. It lags. A trailing mean sits half a window behind the truth, so a real
 *      change in rate takes ~3–4 days to show up, and the rate you read off it
 *      is the rate from last week.
 *   2. It has no rate estimate. You have to difference two averages to get a
 *      slope, which doubles the noise you just spent a window suppressing.
 *   3. It has no uncertainty. A rate of −0.12 kg/week from four noisy readings
 *      and from twenty-eight tidy ones look identical, and they are not.
 *
 * A local linear trend model — a random walk in *level* plus a random walk in
 * *slope* — fixes all three. It tracks level and rate jointly, produces a
 * covariance for both, handles missing days natively (predict, do not update),
 * and its rate variance is exactly what the maintenance engine needs to size
 * its confidence interval.
 *
 * State:        x = [level, slope]ᵀ
 * Transition:   F = [[1, dt], [0, 1]]
 * Observation:  y = level + ε,   ε ~ N(0, R)
 *
 * Refs: Harvey AC. Forecasting, Structural Time Series Models and the Kalman
 *       Filter. Cambridge University Press; 1989.
 *       Rauch HE, Tung F, Striebel CT. AIAA Journal. 1965;3(8):1445-1450.
 *
 * @module stats/kalman
 */

import { median } from './descriptive.js';
import { MAD_TO_SIGMA } from '../core/constants.js';

/* ============================================================
   2×2 LINEAR ALGEBRA
   ============================================================
   Hand-rolled rather than pulled from a library: the state is two-dimensional
   forever, and a dependency-free static site is the deployment target. */

const mul = (A, B) => [
  [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]],
  [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]],
];

const add = (A, B) => [
  [A[0][0] + B[0][0], A[0][1] + B[0][1]],
  [A[1][0] + B[1][0], A[1][1] + B[1][1]],
];

const subM = (A, B) => [
  [A[0][0] - B[0][0], A[0][1] - B[0][1]],
  [A[1][0] - B[1][0], A[1][1] - B[1][1]],
];

const transpose = (A) => [
  [A[0][0], A[1][0]],
  [A[0][1], A[1][1]],
];

const matVec = (A, v) => [A[0][0] * v[0] + A[0][1] * v[1], A[1][0] * v[0] + A[1][1] * v[1]];

function inverse(A) {
  const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
  // Ridge the diagonal rather than returning null on a singular covariance:
  // a degenerate P should not abort the smoother pass.
  if (Math.abs(det) < 1e-12) {
    const eps = 1e-9;
    const B = [[A[0][0] + eps, A[0][1]], [A[1][0], A[1][1] + eps]];
    const d2 = B[0][0] * B[1][1] - B[0][1] * B[1][0];
    return [[B[1][1] / d2, -B[0][1] / d2], [-B[1][0] / d2, B[0][0] / d2]];
  }
  return [[A[1][1] / det, -A[0][1] / det], [-A[1][0] / det, A[0][0] / det]];
}

/** Force symmetry — guards against drift from accumulated float error. */
const symmetrise = (P) => {
  const off = (P[0][1] + P[1][0]) / 2;
  return [[P[0][0], off], [off, P[1][1]]];
};

/* ============================================================
   DEFAULT PROCESS NOISE (body weight, kg)
   ============================================================
   These are the knobs that decide how responsive the trend is. They are
   exposed in Settings because the right values depend on how erratic your
   weigh-ins are and how fast your intake actually changes. */

export const DEFAULT_TREND_PARAMS = {
  /** SD of day-to-day level shocks not explained by the slope (kg/√day).
   *  Small: genuine level jumps are rare, and most apparent ones are water. */
  levelSigma: 0.02,

  /** SD of day-to-day drift in the *rate* (kg/day per √day). Sets how quickly
   *  the filter accepts that your rate of change has genuinely changed.
   *  0.0035 lets the rate move ~0.02 kg/day over a month without forcing it. */
  slopeSigma: 0.0035,

  /** Observation SD (kg). Null means estimate it from the data. */
  observationSigma: null,

  /** Huber threshold in SDs. Innovations beyond this have their observation
   *  variance inflated, so a 1.5 kg post-ramen reading bends the trend a
   *  little instead of yanking it. */
  huberK: 2.0,

  /** Hard rejection threshold in SDs — beyond this the reading is almost
   *  certainly a mis-entry (units confusion, someone else on the scale). */
  rejectK: 6.0,
};

/* ============================================================
   OBSERVATION NOISE ESTIMATION
   ============================================================ */

/**
 * Robustly estimate daily weigh-in noise from the data itself.
 *
 * Uses the MAD of first differences ÷ √2: differencing removes the (slow)
 * trend, and the variance of a difference of two independent readings is 2σ².
 * MAD rather than SD so that the outliers we are trying to protect against do
 * not inflate the very threshold used to detect them.
 *
 * @param {(number|null)[]} series  daily values, nulls for missing days
 * @returns {number} SD in the units of the series
 */
export function estimateObservationSigma(series) {
  const diffs = [];
  let prev = null;
  let gap = 0;
  for (const y of series) {
    if (Number.isFinite(y)) {
      if (prev != null && gap <= 2) diffs.push((y - prev) / Math.sqrt(gap + 1));
      prev = y;
      gap = 0;
    } else {
      gap += 1;
    }
  }
  if (diffs.length < 4) return null;
  const m = median(diffs.map(Math.abs));
  const sigma = (MAD_TO_SIGMA * m) / Math.SQRT2;
  // Floor and ceiling: a scale that reads to 0.1 kg cannot have σ < 0.1, and a
  // σ above 2 kg means something is wrong with the data, not the person.
  return Math.min(2.0, Math.max(0.1, sigma));
}

/* ============================================================
   FILTER + SMOOTHER
   ============================================================ */

/**
 * @typedef {Object} TrendPoint
 * @property {number}  index        day index into the input series
 * @property {number|null} observation
 * @property {number}  level        filtered (causal) level
 * @property {number}  slope        filtered rate, units per day
 * @property {number}  levelVar
 * @property {number}  slopeVar
 * @property {number}  smoothedLevel  RTS-smoothed level (uses future data)
 * @property {number}  smoothedSlope
 * @property {number}  smoothedLevelVar
 * @property {number}  smoothedSlopeVar
 * @property {number|null} innovation    observation − prediction
 * @property {number|null} innovationZ   innovation in SDs
 * @property {number}  weight        0–1, how much this observation was trusted
 * @property {boolean} rejected
 *
 * @typedef {Object} TrendResult
 * @property {TrendPoint[]} points
 * @property {number} observationSigma
 * @property {{level:number, slope:number, levelVar:number, slopeVar:number}} current
 *           filtered state at the last day — the causal estimate, the one to
 *           show as "today's trend weight"
 * @property {number} nObservations
 * @property {number[]} outlierIndices
 * @property {number} logLikelihood  for comparing parameter choices
 */

/**
 * Run the filter over a daily grid.
 *
 * The grid must be one entry per calendar day (null for days with no reading),
 * which keeps dt = 1 everywhere and makes every downstream index a day number.
 *
 * @param {(number|null)[]} series
 * @param {Partial<typeof DEFAULT_TREND_PARAMS> & {observationVariances?: (number|null)[]}} [params]
 * @returns {TrendResult|null}
 */
export function localLinearTrend(series, params = {}) {
  const p = { ...DEFAULT_TREND_PARAMS, ...params };
  const n = series.length;
  if (!n) return null;

  const firstIdx = series.findIndex((v) => Number.isFinite(v));
  if (firstIdx === -1) return null;

  const sigma = Number.isFinite(p.observationSigma)
    ? p.observationSigma
    : estimateObservationSigma(series) ?? 0.5;
  const R0 = sigma * sigma;

  const dt = 1;
  const F = [[1, dt], [0, 1]];
  const Ft = transpose(F);
  const sl2 = p.levelSigma ** 2;
  const ss2 = p.slopeSigma ** 2;
  // Continuous white-noise acceleration, integrated over one day.
  const Q = [
    [ss2 * (dt ** 3) / 3 + sl2 * dt, (ss2 * dt * dt) / 2],
    [(ss2 * dt * dt) / 2, ss2 * dt],
  ];

  // Initialisation: level at the first reading with generous variance, slope at
  // zero with a variance wide enough not to fight the first month of data.
  let x = [series[firstIdx], 0];
  let P = [[R0 * 4, 0], [0, 0.01 ** 2]];

  const xPred = new Array(n);
  const PPred = new Array(n);
  const xFilt = new Array(n);
  const PFilt = new Array(n);
  const meta = new Array(n);
  let logLik = 0;
  let nObs = 0;
  const outlierIndices = [];

  for (let i = 0; i < n; i++) {
    // --- predict ---
    if (i === 0) {
      xPred[i] = x.slice();
      PPred[i] = [[P[0][0], P[0][1]], [P[1][0], P[1][1]]];
    } else {
      xPred[i] = matVec(F, x);
      PPred[i] = symmetrise(add(mul(mul(F, P), Ft), Q));
    }
    x = xPred[i].slice();
    P = PPred[i].map((r) => r.slice());

    // --- update ---
    const y = series[i];
    let innovation = null;
    let innovationZ = null;
    let weight = 0;
    let rejected = false;

    if (Number.isFinite(y) && i >= firstIdx) {
      const Ri = Number.isFinite(params.observationVariances?.[i])
        ? params.observationVariances[i]
        : R0;
      const S0 = P[0][0] + Ri;
      innovation = y - x[0];
      innovationZ = innovation / Math.sqrt(S0);

      let R = Ri;
      const absZ = Math.abs(innovationZ);
      if (absZ > p.rejectK) {
        // Implausible reading — skip the update entirely, but keep it visible
        // so the UI can flag it rather than silently discarding user data.
        rejected = true;
        outlierIndices.push(i);
      } else if (absZ > p.huberK) {
        // Huber down-weighting: inflate R so the reading still informs the
        // filter, just less. Preferable to hard rejection, which throws away
        // real information on genuine step-changes (a refeed, a flight).
        R = Ri * (absZ / p.huberK) ** 2;
        outlierIndices.push(i);
      }

      if (!rejected) {
        const S = P[0][0] + R;
        const K = [P[0][0] / S, P[1][0] / S];       // Kalman gain, H = [1, 0]
        x = [x[0] + K[0] * innovation, x[1] + K[1] * innovation];
        // Joseph-free simple form is fine here given the symmetrise() guard.
        P = symmetrise([
          [P[0][0] - K[0] * P[0][0], P[0][1] - K[0] * P[0][1]],
          [P[1][0] - K[1] * P[0][0], P[1][1] - K[1] * P[0][1]],
        ]);
        weight = K[0];
        nObs += 1;
        logLik += -0.5 * (Math.log(2 * Math.PI * S) + (innovation * innovation) / S);
      }
    }

    xFilt[i] = x.slice();
    PFilt[i] = P.map((r) => r.slice());
    meta[i] = { innovation, innovationZ, weight, rejected };
  }

  // --- RTS smoother (backward pass) ---
  const xSm = new Array(n);
  const PSm = new Array(n);
  xSm[n - 1] = xFilt[n - 1].slice();
  PSm[n - 1] = PFilt[n - 1].map((r) => r.slice());

  for (let i = n - 2; i >= 0; i--) {
    const C = mul(mul(PFilt[i], Ft), inverse(PPred[i + 1]));
    const dx = [xSm[i + 1][0] - xPred[i + 1][0], xSm[i + 1][1] - xPred[i + 1][1]];
    xSm[i] = [xFilt[i][0] + C[0][0] * dx[0] + C[0][1] * dx[1],
              xFilt[i][1] + C[1][0] * dx[0] + C[1][1] * dx[1]];
    PSm[i] = symmetrise(add(PFilt[i], mul(mul(C, subM(PSm[i + 1], PPred[i + 1])), transpose(C))));
  }

  const points = [];
  for (let i = 0; i < n; i++) {
    points.push({
      index: i,
      observation: Number.isFinite(series[i]) ? series[i] : null,
      level: xFilt[i][0],
      slope: xFilt[i][1],
      levelVar: Math.max(0, PFilt[i][0][0]),
      slopeVar: Math.max(0, PFilt[i][1][1]),
      smoothedLevel: xSm[i][0],
      smoothedSlope: xSm[i][1],
      smoothedLevelVar: Math.max(0, PSm[i][0][0]),
      smoothedSlopeVar: Math.max(0, PSm[i][1][1]),
      ...meta[i],
    });
  }

  const last = points[n - 1];
  return {
    points,
    observationSigma: sigma,
    current: {
      level: last.level,
      slope: last.slope,
      levelVar: last.levelVar,
      slopeVar: last.slopeVar,
    },
    nObservations: nObs,
    outlierIndices,
    logLikelihood: logLik,
  };
}

/**
 * Forecast the level forward from the final filtered state, with a growing
 * interval. Used for "where will I be in N weeks at this rate".
 *
 * @param {TrendResult} result
 * @param {number} days
 */
export function forecast(result, days) {
  if (!result) return [];
  const { level, slope, levelVar, slopeVar } = result.current;
  const out = [];
  for (let d = 1; d <= days; d++) {
    // Var(level + d·slope) — the covariance term is omitted, making this
    // marginally conservative.
    const variance = levelVar + d * d * slopeVar;
    out.push({ day: d, value: level + slope * d, sd: Math.sqrt(variance) });
  }
  return out;
}
