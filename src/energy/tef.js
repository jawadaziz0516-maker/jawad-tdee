/**
 * tef.js — thermic effect of food.
 *
 * Most calculators bolt a flat 10% onto TDEE. That is the population average
 * for a mixed diet, and it is wrong in the direction that matters most to
 * anyone tracking macros: a 200 g protein day and a 60 g protein day at the
 * same calories differ by roughly 100–150 kcal of thermic cost. Computing TEF
 * from the actual macro split rather than from total calories is one of the
 * cheapest accuracy wins available.
 *
 * Coefficients are the proportion of each macronutrient's ingested energy
 * dissipated as heat over the following ~6 hours:
 *
 *   Protein   20–30%   — obligatory cost of deamination, ureagenesis and
 *                        peptide-bond synthesis; the largest and most reliable
 *   Carbohydrate 5–10% — glycogen storage cost; higher when de-novo lipogenesis
 *                        is engaged, which is rare outside massive overfeeding
 *   Fat        0–3%    — dietary fat is stored with almost no processing cost
 *   Alcohol   10–20%   — hepatic oxidation via ADH and the MEOS pathway
 *
 * Refs: Westerterp KR. Nutr Metab (Lond). 2004;1(1):5.
 *       Halton TL, Hu FB. J Am Coll Nutr. 2004;23(5):373-385.
 *       Suter PM, et al. Am J Clin Nutr. 1994;59(1):1-5 (alcohol).
 *
 * @module energy/tef
 */

import { ATWATER, FIBRE_METABOLISABLE_KCAL_PER_G } from '../core/constants.js';

/** Mid-range defaults, overridable in settings. */
export const DEFAULT_TEF_COEFFICIENTS = {
  protein: 0.25,
  carb: 0.075,
  fat: 0.02,
  alcohol: 0.15,
  /** Applied to calories not explained by the logged macros — assumes a mixed
   *  composition. Also covers the case where only total calories are logged. */
  unaccounted: 0.10,
};

export const TEF_COEFFICIENT_RANGES = {
  protein: [0.20, 0.30],
  carb: [0.05, 0.10],
  fat: [0.0, 0.03],
  alcohol: [0.10, 0.20],
  unaccounted: [0.05, 0.15],
};

/**
 * @typedef {Object} Intake
 * @property {number} [kcal]      as logged; if absent it is derived from macros
 * @property {number} [protein]   grams
 * @property {number} [carbs]     grams
 * @property {number} [fat]       grams
 * @property {number} [fiber]     grams
 * @property {number} [alcohol]   grams
 *
 * @typedef {Object} TefResult
 * @property {number} kcal              thermic cost of the day's intake
 * @property {number} fraction          kcal ÷ metabolisable intake
 * @property {number} metabolisableKcal intake after any fibre correction
 * @property {number} loggedKcal        intake exactly as logged
 * @property {number} macroKcal         energy explained by the logged macros
 * @property {number} unaccountedKcal   logged calories the macros do not explain
 * @property {{protein:number,carb:number,fat:number,alcohol:number,unaccounted:number}} breakdown
 * @property {boolean} macrosComplete
 * @property {string[]} notes
 */

/**
 * @param {Intake} intake
 * @param {{coefficients?: Partial<typeof DEFAULT_TEF_COEFFICIENTS>, applyFibreCorrection?: boolean}} [options]
 * @returns {TefResult}
 */
export function computeTef(intake = {}, options = {}) {
  const c = { ...DEFAULT_TEF_COEFFICIENTS, ...(options.coefficients || {}) };
  const applyFibre = options.applyFibreCorrection === true;
  const notes = [];

  const protein = num(intake.protein);
  const carbs = num(intake.carbs);
  const fat = num(intake.fat);
  const alcohol = num(intake.alcohol);
  const fiber = num(intake.fiber);

  const proteinKcal = protein * ATWATER.protein;
  const carbKcal = carbs * ATWATER.carb;
  const fatKcal = fat * ATWATER.fat;
  const alcoholKcal = alcohol * ATWATER.alcohol;
  const macroKcal = proteinKcal + carbKcal + fatKcal + alcoholKcal;

  const loggedKcal = isNum(intake.kcal) ? intake.kcal : macroKcal;

  /* Fibre correction — optional and off by default.
     US Nutrition Facts labels count fibre inside total carbohydrate at 4 kcal/g,
     but only ~2 kcal/g is metabolisable. Applying this when your food database
     already excludes fibre (as EU labelling does) would double-subtract, which
     is why the default is off. */
  let metabolisableKcal = loggedKcal;
  let fibreAdjustment = 0;
  if (applyFibre && fiber > 0) {
    fibreAdjustment = fiber * (ATWATER.carb - FIBRE_METABOLISABLE_KCAL_PER_G);
    metabolisableKcal = Math.max(0, loggedKcal - fibreAdjustment);
    notes.push(
      `Fibre correction: −${Math.round(fibreAdjustment)} kcal from ${Math.round(fiber)} g fibre ` +
        `(counted at 2 kcal/g rather than 4).`,
    );
  }

  // Calories logged but not explained by macros — mixed-composition assumption.
  const unaccountedKcal = Math.max(0, metabolisableKcal - macroKcal);
  const macrosComplete = macroKcal > 0 && unaccountedKcal / Math.max(1, metabolisableKcal) < 0.08;

  if (macroKcal === 0 && metabolisableKcal > 0) {
    notes.push(
      'No macros logged — TEF fell back to a flat mixed-diet rate. Logging ' +
        'protein alone recovers most of the available accuracy here.',
    );
  } else if (!macrosComplete && macroKcal > 0) {
    notes.push(
      `${Math.round(unaccountedKcal)} kcal are not explained by the logged macros ` +
        'and were costed at the mixed-diet rate.',
    );
  }

  // If macros overshoot logged calories, scale them proportionally rather than
  // reporting a negative remainder.
  //
  // The scaling always applies, but the *note* only fires past a tolerance.
  // Atwater factors are integers applied to rounded gram counts, so a handful
  // of kcal of overshoot is arithmetic, not a mistake — warning about it every
  // day would train the user to ignore the warnings that matter.
  let scale = 1;
  if (macroKcal > metabolisableKcal && macroKcal > 0 && metabolisableKcal > 0) {
    scale = metabolisableKcal / macroKcal;
    const overshoot = macroKcal - metabolisableKcal;
    const tolerance = Math.max(25, metabolisableKcal * 0.02);
    if (overshoot > tolerance) {
      notes.push(
        `Logged macros come to ${Math.round(macroKcal)} kcal, more than the ` +
          `${Math.round(metabolisableKcal)} kcal logged — macro energy was scaled to match. ` +
          'A common cause is alcohol counted separately from the calorie total.',
      );
    }
  }

  const breakdown = {
    protein: proteinKcal * scale * c.protein,
    carb: carbKcal * scale * c.carb,
    fat: fatKcal * scale * c.fat,
    alcohol: alcoholKcal * scale * c.alcohol,
    unaccounted: unaccountedKcal * c.unaccounted,
  };

  const kcal =
    breakdown.protein + breakdown.carb + breakdown.fat + breakdown.alcohol + breakdown.unaccounted;

  return {
    kcal,
    fraction: metabolisableKcal > 0 ? kcal / metabolisableKcal : 0,
    metabolisableKcal,
    loggedKcal,
    macroKcal,
    unaccountedKcal,
    fibreAdjustment,
    breakdown,
    macrosComplete,
    notes,
  };
}

/**
 * The TEF fraction to assume for a *hypothetical* day at maintenance, given a
 * habitual macro split. Needed because TEF is a fraction of intake while
 * maintenance is what we are solving for — see `solveMaintenanceWithTef`.
 *
 * @param {{proteinPct:number, carbPct:number, fatPct:number, alcoholPct?:number}} split
 *        energy shares, each 0–1
 */
export function tefFractionForSplit(split, coefficients = DEFAULT_TEF_COEFFICIENTS) {
  const c = { ...DEFAULT_TEF_COEFFICIENTS, ...coefficients };
  const p = clamp01(split.proteinPct ?? 0);
  const cb = clamp01(split.carbPct ?? 0);
  const f = clamp01(split.fatPct ?? 0);
  const a = clamp01(split.alcoholPct ?? 0);
  const known = p + cb + f + a;
  const rest = Math.max(0, 1 - known);
  return p * c.protein + cb * c.carb + f * c.fat + a * c.alcohol + rest * c.unaccounted;
}

/**
 * Derive the habitual energy split from a set of logged days, so the TEF
 * fraction used in the maintenance fixed point reflects how this person
 * actually eats rather than a generic diet.
 *
 * @param {Intake[]} intakes
 */
export function habitualSplit(intakes) {
  let p = 0, c = 0, f = 0, a = 0, total = 0, days = 0;
  for (const i of intakes || []) {
    const macro =
      num(i.protein) * ATWATER.protein +
      num(i.carbs) * ATWATER.carb +
      num(i.fat) * ATWATER.fat +
      num(i.alcohol) * ATWATER.alcohol;
    const kcal = isNum(i.kcal) ? i.kcal : macro;
    if (kcal <= 0) continue;
    p += num(i.protein) * ATWATER.protein;
    c += num(i.carbs) * ATWATER.carb;
    f += num(i.fat) * ATWATER.fat;
    a += num(i.alcohol) * ATWATER.alcohol;
    total += kcal;
    days += 1;
  }
  if (total <= 0) {
    // A conventional mixed diet: 20% protein, 45% carbohydrate, 35% fat.
    return { proteinPct: 0.20, carbPct: 0.45, fatPct: 0.35, alcoholPct: 0, days: 0, assumed: true };
  }
  return {
    proteinPct: p / total,
    carbPct: c / total,
    fatPct: f / total,
    alcoholPct: a / total,
    days,
    assumed: false,
  };
}

/**
 * Solve the maintenance fixed point.
 *
 * Maintenance M satisfies  M = BMR + NEAT + EAT + TEF(M), and since TEF is
 * proportional to intake — which at maintenance *is* M — this closes to
 *
 *     M = (BMR + NEAT + EAT) / (1 − f)
 *
 * Adding a flat 10% to the sum instead, as most calculators do, understates
 * maintenance by about 1.2% — small, but free to get right.
 */
export function solveMaintenanceWithTef(bmrPlusNeatPlusEat, tefFraction) {
  const f = clamp(tefFraction ?? 0.1, 0, 0.4);
  return bmrPlusNeatPlusEat / (1 - f);
}

/* ---------- internals ---------- */

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function num(v) {
  return isNum(v) ? v : 0;
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function clamp01(v) {
  return clamp(v, 0, 1);
}
