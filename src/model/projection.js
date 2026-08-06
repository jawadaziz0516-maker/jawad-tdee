/**
 * projection.js — forward simulation of weight change.
 *
 * A static calculation ("500 kcal deficit ÷ 3,500 = 1 lb/week, forever") is
 * wrong in three compounding ways, all of which this module fixes:
 *
 *   1. Expenditure falls as you shrink. Less mass costs less to carry, heat and
 *      move, so the same intake becomes a smaller deficit every week.
 *   2. Tissue energy density changes. As fat mass falls, Forbes' relation
 *      shifts the composition of further loss toward lean tissue, which is
 *      cheaper per kilogram — the scale keeps moving even as the deficit
 *      narrows.
 *   3. Adaptive thermogenesis. Sustained restriction suppresses expenditure
 *      beyond what mass loss alone explains, with a lag of a couple of weeks.
 *
 * The result is the familiar asymptote: weight approaches a new plateau rather
 * than descending in a straight line. Anyone who has followed a linear
 * projection into month three has met this the hard way.
 *
 * Ref: Hall KD, et al. Lancet. 2011;378(9793):826-837.
 *      Thomas DM, et al. Am J Clin Nutr. 2010;92(6):1326-1331.
 *
 * @module model/projection
 */

import { ADAPTATION } from '../core/constants.js';
import { energyDensityOfChange, stepComposition, bodyFatPct as bfPct } from './bodyComposition.js';
import { Z_95 } from '../core/constants.js';

/**
 * @typedef {Object} ProjectionDay
 * @property {number} day
 * @property {number} weightKg
 * @property {number} fatMassKg
 * @property {number} leanMassKg
 * @property {number} bodyFatPct
 * @property {number} tdeeKcal        expenditure that day, after mass loss and adaptation
 * @property {number} adaptationKcal  the suppression term
 * @property {number} balanceKcal     intake − expenditure
 * @property {number} kcalPerKg       current tissue energy density
 * @property {number} cumulativeKcal
 */

/**
 * @param {Object} args
 * @param {number} args.startWeightKg
 * @param {number} args.bodyFatPct
 * @param {number} args.maintenanceKcal   current maintenance at the current weight
 * @param {number} args.intakeKcal        planned daily intake
 * @param {number} args.dMaintenanceDKg   kcal/day per kg of body mass
 * @param {number} args.days
 * @param {Object} [args.options]
 * @param {boolean} [args.options.applyAdaptation]
 * @param {number}  [args.options.resistanceSessionsPerWeek]
 * @param {number}  [args.options.proteinGPerKg]
 * @returns {{days: ProjectionDay[], summary: Object}}
 */
export function projectWeight({
  startWeightKg,
  bodyFatPct,
  maintenanceKcal,
  intakeKcal,
  dMaintenanceDKg = 20,
  days = 84,
  options = {},
}) {
  const { applyAdaptation = true, resistanceSessionsPerWeek = 0, proteinGPerKg = 0 } = options;

  const bf = Number.isFinite(bodyFatPct) ? bodyFatPct : 22;
  let fatMassKg = startWeightKg * (bf / 100);
  let leanMassKg = startWeightKg - fatMassKg;
  let weightKg = startWeightKg;
  let adaptation = 0;
  let cumulative = 0;

  const out = [];
  const maxAdaptation = ADAPTATION.MAX_FRACTION * maintenanceKcal;

  for (let d = 1; d <= days; d++) {
    // Expenditure at today's mass, before adaptation.
    const massEffect = dMaintenanceDKg * (weightKg - startWeightKg);
    const tdeeBeforeAdaptation = maintenanceKcal + massEffect;

    // Adaptive thermogenesis approaches β × (sustained change in intake) with a
    // first-order lag. Positive when eating below maintenance, i.e. it makes
    // expenditure fall further than mass alone would.
    if (applyAdaptation) {
      const target = Math.max(
        -maxAdaptation,
        Math.min(maxAdaptation, ADAPTATION.BETA * (maintenanceKcal - intakeKcal)),
      );
      adaptation += (target - adaptation) / ADAPTATION.TAU_DAYS;
    }

    const tdee = tdeeBeforeAdaptation - adaptation;
    const balance = intakeKcal - tdee;
    cumulative += balance;

    const density = energyDensityOfChange({
      fatMassKg,
      inSurplus: balance > 0,
      resistanceSessionsPerWeek,
      proteinGPerKg,
      applyTrainingAdjustment: options.applyTrainingPartitioning !== false,
    });

    const deltaKg = balance / density.kcalPerKg;
    const stepped = stepComposition({ fatMassKg, leanMassKg, deltaKg }, {
      resistanceSessionsPerWeek,
      proteinGPerKg,
      applyTrainingAdjustment: options.applyTrainingPartitioning !== false,
    });
    fatMassKg = stepped.fatMassKg;
    leanMassKg = stepped.leanMassKg;
    weightKg = fatMassKg + leanMassKg;

    out.push({
      day: d,
      weightKg,
      fatMassKg,
      leanMassKg,
      bodyFatPct: bfPct(fatMassKg, leanMassKg),
      tdeeKcal: tdee,
      adaptationKcal: adaptation,
      balanceKcal: balance,
      kcalPerKg: density.kcalPerKg,
      cumulativeKcal: cumulative,
    });
  }

  const last = out[out.length - 1];
  const naiveDeltaKg = (((intakeKcal - maintenanceKcal) * days) / 3500) * 0.45359237;

  return {
    days: out,
    summary: {
      startWeightKg,
      endWeightKg: last?.weightKg ?? startWeightKg,
      deltaKg: (last?.weightKg ?? startWeightKg) - startWeightKg,
      fatDeltaKg: (last?.fatMassKg ?? fatMassKg) - startWeightKg * (bf / 100),
      leanDeltaKg: (last?.leanMassKg ?? leanMassKg) - (startWeightKg - startWeightKg * (bf / 100)),
      endBodyFatPct: last?.bodyFatPct ?? bf,
      endTdee: last?.tdeeKcal ?? maintenanceKcal,
      adaptationKcal: last?.adaptationKcal ?? 0,
      /** What the 3,500 kcal rule would have promised, for contrast. */
      naiveDeltaKg,
      naiveOverstatementKg: naiveDeltaKg - ((last?.weightKg ?? startWeightKg) - startWeightKg),
      averageWeeklyKg: (((last?.weightKg ?? startWeightKg) - startWeightKg) / days) * 7,
    },
  };
}

/**
 * Project with an uncertainty band, by running the simulation at the lower and
 * upper ends of the maintenance credible interval. The band is what makes the
 * projection honest: at ±150 kcal on maintenance, a "0.5 kg/week" plan is
 * really somewhere between 0.2 and 0.8, and you should know that before you
 * conclude in three weeks that your metabolism is broken.
 */
export function projectWithUncertainty({ maintenance, ...args }) {
  const half = Z_95 * maintenance.sd;
  const central = projectWeight({ ...args, maintenanceKcal: maintenance.kcal });
  // A HIGHER true maintenance means a LARGER deficit, so it pairs with the
  // faster-loss edge of the band.
  const fast = projectWeight({ ...args, maintenanceKcal: maintenance.kcal + half });
  const slow = projectWeight({ ...args, maintenanceKcal: maintenance.kcal - half });
  return { central, fast, slow };
}

/**
 * Days to reach a target weight at a given intake, or null if the trajectory
 * never gets there — which is the honest answer when a modest deficit
 * asymptotes above the goal.
 */
export function daysToTarget({ targetWeightKg, maxDays = 730, ...args }) {
  const { days } = projectWeight({ ...args, days: maxDays });
  const goingDown = targetWeightKg < args.startWeightKg;
  for (const d of days) {
    if (goingDown ? d.weightKg <= targetWeightKg : d.weightKg >= targetWeightKg) {
      return { days: d.day, date: null, projection: d };
    }
  }
  return null;
}

/**
 * Expected weight change over a past window given what was actually eaten —
 * the "did my body do what the energy balance said it should?" check. A large
 * persistent gap between expected and actual is the signal the adaptive engine
 * is picking up on.
 */
export function expectedVsActual({ meanIntake, maintenanceKcal, days, actualDeltaKg, fatMassKg }) {
  const density = energyDensityOfChange({
    fatMassKg,
    inSurplus: meanIntake > maintenanceKcal,
    applyTrainingAdjustment: false,
  });
  const expectedDeltaKg = ((meanIntake - maintenanceKcal) * days) / density.kcalPerKg;
  return {
    expectedDeltaKg,
    actualDeltaKg,
    discrepancyKg: actualDeltaKg - expectedDeltaKg,
    discrepancyKcalPerDay: ((actualDeltaKg - expectedDeltaKg) * density.kcalPerKg) / days,
    kcalPerKg: density.kcalPerKg,
  };
}
