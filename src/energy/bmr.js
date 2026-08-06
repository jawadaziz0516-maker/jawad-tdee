/**
 * bmr.js — basal metabolic rate.
 *
 * BMR equations are exposed as a registry rather than a switch statement, so a
 * new equation can be added without touching any consumer. Each entry declares
 * what inputs it needs; the resolver degrades gracefully when body composition
 * is unavailable.
 *
 * A note on what these equations actually predict: every one of them was fitted
 * to a population, and the residual SD is roughly ±8–10% even for the best of
 * them (Frankenfield 2005). A BMR estimate is therefore a *prior*, not a
 * measurement. The adaptive engine in model/maintenance.js exists precisely
 * because this number is uncertain — over time, observed energy balance is
 * allowed to overrule it.
 *
 * @module energy/bmr
 */

/**
 * @typedef {Object} BodyState
 * @property {number}  weightKg      body mass (use trend weight, not scale weight)
 * @property {number}  heightCm
 * @property {number}  age           years
 * @property {'male'|'female'} sex   biological sex as used in the source equations
 * @property {number} [bodyFatPct]   0–100; enables lean-mass equations
 */

/* ============================================================
   LEAN MASS
   ============================================================ */

/** Fat-free mass in kg, or null when body fat is unknown. */
export function leanMassKg({ weightKg, bodyFatPct }) {
  if (!isNum(weightKg) || !isNum(bodyFatPct)) return null;
  return weightKg * (1 - bodyFatPct / 100);
}

export function fatMassKg({ weightKg, bodyFatPct }) {
  if (!isNum(weightKg) || !isNum(bodyFatPct)) return null;
  return weightKg * (bodyFatPct / 100);
}

/**
 * Deurenberg BMI-based body-fat estimate — a fallback, never a substitute for
 * a real measurement. Error SD is ~4 percentage points, and it is biased for
 * muscular individuals (it reads lean athletes as fatter than they are).
 * Ref: Deurenberg P, et al. Br J Nutr. 1991;65(2):105-114.
 */
export function estimateBodyFatDeurenberg({ weightKg, heightCm, age, sex }) {
  if (!isNum(weightKg) || !isNum(heightCm) || !isNum(age)) return null;
  const bmi = weightKg / (heightCm / 100) ** 2;
  const sexTerm = sex === 'male' ? 1 : 0;
  return 1.2 * bmi - 10.8 * sexTerm + 0.23 * age - 5.4;
}

export function bmi({ weightKg, heightCm }) {
  if (!isNum(weightKg) || !isNum(heightCm)) return null;
  return weightKg / (heightCm / 100) ** 2;
}

/* ============================================================
   EQUATION REGISTRY
   ============================================================ */

/**
 * @typedef {Object} BmrFormula
 * @property {string}   id
 * @property {string}   label
 * @property {string}   citation
 * @property {string}   notes
 * @property {boolean}  needsBodyFat
 * @property {(s: BodyState) => number|null} calc
 */

/** @type {Record<string, BmrFormula>} */
export const BMR_FORMULAS = {
  mifflin: {
    id: 'mifflin',
    label: 'Mifflin–St Jeor',
    citation: 'Mifflin MD, et al. Am J Clin Nutr. 1990;51(2):241-247.',
    notes:
      'The best-validated general-population equation; the Academy of Nutrition ' +
      'and Dietetics recommends it for non-obese and obese adults alike. ' +
      'Predicts within ±10% of measured RMR in ~82% of people. Does not use ' +
      'body composition, so it under-predicts for very muscular individuals.',
    needsBodyFat: false,
    calc: ({ weightKg, heightCm, age, sex }) => {
      if (!isNum(weightKg) || !isNum(heightCm) || !isNum(age)) return null;
      const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
      return sex === 'male' ? base + 5 : base - 161;
    },
  },

  harris: {
    id: 'harris',
    label: 'Harris–Benedict (Roza revision)',
    citation: 'Roza AM, Shizgal HM. Am J Clin Nutr. 1984;40(1):168-182.',
    notes:
      'The 1984 revision of the 1919 original, refitted to the Mayo Foundation ' +
      'data. Tends to over-predict by 5–15% versus Mifflin–St Jeor, especially ' +
      'in overweight subjects, because the original cohort was leaner and more ' +
      'active than a modern sample.',
    needsBodyFat: false,
    calc: ({ weightKg, heightCm, age, sex }) => {
      if (!isNum(weightKg) || !isNum(heightCm) || !isNum(age)) return null;
      return sex === 'male'
        ? 88.362 + 13.397 * weightKg + 4.799 * heightCm - 5.677 * age
        : 447.593 + 9.247 * weightKg + 3.098 * heightCm - 4.33 * age;
    },
  },

  katch: {
    id: 'katch',
    label: 'Katch–McArdle',
    citation: 'Katch FI, McArdle WD. Nutrition, Weight Control and Exercise. 1983.',
    notes:
      'Driven entirely by fat-free mass, which is the tissue that actually ' +
      'respires — so it handles muscular and lean physiques far better than ' +
      'weight-based equations. Accuracy is bounded by the accuracy of your ' +
      'body-fat measurement; a bad body-fat number makes this worse than ' +
      'Mifflin–St Jeor, not better.',
    needsBodyFat: true,
    calc: (state) => {
      const lbm = leanMassKg(state);
      return lbm == null ? null : 370 + 21.6 * lbm;
    },
  },

  cunningham: {
    id: 'cunningham',
    label: 'Cunningham',
    citation: 'Cunningham JJ. Am J Clin Nutr. 1980;33(11):2372-2374.',
    notes:
      'Also fat-free-mass based, and validated specifically in athletic ' +
      'populations, where it out-performs Mifflin–St Jeor. Runs roughly ' +
      '5–8% higher than Katch–McArdle at typical lean masses. Preferred if ' +
      'you train hard and carry above-average muscle.',
    needsBodyFat: true,
    calc: (state) => {
      const lbm = leanMassKg(state);
      return lbm == null ? null : 500 + 22 * lbm;
    },
  },

  tenhaaf: {
    id: 'tenhaaf',
    label: 'Ten Haaf (athletes)',
    citation: 'Ten Haaf T, Weijs PJM. PLoS One. 2014;9(9):e108460.',
    notes:
      'Fitted on recreational and competitive athletes, using fat-free mass. ' +
      'Included because the four classic equations were all derived on general ' +
      'or clinical populations. Use only if you train ≥5 h/week.',
    needsBodyFat: true,
    calc: (state) => {
      const lbm = leanMassKg(state);
      return lbm == null ? null : 95.272 + 22.771 * lbm;
    },
  },
};

/** Registry order for menus. */
export const BMR_FORMULA_IDS = ['mifflin', 'harris', 'katch', 'cunningham', 'tenhaaf'];

export const DEFAULT_BMR_FORMULA = 'mifflin';

/* ============================================================
   RESOLUTION
   ============================================================ */

/**
 * @typedef {Object} BmrResult
 * @property {number|null} kcal
 * @property {string}      formulaId   the equation actually used
 * @property {string}      formulaLabel
 * @property {boolean}     fellBack    true if the requested equation was unusable
 * @property {string|null} fallbackReason
 * @property {number|null} leanMassKg
 * @property {number|null} bodyFatPct  the value used, measured or estimated
 * @property {boolean}     bodyFatEstimated
 */

/**
 * Compute BMR, falling back safely when the requested equation's inputs are
 * missing. Lean-mass equations will use a Deurenberg estimate only if
 * `allowEstimatedBodyFat` is set — otherwise they fall back to Mifflin–St Jeor,
 * because a guessed body fat inside a body-fat equation is false precision.
 *
 * @param {BodyState} state
 * @param {string} [formulaId]
 * @param {{allowEstimatedBodyFat?: boolean}} [options]
 * @returns {BmrResult}
 */
export function computeBmr(state, formulaId = DEFAULT_BMR_FORMULA, options = {}) {
  const requested = BMR_FORMULAS[formulaId] ?? BMR_FORMULAS[DEFAULT_BMR_FORMULA];

  let workingState = { ...state };
  let bodyFatEstimated = false;
  let fallbackReason = null;

  if (requested.needsBodyFat && !isNum(state.bodyFatPct)) {
    if (options.allowEstimatedBodyFat) {
      const est = estimateBodyFatDeurenberg(state);
      if (isNum(est)) {
        workingState.bodyFatPct = clamp(est, 3, 60);
        bodyFatEstimated = true;
      }
    }
    if (!isNum(workingState.bodyFatPct)) {
      const fb = BMR_FORMULAS[DEFAULT_BMR_FORMULA];
      return {
        kcal: fb.calc(workingState),
        formulaId: fb.id,
        formulaLabel: fb.label,
        fellBack: true,
        fallbackReason: `${requested.label} needs a body-fat percentage — using ${fb.label} until one is logged.`,
        leanMassKg: null,
        bodyFatPct: null,
        bodyFatEstimated: false,
      };
    }
  }

  const kcal = requested.calc(workingState);
  if (!isNum(kcal)) {
    return {
      kcal: null,
      formulaId: requested.id,
      formulaLabel: requested.label,
      fellBack: false,
      fallbackReason: 'Missing height, age or weight.',
      leanMassKg: leanMassKg(workingState),
      bodyFatPct: workingState.bodyFatPct ?? null,
      bodyFatEstimated,
    };
  }

  return {
    kcal,
    formulaId: requested.id,
    formulaLabel: requested.label,
    fellBack: false,
    fallbackReason,
    leanMassKg: leanMassKg(workingState),
    bodyFatPct: workingState.bodyFatPct ?? null,
    bodyFatEstimated,
  };
}

/**
 * Every equation's output for the same body state — used by the Settings screen
 * to show the spread between models, which is itself informative: a wide spread
 * means the physiological prior deserves less weight.
 * @returns {Array<{id: string, label: string, kcal: number|null, available: boolean, notes: string, citation: string}>}
 */
export function compareFormulas(state) {
  return BMR_FORMULA_IDS.map((id) => {
    const f = BMR_FORMULAS[id];
    const available = !f.needsBodyFat || isNum(state.bodyFatPct);
    return {
      id,
      label: f.label,
      kcal: available ? f.calc(state) : null,
      available,
      notes: f.notes,
      citation: f.citation,
    };
  });
}

/**
 * Sensitivity of BMR to body mass, kcal per kg, evaluated locally. Feeds the
 * forward projection in model/projection.js, where expenditure must fall as
 * weight falls — the failure that makes naive "3500 kcal per pound" plans
 * over-promise.
 */
export function bmrPerKg(state, formulaId) {
  const lo = computeBmr({ ...state, weightKg: state.weightKg - 0.5 }, formulaId);
  const hi = computeBmr({ ...state, weightKg: state.weightKg + 0.5 }, formulaId);
  if (!isNum(lo.kcal) || !isNum(hi.kcal)) return null;
  return hi.kcal - lo.kcal;
}

/* ---------- internals ---------- */

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
