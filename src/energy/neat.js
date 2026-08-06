/**
 * neat.js — non-exercise activity thermogenesis.
 *
 * NEAT is the most variable component of human energy expenditure: Levine's
 * overfeeding work found a ~700 kcal/day spread between individuals in how much
 * spontaneous activity changed in response to the same surplus. It is also the
 * component that generic TDEE calculators collapse into a single "activity
 * multiplier", which is where most of their error comes from.
 *
 * This module builds NEAT additively from four measurable-ish parts:
 *
 *   1. Ambulatory   — from step count, costed by body mass and stride length
 *   2. Occupational — the non-ambulatory demand of work (carrying, lifting,
 *                     pedalling), with the walking share removed so it is not
 *                     counted twice against steps
 *   3. Postural     — standing hours above sitting
 *   4. Spontaneous  — fidgeting / restlessness constitutional term
 *
 * DOUBLE-COUNTING is the central design hazard here, on two fronts:
 *   • Steps vs. occupation — handled by each occupation's `ambulatoryShare`.
 *   • Steps vs. logged exercise — handled by `exerciseSteps`, subtracted by
 *     the caller (see energy/tdee.js) so a logged 10 km run does not also
 *     inflate NEAT through the step count that wearable recorded.
 *
 * Ref: Levine JA, et al. Science. 1999;283(5399):212-214.
 *      Levine JA. Best Pract Res Clin Endocrinol Metab. 2002;16(4):679-702.
 *
 * @module energy/neat
 */

import {
  WALK_NET_KCAL_PER_KG_KM,
  STRIDE_TO_HEIGHT_RATIO,
  STANDING_PREMIUM_KCAL_PER_KG_H,
  KCAL_PER_MET_KG_HOUR,
} from '../core/constants.js';

/* ============================================================
   OCCUPATION PROFILES
   ============================================================
   `netMet`         METs above rest sustained during work hours.
   `ambulatoryShare` fraction of that demand that shows up as steps, and is
                     therefore already paid for by the ambulatory term.
   MET values follow the 2011 Compendium of Physical Activities
   (Ainsworth BE, et al. Med Sci Sports Exerc. 2011;43(8):1575-1581). */

export const OCCUPATIONS = {
  desk: {
    id: 'desk',
    label: 'Desk / seated',
    netMet: 0.3,
    ambulatoryShare: 0.3,
    defaultStandingHours: 1,
    defaultHours: 8,
    note: 'Office work, driving, studying. Compendium 1.3–1.5 METs.',
  },
  mixed: {
    id: 'mixed',
    label: 'Mixed seated & standing',
    netMet: 0.7,
    ambulatoryShare: 0.5,
    defaultStandingHours: 3,
    defaultHours: 8,
    note: 'Teaching, lab work, retail floor with a counter.',
  },
  standing: {
    id: 'standing',
    label: 'Standing / on your feet',
    netMet: 1.1,
    ambulatoryShare: 0.6,
    defaultStandingHours: 6,
    defaultHours: 8,
    note: 'Hospitality, retail, hairdressing. Compendium ~2.0–2.3 METs.',
  },
  lightManual: {
    id: 'lightManual',
    label: 'Light manual',
    netMet: 1.8,
    ambulatoryShare: 0.5,
    defaultStandingHours: 6,
    defaultHours: 8,
    note: 'Nursing, warehouse picking, bartending. Compendium ~2.5–3.0 METs.',
  },
  heavyManual: {
    id: 'heavyManual',
    label: 'Heavy manual',
    netMet: 3.2,
    ambulatoryShare: 0.4,
    defaultStandingHours: 7,
    defaultHours: 8,
    note: 'Construction, landscaping, moving. Compendium ~4.0–5.5 METs.',
  },
  cycleCourier: {
    id: 'cycleCourier',
    label: 'Cycling work (pedicab / courier)',
    netMet: 5.5,
    ambulatoryShare: 0.05,
    defaultStandingHours: 1,
    defaultHours: 6,
    note:
      'Load-bearing cycling is 6–9 METs and produces almost no steps, so it ' +
      'is invisible to a step counter — hence the low ambulatory share. If ' +
      'you wear a heart-rate monitor at work, log those hours as exercise ' +
      'instead and set occupation to Desk: HR-derived cost beats this estimate.',
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    netMet: 1.0,
    ambulatoryShare: 0.5,
    defaultStandingHours: 4,
    defaultHours: 8,
    note: 'Set the MET load and ambulatory share by hand.',
  },
};

export const OCCUPATION_IDS = Object.keys(OCCUPATIONS);

/* ============================================================
   SPONTANEOUS / FIDGET TERM
   ============================================================
   Deliberately conservative relative to the ~700 kcal between-subject range
   Levine reported, because self-assessed restlessness is a weak instrument.
   If the adaptive engine consistently lands above or below the physiological
   prior, this is the term most likely to be responsible. */

export const FIDGET_LEVELS = {
  low: { id: 'low', label: 'Still', kcal: -120, note: 'Rarely restless; sits without shifting.' },
  average: { id: 'average', label: 'Average', kcal: 0, note: 'Population mid-point.' },
  high: { id: 'high', label: 'Restless', kcal: 200, note: 'Paces on calls, taps, rarely settles.' },
  veryHigh: { id: 'veryHigh', label: 'Very restless', kcal: 350, note: 'Constant motion; cannot sit still.' },
};

/* ============================================================
   LIFESTYLE FALLBACK
   ============================================================
   Only used when no step count is available for a day — maps a coarse
   self-report onto an expected step count, so the ambulatory term still has
   something to work with. */

export const LIFESTYLE_LEVELS = {
  sedentary: { id: 'sedentary', label: 'Sedentary', steps: 3000 },
  lightlyActive: { id: 'lightlyActive', label: 'Lightly active', steps: 6000 },
  moderatelyActive: { id: 'moderatelyActive', label: 'Moderately active', steps: 9000 },
  veryActive: { id: 'veryActive', label: 'Very active', steps: 13000 },
  extremelyActive: { id: 'extremelyActive', label: 'Extremely active', steps: 18000 },
};

/* ============================================================
   AMBULATORY COST
   ============================================================ */

/** Stride length in metres from standing height. */
export function strideLengthM(heightCm) {
  if (!isNum(heightCm)) return 0.72;
  return (heightCm / 100) * STRIDE_TO_HEIGHT_RATIO;
}

/**
 * Net energy cost of a step count, above resting metabolism.
 * Net (not gross) because BMR is accounted separately — adding gross walking
 * cost to a full-day BMR double-counts resting expenditure for the time spent
 * walking.
 */
export function stepsToKcal(steps, weightKg, heightCm) {
  if (!isNum(steps) || !isNum(weightKg) || steps <= 0) return 0;
  const km = (steps * strideLengthM(heightCm)) / 1000;
  return km * weightKg * WALK_NET_KCAL_PER_KG_KM;
}

/** Marginal cost of one additional step — used for the day-adjusted target. */
export function kcalPerStep(weightKg, heightCm) {
  return stepsToKcal(1000, weightKg, heightCm) / 1000;
}

/* ============================================================
   FULL NEAT MODEL
   ============================================================ */

/**
 * @typedef {Object} NeatInputs
 * @property {number}  weightKg
 * @property {number}  heightCm
 * @property {number} [steps]           measured steps for the day
 * @property {number} [exerciseSteps]   steps already attributed to logged exercise
 * @property {string} [occupation]      key of OCCUPATIONS
 * @property {number} [workHours]
 * @property {number} [customNetMet]        used when occupation === 'custom'
 * @property {number} [customAmbulatoryShare]
 * @property {number} [standingHours]
 * @property {string} [fidget]          key of FIDGET_LEVELS
 * @property {string} [lifestyle]       key of LIFESTYLE_LEVELS, fallback for steps
 * @property {number} [manualOverrideKcal] bypasses the model entirely
 *
 * @typedef {Object} NeatResult
 * @property {number} kcal
 * @property {number} ambulatoryKcal
 * @property {number} occupationalKcal
 * @property {number} posturalKcal
 * @property {number} spontaneousKcal
 * @property {number} netSteps          steps credited to NEAT after exercise removal
 * @property {boolean} stepsEstimated   true when steps came from the lifestyle fallback
 * @property {boolean} overridden
 */

/**
 * @param {NeatInputs} input
 * @returns {NeatResult}
 */
export function computeNeat(input) {
  const {
    weightKg,
    heightCm,
    steps,
    exerciseSteps = 0,
    occupation = 'desk',
    workHours,
    customNetMet,
    customAmbulatoryShare,
    standingHours,
    fidget = 'average',
    lifestyle = 'lightlyActive',
    manualOverrideKcal,
  } = input;

  if (isNum(manualOverrideKcal)) {
    return {
      kcal: manualOverrideKcal,
      ambulatoryKcal: 0,
      occupationalKcal: 0,
      posturalKcal: 0,
      spontaneousKcal: 0,
      netSteps: 0,
      stepsEstimated: false,
      overridden: true,
    };
  }

  const occ = OCCUPATIONS[occupation] ?? OCCUPATIONS.desk;
  const netMet = occupation === 'custom' && isNum(customNetMet) ? customNetMet : occ.netMet;
  const ambShare =
    occupation === 'custom' && isNum(customAmbulatoryShare)
      ? clamp(customAmbulatoryShare, 0, 1)
      : occ.ambulatoryShare;

  // 1. Ambulatory — measured steps preferred, lifestyle self-report as fallback.
  const stepsEstimated = !isNum(steps);
  const rawSteps = stepsEstimated
    ? (LIFESTYLE_LEVELS[lifestyle] ?? LIFESTYLE_LEVELS.lightlyActive).steps
    : steps;
  const netSteps = Math.max(0, rawSteps - (exerciseSteps || 0));
  const ambulatoryKcal = stepsToKcal(netSteps, weightKg, heightCm);

  // 2. Occupational — only the share that steps cannot see.
  const hours = isNum(workHours) ? workHours : occ.defaultHours;
  const occupationalKcal =
    netMet * (1 - ambShare) * KCAL_PER_MET_KG_HOUR * weightKg * hours;

  // 3. Postural — standing above sitting, excluding work hours already counted
  //    inside the occupational MET load.
  const standHrs = isNum(standingHours) ? standingHours : occ.defaultStandingHours;
  const posturalKcal = Math.max(0, standHrs) * STANDING_PREMIUM_KCAL_PER_KG_H * weightKg;

  // 4. Spontaneous — constitutional restlessness.
  const spontaneousKcal = (FIDGET_LEVELS[fidget] ?? FIDGET_LEVELS.average).kcal;

  const kcal = Math.max(
    0,
    ambulatoryKcal + occupationalKcal + posturalKcal + spontaneousKcal,
  );

  return {
    kcal,
    ambulatoryKcal,
    occupationalKcal,
    posturalKcal,
    spontaneousKcal,
    netSteps,
    stepsEstimated,
    overridden: false,
  };
}

/**
 * Sensitivity of NEAT to body mass, kcal per kg. Every term except the
 * spontaneous one scales linearly with mass, so this is exact rather than
 * numerical.
 */
export function neatPerKg(input) {
  const a = computeNeat({ ...input, weightKg: input.weightKg - 0.5 });
  const b = computeNeat({ ...input, weightKg: input.weightKg + 0.5 });
  return b.kcal - a.kcal;
}

/* ---------- internals ---------- */

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
