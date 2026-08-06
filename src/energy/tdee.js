/**
 * tdee.js — composition of the four expenditure components.
 *
 * This module owns the *physiological* estimate: what the equations predict
 * from your body and behaviour. It knows nothing about your weight history.
 * The estimate it produces is used two ways downstream:
 *
 *   • as the Bayesian prior for the adaptive engine (model/maintenance.js)
 *   • as the day-level breakdown shown on the dashboard
 *
 * The composition is deliberately explicit about double-counting hazards:
 *
 *   BMR   covers 24 h of resting metabolism
 *   NEAT  is *net* of resting, and excludes steps attributed to exercise
 *   EAT   is *net* of resting for the exercise duration
 *   TEF   is a function of intake, solved as a fixed point at maintenance
 *
 * @module energy/tdee
 */

import { computeBmr, bmrPerKg, leanMassKg, fatMassKg } from './bmr.js';
import { computeNeat, neatPerKg, kcalPerStep } from './neat.js';
import { computeEat } from './eat.js';
import { computeTef, tefFractionForSplit, solveMaintenanceWithTef, habitualSplit } from './tef.js';
import { ageOn } from '../core/time.js';

/**
 * @typedef {Object} PhysiologicalEstimate
 * @property {number} maintenanceKcal   TDEE at maintenance intake (TEF solved)
 * @property {number} bmrKcal
 * @property {number} neatKcal
 * @property {number} eatKcal
 * @property {number} tefKcal           TEF component at maintenance
 * @property {number} tefKcalActual     TEF of the day's actual intake
 * @property {number} tefFraction
 * @property {Object} bmr               full BmrResult
 * @property {Object} neat              full NeatResult
 * @property {Object} eat               full EAT aggregate
 * @property {Object} tef               full TefResult for actual intake
 * @property {number} dMaintenanceDKg   sensitivity, kcal per kg of body mass
 * @property {number} kcalPerStep
 * @property {string[]} caveats
 */

/**
 * Compute the full physiological picture for a single day.
 *
 * @param {Object} args
 * @param {Object} args.profile   user profile (sex, birthDate, heightCm, formula, NEAT settings)
 * @param {Object} args.day       the day's log entry
 * @param {number} args.weightKg  body mass to use — pass TREND weight, not scale weight
 * @param {number} [args.bodyFatPct]
 * @param {Object} [args.habitual] habitual macro split for the TEF fixed point
 * @returns {PhysiologicalEstimate}
 */
export function computeDailyExpenditure({ profile, day, weightKg, bodyFatPct, habitual }) {
  const caveats = [];
  const age = ageOn(profile.birthDate) ?? profile.age ?? 30;

  const bodyState = {
    weightKg,
    heightCm: profile.heightCm,
    age,
    sex: profile.sex,
    bodyFatPct: bodyFatPct ?? day?.bodyFatPct ?? profile.bodyFatPct ?? undefined,
  };

  /* --- BMR --------------------------------------------------------------- */
  const bmr = computeBmr(bodyState, profile.bmrFormula, {
    allowEstimatedBodyFat: profile.allowEstimatedBodyFat === true,
  });
  if (bmr.fellBack && bmr.fallbackReason) caveats.push(bmr.fallbackReason);
  if (bmr.bodyFatEstimated) {
    caveats.push('Body fat is a BMI-based estimate (±4 pp) — a real measurement would tighten this.');
  }
  const bmrKcal = bmr.kcal ?? 0;

  /* --- EAT (before NEAT, because NEAT needs its step count) -------------- */
  const eat = computeEat(day?.exercise ?? [], {
    weightKg,
    bmrKcal,
    age,
    sex: profile.sex,
    heightCm: profile.heightCm,
    vo2max: profile.vo2max,
  }, { trustWearable: profile.trustWearable !== false });

  /* --- NEAT -------------------------------------------------------------- */
  const neat = computeNeat({
    weightKg,
    heightCm: profile.heightCm,
    steps: isNum(day?.steps) ? day.steps : undefined,
    exerciseSteps: profile.subtractExerciseSteps === false ? 0 : eat.steps,
    occupation: profile.occupation,
    workHours: profile.workHours,
    customNetMet: profile.customNetMet,
    customAmbulatoryShare: profile.customAmbulatoryShare,
    standingHours: profile.standingHours,
    fidget: profile.fidget,
    lifestyle: profile.lifestyle,
    manualOverrideKcal: isNum(day?.neatOverrideKcal) ? day.neatOverrideKcal : profile.neatOverrideKcal,
  });
  if (neat.stepsEstimated) {
    caveats.push(
      `No step count for this day — NEAT assumed ${neat.netSteps.toLocaleString()} steps from your ` +
        'lifestyle setting. Logging steps is the single highest-value input here.',
    );
  }

  /* --- TEF --------------------------------------------------------------- */
  const tefOptions = {
    coefficients: profile.tefCoefficients,
    applyFibreCorrection: profile.applyFibreCorrection === true,
  };
  const tef = computeTef(day?.intake ?? {}, tefOptions);
  caveats.push(...tef.notes);

  const split = habitual ?? habitualSplit(day?.intake ? [day.intake] : []);
  const tefFraction = tefFractionForSplit(split, profile.tefCoefficients);

  /* --- Maintenance fixed point ------------------------------------------ */
  const beforeTef = bmrKcal + neat.kcal + eat.kcal;
  const maintenanceKcal = solveMaintenanceWithTef(beforeTef, tefFraction);
  const tefKcal = maintenanceKcal - beforeTef;

  /* --- Sensitivity to body mass ----------------------------------------- */
  const dBmr = bmrPerKg(bodyState, profile.bmrFormula) ?? 0;
  const dNeat = neatPerKg({
    weightKg,
    heightCm: profile.heightCm,
    steps: isNum(day?.steps) ? day.steps : undefined,
    exerciseSteps: eat.steps,
    occupation: profile.occupation,
    workHours: profile.workHours,
    customNetMet: profile.customNetMet,
    customAmbulatoryShare: profile.customAmbulatoryShare,
    standingHours: profile.standingHours,
    fidget: profile.fidget,
    lifestyle: profile.lifestyle,
  });
  const dEat = weightKg > 0 ? eat.kcal / weightKg : 0; // EAT scales with mass
  const dMaintenanceDKg = (dBmr + dNeat + dEat) / (1 - tefFraction);

  return {
    maintenanceKcal,
    bmrKcal,
    neatKcal: neat.kcal,
    eatKcal: eat.kcal,
    tefKcal,
    tefKcalActual: tef.kcal,
    tefFraction,
    bmr,
    neat,
    eat,
    tef,
    leanMassKg: leanMassKg(bodyState),
    fatMassKg: fatMassKg(bodyState),
    dMaintenanceDKg,
    kcalPerStep: kcalPerStep(weightKg, profile.heightCm),
    caveats,
  };
}

/**
 * Uncertainty of the physiological estimate, used as the prior SD in the
 * Bayesian engine. This is not decoration — it decides how quickly observed
 * energy balance is allowed to overrule the equations. A tight prior on a
 * badly-specified model would keep the estimate wrong for months.
 *
 * Component SDs, added in quadrature (they are largely independent):
 *   BMR   ~8% of BMR   — published SEE for Mifflin–St Jeor and relatives
 *   NEAT  ~25% of NEAT — the dominant term; step-cost and occupational
 *                        assumptions are both coarse
 *   EAT   ~15% of EAT with heart rate, ~30% from MET tables alone
 *   TEF   ~15% of TEF
 *
 * @param {PhysiologicalEstimate} est
 * @returns {number} SD in kcal/day
 */
export function physiologicalUncertainty(est) {
  const eatSource = est.eat.sessions?.[0]?.source;
  const eatRelSd = eatSource === 'heartRate' || eatSource === 'wearable' ? 0.15 : 0.30;
  const parts = [
    0.08 * est.bmrKcal,
    0.25 * est.neatKcal,
    eatRelSd * est.eatKcal,
    0.15 * est.tefKcal,
  ];
  const variance = parts.reduce((s, sd) => s + sd * sd, 0);
  // Floor at 120 kcal: even a perfectly specified model cannot claim better,
  // given between-subject variation in metabolic efficiency.
  return Math.max(120, Math.sqrt(variance));
}

/**
 * Average of a set of daily estimates, for use as a stable prior over a window
 * rather than a single day (which would inherit that day's exercise noise).
 */
export function averageEstimates(estimates) {
  const list = estimates.filter(Boolean);
  if (!list.length) return null;
  const mean = (fn) => list.reduce((s, e) => s + fn(e), 0) / list.length;
  return {
    maintenanceKcal: mean((e) => e.maintenanceKcal),
    bmrKcal: mean((e) => e.bmrKcal),
    neatKcal: mean((e) => e.neatKcal),
    eatKcal: mean((e) => e.eatKcal),
    tefKcal: mean((e) => e.tefKcal),
    dMaintenanceDKg: mean((e) => e.dMaintenanceDKg),
    kcalPerStep: mean((e) => e.kcalPerStep),
    days: list.length,
  };
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
