/**
 * bodyComposition.js — how energy converts to body mass.
 *
 * THE PROBLEM WITH "3,500 kcal PER POUND"
 *
 * Wishnofsky's 1958 rule assumes every pound gained or lost is pure adipose
 * tissue (3,500 ≈ 454 g × 87% lipid × 9.4 kcal/g). Two things break it:
 *
 *   1. Weight change is never pure fat. It is a mixture of fat and fat-free
 *      mass, and the mixture depends on how fat you already are — a lean
 *      person loses proportionally more lean tissue, which stores only about a
 *      fifth as much energy per kilogram. For a lean man, the true figure is
 *      nearer 2,900 kcal/lb; for someone with obesity it approaches 3,600.
 *   2. Expenditure falls as you shrink. The rule is a static calculation
 *      applied to a dynamic system, which is why it over-predicts long-run
 *      weight loss by roughly a factor of two.
 *
 * This module handles (1). Point (2) lives in model/projection.js.
 *
 * Refs: Forbes GB. Ann N Y Acad Sci. 2000;904:359-365.
 *       Hall KD. Int J Obes. 2008;32(3):573-576.
 *       Thomas DM, et al. Am J Clin Nutr. 2010;92(6):1326-1331 (why the
 *       3500 rule fails dynamically).
 *
 * @module model/bodyComposition
 */

import { TISSUE, FORBES_C_KG, LB_PER_KG } from '../core/constants.js';

/**
 * Fraction of a weight change that comes from fat-free mass, from Forbes'
 * relation dFFM/dFM = C/FM:
 *
 *     p_lean = (C/FM) / (1 + C/FM) = C / (C + FM)
 *
 * The behaviour this produces is the whole point: at 15 kg of fat mass, 41% of
 * any weight change is lean tissue; at 45 kg, only 19% is. Lean people pay for
 * a deficit partly in muscle unless they defend it, and their scale moves
 * faster per calorie because lean tissue is mostly water.
 *
 * @param {number} fatMassKg
 * @returns {number} 0–1
 */
export function leanFractionOfChange(fatMassKg) {
  if (!(fatMassKg > 0)) return 0.5; // degenerate input — split the difference
  return FORBES_C_KG / (FORBES_C_KG + fatMassKg);
}

/**
 * Adjustment for resistance training in a surplus.
 *
 * ASSUMPTION, not an established constant. Forbes' relation was fitted mainly
 * to weight loss in untrained subjects. Hard resistance training with adequate
 * protein shifts partitioning toward lean mass in a surplus, and defends lean
 * mass in a deficit. The magnitude here (up to ±0.12 absolute on the lean
 * fraction) is deliberately modest and is exposed as a setting so it can be
 * turned off — do that if you want the pure Forbes model.
 *
 * @param {number} baseLeanFraction
 * @param {{inSurplus: boolean, resistanceSessionsPerWeek: number, proteinGPerKg: number}} ctx
 */
export function adjustForTraining(baseLeanFraction, ctx) {
  const sessions = Math.min(6, Math.max(0, ctx.resistanceSessionsPerWeek ?? 0));
  const protein = Math.min(2.5, Math.max(0, ctx.proteinGPerKg ?? 0));
  // Both inputs have to be present for any adjustment: lifting without protein
  // or protein without lifting does not move partitioning much.
  const stimulus = (sessions / 4) * Math.min(1, protein / 1.6);
  const magnitude = 0.12 * Math.min(1, stimulus);
  const shifted = ctx.inSurplus
    ? baseLeanFraction + magnitude          // build more lean in a surplus
    : baseLeanFraction - magnitude;         // spare lean in a deficit
  return Math.min(0.95, Math.max(0.05, shifted));
}

/**
 * Effective energy density of weight change, kcal per kg.
 *
 * @param {Object} args
 * @param {number} args.fatMassKg
 * @param {boolean} [args.inSurplus]
 * @param {number} [args.resistanceSessionsPerWeek]
 * @param {number} [args.proteinGPerKg]
 * @param {boolean} [args.applyTrainingAdjustment]
 * @returns {{kcalPerKg:number, kcalPerLb:number, leanFraction:number, fatFraction:number}}
 */
export function energyDensityOfChange({
  fatMassKg,
  inSurplus = false,
  resistanceSessionsPerWeek = 0,
  proteinGPerKg = 0,
  applyTrainingAdjustment = true,
}) {
  let leanFraction = leanFractionOfChange(fatMassKg);
  if (applyTrainingAdjustment) {
    leanFraction = adjustForTraining(leanFraction, {
      inSurplus,
      resistanceSessionsPerWeek,
      proteinGPerKg,
    });
  }
  const fatFraction = 1 - leanFraction;
  const kcalPerKg = leanFraction * TISSUE.LEAN_KCAL_PER_KG + fatFraction * TISSUE.FAT_KCAL_PER_KG;
  return {
    kcalPerKg,
    kcalPerLb: kcalPerKg / LB_PER_KG,
    leanFraction,
    fatFraction,
  };
}

/**
 * Split an observed weight change into its fat and lean parts.
 * @returns {{fatKg:number, leanKg:number, energyKcal:number, kcalPerKg:number}}
 */
export function decomposeWeightChange(deltaKg, densityArgs) {
  const d = energyDensityOfChange({ ...densityArgs, inSurplus: deltaKg > 0 });
  return {
    fatKg: deltaKg * d.fatFraction,
    leanKg: deltaKg * d.leanFraction,
    energyKcal: deltaKg * d.kcalPerKg,
    kcalPerKg: d.kcalPerKg,
  };
}

/**
 * Track fat and lean mass forward through a weight change, so the projection
 * can re-evaluate partitioning as body composition shifts. Without this, a
 * long simulated cut would keep using the starting fat mass and progressively
 * over-state how fast the scale moves.
 */
export function stepComposition({ fatMassKg, leanMassKg, deltaKg }, densityArgs = {}) {
  const d = energyDensityOfChange({ fatMassKg, inSurplus: deltaKg > 0, ...densityArgs });
  return {
    fatMassKg: Math.max(1, fatMassKg + deltaKg * d.fatFraction),
    leanMassKg: Math.max(20, leanMassKg + deltaKg * d.leanFraction),
    density: d,
  };
}

/** Body-fat percentage from a fat/lean pair. */
export function bodyFatPct(fatMassKg, leanMassKg) {
  const total = fatMassKg + leanMassKg;
  return total > 0 ? (fatMassKg / total) * 100 : null;
}

/**
 * The naive constant, for side-by-side display. Showing the user how far their
 * effective density sits from 3,500 kcal/lb is the clearest way to explain why
 * their weight moved more (or less) than a calculator promised.
 */
export const WISHNOFSKY_KCAL_PER_LB = 3500;
