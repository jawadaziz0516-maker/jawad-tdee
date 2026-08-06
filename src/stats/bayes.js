/**
 * bayes.js — conjugate Gaussian updating for a slowly drifting quantity.
 *
 * The maintenance estimate is a latent state that changes slowly (metabolic
 * adaptation, seasonal activity, training load) and is observed noisily and
 * indirectly (through weekly energy balance). That is exactly a scalar Kalman
 * filter, which for Gaussians is identical to sequential Bayesian updating:
 *
 *   PREDICT   variance grows by the process noise for the elapsed time —
 *             "I know less about my maintenance than I did three weeks ago"
 *   UPDATE    precision-weighted blend of prior and observation —
 *             a tight observation moves the estimate more than a vague one
 *
 * The two properties this buys, which a running average of "observed TDEE"
 * cannot give you:
 *
 *   • Automatic weighting by evidence quality. A week with six weigh-ins and
 *     complete intake logging moves the estimate several times as far as a
 *     week with two weigh-ins and four logged days.
 *   • Calibrated uncertainty. The posterior SD is what the dashboard reports
 *     as ±kcal, and it is meaningful rather than decorative.
 *
 * @module stats/bayes
 */

import { Z_95 } from '../core/constants.js';

/**
 * @typedef {Object} Gaussian
 * @property {number} mean
 * @property {number} variance
 */

/** Precision-weighted product of two Gaussians. */
export function updateNormal(prior, observation) {
  if (!Number.isFinite(observation?.mean) || !(observation?.variance > 0)) return { ...prior };
  const priorPrec = 1 / prior.variance;
  const obsPrec = 1 / observation.variance;
  const posteriorPrec = priorPrec + obsPrec;
  return {
    mean: (prior.mean * priorPrec + observation.mean * obsPrec) / posteriorPrec,
    variance: 1 / posteriorPrec,
  };
}

/**
 * Random-walk prediction step: uncertainty grows with elapsed time.
 *
 * `processSdPerDay` is the key tuning constant of the whole adaptive engine.
 * Too small and the estimate ossifies — it stops responding after a couple of
 * months, which is precisely when a real metabolic adaptation would show up.
 * Too large and it chases noise, which is what "adaptive TDEE" tools that just
 * average the last three weeks effectively do.
 */
export function predictRandomWalk(state, days, processSdPerDay) {
  return {
    mean: state.mean,
    variance: state.variance + days * processSdPerDay ** 2,
  };
}

/** Symmetric credible interval. */
export function credibleInterval(state, z = Z_95) {
  const sd = Math.sqrt(Math.max(0, state.variance));
  return { lower: state.mean - z * sd, upper: state.mean + z * sd, halfWidth: z * sd, sd };
}

/**
 * Run a sequence of observations through predict/update, returning the whole
 * trace so the UI can chart how the estimate converged — the single most
 * convincing view that the model is learning rather than guessing.
 *
 * @param {Gaussian} prior
 * @param {Array<{mean: number, variance: number, days?: number, label?: string, meta?: any}>} observations
 * @param {{processSdPerDay?: number}} [options]
 * @returns {{
 *   posterior: Gaussian,
 *   trace: Array<{label?: string, prior: Gaussian, observation: Gaussian, posterior: Gaussian, shift: number, meta?: any}>
 * }}
 */
export function sequentialUpdate(prior, observations, options = {}) {
  const processSdPerDay = options.processSdPerDay ?? 8;
  let state = { ...prior };
  const trace = [];

  for (const obs of observations) {
    const predicted = predictRandomWalk(state, obs.days ?? 7, processSdPerDay);
    const posterior = updateNormal(predicted, obs);
    trace.push({
      label: obs.label,
      prior: predicted,
      observation: { mean: obs.mean, variance: obs.variance },
      posterior,
      shift: posterior.mean - predicted.mean,
      meta: obs.meta,
    });
    state = posterior;
  }
  return { posterior: state, trace };
}

/**
 * How much each observation contributed to the final estimate, as a share of
 * total precision. Powers the "what is this number built from" panel — the
 * honest answer to "why does it say 2,865?".
 */
export function evidenceWeights(prior, observations, processSdPerDay = 8) {
  const priorPrec = 1 / prior.variance;
  const obsPrec = observations.map((o) => (o.variance > 0 ? 1 / o.variance : 0));
  const total = priorPrec + obsPrec.reduce((s, p) => s + p, 0);
  return {
    prior: priorPrec / total,
    observations: obsPrec.map((p) => p / total),
    totalPrecision: total,
    processSdPerDay,
  };
}

/**
 * Qualitative confidence label from the posterior SD, in kcal.
 *
 * Thresholds are chosen against what the number is *for*: if you are setting a
 * 500 kcal deficit, a ±150 kcal band on maintenance means your actual deficit
 * is somewhere between 350 and 650 — usable. A ±300 band means it might be 200,
 * which is not.
 */
export function confidenceLabel(sdKcal) {
  if (!Number.isFinite(sdKcal)) return { level: 'none', label: 'No estimate', rank: 0 };
  const halfWidth = Z_95 * sdKcal;
  if (halfWidth <= 80) return { level: 'high', label: 'High', rank: 3 };
  if (halfWidth <= 160) return { level: 'moderate', label: 'Moderate', rank: 2 };
  if (halfWidth <= 280) return { level: 'low', label: 'Low', rank: 1 };
  return { level: 'veryLow', label: 'Very low', rank: 0 };
}

/**
 * Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf). Used for
 * probability statements such as "83% chance your true maintenance is above
 * 2,800 kcal".
 */
export function normalCdf(x, mean = 0, sd = 1) {
  const z = (x - mean) / (sd * Math.SQRT2);
  return 0.5 * (1 + erf(z));
}

function erf(x) {
  const sign = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}

/** P(true value > threshold) under the posterior. */
export function probabilityAbove(state, threshold) {
  const sd = Math.sqrt(Math.max(1e-9, state.variance));
  return 1 - normalCdf(threshold, state.mean, sd);
}
