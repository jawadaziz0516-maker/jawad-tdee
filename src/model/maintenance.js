/**
 * maintenance.js — the adaptive maintenance engine.
 *
 * This is the module the whole application exists to serve. It answers one
 * question — how many calories hold your weight steady — and it answers it by
 * combining two independent sources of evidence:
 *
 *   PRIOR       what the physiology predicts (BMR + NEAT + EAT + TEF)
 *   LIKELIHOOD  what your body actually did (intake versus trend-weight change)
 *
 * The second is far more informative once enough of it exists, but it is noisy
 * early on, so the estimate starts near the equations and migrates toward
 * observed reality at a rate governed by how good the evidence is. That is a
 * Bayesian filter, not a heuristic, and it gives a calibrated ± band for free.
 *
 * ── WHAT "MAINTENANCE" MEANS HERE ──────────────────────────────────────────
 *
 * The adaptive estimate is maintenance *in the units you log in*. If your
 * tracking systematically misses 10% of what you eat — which is the norm, not
 * the exception; doubly-labelled-water studies put mean under-reporting around
 * 20% — then this number is 10% below your true expenditure, and that is the
 * useful behaviour. You will set targets in the same units you log in, so the
 * bias cancels. Do not compare it to a calculator's TDEE and conclude your
 * metabolism is broken.
 * Ref: Lichtman SW, et al. N Engl J Med. 1992;327(27):1893-1898.
 *
 * ── WHY WEEKLY BLOCKS ──────────────────────────────────────────────────────
 *
 * Observations are formed over non-overlapping 7-day blocks. Rolling windows
 * would be prettier and would also feed the filter the same data seven times,
 * inflating confidence roughly √7-fold. The rolling view still exists for the
 * chart; it just is not allowed to vote.
 *
 * @module model/maintenance
 */

import { computeDailyExpenditure, physiologicalUncertainty, averageEstimates } from '../energy/tdee.js';
import { habitualSplit } from '../energy/tef.js';
import { energyDensityOfChange } from './bodyComposition.js';
import { sequentialUpdate, credibleInterval, confidenceLabel, evidenceWeights, probabilityAbove } from '../stats/bayes.js';
import { mean, stdev, median } from '../stats/descriptive.js';
import { daysBetween, addDays } from '../core/time.js';
import { Z_95 } from '../core/constants.js';

export const DEFAULT_ENGINE_PARAMS = {
  /** Days per observation block. 7 aligns with weekly eating rhythms. */
  blockDays: 7,

  /** Random-walk SD of true maintenance, kcal/day per √day. Governs how fast
   *  the estimate is willing to move. 8 gives ~±60 kcal of drift latitude per
   *  month, which comfortably covers real metabolic adaptation without
   *  chasing noise. */
  processSdPerDay: 8,

  /** Minimum share of days in a block that must have intake logged. */
  minIntakeCoverage: 0.6,

  /** Minimum weigh-ins in a block for its rate to be usable. */
  minWeighIns: 2,

  /** Irreducible error in the energy-balance relation itself, kcal/day. Covers
   *  unmeasured fluid shifts across block boundaries and the fact that tissue
   *  energy density is itself estimated. */
  modelErrorKcal: 110,

  /** SD assumed for the intake of an *unlogged* day, kcal. Unlogged days skew
   *  high in practice, but assuming a bias rather than just uncertainty would
   *  put a thumb on the scale, so only the variance is inflated. */
  unloggedDaySd: 450,

  /** Window for the physiological prior, days. */
  priorWindowDays: 28,

  /** Cap on how far the posterior may sit from the prior, as a multiple of the
   *  prior SD. A guard against a data-entry disaster silently producing a
   *  1,200 kcal maintenance. */
  maxPriorDeviationSd: 4,
};

/**
 * @typedef {Object} MaintenanceResult
 * @property {number}  kcal          the headline estimate
 * @property {number}  sd
 * @property {{lower:number, upper:number, halfWidth:number}} ci
 * @property {Object}  confidence
 * @property {Object}  prior
 * @property {Array}   blocks
 * @property {Array}   trace
 * @property {Object}  dataQuality
 * @property {number}  adaptationRatio  observed ÷ predicted
 * @property {Array}   observedSeries   rolling view, for charting only
 */

/**
 * @param {Object} args
 * @param {Array<Object>} args.entries   all day records
 * @param {Object} args.profile
 * @param {Object} args.trend            output of computeTrendWeight
 * @param {Object} [args.params]
 * @returns {MaintenanceResult|null}
 */
export function estimateMaintenance({ entries, profile, trend, params = {} }) {
  const p = { ...DEFAULT_ENGINE_PARAMS, ...params };
  const sorted = [...(entries || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length || !trend?.days?.length) return null;

  const trendByDate = new Map(trend.days.map((d) => [d.date, d]));
  const habitual = habitualSplit(sorted.map((d) => d.intake).filter(Boolean));

  /* ============================================================
     1. PHYSIOLOGICAL PRIOR
     ============================================================ */

  const priorWindow = sorted.slice(-p.priorWindowDays);
  const estimates = priorWindow.map((day) => {
    const t = trendByDate.get(day.date);
    const weightKg = t?.trendKg ?? day.weightKg ?? trend.current.trendKg;
    return {
      date: day.date,
      ...computeDailyExpenditure({
        profile,
        day,
        weightKg,
        bodyFatPct: day.bodyFatPct ?? profile.bodyFatPct,
        habitual,
      }),
    };
  });

  const priorAvg = averageEstimates(estimates);
  if (!priorAvg) return null;

  const priorSd = median(estimates.map(physiologicalUncertainty)) ?? 250;
  const prior = { mean: priorAvg.maintenanceKcal, variance: priorSd ** 2 };

  /* ============================================================
     2. OBSERVATIONS — non-overlapping blocks of energy balance
     ============================================================ */

  const blocks = buildBlocks({ sorted, trend, trendByDate, profile, p });
  const usable = blocks.filter((b) => b.usable);

  const observations = usable.map((b) => ({
    mean: b.observedMaintenance,
    variance: b.variance,
    days: b.spanDays,
    label: b.label,
    meta: b,
  }));

  /* ============================================================
     3. SEQUENTIAL BAYESIAN UPDATE
     ============================================================ */

  const { posterior, trace } = sequentialUpdate(prior, observations, {
    processSdPerDay: p.processSdPerDay,
  });

  // Sanity guard: refuse to travel absurdly far from physiology on the strength
  // of data that is probably a logging error.
  const maxDeviation = p.maxPriorDeviationSd * priorSd;
  let kcal = posterior.mean;
  let clamped = false;
  if (Math.abs(kcal - prior.mean) > maxDeviation) {
    kcal = prior.mean + Math.sign(kcal - prior.mean) * maxDeviation;
    clamped = true;
  }

  const sd = Math.sqrt(posterior.variance);
  const ci = credibleInterval({ mean: kcal, variance: posterior.variance });
  const weights = evidenceWeights(prior, observations, p.processSdPerDay);

  /* ============================================================
     4. DATA QUALITY & CONFIDENCE
     ============================================================ */

  const dataQuality = assessDataQuality({ sorted, trend, blocks, usable });
  const rawConfidence = confidenceLabel(sd);
  const confidence = degradeConfidence(rawConfidence, dataQuality);

  /* ============================================================
     5. ROLLING VIEW (chart only — not fed to the filter)
     ============================================================ */

  const observedSeries = rollingObservedMaintenance({ sorted, trend, trendByDate, profile, window: 21 });

  return {
    kcal,
    sd,
    ci,
    clamped,
    confidence,
    prior: {
      kcal: prior.mean,
      sd: priorSd,
      components: {
        bmr: priorAvg.bmrKcal,
        neat: priorAvg.neatKcal,
        eat: priorAvg.eatKcal,
        tef: priorAvg.tefKcal,
      },
      days: priorAvg.days,
      dMaintenanceDKg: priorAvg.dMaintenanceDKg,
      kcalPerStep: priorAvg.kcalPerStep,
    },
    blocks,
    trace,
    weights,
    dataQuality,
    habitual,
    /** What a typical recent day looked like — the baseline that
     *  dailyAdjustedMaintenance() measures today against. */
    habitualAverages: {
      eatKcal: mean(estimates.map((e) => e.eatKcal)) ?? 0,
      neatKcal: mean(estimates.map((e) => e.neatKcal)) ?? 0,
      steps: mean(priorWindow.map((d) => d.steps).filter(Number.isFinite)) ?? 0,
      intakeKcal: mean(priorWindow.map((d) => d.intake?.kcal).filter(Number.isFinite)) ?? null,
      days: estimates.length,
    },
    dailyEstimates: estimates,
    /** >1 means you burn more than the equations predict; <1 means less.
     *  Values outside 0.85–1.15 usually indicate logging bias, not metabolism. */
    adaptationRatio: prior.mean > 0 ? kcal / prior.mean : null,
    observedSeries,
    probabilityAbove: (threshold) => probabilityAbove({ mean: kcal, variance: posterior.variance }, threshold),
  };
}

/* ============================================================
   BLOCK CONSTRUCTION
   ============================================================ */

function buildBlocks({ sorted, trend, trendByDate, profile, p }) {
  const trendDays = trend.days;
  const lastDate = trendDays[trendDays.length - 1].date;
  const firstDate = trendDays[0].date;
  const totalDays = daysBetween(firstDate, lastDate) + 1;
  const nBlocks = Math.floor(totalDays / p.blockDays);
  if (nBlocks < 1) return [];

  const entriesByDate = new Map(sorted.map((d) => [d.date, d]));
  const blocks = [];

  // Anchored at the most recent day and walking backwards, so the newest data
  // always forms a complete block rather than being stranded in a remainder.
  for (let b = nBlocks - 1; b >= 0; b--) {
    const endDate = addDays(lastDate, -(nBlocks - 1 - b) * p.blockDays);
    const startDate = addDays(endDate, -(p.blockDays - 1));
    const dates = [];
    for (let i = 0; i < p.blockDays; i++) dates.push(addDays(startDate, i));

    const dayEntries = dates.map((d) => entriesByDate.get(d)).filter(Boolean);
    const intakes = dayEntries
      .map((d) => d.intake?.kcal)
      .filter((v) => Number.isFinite(v) && v > 0);
    const weighIns = dates.filter((d) => Number.isFinite(entriesByDate.get(d)?.weightKg)).length;

    const coverage = intakes.length / p.blockDays;
    const startTrend = trendByDate.get(startDate);
    const endTrend = trendByDate.get(endDate);

    const block = {
      label: `${startDate} → ${endDate}`,
      startDate,
      endDate,
      spanDays: p.blockDays,
      loggedDays: intakes.length,
      coverage,
      weighIns,
      usable: false,
      reason: null,
    };

    if (!startTrend || !endTrend) {
      block.reason = 'Outside the trend-weight window.';
      blocks.push(block);
      continue;
    }
    if (coverage < p.minIntakeCoverage) {
      block.reason = `Only ${intakes.length}/${p.blockDays} days of intake logged.`;
      blocks.push(block);
      continue;
    }
    if (weighIns < p.minWeighIns) {
      block.reason = `Only ${weighIns} weigh-in${weighIns === 1 ? '' : 's'} this week.`;
      blocks.push(block);
      continue;
    }

    /* --- intake --- */
    const meanIntake = mean(intakes);
    const intakeSd = stdev(intakes) ?? 400;
    const nLogged = intakes.length;
    const nMissing = p.blockDays - nLogged;
    // Var of the block mean: logged days contribute sampling error; missing
    // days contribute their full assumed spread, scaled by how many there are.
    const varIntake =
      ((nLogged / p.blockDays) ** 2 * (intakeSd ** 2 / nLogged)) +
      ((nMissing / p.blockDays) ** 2 * p.unloggedDaySd ** 2);

    /* --- weight rate, from the smoothed trend --- */
    const deltaKg = endTrend.trendSmoothKg - startTrend.trendSmoothKg;
    const span = daysBetween(startDate, endDate);
    const rateKgPerDay = deltaKg / span;
    // Endpoint variances; their positive covariance is ignored, which makes
    // this slightly conservative (wider interval) rather than overconfident.
    const varRate =
      (endTrend.smoothLevelSd ** 2 + startTrend.smoothLevelSd ** 2) / (span * span);

    /* --- tissue energy density at this block's composition --- */
    const midTrend = trendByDate.get(addDays(startDate, Math.floor(p.blockDays / 2)));
    const weightKg = midTrend?.trendKg ?? endTrend.trendKg;
    const bodyFatPct =
      median(dayEntries.map((d) => d.bodyFatPct).filter(Number.isFinite)) ??
      profile.bodyFatPct ??
      null;
    const fatMassKg = Number.isFinite(bodyFatPct) ? weightKg * (bodyFatPct / 100) : weightKg * 0.22;

    const resistanceSessions = dayEntries.reduce(
      (s, d) => s + (d.exercise || []).filter((e) => e.activityId === 'weights' || e.activityId === 'circuit').length,
      0,
    );
    const proteinG = mean(dayEntries.map((d) => d.intake?.protein).filter(Number.isFinite));

    const density = energyDensityOfChange({
      fatMassKg,
      inSurplus: deltaKg > 0,
      resistanceSessionsPerWeek: resistanceSessions,
      proteinGPerKg: proteinG != null && weightKg ? proteinG / weightKg : 0,
      applyTrainingAdjustment: profile.applyTrainingPartitioning !== false,
    });

    /* --- the observation ---
       maintenance = intake − (energy deposited or withdrawn per day) */
    const observedMaintenance = meanIntake - density.kcalPerKg * rateKgPerDay;
    const variance =
      varIntake + density.kcalPerKg ** 2 * varRate + p.modelErrorKcal ** 2;

    Object.assign(block, {
      usable: true,
      meanIntake,
      intakeSd,
      deltaKg,
      rateKgPerDay,
      weeklyRateKg: rateKgPerDay * 7,
      kcalPerKg: density.kcalPerKg,
      leanFraction: density.leanFraction,
      energyBalanceKcal: -density.kcalPerKg * rateKgPerDay,
      observedMaintenance,
      variance,
      sd: Math.sqrt(variance),
      avgSteps: mean(dayEntries.map((d) => d.steps).filter(Number.isFinite)),
      avgExerciseMinutes: mean(
        dayEntries.map((d) => (d.exercise || []).reduce((s, e) => s + (e.minutes || 0), 0)),
      ),
    });
    blocks.push(block);
  }

  return blocks.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/* ============================================================
   ROLLING VIEW (charts)
   ============================================================ */

/**
 * Rolling-window observed maintenance. Overlapping and therefore statistically
 * dependent — informative to look at, illegitimate to update on. Kept strictly
 * out of the filter.
 */
function rollingObservedMaintenance({ sorted, trend, trendByDate, profile, window }) {
  const out = [];
  const entriesByDate = new Map(sorted.map((d) => [d.date, d]));

  for (let i = window - 1; i < trend.days.length; i++) {
    const endDay = trend.days[i];
    const startDay = trend.days[i - window + 1];
    const dates = [];
    for (let k = i - window + 1; k <= i; k++) dates.push(trend.days[k].date);

    const intakes = dates
      .map((d) => entriesByDate.get(d)?.intake?.kcal)
      .filter((v) => Number.isFinite(v) && v > 0);
    if (intakes.length < window * 0.6) {
      out.push({ date: endDay.date, kcal: null });
      continue;
    }

    const span = endDay.index - startDay.index;
    const rate = (endDay.trendSmoothKg - startDay.trendSmoothKg) / span;
    const bf = profile.bodyFatPct ?? 22;
    const density = energyDensityOfChange({
      fatMassKg: endDay.trendKg * (bf / 100),
      inSurplus: rate > 0,
      applyTrainingAdjustment: false,
    });
    out.push({
      date: endDay.date,
      kcal: mean(intakes) - density.kcalPerKg * rate,
      meanIntake: mean(intakes),
      rateKgPerDay: rate,
    });
  }
  return out;
}

/* ============================================================
   DATA QUALITY
   ============================================================ */

function assessDataQuality({ sorted, trend, blocks, usable }) {
  const totalDays = trend.days.length;
  const intakeDays = sorted.filter((d) => Number.isFinite(d.intake?.kcal) && d.intake.kcal > 0).length;
  const weighDays = sorted.filter((d) => Number.isFinite(d.weightKg)).length;
  const macroDays = sorted.filter((d) => Number.isFinite(d.intake?.protein)).length;
  const stepDays = sorted.filter((d) => Number.isFinite(d.steps)).length;

  const issues = [];
  const intakeCoverage = totalDays ? intakeDays / totalDays : 0;
  const weighCoverage = totalDays ? weighDays / totalDays : 0;

  if (totalDays < 14) issues.push({ level: 'warn', text: `Only ${totalDays} days of history — the estimate is still mostly physiological prediction.` });
  if (weighCoverage < 0.5) issues.push({ level: 'warn', text: `Weighed on ${Math.round(weighCoverage * 100)}% of days. Daily weigh-ins roughly halve the width of the confidence interval.` });
  if (intakeCoverage < 0.7) issues.push({ level: 'warn', text: `Intake logged on ${Math.round(intakeCoverage * 100)}% of days. Unlogged days widen the interval more than inaccurate ones do.` });
  if (macroDays < intakeDays * 0.5) issues.push({ level: 'info', text: 'Macros are missing on many days — TEF falls back to a flat rate on those.' });
  if (stepDays < totalDays * 0.5) issues.push({ level: 'info', text: 'Step counts are sparse — NEAT is relying on your lifestyle setting.' });
  if (!usable.length) issues.push({ level: 'warn', text: 'No complete week yet meets the bar for a usable observation.' });

  return {
    totalDays,
    intakeDays,
    weighDays,
    macroDays,
    stepDays,
    intakeCoverage,
    weighCoverage,
    blocksTotal: blocks.length,
    blocksUsable: usable.length,
    issues,
    score: Math.round(
      100 * Math.min(1, (0.4 * Math.min(1, totalDays / 42)) + 0.3 * weighCoverage + 0.3 * intakeCoverage),
    ),
  };
}

/**
 * The posterior SD can look tight on thin data — a filter is only as honest as
 * its inputs. Cap the reported confidence by what the log actually supports.
 */
function degradeConfidence(base, dq) {
  let rank = base.rank;
  if (dq.blocksUsable < 2) rank = Math.min(rank, 1);
  if (dq.blocksUsable < 4) rank = Math.min(rank, 2);
  if (dq.totalDays < 21) rank = Math.min(rank, 1);
  if (dq.weighCoverage < 0.35) rank = Math.min(rank, 1);
  const byRank = ['Very low', 'Low', 'Moderate', 'High'];
  const levels = ['veryLow', 'low', 'moderate', 'high'];
  return {
    level: levels[rank],
    label: byRank[rank],
    rank,
    cappedByData: rank < base.rank,
    statisticalLabel: base.label,
  };
}

/* ============================================================
   DAILY TARGETS
   ============================================================ */

/**
 * Today's maintenance, adjusted for how today differs from the average day the
 * estimate was built on.
 *
 * The adaptive number is an *average* that already contains your habitual
 * exercise and stepping. Adding today's full workout on top would double-count
 * it; ignoring an unusually big day would under-feed it. So only the deviation
 * from habit is applied.
 */
export function dailyAdjustedMaintenance({ maintenance, todayEstimate, habitualAverages }) {
  if (!maintenance) return null;
  const base = maintenance.kcal;
  const parts = [];

  let adjusted = base;

  if (Number.isFinite(todayEstimate?.eatKcal) && Number.isFinite(habitualAverages?.eatKcal)) {
    const delta = todayEstimate.eatKcal - habitualAverages.eatKcal;
    adjusted += delta;
    parts.push({
      id: 'exercise',
      label: 'Exercise vs. your average',
      kcal: delta,
      detail: `${Math.round(todayEstimate.eatKcal)} kcal today vs ${Math.round(habitualAverages.eatKcal)} typical`,
    });
  }

  if (
    Number.isFinite(todayEstimate?.neat?.netSteps) &&
    Number.isFinite(habitualAverages?.steps) &&
    Number.isFinite(todayEstimate?.kcalPerStep)
  ) {
    const delta = (todayEstimate.neat.netSteps - habitualAverages.steps) * todayEstimate.kcalPerStep;
    adjusted += delta;
    parts.push({
      id: 'steps',
      label: 'Steps vs. your average',
      kcal: delta,
      detail: `${Math.round(todayEstimate.neat.netSteps).toLocaleString()} vs ${Math.round(habitualAverages.steps).toLocaleString()} typical`,
    });
  }

  return { base, adjusted, parts };
}

/**
 * Intake required to move trend weight at a chosen rate.
 *
 * @param {Object} maintenance
 * @param {number} targetWeeklyKg  negative to lose
 * @param {Object} composition     {fatMassKg, ...} for the energy density
 */
export function intakeForRate(maintenance, targetWeeklyKg, composition) {
  if (!maintenance) return null;
  const density = energyDensityOfChange({
    fatMassKg: composition?.fatMassKg ?? 20,
    inSurplus: targetWeeklyKg > 0,
    resistanceSessionsPerWeek: composition?.resistanceSessionsPerWeek ?? 0,
    proteinGPerKg: composition?.proteinGPerKg ?? 0,
    applyTrainingAdjustment: composition?.applyTrainingAdjustment !== false,
  });
  const dailyEnergy = (targetWeeklyKg * density.kcalPerKg) / 7;
  const kcal = maintenance.kcal + dailyEnergy;
  const halfWidth = Z_95 * maintenance.sd;
  return {
    kcal,
    dailyEnergy,
    kcalPerKg: density.kcalPerKg,
    kcalPerLb: density.kcalPerLb,
    ci: { lower: kcal - halfWidth, upper: kcal + halfWidth },
    /** Honest framing: uncertainty in maintenance is uncertainty in the deficit
     *  you are actually running. */
    actualDeficitRange: {
      lower: dailyEnergy - halfWidth,
      upper: dailyEnergy + halfWidth,
    },
  };
}
