/**
 * engine.js — the analytics façade.
 *
 * Views ask this module one question ("what do we know right now?") and get a
 * single immutable snapshot back. Nothing in ui/ imports a statistics module
 * directly, so the modelling layer can be reworked without touching a view.
 *
 * Recomputation is memoised on a cheap signature of the inputs, because the
 * full pipeline — Kalman filter over every day, cross-validated ridge fit,
 * sequential Bayesian update — runs on every keystroke in the log form
 * otherwise.
 *
 * @module model/engine
 */

import { computeTrendWeight, trendChangeOver } from './trendWeight.js';
import { estimateMaintenance, dailyAdjustedMaintenance, intakeForRate } from './maintenance.js';
import { computeDailyExpenditure } from '../energy/tdee.js';
import { habitualSplit } from '../energy/tef.js';
import { energyDensityOfChange } from './bodyComposition.js';
import { mean, median } from '../stats/descriptive.js';
import { todayISO, addDays, daysBetween } from '../core/time.js';

/**
 * @typedef {Object} Snapshot
 * @property {Object|null} trend
 * @property {Object|null} maintenance
 * @property {Object|null} today        expenditure estimate for the focus day
 * @property {Object|null} adjusted     today's maintenance, adjusted for today
 * @property {Object} summary           headline numbers for the dashboard
 * @property {Object} composition
 * @property {boolean} hasData
 */

let cache = { signature: null, snapshot: null };

/** Cheap change detector — day count, last update, and the settings that
 *  actually alter the model output. */
function signatureOf(entries, profile, focusDate) {
  const last = entries[entries.length - 1];
  return [
    entries.length,
    last?.date,
    last?.updatedAt,
    focusDate,
    profile.bmrFormula,
    profile.occupation,
    profile.workHours,
    profile.standingHours,
    profile.fidget,
    profile.lifestyle,
    profile.heightCm,
    profile.sex,
    profile.birthDate,
    profile.bodyFatPct,
    profile.applyWaterModel,
    profile.applyFibreCorrection,
    profile.applyTrainingPartitioning,
    profile.trustWearable,
    profile.subtractExerciseSteps,
    profile.neatOverrideKcal,
    JSON.stringify(profile.tefCoefficients),
    JSON.stringify(profile.trendParams),
    JSON.stringify(profile.engineParams),
    // Any edit to any day changes the max updatedAt.
    entries.reduce((acc, d) => (d.updatedAt > acc ? d.updatedAt : acc), ''),
  ].join('|');
}

/**
 * @param {Array<Object>} entries
 * @param {Object} profile
 * @param {string} [focusDate]
 * @returns {Snapshot}
 */
export function analyse(entries, profile, focusDate = todayISO()) {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const signature = signatureOf(sorted, profile, focusDate);
  if (cache.signature === signature) return cache.snapshot;

  const snapshot = build(sorted, profile, focusDate);
  cache = { signature, snapshot };
  return snapshot;
}

export function invalidate() {
  cache = { signature: null, snapshot: null };
}

function build(sorted, profile, focusDate) {
  const hasWeight = sorted.some((d) => Number.isFinite(d.weightKg));

  if (!sorted.length || !hasWeight) {
    return {
      hasData: false,
      trend: null,
      maintenance: null,
      today: null,
      adjusted: null,
      summary: emptySummary(),
      composition: null,
      focusDate,
    };
  }

  const trend = computeTrendWeight(sorted, {
    applyWaterModel: profile.applyWaterModel !== false,
    trendParams: profile.trendParams,
  });

  const maintenance = trend
    ? estimateMaintenance({ entries: sorted, profile, trend, params: profile.engineParams })
    : null;

  /* ---- the focus day ---- */
  const focusEntry = sorted.find((d) => d.date === focusDate) ?? { date: focusDate, intake: {}, exercise: [] };
  const trendForFocus = trend?.days.find((d) => d.date === focusDate) ?? trend?.days[trend.days.length - 1];
  const weightForFocus = trendForFocus?.trendKg ?? focusEntry.weightKg ?? null;

  const habitual = habitualSplit(sorted.map((d) => d.intake).filter(Boolean));
  const today = weightForFocus
    ? computeDailyExpenditure({
        profile,
        day: focusEntry,
        weightKg: weightForFocus,
        bodyFatPct: focusEntry.bodyFatPct ?? latestBodyFat(sorted) ?? profile.bodyFatPct,
        habitual,
      })
    : null;

  const adjusted =
    maintenance && today
      ? dailyAdjustedMaintenance({
          maintenance,
          todayEstimate: today,
          habitualAverages: maintenance.habitualAverages,
        })
      : null;

  /* ---- body composition ---- */
  const bodyFatPct = latestBodyFat(sorted) ?? profile.bodyFatPct ?? null;
  const currentWeight = trend?.current.trendKg ?? null;
  const fatMassKg = Number.isFinite(bodyFatPct) && currentWeight ? currentWeight * (bodyFatPct / 100) : null;
  const proteinGPerKg =
    currentWeight && maintenance
      ? (mean(sorted.slice(-28).map((d) => d.intake?.protein).filter(Number.isFinite)) ?? 0) / currentWeight
      : 0;
  const resistanceSessionsPerWeek =
    (sorted.slice(-28).reduce(
      (s, d) => s + (d.exercise || []).filter((e) => e.activityId === 'weights' || e.activityId === 'circuit').length,
      0,
    ) /
      Math.max(1, Math.min(28, sorted.length))) *
    7;

  const density = energyDensityOfChange({
    fatMassKg: fatMassKg ?? (currentWeight ?? 80) * 0.22,
    inSurplus: (trend?.current.slopeKgPerDay ?? 0) > 0,
    resistanceSessionsPerWeek,
    proteinGPerKg,
    applyTrainingAdjustment: profile.applyTrainingPartitioning !== false,
  });

  const composition = {
    bodyFatPct,
    bodyFatIsEstimate: !sorted.some((d) => Number.isFinite(d.bodyFatPct)),
    fatMassKg,
    leanMassKg: fatMassKg != null && currentWeight ? currentWeight - fatMassKg : null,
    density,
    proteinGPerKg,
    resistanceSessionsPerWeek,
  };

  return {
    hasData: true,
    focusDate,
    trend,
    maintenance,
    today,
    adjusted,
    composition,
    summary: buildSummary({ sorted, trend, maintenance, today, focusEntry, focusDate, density }),
  };
}

/* ============================================================
   SUMMARY
   ============================================================ */

function buildSummary({ sorted, trend, maintenance, today, focusEntry, focusDate, density }) {
  const byDate = new Map(sorted.map((d) => [d.date, d]));

  const windowMean = (days, pick) => {
    const values = [];
    for (let i = 0; i < days; i++) {
      const v = pick(byDate.get(addDays(focusDate, -i)));
      if (Number.isFinite(v)) values.push(v);
    }
    return values.length ? { value: mean(values), n: values.length } : { value: null, n: 0 };
  };

  const intake7 = windowMean(7, (d) => d?.intake?.kcal);
  const intake28 = windowMean(28, (d) => d?.intake?.kcal);
  const steps7 = windowMean(7, (d) => d?.steps);
  const protein7 = windowMean(7, (d) => d?.intake?.protein);
  const sleep7 = windowMean(7, (d) => d?.sleepHours);

  const todayIntake = focusEntry?.intake?.kcal ?? null;
  const maintenanceKcal = maintenance?.kcal ?? today?.maintenanceKcal ?? null;

  const balanceToday =
    Number.isFinite(todayIntake) && Number.isFinite(maintenanceKcal) ? todayIntake - maintenanceKcal : null;
  const balance7 =
    Number.isFinite(intake7.value) && Number.isFinite(maintenanceKcal) ? intake7.value - maintenanceKcal : null;
  const balance28 =
    Number.isFinite(intake28.value) && Number.isFinite(maintenanceKcal) ? intake28.value - maintenanceKcal : null;

  return {
    maintenanceKcal,
    todayIntake,
    balanceToday,
    balance7,
    balance28,
    intake7: intake7.value,
    intake7n: intake7.n,
    intake28: intake28.value,
    intake28n: intake28.n,
    steps7: steps7.value,
    protein7: protein7.value,
    sleep7: sleep7.value,
    trendKg: trend?.current.trendKg ?? null,
    weeklyRateKg: trend?.current.weeklyRateKg ?? null,
    weeklyRateCI: trend?.current.weeklyRateCI ?? null,
    rateIsSignificant: trend?.current.rateIsSignificant ?? false,
    change7: trendChangeOver(trend, 7),
    change28: trendChangeOver(trend, 28),
    change90: trendChangeOver(trend, 90),
    kcalPerKg: density.kcalPerKg,
    kcalPerLb: density.kcalPerLb,
    /** Weekly rate implied by the last 7 days of eating — what the scale
     *  *should* do if nothing else changes. */
    impliedWeeklyKg:
      Number.isFinite(balance7) ? (balance7 * 7) / density.kcalPerKg : null,
    daysLogged: sorted.length,
    spanDays: sorted.length ? daysBetween(sorted[0].date, sorted[sorted.length - 1].date) + 1 : 0,
  };
}

function emptySummary() {
  return {
    maintenanceKcal: null, todayIntake: null, balanceToday: null, balance7: null, balance28: null,
    intake7: null, intake28: null, steps7: null, protein7: null, sleep7: null,
    trendKg: null, weeklyRateKg: null, weeklyRateCI: null, rateIsSignificant: false,
    change7: null, change28: null, change90: null, daysLogged: 0, spanDays: 0,
  };
}

function latestBodyFat(sorted) {
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (Number.isFinite(sorted[i].bodyFatPct)) return sorted[i].bodyFatPct;
  }
  return null;
}

/** Convenience re-export so views have a single import surface. */
export { intakeForRate };
