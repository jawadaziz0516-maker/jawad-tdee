/**
 * demo.js — synthetic dataset with a known ground truth.
 *
 * This is not decoration. An estimator whose accuracy you cannot check is a
 * random number generator with good manners. The generator below simulates a
 * person whose true maintenance is a number *we choose*, runs their body
 * forward under real energy-balance physics, then corrupts the observations
 * the way reality does — water shifts from sodium and carbohydrate, scale
 * noise, missed weigh-ins, unlogged days.
 *
 * The engine then has to recover the number we picked. tests/tests.js asserts
 * that it lands within ±100 kcal, which is the only meaningful accuracy claim
 * this application can make about itself.
 *
 * @module data/demo
 */

import { addDays, todayISO } from '../core/time.js';
import { energyDensityOfChange } from '../model/bodyComposition.js';

/** Deterministic PRNG (mulberry32) — a fixed seed means a reproducible demo. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller normal deviate. */
function normal(rand, mean = 0, sd = 1) {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * @param {Object} [options]
 * @param {number} [options.days]
 * @param {number} [options.trueMaintenance]  kcal/day at the starting weight
 * @param {number} [options.startWeightKg]
 * @param {number} [options.bodyFatPct]
 * @param {number} [options.targetIntake]     what the simulated person eats
 * @param {number} [options.seed]
 * @param {number} [options.weighInProbability]
 * @param {number} [options.logProbability]
 * @returns {{days: Object[], truth: Object}}
 */
export function generateDemoData(options = {}) {
  const {
    days: nDays = 120,
    trueMaintenance = 2900,
    startWeightKg = 82,
    bodyFatPct = 18,
    targetIntake = 2500,
    seed = 20260804,
    weighInProbability = 0.85,
    logProbability = 0.9,
    dMaintenanceDKg = 22,
  } = options;

  const rand = rng(seed);
  const endDate = todayISO();
  const startDate = addDays(endDate, -(nDays - 1));

  let fatMassKg = startWeightKg * (bodyFatPct / 100);
  let leanMassKg = startWeightKg - fatMassKg;
  let trueWeight = startWeightKg;
  let adaptation = 0;

  const out = [];
  const truthSeries = [];
  const rawWater = [];

  for (let i = 0; i < nDays; i++) {
    const date = addDays(startDate, i);
    const dow = new Date(date + 'T00:00:00').getDay();
    const isWeekend = dow === 0 || dow === 6;

    /* --- behaviour --------------------------------------------------- */
    // Weekends run higher and saltier; that pattern is what makes the water
    // model learnable in the first place.
    const intake = Math.round(
      targetIntake + (isWeekend ? 420 : -60) + normal(rand, 0, 190),
    );
    const proteinG = Math.round((intake * 0.28) / 4 + normal(rand, 0, 12));
    const fatG = Math.round((intake * 0.30) / 9 + normal(rand, 0, 6));
    const alcoholG = isWeekend && rand() < 0.45 ? Math.round(18 + rand() * 40) : 0;
    // Carbohydrate absorbs the remainder, so the macros reconcile to the
    // calorie total. Alcohol has to be subtracted here — a real log where the
    // macros overshoot the calories is a data-entry error, and generating one
    // by accident would exercise the wrong code path in the TEF module.
    const carbsG = Math.max(
      40,
      Math.round((intake - proteinG * 4 - fatG * 9 - alcoholG * 7) / 4),
    );
    const fiberG = Math.round(carbsG * 0.09 + normal(rand, 0, 3));
    const sodiumMg = Math.round(2600 + (isWeekend ? 1500 : 0) + carbsG * 2.2 + normal(rand, 0, 500));
    const steps = Math.round(
      (isWeekend ? 7200 : 11200) + normal(rand, 0, 2600),
    );
    const sleepHours = Math.round((isWeekend ? 7.6 : 6.9) + normal(rand, 0, 0.8) * 10) / 10;
    const stress = Math.max(1, Math.min(5, Math.round(normal(rand, isWeekend ? 2.1 : 3.1, 0.9))));

    const exercise = [];
    const liftDay = [1, 2, 4, 5].includes(dow) && rand() < 0.85;
    if (liftDay) {
      exercise.push({
        activityId: 'weights',
        minutes: Math.round(60 + normal(rand, 0, 12)),
        rpe: Math.max(4, Math.min(10, Math.round(normal(rand, 7.5, 1)))),
      });
    }
    const runDay = [3, 6].includes(dow) && rand() < 0.6;
    if (runDay) {
      const km = Math.round((6 + normal(rand, 0, 2)) * 10) / 10;
      exercise.push({
        activityId: 'running',
        minutes: Math.round(km * 5.6),
        distanceKm: km,
        avgHr: Math.round(normal(rand, 152, 8)),
        rpe: 7,
      });
    }

    /* --- true physiology --------------------------------------------- */
    // Expenditure varies day to day with activity, and falls as mass falls.
    const activityDelta = (steps - 10000) * 0.035 + (liftDay ? 190 : 0) + (runDay ? 330 : 0);
    const massEffect = dMaintenanceDKg * (trueWeight - startWeightKg);
    const adaptationTarget = 0.12 * (trueMaintenance - intake);
    adaptation += (adaptationTarget - adaptation) / 14;

    const trueTdee = trueMaintenance + activityDelta + massEffect - adaptation;
    const balance = intake - trueTdee;

    const density = energyDensityOfChange({
      fatMassKg,
      inSurplus: balance > 0,
      resistanceSessionsPerWeek: 4,
      proteinGPerKg: proteinG / trueWeight,
    });
    const deltaKg = balance / density.kcalPerKg;
    fatMassKg = Math.max(3, fatMassKg + deltaKg * density.fatFraction);
    leanMassKg = Math.max(30, leanMassKg + deltaKg * density.leanFraction);
    trueWeight = fatMassKg + leanMassKg;

    /* --- observation corruption --------------------------------------- */
    // Water: sodium and carbohydrate above baseline, alcohol, short sleep,
    // and yesterday's training all push the scale up transiently.
    //
    // Recorded raw here and mean-centred in a second pass below. Left
    // uncentred, these strictly-non-negative terms would impose a permanent
    // ~0.9 kg offset, which would make `trueWeight` and the scale reading two
    // different quantities — habitual hydration is part of what a scale
    // measures, and real water retention fluctuates *around* it rather than
    // sitting on top of it.
    const prev = out[out.length - 1];
    const rawWaterKg =
      0.00022 * (sodiumMg - 3000) +
      0.0022 * (carbsG - 250) +
      0.012 * alcoholG +
      0.09 * Math.max(0, 7.2 - sleepHours) +
      0.05 * ((prev?.exercise || []).length ? 1 : 0) +
      normal(rand, 0, 0.28);
    rawWater.push(rawWaterKg);

    const weighed = rand() < weighInProbability;
    const logged = rand() < logProbability;

    truthSeries.push({ date, trueWeight, trueTdee, adaptation, fatMassKg, leanMassKg });

    out.push({
      date,
      _weighed: weighed,
      weightKg: null, // filled in below, once the water term is centred
      bodyFatPct: i % 14 === 0 ? Math.round((fatMassKg / trueWeight) * 1000) / 10 : null,
      intake: logged
        ? {
            kcal: intake,
            protein: proteinG,
            carbs: carbsG,
            fat: fatG,
            fiber: fiberG,
            alcohol: alcoholG || null,
          }
        : { kcal: null, protein: null, carbs: null, fat: null, fiber: null, alcohol: null },
      steps,
      exercise,
      sleepHours,
      sleepQuality: Math.max(1, Math.min(5, Math.round(normal(rand, 3.4, 0.9)))),
      stress,
      waterMl: Math.round(2200 + normal(rand, 0, 500)),
      sodiumMg,
      notes: '',
    });
  }

  /* --- second pass: centre the water term and record the scale reading --- */
  const waterMean = rawWater.reduce((s, w) => s + w, 0) / Math.max(1, rawWater.length);
  for (let i = 0; i < out.length; i++) {
    const observed = truthSeries[i].trueWeight + (rawWater[i] - waterMean);
    out[i].weightKg = out[i]._weighed ? Math.round(observed * 10) / 10 : null;
    delete out[i]._weighed;
  }

  return {
    days: out,
    truth: {
      trueMaintenanceAtStart: trueMaintenance,
      /** The quantity the engine should recover: average true expenditure over
       *  the period, which includes habitual exercise and mass loss. */
      meanTrueTdee: truthSeries.reduce((s, t) => s + t.trueTdee, 0) / truthSeries.length,
      startWeightKg,
      endWeightKg: trueWeight,
      totalDeltaKg: trueWeight - startWeightKg,
      series: truthSeries,
      targetIntake,
      nDays,
    },
  };
}

/** Profile matching the simulated person, so the prior is not absurd. */
export function demoProfile() {
  return {
    name: 'Demo',
    sex: 'male',
    birthDate: '1996-04-12',
    heightCm: 178,
    bodyFatPct: 18,
    units: 'imperial',
    bmrFormula: 'mifflin',
    occupation: 'mixed',
    workHours: 8,
    standingHours: 3,
    fidget: 'average',
    lifestyle: 'moderatelyActive',
    goal: { mode: 'lose', weeklyRateKg: -0.45, targetWeightKg: 76, proteinGPerKg: 2.0 },
  };
}
