/**
 * schema.js — the shape of everything that gets persisted, plus validation
 * and forward migration.
 *
 * The storage layer is deliberately dumb: it moves opaque blobs. All knowledge
 * of what a valid record looks like lives here, so adding a field means
 * touching one file and bumping one number.
 *
 * @module data/schema
 */

import { todayISO, isValidISODate } from '../core/time.js';
import { DEFAULT_TEF_COEFFICIENTS } from '../energy/tef.js';
import { DEFAULT_TREND_PARAMS } from '../stats/kalman.js';
import { DEFAULT_ENGINE_PARAMS } from '../model/maintenance.js';

export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'ember.tdee.v1';

/* ============================================================
   PROFILE
   ============================================================ */

export function defaultProfile() {
  return {
    // --- identity & anthropometrics ---
    name: '',
    sex: 'male',
    birthDate: '1998-01-01',
    heightCm: 178,
    bodyFatPct: null,
    vo2max: null,

    // --- units & display ---
    units: 'imperial',

    /** 'simple' shows the number and what to do about it. 'detailed' adds the
     *  component breakdowns, the evidence tables and the extra charts.
     *  Simple is the default: the most common failure of a tool like this is
     *  showing so much that the one number you needed gets lost. */
    detailLevel: 'simple',

    /** True while the sample dataset is loaded, so the UI can say so plainly
     *  rather than presenting simulated numbers as if they were yours. */
    demoLoaded: false,

    /** Set once the user has confirmed their own details, which suppresses the
     *  first-run setup prompt. */
    profileConfirmed: false,

    // --- BMR ---
    bmrFormula: 'mifflin',
    allowEstimatedBodyFat: false,

    // --- NEAT ---
    occupation: 'desk',
    workHours: 8,
    standingHours: 2,
    customNetMet: 1.0,
    customAmbulatoryShare: 0.5,
    fidget: 'average',
    lifestyle: 'lightlyActive',
    neatOverrideKcal: null,
    subtractExerciseSteps: true,

    // --- EAT ---
    trustWearable: true,

    // --- TEF ---
    tefCoefficients: { ...DEFAULT_TEF_COEFFICIENTS },
    applyFibreCorrection: false,

    // --- modelling ---
    applyWaterModel: true,
    applyTrainingPartitioning: true,
    trendParams: { ...DEFAULT_TREND_PARAMS },
    engineParams: { ...DEFAULT_ENGINE_PARAMS },

    // --- goals ---
    goal: {
      mode: 'maintain',          // 'lose' | 'maintain' | 'gain'
      weeklyRateKg: 0,
      targetWeightKg: null,
      proteinGPerKg: 1.8,
    },
  };
}

/* ============================================================
   DAY ENTRY
   ============================================================ */

export function emptyDay(date = todayISO()) {
  return {
    date,
    weightKg: null,
    bodyFatPct: null,
    intake: { kcal: null, protein: null, carbs: null, fat: null, fiber: null, alcohol: null },
    steps: null,
    exercise: [],
    sleepHours: null,
    sleepQuality: null,   // 1–5
    stress: null,         // 1–5
    waterMl: null,
    sodiumMg: null,
    neatOverrideKcal: null,
    notes: '',
    updatedAt: new Date().toISOString(),
  };
}

export function emptyExercise() {
  return {
    id: cryptoId(),
    activityId: 'weights',
    minutes: null,
    avgHr: null,
    distanceKm: null,
    wearableKcal: null,
    wearableIsNet: false,
    rpe: null,
    customMet: null,
    note: '',
  };
}

/* ============================================================
   VALIDATION / NORMALISATION
   ============================================================
   Normalisation is total: anything that comes back from storage, CSV or a
   form goes through here, so downstream code can assume numbers are numbers
   and missing means null (never NaN, never ''). */

const numOrNull = (v) => {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const clampOrNull = (v, lo, hi) => {
  const n = numOrNull(v);
  if (n == null) return null;
  return Math.min(hi, Math.max(lo, n));
};

export function normaliseDay(raw) {
  if (!raw || !isValidISODate(raw.date)) return null;
  const base = emptyDay(raw.date);
  const intake = raw.intake || {};

  return {
    ...base,
    date: raw.date,
    weightKg: clampOrNull(raw.weightKg, 20, 400),
    bodyFatPct: clampOrNull(raw.bodyFatPct, 2, 70),
    intake: {
      kcal: clampOrNull(intake.kcal, 0, 20000),
      protein: clampOrNull(intake.protein, 0, 1000),
      carbs: clampOrNull(intake.carbs, 0, 2000),
      fat: clampOrNull(intake.fat, 0, 1000),
      fiber: clampOrNull(intake.fiber, 0, 300),
      alcohol: clampOrNull(intake.alcohol, 0, 500),
    },
    steps: clampOrNull(raw.steps, 0, 200000),
    exercise: (Array.isArray(raw.exercise) ? raw.exercise : []).map(normaliseExercise).filter(Boolean),
    sleepHours: clampOrNull(raw.sleepHours, 0, 24),
    sleepQuality: clampOrNull(raw.sleepQuality, 1, 5),
    stress: clampOrNull(raw.stress, 1, 5),
    waterMl: clampOrNull(raw.waterMl, 0, 20000),
    sodiumMg: clampOrNull(raw.sodiumMg, 0, 30000),
    neatOverrideKcal: clampOrNull(raw.neatOverrideKcal, 0, 5000),
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 2000) : '',
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

export function normaliseExercise(raw) {
  if (!raw) return null;
  const minutes = clampOrNull(raw.minutes, 0, 1440);
  const wearable = clampOrNull(raw.wearableKcal, 0, 20000);
  // An entry with neither duration nor a device number carries no information.
  if (minutes == null && wearable == null) return null;
  return {
    id: raw.id || cryptoId(),
    activityId: typeof raw.activityId === 'string' ? raw.activityId : 'custom',
    minutes,
    avgHr: clampOrNull(raw.avgHr, 30, 230),
    distanceKm: clampOrNull(raw.distanceKm, 0, 500),
    wearableKcal: wearable,
    wearableIsNet: raw.wearableIsNet === true,
    rpe: clampOrNull(raw.rpe, 1, 10),
    customMet: clampOrNull(raw.customMet, 0.9, 25),
    note: typeof raw.note === 'string' ? raw.note.slice(0, 300) : '',
  };
}

export function normaliseProfile(raw) {
  const base = defaultProfile();
  if (!raw) return base;
  const merged = {
    ...base,
    ...raw,
    tefCoefficients: { ...base.tefCoefficients, ...(raw.tefCoefficients || {}) },
    trendParams: { ...base.trendParams, ...(raw.trendParams || {}) },
    engineParams: { ...base.engineParams, ...(raw.engineParams || {}) },
    goal: { ...base.goal, ...(raw.goal || {}) },
  };
  merged.heightCm = clampOrNull(merged.heightCm, 100, 250) ?? base.heightCm;
  merged.bodyFatPct = clampOrNull(merged.bodyFatPct, 2, 70);
  merged.vo2max = clampOrNull(merged.vo2max, 15, 95);
  merged.workHours = clampOrNull(merged.workHours, 0, 24) ?? 8;
  merged.standingHours = clampOrNull(merged.standingHours, 0, 24) ?? 2;
  if (!isValidISODate(merged.birthDate)) merged.birthDate = base.birthDate;
  if (merged.sex !== 'male' && merged.sex !== 'female') merged.sex = 'male';
  if (merged.detailLevel !== 'detailed') merged.detailLevel = 'simple';
  merged.name = typeof merged.name === 'string' ? merged.name.slice(0, 60) : '';
  return merged;
}

/**
 * True when the profile still holds shipped defaults for the things that
 * actually move the estimate. Drives the first-run setup prompt — an app whose
 * headline number is built on a stranger's height is worse than one that says
 * it needs your height.
 */
export function profileNeedsSetup(profile) {
  if (!profile) return true;
  if (profile.profileConfirmed) return false;
  const base = defaultProfile();
  return (
    profile.birthDate === base.birthDate ||
    profile.heightCm === base.heightCm ||
    !profile.name
  );
}

/**
 * True when a day carries no information — used to avoid persisting rows that
 * exist only because a form was opened.
 */
export function isDayEmpty(day) {
  if (!day) return true;
  const i = day.intake || {};
  return (
    day.weightKg == null &&
    day.bodyFatPct == null &&
    i.kcal == null && i.protein == null && i.carbs == null && i.fat == null &&
    i.fiber == null && i.alcohol == null &&
    day.steps == null &&
    (!day.exercise || day.exercise.length === 0) &&
    day.sleepHours == null && day.stress == null &&
    day.waterMl == null && day.sodiumMg == null &&
    !day.notes
  );
}

/* ============================================================
   DATABASE ENVELOPE & MIGRATION
   ============================================================ */

export function emptyDatabase() {
  return {
    version: SCHEMA_VERSION,
    profile: defaultProfile(),
    days: {},                // keyed by ISO date
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Migrate a persisted blob up to the current schema version.
 *
 * Migrations are additive and ordered; each step takes vN to vN+1. When the
 * time comes, add a case rather than editing the loader — an app that silently
 * drops a user's history on upgrade is worse than one that fails loudly.
 */
export function migrate(db) {
  if (!db || typeof db !== 'object') return emptyDatabase();
  let working = { ...db };
  let version = Number(working.version) || 0;

  if (version < 1) {
    working = {
      ...emptyDatabase(),
      ...working,
      version: 1,
      profile: normaliseProfile(working.profile),
      days: working.days || {},
    };
    version = 1;
  }

  // Future migrations slot in here:
  // if (version < 2) { ...; version = 2; }

  const days = {};
  for (const [date, day] of Object.entries(working.days || {})) {
    const n = normaliseDay({ ...day, date });
    if (n && !isDayEmpty(n)) days[date] = n;
  }

  return {
    version: SCHEMA_VERSION,
    profile: normaliseProfile(working.profile),
    days,
    createdAt: working.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/* ---------- internals ---------- */

export function cryptoId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
