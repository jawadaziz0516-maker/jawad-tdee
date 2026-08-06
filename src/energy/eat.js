/**
 * eat.js — exercise activity thermogenesis.
 *
 * Three independent estimators, resolved by a documented precedence:
 *
 *   1. WEARABLE   — a device-reported number, if you trust the device
 *   2. HEART RATE — Keytel regression, when average HR for the session is known
 *   3. MET        — Compendium table or ACSM speed equation
 *
 * All three are converted to *net* cost (above what you would have burned
 * resting for the same duration) before they leave this module, because BMR is
 * accounted separately in the TDEE sum. Skipping that subtraction inflates a
 * one-hour session by roughly 60–80 kcal, and someone training daily would
 * carry a permanent ~70 kcal/day overestimate into their maintenance number.
 *
 * @module energy/eat
 */

import { KCAL_PER_MET_KG_HOUR } from '../core/constants.js';
import {
  ACTIVITIES,
  metFromRpe,
  metFromSpeed,
  speedModelIsValid,
} from './metTable.js';

/**
 * @typedef {Object} ExerciseEntry
 * @property {string}  activityId
 * @property {number}  minutes
 * @property {number} [avgHr]         session average heart rate, bpm
 * @property {number} [distanceKm]
 * @property {number} [wearableKcal]  device-reported energy
 * @property {boolean}[wearableIsNet] true if the device already excludes resting
 * @property {number} [rpe]           Borg CR10, 1–10
 * @property {number} [customMet]     for activityId === 'custom'
 * @property {string} [note]
 *
 * @typedef {Object} EatContext
 * @property {number} weightKg
 * @property {number} bmrKcal    the individual's own BMR for the day
 * @property {number} age
 * @property {'male'|'female'} sex
 * @property {number} [heightCm]
 * @property {number} [vo2max]   improves the Keytel estimate materially
 *
 * @typedef {Object} EatEstimate
 * @property {number} netKcal      above-resting cost
 * @property {number} grossKcal    total cost including resting for the duration
 * @property {number} restingKcal  the amount subtracted
 * @property {'wearable'|'heartRate'|'speed'|'met'} source
 * @property {number|null} met     effective MET, where applicable
 * @property {number} estimatedSteps
 * @property {string} label
 * @property {string} rationale
 */

/* ============================================================
   HEART-RATE MODEL
   ============================================================ */

/**
 * Keytel et al. energy expenditure from heart rate, kJ/min → kcal/min.
 * Ref: Keytel LR, et al. J Sports Sci. 2005;23(3):289-297.
 *
 * Validity notes, which matter more than the equation itself:
 *  • Fitted between roughly 90 and 150 bpm. Outside that band it degrades,
 *    and above ~90% HRmax it over-estimates because HR keeps climbing while
 *    oxygen uptake plateaus (cardiac drift).
 *  • Assumes a steady aerobic state. It is poorly suited to weight lifting,
 *    where HR is driven by pressor response rather than oxygen cost — a heavy
 *    set of squats spikes HR without a matching energy cost.
 *  • The VO2max form is meaningfully more accurate; supply it if you know it.
 */
export function keytelKcalPerMin({ avgHr, weightKg, age, sex, vo2max }) {
  if (!isNum(avgHr) || !isNum(weightKg) || !isNum(age)) return null;
  const male = sex === 'male';

  let kj;
  if (isNum(vo2max)) {
    kj = male
      ? -59.3954 + (-36.3781 + 0.271 * age + 0.394 * weightKg + 0.404 * vo2max + 0.634 * avgHr)
      : -59.3954 + (0.274 * age + 0.103 * weightKg + 0.380 * vo2max + 0.450 * avgHr);
  } else {
    kj = male
      ? -55.0969 + 0.6309 * avgHr + 0.1988 * weightKg + 0.2017 * age
      : -20.4022 + 0.4472 * avgHr - 0.1263 * weightKg + 0.074 * age;
  }
  return kj / 4.184; // kJ/min → kcal/min
}

/** How far outside Keytel's fitted range this HR sits — drives the warning. */
export function heartRateConfidence(avgHr, age) {
  if (!isNum(avgHr)) return { ok: false, warning: null };
  const hrMax = isNum(age) ? 208 - 0.7 * age : 190; // Tanaka HR, et al. JACC. 2001
  const pct = avgHr / hrMax;
  if (avgHr < 90) {
    return { ok: false, warning: 'Below Keytel’s fitted range (~90 bpm) — MET estimate used instead.' };
  }
  if (pct > 0.9) {
    return { ok: true, warning: 'Near maximal heart rate — HR-derived cost tends to run high here.' };
  }
  return { ok: true, warning: null };
}

/* ============================================================
   SINGLE-SESSION ESTIMATE
   ============================================================ */

/**
 * @param {ExerciseEntry} entry
 * @param {EatContext} ctx
 * @param {{trustWearable?: boolean}} [options]
 * @returns {EatEstimate}
 */
export function estimateExercise(entry, ctx, options = {}) {
  const { trustWearable = true } = options;
  const activity = ACTIVITIES[entry.activityId] ?? ACTIVITIES.custom;
  const minutes = isNum(entry.minutes) ? Math.max(0, entry.minutes) : 0;
  const hours = minutes / 60;

  // Resting energy for the same duration, from this person's own BMR rather
  // than the population 1.0-MET convention.
  const restingKcal = isNum(ctx.bmrKcal) ? (ctx.bmrKcal / 1440) * minutes : 0;

  const estimatedSteps = estimateStepsFor(entry, activity, ctx);

  /* --- 1. Wearable ------------------------------------------------------- */
  if (trustWearable && isNum(entry.wearableKcal) && entry.wearableKcal > 0) {
    const gross = entry.wearableIsNet ? entry.wearableKcal + restingKcal : entry.wearableKcal;
    return {
      netKcal: Math.max(0, gross - restingKcal),
      grossKcal: gross,
      restingKcal,
      source: 'wearable',
      met: minutes > 0 && ctx.weightKg ? gross / (KCAL_PER_MET_KG_HOUR * ctx.weightKg * hours) : null,
      estimatedSteps,
      label: activity.label,
      rationale: entry.wearableIsNet
        ? 'Device value, treated as already excluding resting metabolism.'
        : 'Device value, treated as total burn; your resting rate for the session was subtracted.',
    };
  }

  /* --- 2. Heart rate ----------------------------------------------------- */
  const hrOk = heartRateConfidence(entry.avgHr, ctx.age);
  const suitableForHr = entry.activityId !== 'weights';
  if (isNum(entry.avgHr) && hrOk.ok && suitableForHr && minutes > 0) {
    const perMin = keytelKcalPerMin({
      avgHr: entry.avgHr,
      weightKg: ctx.weightKg,
      age: ctx.age,
      sex: ctx.sex,
      vo2max: ctx.vo2max,
    });
    if (isNum(perMin) && perMin > 0) {
      const gross = perMin * minutes;
      return {
        netKcal: Math.max(0, gross - restingKcal),
        grossKcal: gross,
        restingKcal,
        source: 'heartRate',
        met: ctx.weightKg ? gross / (KCAL_PER_MET_KG_HOUR * ctx.weightKg * hours) : null,
        estimatedSteps,
        label: activity.label,
        rationale:
          `Keytel HR regression at ${Math.round(entry.avgHr)} bpm` +
          (ctx.vo2max ? ' with VO₂max.' : '.') +
          (hrOk.warning ? ` ${hrOk.warning}` : ''),
      };
    }
  }

  /* --- 3. Speed-based MET ------------------------------------------------ */
  if (activity.speedModel && isNum(entry.distanceKm) && entry.distanceKm > 0 && minutes > 0) {
    const speedKmh = entry.distanceKm / hours;
    if (speedModelIsValid(activity.speedModel, speedKmh)) {
      const met = metFromSpeed(activity.speedModel, speedKmh);
      const gross = met * KCAL_PER_MET_KG_HOUR * ctx.weightKg * hours;
      return {
        netKcal: Math.max(0, gross - restingKcal),
        grossKcal: gross,
        restingKcal,
        source: 'speed',
        met,
        estimatedSteps,
        label: activity.label,
        rationale:
          `ACSM ${activity.speedModel} equation at ${speedKmh.toFixed(1)} km/h ` +
          `(${met.toFixed(1)} METs) — pace-derived, more specific than the MET table.`,
      };
    }
  }

  /* --- 4. MET table ------------------------------------------------------ */
  const met =
    entry.activityId === 'custom' && isNum(entry.customMet)
      ? entry.customMet
      : metFromRpe(activity, entry.rpe);
  const gross = met * KCAL_PER_MET_KG_HOUR * ctx.weightKg * hours;
  return {
    netKcal: Math.max(0, gross - restingKcal),
    grossKcal: gross,
    restingKcal,
    source: 'met',
    met,
    estimatedSteps,
    label: activity.label,
    rationale: isNum(entry.rpe)
      ? `Compendium MET range scaled to RPE ${entry.rpe} (${met.toFixed(1)} METs).`
      : `Compendium typical value (${met.toFixed(1)} METs). Adding RPE or heart rate sharpens this.`,
  };
}

/**
 * Steps a wearable would plausibly have logged during this session, so NEAT can
 * subtract them and avoid paying for the same movement twice.
 */
function estimateStepsFor(entry, activity, ctx) {
  if (!activity.producesSteps) return 0;
  const strideM = ((ctx.heightCm ?? 175) / 100) * 0.415;

  if (isNum(entry.distanceKm) && entry.distanceKm > 0) {
    // Running stride is longer than walking stride — roughly 1.35× at
    // recreational paces.
    const factor = activity.id === 'running' ? 1.35 : 1.0;
    return Math.round((entry.distanceKm * 1000) / (strideM * factor));
  }
  // Fall back to a cadence assumption for court/field sports and treadmill work.
  const cadence = activity.id === 'running' ? 165 : activity.id === 'walking' ? 110 : 90;
  return Math.round(cadence * (entry.minutes || 0));
}

/* ============================================================
   DAY AGGREGATE
   ============================================================ */

/**
 * @param {ExerciseEntry[]} entries
 * @param {EatContext} ctx
 * @param {{trustWearable?: boolean}} [options]
 * @returns {{kcal: number, steps: number, minutes: number, sessions: Array<EatEstimate & {entry: ExerciseEntry}>}}
 */
export function computeEat(entries, ctx, options) {
  const list = Array.isArray(entries) ? entries : [];
  const sessions = list.map((entry) => ({
    ...estimateExercise(entry, ctx, options),
    entry,
  }));
  return {
    kcal: sessions.reduce((s, x) => s + x.netKcal, 0),
    steps: sessions.reduce((s, x) => s + x.estimatedSteps, 0),
    minutes: list.reduce((s, e) => s + (isNum(e.minutes) ? e.minutes : 0), 0),
    sessions,
  };
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
