/**
 * tests.js — verification suite.
 *
 * Runs in the browser (tests/index.html) because the app has no build step and
 * no Node dependency. Pure assertions, no framework.
 *
 * The suite that matters is the last one: RECOVERY. It feeds the engine a
 * synthetic person whose true expenditure we chose, corrupted with realistic
 * water noise, scale error, missed weigh-ins and unlogged days, and asserts
 * that the estimate lands within ±100 kcal of the truth. Everything above it
 * is scaffolding for that claim.
 */

import { lbToKg, kgToLb, feetInchesToCm, fmtSigned } from '../src/core/units.js';
import { addDays, daysBetween, ageOn, isoWeekKey, enumerateDates } from '../src/core/time.js';
import { computeBmr, leanMassKg, BMR_FORMULAS } from '../src/energy/bmr.js';
import { computeNeat, stepsToKcal, OCCUPATIONS } from '../src/energy/neat.js';
import { estimateExercise, keytelKcalPerMin } from '../src/energy/eat.js';
import { metFromSpeed, metFromRpe, ACTIVITIES } from '../src/energy/metTable.js';
import { computeTef, tefFractionForSplit, solveMaintenanceWithTef, habitualSplit } from '../src/energy/tef.js';
import { computeDailyExpenditure } from '../src/energy/tdee.js';
import { mean, median, mad, stdev, linearRegression, theilSen, rollingMean } from '../src/stats/descriptive.js';
import { alphaFromHalfLife, halfLifeFromAlpha, ewma } from '../src/stats/smoothing.js';
import { localLinearTrend, estimateObservationSigma } from '../src/stats/kalman.js';
import { ridge, solve } from '../src/stats/regression.js';
import { updateNormal, sequentialUpdate, confidenceLabel, normalCdf } from '../src/stats/bayes.js';
import { huberWeight, plausibilityCheck } from '../src/stats/outliers.js';
import { leanFractionOfChange, energyDensityOfChange, WISHNOFSKY_KCAL_PER_LB } from '../src/model/bodyComposition.js';
import { computeTrendWeight } from '../src/model/trendWeight.js';
import { estimateMaintenance, intakeForRate } from '../src/model/maintenance.js';
import { projectWeight } from '../src/model/projection.js';
import { normaliseDay, normaliseProfile, migrate, isDayEmpty, defaultProfile } from '../src/data/schema.js';
import { parseCsv, importCsv, exportCsv, detectMapping, parseDate } from '../src/data/csv.js';
import { Store, MemoryAdapter } from '../src/data/store.js';
import { generateDemoData, demoProfile } from '../src/data/demo.js';

/* ============================================================
   MICRO-FRAMEWORK
   ============================================================ */

const suites = [];
let current = null;

function describe(name, fn) {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

function it(name, fn) {
  current.tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function near(actual, expected, tolerance, label = '') {
  const diff = Math.abs(actual - expected);
  assert(
    diff <= tolerance,
    `${label}expected ${round(actual)} to be within ${tolerance} of ${round(expected)} (off by ${round(diff)})`,
  );
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : String(v));

/* ============================================================
   CORE
   ============================================================ */

describe('core/units', () => {
  it('converts pounds to kilograms exactly', () => {
    near(lbToKg(220.462), 100, 0.001);
    near(kgToLb(100), 220.462, 0.01);
  });
  it('round-trips mass', () => near(kgToLb(lbToKg(185)), 185, 1e-9));
  it('converts feet and inches', () => near(feetInchesToCm(5, 10), 177.8, 0.01));
  it('formats signed numbers with a true minus sign', () => {
    assert(fmtSigned(312) === '+312', 'positive');
    assert(fmtSigned(-148) === '−148', 'negative uses U+2212');
    assert(fmtSigned(0) === '0', 'zero unsigned');
  });
});

describe('core/time', () => {
  it('adds and differences days', () => {
    assert(addDays('2026-08-04', 7) === '2026-08-11');
    assert(addDays('2026-03-01', -1) === '2026-02-28');
    assert(daysBetween('2026-08-04', '2026-08-11') === 7);
  });
  it('crosses a leap-year boundary', () => {
    assert(addDays('2028-02-28', 1) === '2028-02-29', 'leap day exists');
    assert(daysBetween('2028-02-28', '2028-03-01') === 2);
  });
  it('computes age before and after a birthday', () => {
    assert(ageOn('2000-12-25', '2026-08-04') === 25, 'before birthday');
    assert(ageOn('2000-01-01', '2026-08-04') === 26, 'after birthday');
  });
  it('enumerates an inclusive range', () => {
    assert(enumerateDates('2026-08-01', '2026-08-05').length === 5);
  });
  it('produces ISO week keys', () => {
    assert(/^\d{4}-W\d{2}$/.test(isoWeekKey('2026-08-04')));
  });
});

/* ============================================================
   ENERGY
   ============================================================ */

describe('energy/bmr', () => {
  // Hand-computed: 10(80) + 6.25(180) − 5(30) + 5 = 800 + 1125 − 150 + 5
  it('matches Mifflin–St Jeor by hand (male)', () => {
    const r = computeBmr({ weightKg: 80, heightCm: 180, age: 30, sex: 'male' }, 'mifflin');
    near(r.kcal, 1780, 0.5);
  });
  it('matches Mifflin–St Jeor by hand (female)', () => {
    const r = computeBmr({ weightKg: 65, heightCm: 165, age: 30, sex: 'female' }, 'mifflin');
    near(r.kcal, 10 * 65 + 6.25 * 165 - 5 * 30 - 161, 0.5);
  });
  it('matches Katch–McArdle by hand', () => {
    // LBM = 80 × 0.85 = 68 → 370 + 21.6(68) = 1838.8
    const r = computeBmr({ weightKg: 80, heightCm: 180, age: 30, sex: 'male', bodyFatPct: 15 }, 'katch');
    near(r.kcal, 1838.8, 0.5);
  });
  it('matches Cunningham by hand', () => {
    const r = computeBmr({ weightKg: 80, heightCm: 180, age: 30, sex: 'male', bodyFatPct: 15 }, 'cunningham');
    near(r.kcal, 500 + 22 * 68, 0.5);
  });
  it('falls back when body fat is missing', () => {
    const r = computeBmr({ weightKg: 80, heightCm: 180, age: 30, sex: 'male' }, 'katch');
    assert(r.fellBack === true, 'should report the fallback');
    assert(r.formulaId === 'mifflin', 'should land on Mifflin–St Jeor');
    assert(typeof r.fallbackReason === 'string' && r.fallbackReason.length > 0);
  });
  it('puts Harris–Benedict above Mifflin–St Jeor, as the literature reports', () => {
    const s = { weightKg: 80, heightCm: 180, age: 30, sex: 'male' };
    assert(BMR_FORMULAS.harris.calc(s) > BMR_FORMULAS.mifflin.calc(s));
  });
  it('computes lean mass', () => near(leanMassKg({ weightKg: 80, bodyFatPct: 20 }), 64, 1e-9));
});

describe('energy/neat', () => {
  it('costs steps from stride length and mass', () => {
    // 10,000 steps × 0.415 × 1.80 m = 7.47 km; × 80 kg × 0.5 kcal/kg/km
    near(stepsToKcal(10000, 80, 180), 7.47 * 80 * 0.5, 1);
  });
  it('scales step cost linearly with body mass', () => {
    near(stepsToKcal(10000, 100, 180) / stepsToKcal(10000, 50, 180), 2, 1e-9);
  });
  it('subtracts exercise steps so NEAT and EAT do not both bill them', () => {
    const base = { weightKg: 80, heightCm: 180, steps: 15000, occupation: 'desk' };
    const withExercise = computeNeat({ ...base, exerciseSteps: 8000 });
    const without = computeNeat(base);
    assert(withExercise.kcal < without.kcal, 'exercise steps must reduce NEAT');
    assert(withExercise.netSteps === 7000);
  });
  it('never returns negative NEAT', () => {
    const r = computeNeat({ weightKg: 50, heightCm: 150, steps: 0, occupation: 'desk', fidget: 'low', standingHours: 0, workHours: 0 });
    assert(r.kcal >= 0);
  });
  it('honours a manual override', () => {
    const r = computeNeat({ weightKg: 80, heightCm: 180, steps: 12000, manualOverrideKcal: 500 });
    assert(r.overridden && r.kcal === 500);
  });
  it('ranks occupations sensibly', () => {
    const base = { weightKg: 80, heightCm: 180, steps: 8000 };
    const desk = computeNeat({ ...base, occupation: 'desk' }).kcal;
    const heavy = computeNeat({ ...base, occupation: 'heavyManual' }).kcal;
    const pedicab = computeNeat({ ...base, occupation: 'cycleCourier' }).kcal;
    assert(heavy > desk, 'heavy manual above desk');
    assert(pedicab > heavy, 'load-bearing cycling above heavy manual');
  });
  it('falls back to lifestyle when steps are absent', () => {
    const r = computeNeat({ weightKg: 80, heightCm: 180, lifestyle: 'veryActive' });
    assert(r.stepsEstimated === true);
    assert(r.netSteps === 13000);
  });
});

describe('energy/eat', () => {
  const ctx = { weightKg: 80, bmrKcal: 1780, age: 30, sex: 'male', heightCm: 180 };

  it('computes MET cost net of the individual’s own resting rate', () => {
    const est = estimateExercise({ activityId: 'weights', minutes: 60, rpe: 5 }, ctx);
    const gross = 4.5 * 1.05 * 80 * 1; // MET × kcal/kg/h × kg × h
    near(est.grossKcal, gross, 1);
    near(est.restingKcal, 1780 / 24, 0.5);
    near(est.netKcal, gross - 1780 / 24, 1);
  });

  it('derives running cost from pace when distance is given', () => {
    // 10 km in 50 min = 12 km/h = 200 m/min → VO2 = 0.2(200)+3.5 = 43.5 → 12.43 METs
    const est = estimateExercise({ activityId: 'running', minutes: 50, distanceKm: 10 }, ctx);
    assert(est.source === 'speed', `expected speed model, got ${est.source}`);
    near(est.met, 43.5 / 3.5, 0.05);
  });

  it('prefers heart rate over the MET table', () => {
    const est = estimateExercise({ activityId: 'cycling', minutes: 45, avgHr: 140 }, ctx);
    assert(est.source === 'heartRate');
  });

  it('refuses heart rate for lifting, where it does not track oxygen cost', () => {
    const est = estimateExercise({ activityId: 'weights', minutes: 45, avgHr: 140 }, ctx);
    assert(est.source === 'met', 'lifting must not use the HR regression');
  });

  it('prefers a wearable number above everything', () => {
    const est = estimateExercise({ activityId: 'running', minutes: 50, distanceKm: 10, avgHr: 150, wearableKcal: 600 }, ctx);
    assert(est.source === 'wearable');
    near(est.grossKcal, 600, 0.01);
  });

  it('treats a net wearable figure as net', () => {
    const gross = estimateExercise({ activityId: 'running', minutes: 60, wearableKcal: 600, wearableIsNet: false }, ctx);
    const net = estimateExercise({ activityId: 'running', minutes: 60, wearableKcal: 600, wearableIsNet: true }, ctx);
    near(net.netKcal - gross.netKcal, 1780 / 24, 1);
  });

  it('scales MET with RPE within the activity’s range', () => {
    const low = estimateExercise({ activityId: 'cycling', minutes: 60, rpe: 2 }, ctx);
    const high = estimateExercise({ activityId: 'cycling', minutes: 60, rpe: 9 }, ctx);
    assert(high.netKcal > low.netKcal * 1.5, 'RPE must materially move the estimate');
  });

  it('reproduces Keytel for a known input', () => {
    // Male: (−55.0969 + 0.6309(140) + 0.1988(80) + 0.2017(30)) / 4.184
    const expected = (-55.0969 + 0.6309 * 140 + 0.1988 * 80 + 0.2017 * 30) / 4.184;
    near(keytelKcalPerMin({ avgHr: 140, weightKg: 80, age: 30, sex: 'male' }), expected, 1e-6);
  });

  it('derives walking METs from the ACSM equation', () => {
    // 5 km/h = 83.33 m/min → (0.1(83.33) + 3.5)/3.5 = 3.38 METs
    near(metFromSpeed('walk', 5), 3.381, 0.01);
  });

  it('pins RPE 5 to the activity’s typical MET', () => {
    near(metFromRpe(ACTIVITIES.cycling, 5), ACTIVITIES.cycling.metTypical, 1e-9);
  });
});

describe('energy/tef', () => {
  it('costs each macronutrient at its own rate', () => {
    // 200 g protein (800 kcal), 250 g carb (1000), 80 g fat (720) = 2520 kcal
    const r = computeTef({ kcal: 2520, protein: 200, carbs: 250, fat: 80 });
    near(r.breakdown.protein, 800 * 0.25, 0.5);
    near(r.breakdown.carb, 1000 * 0.075, 0.5);
    near(r.breakdown.fat, 720 * 0.02, 0.5);
    near(r.kcal, 200 + 75 + 14.4, 1);
  });

  it('makes a high-protein day cost meaningfully more than a low-protein one', () => {
    const high = computeTef({ kcal: 2500, protein: 200, carbs: 200, fat: 78 });
    const low = computeTef({ kcal: 2500, protein: 60, carbs: 340, fat: 78 });
    assert(high.kcal - low.kcal > 80, `expected >80 kcal difference, got ${round(high.kcal - low.kcal)}`);
  });

  it('costs unexplained calories at the mixed rate', () => {
    const r = computeTef({ kcal: 2000, protein: 100 }); // 400 kcal explained
    near(r.unaccountedKcal, 1600, 1);
    near(r.kcal, 400 * 0.25 + 1600 * 0.1, 1);
  });

  it('scales macros down when they overshoot the calorie total', () => {
    const r = computeTef({ kcal: 1000, protein: 200, carbs: 200, fat: 100 });
    assert(r.notes.some((n) => n.includes('more than')), 'should warn about the overshoot');
    assert(r.kcal < 1000 * 0.3, 'thermic cost stays plausible');
  });

  it('stays quiet about a rounding-sized overshoot', () => {
    // Atwater factors are integers applied to rounded gram counts, so a few
    // kcal of disagreement is arithmetic, not a user error. Warning daily
    // about it would train the user to ignore the warnings that matter.
    // 700 + 1064 + 747 = 2511 kcal of macros against 2500 logged: 11 kcal over,
    // well inside the 2%/25 kcal tolerance.
    const r = computeTef({ kcal: 2500, protein: 175, carbs: 266, fat: 83 });
    assert(175 * 4 + 266 * 4 + 83 * 9 > 2500, 'this fixture must actually overshoot');
    assert(r.notes.length === 0, `expected no note, got: ${r.notes.join(' | ')}`);
    assert(r.kcal > 0 && r.kcal < 2500 * 0.3, 'but the scaling still applies');
  });

  it('applies the fibre correction only when asked', () => {
    const off = computeTef({ kcal: 2000, carbs: 250, fiber: 40 });
    const on = computeTef({ kcal: 2000, carbs: 250, fiber: 40 }, { applyFibreCorrection: true });
    near(off.metabolisableKcal, 2000, 0.01);
    near(on.metabolisableKcal, 2000 - 40 * 2, 0.01);
  });

  it('solves the maintenance fixed point rather than adding a flat percentage', () => {
    const beforeTef = 2600;
    const f = 0.10;
    const solved = solveMaintenanceWithTef(beforeTef, f);
    near(solved, 2600 / 0.9, 0.01);
    assert(solved > beforeTef * 1.1, 'fixed point must exceed the naive +10%');
    // And TEF is exactly 10% of the *result*, which is the definition.
    near((solved - beforeTef) / solved, f, 1e-9);
  });

  it('derives the TEF fraction from a habitual split', () => {
    const f = tefFractionForSplit({ proteinPct: 0.3, carbPct: 0.4, fatPct: 0.3 });
    near(f, 0.3 * 0.25 + 0.4 * 0.075 + 0.3 * 0.02, 1e-9);
  });

  it('computes a habitual split from logged days', () => {
    const split = habitualSplit([{ kcal: 2000, protein: 150, carbs: 200, fat: 55 }]);
    near(split.proteinPct, 600 / 2000, 0.01);
    assert(split.assumed === false);
  });
});

describe('energy/tdee', () => {
  it('composes a plausible day', () => {
    const est = computeDailyExpenditure({
      profile: { ...defaultProfile(), sex: 'male', birthDate: '1996-01-01', heightCm: 180, occupation: 'desk' },
      day: { date: '2026-08-04', steps: 10000, intake: { kcal: 2600, protein: 180, carbs: 250, fat: 80 }, exercise: [] },
      weightKg: 80,
    });
    assert(est.bmrKcal > 1500 && est.bmrKcal < 2000, `BMR ${round(est.bmrKcal)}`);
    assert(est.neatKcal > 200 && est.neatKcal < 900, `NEAT ${round(est.neatKcal)}`);
    assert(est.maintenanceKcal > 2200 && est.maintenanceKcal < 3400, `TDEE ${round(est.maintenanceKcal)}`);
  });

  it('reports a positive sensitivity to body mass', () => {
    const args = {
      profile: { ...defaultProfile(), heightCm: 180, occupation: 'desk' },
      day: { date: '2026-08-04', steps: 10000, intake: {}, exercise: [] },
      weightKg: 80,
    };
    const est = computeDailyExpenditure(args);
    assert(est.dMaintenanceDKg > 10 && est.dMaintenanceDKg < 45, `dTDEE/dkg = ${round(est.dMaintenanceDKg)}`);
  });
});

/* ============================================================
   STATISTICS
   ============================================================ */

describe('stats/descriptive', () => {
  it('computes basic summaries', () => {
    near(mean([1, 2, 3, 4]), 2.5, 1e-9);
    near(median([1, 2, 3, 4]), 2.5, 1e-9);
    near(median([5, 1, 3]), 3, 1e-9);
    near(stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2.138, 0.01);
  });
  it('ignores nulls and NaNs', () => {
    near(mean([1, null, 3, NaN, undefined]), 2, 1e-9);
  });
  it('resists outliers with MAD where SD does not', () => {
    const clean = [10, 10.2, 9.8, 10.1, 9.9];
    const dirty = [...clean, 40];
    assert(stdev(dirty) > stdev(clean) * 5, 'SD blows up');
    assert(mad(dirty) < mad(clean) * 3, 'MAD holds steady');
  });
  it('recovers a known regression slope', () => {
    const xs = [0, 1, 2, 3, 4, 5];
    const ys = xs.map((x) => 3 + 2 * x);
    const r = linearRegression(xs, ys);
    near(r.slope, 2, 1e-9);
    near(r.intercept, 3, 1e-9);
    near(r.r2, 1, 1e-9);
  });
  it('resists a bad point with Theil–Sen where OLS does not', () => {
    const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const ys = xs.map((x) => 2 * x);
    ys[8] = 100; // high-leverage outlier, near the end of the range
    near(theilSen(xs, ys).slope, 2, 0.35);
    assert(
      Math.abs(linearRegression(xs, ys).slope - 2) > 3,
      'OLS should be dragged off by a high-leverage point',
    );
  });
  it('emits nulls until a rolling window has enough data', () => {
    const r = rollingMean([1, 2, 3, 4, 5], 4, 3);
    assert(r[0] === null && r[1] === null, 'not enough data yet');
    assert(r[3] !== null);
  });
});

describe('stats/smoothing', () => {
  it('inverts half-life and alpha', () => {
    const a = alphaFromHalfLife(10);
    near(halfLifeFromAlpha(a), 10, 1e-9);
    near(a, 1 - Math.exp(-Math.LN2 / 10), 1e-12);
  });
  it('converges to a constant series', () => {
    const out = ewma(new Array(60).fill(80), alphaFromHalfLife(10));
    near(out[59], 80, 1e-9);
  });
  it('lags a step change by roughly the half-life', () => {
    const series = [...new Array(30).fill(80), ...new Array(30).fill(82)];
    const out = ewma(series, alphaFromHalfLife(10));
    near(out[39], 81, 0.15); // one half-life after the step ⇒ halfway
  });
});

describe('stats/kalman', () => {
  it('recovers a known linear trend through noise', () => {
    const truth = [];
    for (let i = 0; i < 90; i++) truth.push(85 - 0.05 * i);
    // Deterministic pseudo-noise so the test cannot flake.
    const noisy = truth.map((v, i) => v + 0.5 * Math.sin(i * 2.399) + 0.3 * Math.cos(i * 5.1));
    const r = localLinearTrend(noisy);
    near(r.current.slope, -0.05, 0.012, 'slope: ');
    near(r.current.level, truth[89], 0.35, 'level: ');
  });

  it('handles missing days without distorting the rate', () => {
    const series = [];
    for (let i = 0; i < 90; i++) {
      const v = 85 - 0.05 * i + 0.4 * Math.sin(i * 2.399);
      series.push(i % 3 === 0 ? null : v); // weigh in two days out of three
    }
    const r = localLinearTrend(series);
    near(r.current.slope, -0.05, 0.015);
  });

  it('down-weights an outlier instead of chasing it', () => {
    const base = new Array(60).fill(0).map((_, i) => 80 + 0.2 * Math.sin(i));
    const withSpike = [...base];
    withSpike[50] = 84; // a 4 kg jump
    const clean = localLinearTrend(base);
    const spiked = localLinearTrend(withSpike);
    const moved = Math.abs(spiked.points[50].level - clean.points[50].level);
    assert(moved < 1.0, `trend moved ${round(moved)} kg — should barely react`);
    assert(spiked.outlierIndices.includes(50), 'and the spike should be flagged');
  });

  it('reports wider rate uncertainty on sparse data', () => {
    const dense = new Array(60).fill(0).map((_, i) => 80 - 0.03 * i);
    const sparse = dense.map((v, i) => (i % 7 === 0 ? v : null));
    const a = localLinearTrend(dense);
    const b = localLinearTrend(sparse);
    assert(b.current.slopeVar > a.current.slopeVar, 'sparse data must be less certain');
  });

  it('estimates observation noise robustly', () => {
    const series = new Array(80).fill(0).map((_, i) => 80 + 0.6 * Math.sin(i * 2.399));
    const sigma = estimateObservationSigma(series);
    assert(sigma > 0.1 && sigma < 1.5, `sigma = ${round(sigma)}`);
  });
});

describe('stats/regression', () => {
  it('solves a linear system', () => {
    const x = solve([[2, 1], [1, 3]], [5, 10]);
    near(x[0], 1, 1e-9);
    near(x[1], 3, 1e-9);
  });

  it('recovers known coefficients', () => {
    const X = [];
    const y = [];
    for (let i = 0; i < 120; i++) {
      const a = Math.sin(i * 0.7) * 2;
      const b = Math.cos(i * 1.3) * 3;
      X.push([a, b]);
      y.push(1.5 * a - 0.8 * b + 0.4);
    }
    const m = ridge(X, y, 0.001);
    near(m.coefficients[0], 1.5, 0.05);
    near(m.coefficients[1], -0.8, 0.05);
    near(m.intercept, 0.4, 0.05);
    near(m.r2, 1, 0.01);
  });

  it('shrinks coefficients as the penalty grows', () => {
    const X = [];
    const y = [];
    for (let i = 0; i < 60; i++) {
      const a = Math.sin(i);
      X.push([a]);
      y.push(2 * a + 0.3 * Math.cos(i * 3));
    }
    const light = ridge(X, y, 0.01);
    const heavy = ridge(X, y, 500);
    assert(Math.abs(heavy.coefficients[0]) < Math.abs(light.coefficients[0]), 'ridge must shrink');
  });

  it('refuses to fit when there are more predictors than data', () => {
    assert(ridge([[1, 2, 3]], [1], 1) === null);
  });
});

describe('stats/bayes', () => {
  it('lands between prior and observation, nearer the tighter one', () => {
    const post = updateNormal({ mean: 2800, variance: 250 ** 2 }, { mean: 3000, variance: 100 ** 2 });
    assert(post.mean > 2800 && post.mean < 3000);
    assert(post.mean > 2900, 'the tighter observation should dominate');
    assert(post.variance < 100 ** 2, 'posterior is tighter than either input');
  });

  it('converges on repeated consistent evidence', () => {
    const obs = new Array(12).fill({ mean: 2900, variance: 200 ** 2, days: 7 });
    const { posterior } = sequentialUpdate({ mean: 2500, variance: 300 ** 2 }, obs, { processSdPerDay: 8 });
    near(posterior.mean, 2900, 40);
    assert(Math.sqrt(posterior.variance) < 120, 'uncertainty must shrink');
  });

  it('never collapses to zero uncertainty, because the truth drifts', () => {
    const obs = new Array(200).fill({ mean: 2900, variance: 150 ** 2, days: 7 });
    const { posterior } = sequentialUpdate({ mean: 2900, variance: 300 ** 2 }, obs, { processSdPerDay: 8 });
    assert(Math.sqrt(posterior.variance) > 15, 'process noise sets a floor');
  });

  it('grades confidence by interval width', () => {
    assert(confidenceLabel(30).level === 'high');
    assert(confidenceLabel(70).level === 'moderate');
    assert(confidenceLabel(120).level === 'low');
    assert(confidenceLabel(400).level === 'veryLow');
  });

  it('has a correct normal CDF', () => {
    near(normalCdf(0), 0.5, 1e-6);
    near(normalCdf(1.959964), 0.975, 1e-4);
  });
});

describe('stats/outliers', () => {
  it('down-weights beyond the threshold and not before', () => {
    near(huberWeight(1.5, 2), 1, 1e-9);
    near(huberWeight(4, 2), 0.5, 1e-9);
  });
  it('catches a pounds-into-kilograms mistake', () => {
    const r = plausibilityCheck(180, 82, 1);
    assert(!r.ok && r.severity === 'error');
  });
  it('accepts a large but physiologically possible swing', () => {
    assert(plausibilityCheck(83.5, 82, 1).ok === true);
  });
});

/* ============================================================
   MODEL
   ============================================================ */

describe('model/bodyComposition', () => {
  it('follows Forbes: leaner people lose proportionally more lean mass', () => {
    const lean = leanFractionOfChange(12);
    const fat = leanFractionOfChange(45);
    assert(lean > fat, 'lean fraction must fall as fat mass rises');
    near(lean, 10.4 / 22.4, 1e-9);
  });

  it('puts energy density below the 3,500 rule for a lean person', () => {
    const d = energyDensityOfChange({ fatMassKg: 14, applyTrainingAdjustment: false });
    assert(d.kcalPerLb < WISHNOFSKY_KCAL_PER_LB, `${round(d.kcalPerLb)} kcal/lb`);
    assert(d.kcalPerLb > 2500, 'but not absurdly below');
  });

  it('approaches the 3,500 rule for someone with substantial fat mass', () => {
    const d = energyDensityOfChange({ fatMassKg: 40, applyTrainingAdjustment: false });
    near(d.kcalPerLb, 3500, 300);
  });

  it('shifts partitioning toward lean when training and protein are both present', () => {
    const plain = energyDensityOfChange({ fatMassKg: 20, inSurplus: true, applyTrainingAdjustment: false });
    const trained = energyDensityOfChange({
      fatMassKg: 20, inSurplus: true, resistanceSessionsPerWeek: 4, proteinGPerKg: 2.0,
    });
    assert(trained.leanFraction > plain.leanFraction);
  });
});

describe('model/trendWeight', () => {
  it('smooths the scale without lagging like a moving average', () => {
    const entries = [];
    for (let i = 0; i < 60; i++) {
      entries.push({
        date: addDays('2026-06-01', i),
        weightKg: 85 - 0.04 * i + 0.5 * Math.sin(i * 2.399),
      });
    }
    const trend = computeTrendWeight(entries);
    near(trend.current.trendKg, 85 - 0.04 * 59, 0.4);
    near(trend.current.weeklyRateKg, -0.28, 0.09);
  });

  it('produces a rate confidence interval', () => {
    const entries = [];
    for (let i = 0; i < 45; i++) {
      entries.push({ date: addDays('2026-06-01', i), weightKg: 80 + 0.3 * Math.sin(i) });
    }
    const trend = computeTrendWeight(entries);
    assert(trend.current.weeklyRateCI.lower < trend.current.weeklyRateCI.upper);
    assert(trend.current.rateIsSignificant === false, 'a flat trend must not read as significant');
  });

  it('reports why the water model is not yet available', () => {
    const entries = [];
    for (let i = 0; i < 10; i++) entries.push({ date: addDays('2026-06-01', i), weightKg: 80 });
    const trend = computeTrendWeight(entries);
    assert(trend.waterModel.applied === false);
    assert(typeof trend.waterModel.reason === 'string' && trend.waterModel.reason.length > 0);
  });
});

describe('model/projection', () => {
  it('predicts less loss than the 3,500 rule, and slows over time', () => {
    const r = projectWeight({
      startWeightKg: 85, bodyFatPct: 20,
      maintenanceKcal: 2900, intakeKcal: 2400,
      dMaintenanceDKg: 22, days: 180,
    });
    assert(r.summary.deltaKg < 0, 'should lose weight');
    assert(Math.abs(r.summary.deltaKg) < Math.abs(r.summary.naiveDeltaKg), 'must undercut the naive rule');

    const firstMonth = r.days[29].weightKg - 85;
    const sixthMonth = r.days[179].weightKg - r.days[149].weightKg;
    assert(Math.abs(sixthMonth) < Math.abs(firstMonth), 'rate of loss must decelerate');
  });

  it('lets expenditure fall as mass is lost', () => {
    const r = projectWeight({
      startWeightKg: 100, bodyFatPct: 30, maintenanceKcal: 3200, intakeKcal: 2400,
      dMaintenanceDKg: 22, days: 120,
    });
    assert(r.summary.endTdee < 3200, 'TDEE must decline');
  });

  it('makes adaptation reduce expenditure further', () => {
    const args = { startWeightKg: 85, bodyFatPct: 20, maintenanceKcal: 2900, intakeKcal: 2200, dMaintenanceDKg: 22, days: 120 };
    const withAdaptation = projectWeight({ ...args, options: { applyAdaptation: true } });
    const without = projectWeight({ ...args, options: { applyAdaptation: false } });
    assert(withAdaptation.summary.endTdee < without.summary.endTdee);
    assert(Math.abs(withAdaptation.summary.deltaKg) < Math.abs(without.summary.deltaKg));
  });

  it('holds weight when intake equals maintenance', () => {
    const r = projectWeight({
      startWeightKg: 80, bodyFatPct: 18, maintenanceKcal: 2800, intakeKcal: 2800,
      dMaintenanceDKg: 22, days: 90,
    });
    near(r.summary.deltaKg, 0, 0.05);
  });
});

/* ============================================================
   DATA
   ============================================================ */

describe('data/schema', () => {
  it('coerces strings and rejects nonsense', () => {
    const d = normaliseDay({ date: '2026-08-04', weightKg: '82.4', steps: '11,204', intake: { kcal: 'abc' } });
    near(d.weightKg, 82.4, 1e-9);
    assert(d.steps === 11204, 'thousands separators survive');
    assert(d.intake.kcal === null, 'unparseable becomes null, never NaN');
  });

  it('drops a day with no information', () => {
    assert(isDayEmpty(normaliseDay({ date: '2026-08-04' })) === true);
    assert(isDayEmpty(normaliseDay({ date: '2026-08-04', weightKg: 80 })) === false);
  });

  it('rejects an invalid date outright', () => {
    assert(normaliseDay({ date: 'yesterday' }) === null);
  });

  it('drops exercise entries carrying no information', () => {
    const d = normaliseDay({ date: '2026-08-04', weightKg: 80, exercise: [{ activityId: 'weights' }] });
    assert(d.exercise.length === 0);
  });

  it('migrates an unversioned blob without losing days', () => {
    const migrated = migrate({ days: { '2026-08-04': { date: '2026-08-04', weightKg: 80 } } });
    assert(migrated.version === 1);
    assert(migrated.days['2026-08-04'].weightKg === 80);
    assert(migrated.profile.bmrFormula === 'mifflin', 'defaults fill in');
  });

  it('clamps profile values into range', () => {
    const p = normaliseProfile({ heightCm: 9000, sex: 'other', birthDate: 'nope' });
    assert(p.heightCm <= 250);
    assert(p.sex === 'male');
    assert(p.birthDate === defaultProfile().birthDate);
  });
});

describe('data/csv', () => {
  it('parses quoted fields containing commas and quotes', () => {
    const { headers, rows } = parseCsv('a,b\n1,"x, ""y"" z"\n');
    assert(headers.join('|') === 'a|b');
    assert(rows[0][1] === 'x, "y" z');
  });

  it('detects common export headers', () => {
    const { mapping } = detectMapping(['Date', 'Weight (lbs)', 'Energy (kcal)', 'Protein (g)']);
    assert(mapping.date === 0);
    assert(mapping.weightLb === 1, 'a pounds column should map to weightLb');
    assert(mapping.kcal === 2);
    assert(mapping.protein === 3);
  });

  it('parses ambiguous dates consistently', () => {
    assert(parseDate('03/04/2026') === '2026-03-04');
    assert(parseDate('03/04/2026', { preferDayFirst: true }) === '2026-04-03');
    assert(parseDate('2026-08-04T09:00:00Z') === '2026-08-04');
  });

  it('imports and converts pounds', () => {
    const csv = 'Date,Weight (lbs),Calories\n2026-08-01,180,2500\n2026-08-02,181,2600\n';
    const r = importCsv(csv);
    assert(r.days.length === 2);
    near(r.days[0].weightKg, lbToKg(180), 0.001);
    assert(r.days[1].intake.kcal === 2600);
  });

  it('merges two rows for the same date', () => {
    const csv = 'Date,Weight,Calories\n2026-08-01,82,\n2026-08-01,,2500\n';
    const r = importCsv(csv);
    assert(r.days.length === 1);
    assert(r.days[0].weightKg === 82 && r.days[0].intake.kcal === 2500);
  });

  it('reports unreadable rows rather than dropping them silently', () => {
    const r = importCsv('Date,Calories\nnot-a-date,2000\n2026-08-01,2100\n');
    assert(r.days.length === 1);
    assert(r.errors.length === 1 && r.errors[0].row === 2);
  });

  it('round-trips through export and import', () => {
    const days = [{
      date: '2026-08-01', weightKg: 82.4, bodyFatPct: 17.5,
      intake: { kcal: 2500, protein: 180, carbs: 240, fat: 78, fiber: 30, alcohol: null },
      steps: 11000, exercise: [], sleepHours: 7.2, stress: 3, waterMl: 2500, sodiumMg: 3200,
      notes: 'felt good, comma, and "quotes"',
    }];
    const back = importCsv(exportCsv(days));
    near(back.days[0].weightKg, 82.4, 0.001);
    assert(back.days[0].intake.protein === 180);
    assert(back.days[0].notes.includes('quotes'));
  });
});

describe('data/store', () => {
  it('merges nested intake rather than replacing it', async () => {
    const store = new Store(new MemoryAdapter());
    await store.init();
    store.updateDay('2026-08-04', { intake: { kcal: 2500 } });
    store.updateDay('2026-08-04', { intake: { protein: 180 } });
    const d = store.getDay('2026-08-04');
    assert(d.intake.kcal === 2500, 'calories must survive the second write');
    assert(d.intake.protein === 180);
  });

  it('removes a day that has been emptied', async () => {
    const store = new Store(new MemoryAdapter());
    await store.init();
    store.updateDay('2026-08-04', { weightKg: 80 });
    assert(store.getDay('2026-08-04') !== null);
    store.updateDay('2026-08-04', { weightKg: null });
    assert(store.getDay('2026-08-04') === null);
  });

  it('notifies subscribers', async () => {
    const store = new Store(new MemoryAdapter());
    await store.init();
    let calls = 0;
    const off = store.subscribe(() => { calls += 1; });
    store.updateDay('2026-08-04', { weightKg: 80 });
    assert(calls === 1);
    off();
    store.updateDay('2026-08-05', { weightKg: 80 });
    assert(calls === 1, 'unsubscribe must work');
  });

  it('round-trips a JSON export', async () => {
    const store = new Store(new MemoryAdapter());
    await store.init();
    store.updateDay('2026-08-04', { weightKg: 82, intake: { kcal: 2500 } });
    const json = store.exportJson();
    const other = new Store(new MemoryAdapter());
    await other.init();
    await other.importJson(json);
    assert(other.getDay('2026-08-04').intake.kcal === 2500);
  });
});

/* ============================================================
   THE CLAIM: can the engine recover a maintenance we chose?
   ============================================================ */

describe('RECOVERY — end-to-end accuracy against known ground truth', () => {
  const scenarios = [
    { label: 'cut, 2,500 kcal', trueMaintenance: 2900, targetIntake: 2500, seed: 20260804 },
    { label: 'maintenance, 2,900 kcal', trueMaintenance: 2900, targetIntake: 2900, seed: 7 },
    { label: 'surplus, 3,300 kcal', trueMaintenance: 3000, targetIntake: 3300, seed: 99 },
    { label: 'low maintenance', trueMaintenance: 2200, targetIntake: 1900, seed: 4242, startWeightKg: 62, bodyFatPct: 24 },
  ];

  for (const s of scenarios) {
    it(`recovers true expenditure within ±100 kcal — ${s.label}`, () => {
      const { days, truth } = generateDemoData({ days: 140, ...s });
      const profile = normaliseProfile({ ...defaultProfile(), ...demoProfile(), bodyFatPct: s.bodyFatPct ?? 18 });
      const trend = computeTrendWeight(days, { applyWaterModel: true });
      const maintenance = estimateMaintenance({ entries: days, profile, trend });

      assert(maintenance != null, 'engine returned nothing');
      near(maintenance.kcal, truth.meanTrueTdee, 100, `${s.label}: `);
    });
  }

  it('reports an interval that actually contains the truth', () => {
    const { days, truth } = generateDemoData({ days: 140, seed: 31337 });
    const profile = normaliseProfile({ ...defaultProfile(), ...demoProfile() });
    const trend = computeTrendWeight(days);
    const m = estimateMaintenance({ entries: days, profile, trend });
    assert(
      truth.meanTrueTdee >= m.ci.lower && truth.meanTrueTdee <= m.ci.upper,
      `truth ${round(truth.meanTrueTdee)} outside [${round(m.ci.lower)}, ${round(m.ci.upper)}]`,
    );
  });

  it('gets more accurate with more data, which is the entire premise', () => {
    const full = generateDemoData({ days: 160, seed: 555 });
    const profile = normaliseProfile({ ...defaultProfile(), ...demoProfile() });

    const errorAfter = (n) => {
      const slice = full.days.slice(0, n);
      const trend = computeTrendWeight(slice);
      const m = estimateMaintenance({ entries: slice, profile, trend });
      return { error: Math.abs(m.kcal - full.truth.meanTrueTdee), sd: m.sd };
    };

    const early = errorAfter(21);
    const late = errorAfter(160);
    assert(late.sd < early.sd, `uncertainty must fall: ${round(early.sd)} → ${round(late.sd)}`);
    assert(late.error <= early.error + 25, `error should not grow: ${round(early.error)} → ${round(late.error)}`);
  });

  it('tracks the trend weight through the water noise', () => {
    const { days, truth } = generateDemoData({ days: 140, seed: 2024 });
    const trend = computeTrendWeight(days);
    near(trend.current.trendKg, truth.endWeightKg, 0.6, 'trend weight: ');
  });

  it('degrades confidence honestly on thin data', () => {
    const { days } = generateDemoData({ days: 140, seed: 8080 });
    const profile = normaliseProfile({ ...defaultProfile(), ...demoProfile() });

    const thin = days.slice(0, 16);
    const thick = days;
    const mThin = estimateMaintenance({ entries: thin, profile, trend: computeTrendWeight(thin) });
    const mThick = estimateMaintenance({ entries: thick, profile, trend: computeTrendWeight(thick) });
    assert(mThin.confidence.rank <= mThick.confidence.rank, 'thin data must not claim more confidence');
    assert(mThin.dataQuality.score < mThick.dataQuality.score);
  });

  it('converges toward intake when weight is genuinely stable', () => {
    // Eating exactly maintenance for 20 weeks: the estimate must land on it.
    const { days } = generateDemoData({
      days: 140, trueMaintenance: 2750, targetIntake: 2750, seed: 1212, weighInProbability: 0.95, logProbability: 1,
    });
    const profile = normaliseProfile({ ...defaultProfile(), ...demoProfile() });
    const trend = computeTrendWeight(days);
    const m = estimateMaintenance({ entries: days, profile, trend });
    const meanIntake = mean(days.map((d) => d.intake.kcal).filter(Number.isFinite));
    near(m.kcal, meanIntake, 110, 'stable weight ⇒ maintenance ≈ mean intake: ');
  });

  it('derives a coherent intake target from the estimate', () => {
    const { days } = generateDemoData({ days: 120, seed: 606 });
    const profile = normaliseProfile({ ...defaultProfile(), ...demoProfile() });
    const trend = computeTrendWeight(days);
    const m = estimateMaintenance({ entries: days, profile, trend });
    const target = intakeForRate(m, -0.45, { fatMassKg: 14 });
    assert(target.kcal < m.kcal, 'losing weight requires eating below maintenance');
    // 0.45 kg/week at ~6,300 kcal/kg ≈ 405 kcal/day
    near(m.kcal - target.kcal, (0.45 * target.kcalPerKg) / 7, 1);
  });
});

/* ============================================================
   RUNNER
   ============================================================ */

export async function runAll(report = () => {}) {
  const results = [];
  let passed = 0;
  let failed = 0;

  for (const suite of suites) {
    const suiteResult = { name: suite.name, tests: [] };
    for (const test of suite.tests) {
      const started = performance.now();
      try {
        await test.fn();
        suiteResult.tests.push({ name: test.name, ok: true, ms: performance.now() - started });
        passed += 1;
      } catch (err) {
        suiteResult.tests.push({
          name: test.name,
          ok: false,
          error: err.message,
          stack: err.stack,
          ms: performance.now() - started,
        });
        failed += 1;
      }
    }
    results.push(suiteResult);
    report(suiteResult);
  }
  return { results, passed, failed, total: passed + failed };
}
