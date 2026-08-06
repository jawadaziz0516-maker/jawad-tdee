/**
 * csv.js — CSV import and export.
 *
 * Import is column-mapped rather than format-specific: rather than writing a
 * parser per app and breaking every time one of them changes its export, the
 * header row is matched against a synonym table and anything unrecognised is
 * offered to the user to map by hand.
 *
 * Known-good sources: MyFitnessPal nutrition export, Cronometer daily summary,
 * Renpho/Withings weight export, Apple Health via Health Auto Export.
 *
 * @module data/csv
 */

import { isValidISODate, toISODate } from '../core/time.js';
import { lbToKg, flOzToMl } from '../core/units.js';

/* ============================================================
   PARSER
   ============================================================ */

/**
 * RFC 4180-ish parser: handles quoted fields, embedded commas, escaped quotes
 * and both line-ending conventions. Small enough to keep, robust enough to
 * survive real exports.
 *
 * @param {string} text
 * @returns {{headers: string[], rows: string[][]}}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = String(text ?? '').replace(/^﻿/, ''); // strip BOM

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  return { headers: nonEmpty[0].map((h) => h.trim()), rows: nonEmpty.slice(1) };
}

/* ============================================================
   COLUMN MAPPING
   ============================================================ */

/** Field → header synonyms, lowercased and stripped of non-alphanumerics. */
const SYNONYMS = {
  date: ['date', 'day', 'datetime', 'recordeddate', 'measurementdate', 'time'],
  weightKg: ['weightkg', 'weight', 'bodyweight', 'weightkilograms', 'masskg'],
  weightLb: ['weightlb', 'weightlbs', 'weightpounds', 'bodyweightlb'],
  bodyFatPct: ['bodyfat', 'bodyfatpct', 'bodyfatpercentage', 'fatpercent', 'bf'],
  kcal: ['calories', 'energy', 'kcal', 'caloriesconsumed', 'energykcal', 'totalcalories'],
  protein: ['protein', 'proteing', 'proteing'],
  carbs: ['carbs', 'carbohydrates', 'carbohydrate', 'carbsg', 'netcarbs', 'totalcarbohydrate'],
  fat: ['fat', 'fatg', 'totalfat', 'fatgrams'],
  fiber: ['fiber', 'fibre', 'dietaryfiber', 'fiberg'],
  alcohol: ['alcohol', 'alcoholg', 'ethanol'],
  steps: ['steps', 'stepcount', 'dailysteps', 'totalsteps'],
  sleepHours: ['sleep', 'sleephours', 'hoursslept', 'sleepduration', 'asleep'],
  stress: ['stress', 'stresslevel'],
  waterMl: ['water', 'waterml', 'waterintake', 'fluid'],
  waterOz: ['wateroz', 'waterflor', 'waterfluidounces'],
  sodiumMg: ['sodium', 'sodiummg', 'salt'],
  exerciseKcal: ['exercisecalories', 'activecalories', 'activeenergy', 'workoutcalories', 'caloriesburned'],
  exerciseMinutes: ['exerciseminutes', 'activeminutes', 'workoutduration', 'exercisetime'],
  notes: ['notes', 'note', 'comment', 'comments'],
};

const canon = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Guess a header → field mapping. Returns the mapping plus the headers it
 * could not place, so the UI can ask rather than silently dropping data.
 */
export function detectMapping(headers) {
  const mapping = {};
  const used = new Set();

  for (const [field, synonyms] of Object.entries(SYNONYMS)) {
    const idx = headers.findIndex((h, i) => !used.has(i) && synonyms.includes(canon(h)));
    if (idx !== -1) {
      mapping[field] = idx;
      used.add(idx);
    }
  }
  // Looser second pass: substring containment, for headers like
  // "Protein (g)" or "Energy (kcal)".
  for (const [field, synonyms] of Object.entries(SYNONYMS)) {
    if (mapping[field] != null) continue;
    const idx = headers.findIndex(
      (h, i) => !used.has(i) && synonyms.some((s) => canon(h).includes(s)),
    );
    if (idx !== -1) {
      mapping[field] = idx;
      used.add(idx);
    }
  }

  return {
    mapping,
    unmapped: headers.map((h, i) => ({ header: h, index: i })).filter((h) => !used.has(h.index)),
    matched: Object.keys(mapping).length,
  };
}

/* ============================================================
   DATE PARSING
   ============================================================ */

/**
 * Accepts ISO, US (M/D/YYYY), European (D/M/YYYY) and anything Date can parse.
 *
 * Ambiguity between US and European ordering is real and unresolvable per-row,
 * so the caller passes a preference and the parser is consistent about it —
 * silently guessing per row would scatter entries across the calendar.
 */
export function parseDate(value, { preferDayFirst = false } = {}) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (isValidISODate(s.slice(0, 10))) return s.slice(0, 10);

  const slash = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (slash) {
    let [, a, b, y] = slash;
    let year = Number(y);
    if (year < 100) year += year < 50 ? 2000 : 1900;
    const month = preferDayFirst ? Number(b) : Number(a);
    const day = preferDayFirst ? Number(a) : Number(b);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const parsed = new Date(s);
  return Number.isFinite(parsed.getTime()) ? toISODate(parsed) : null;
}

/* ============================================================
   IMPORT
   ============================================================ */

/**
 * @param {string} text
 * @param {Object} [options]
 * @param {Object} [options.mapping]        header index per field; auto-detected if absent
 * @param {boolean} [options.preferDayFirst]
 * @param {'kg'|'lb'} [options.weightUnit]  for an ambiguous "weight" column
 * @returns {{days: Object[], errors: Array, mapping: Object, rowsRead: number}}
 */
export function importCsv(text, options = {}) {
  const { headers, rows } = parseCsv(text);
  if (!headers.length) return { days: [], errors: [{ row: 0, message: 'Empty file.' }], mapping: {}, rowsRead: 0 };

  const detected = detectMapping(headers);
  const mapping = options.mapping ?? detected.mapping;
  const errors = [];

  if (mapping.date == null) {
    return {
      days: [],
      errors: [{ row: 0, message: `No date column found. Headers seen: ${headers.join(', ')}` }],
      mapping,
      unmapped: detected.unmapped,
      rowsRead: rows.length,
    };
  }

  const byDate = new Map();
  const num = (row, idx) => {
    if (idx == null) return null;
    const raw = row[idx];
    if (raw == null || String(raw).trim() === '') return null;
    const n = Number(String(raw).replace(/[^0-9.eE+-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  rows.forEach((row, i) => {
    const date = parseDate(row[mapping.date], { preferDayFirst: options.preferDayFirst });
    if (!date) {
      errors.push({ row: i + 2, message: `Unreadable date: "${row[mapping.date]}"` });
      return;
    }

    let weightKg = num(row, mapping.weightKg);
    const weightLb = num(row, mapping.weightLb);
    if (weightKg == null && weightLb != null) weightKg = lbToKg(weightLb);
    // An ambiguous "weight" column read as lb when the caller says so.
    if (weightKg != null && options.weightUnit === 'lb' && mapping.weightLb == null) {
      weightKg = lbToKg(weightKg);
    }

    let waterMl = num(row, mapping.waterMl);
    const waterOz = num(row, mapping.waterOz);
    if (waterMl == null && waterOz != null) waterMl = flOzToMl(waterOz);

    const exerciseKcal = num(row, mapping.exerciseKcal);
    const exerciseMinutes = num(row, mapping.exerciseMinutes);
    const exercise = [];
    if (exerciseKcal != null || exerciseMinutes != null) {
      exercise.push({
        activityId: 'custom',
        minutes: exerciseMinutes,
        wearableKcal: exerciseKcal,
        // Device "active energy" is already net of resting, which is the whole
        // reason this flag exists.
        wearableIsNet: true,
        note: 'Imported',
      });
    }

    const day = {
      date,
      weightKg,
      bodyFatPct: num(row, mapping.bodyFatPct),
      intake: {
        kcal: num(row, mapping.kcal),
        protein: num(row, mapping.protein),
        carbs: num(row, mapping.carbs),
        fat: num(row, mapping.fat),
        fiber: num(row, mapping.fiber),
        alcohol: num(row, mapping.alcohol),
      },
      steps: num(row, mapping.steps),
      sleepHours: num(row, mapping.sleepHours),
      stress: num(row, mapping.stress),
      waterMl,
      sodiumMg: num(row, mapping.sodiumMg),
      notes: mapping.notes != null ? String(row[mapping.notes] ?? '').slice(0, 500) : '',
      exercise,
    };

    // Multiple rows for one date (common when weight and nutrition come from
    // different exports) merge rather than overwrite.
    if (byDate.has(date)) {
      const prev = byDate.get(date);
      byDate.set(date, {
        ...prev,
        ...stripNulls(day),
        intake: { ...prev.intake, ...stripNulls(day.intake) },
        exercise: [...(prev.exercise || []), ...day.exercise],
      });
    } else {
      byDate.set(date, day);
    }
  });

  return {
    days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    errors,
    mapping,
    unmapped: detected.unmapped,
    rowsRead: rows.length,
  };
}

function stripNulls(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) out[k] = v;
  }
  return out;
}

/* ============================================================
   EXPORT
   ============================================================ */

const EXPORT_COLUMNS = [
  ['date', (d) => d.date],
  ['weight_kg', (d) => d.weightKg],
  ['body_fat_pct', (d) => d.bodyFatPct],
  ['calories', (d) => d.intake?.kcal],
  ['protein_g', (d) => d.intake?.protein],
  ['carbs_g', (d) => d.intake?.carbs],
  ['fat_g', (d) => d.intake?.fat],
  ['fiber_g', (d) => d.intake?.fiber],
  ['alcohol_g', (d) => d.intake?.alcohol],
  ['steps', (d) => d.steps],
  ['exercise_minutes', (d) => (d.exercise || []).reduce((s, e) => s + (e.minutes || 0), 0) || null],
  ['sleep_hours', (d) => d.sleepHours],
  ['stress', (d) => d.stress],
  ['water_ml', (d) => d.waterMl],
  ['sodium_mg', (d) => d.sodiumMg],
  ['notes', (d) => d.notes],
];

/** Round-trips through importCsv without loss. */
export function exportCsv(entries) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [EXPORT_COLUMNS.map(([h]) => h).join(',')];
  for (const day of entries) {
    lines.push(EXPORT_COLUMNS.map(([, fn]) => esc(fn(day))).join(','));
  }
  return lines.join('\n');
}

/**
 * Export the derived analytics rather than the raw log — trend weight, the
 * modelled components, the maintenance estimate per day. This is the file to
 * hand to a spreadsheet or an R session.
 */
export function exportAnalyticsCsv({ trend, maintenance }) {
  const header = [
    'date', 'weight_kg', 'adjusted_weight_kg', 'water_adjustment_kg',
    'trend_kg', 'trend_smoothed_kg', 'rate_kg_per_week', 'rate_sd_kg_per_week',
    'is_outlier', 'rolling_observed_maintenance_kcal',
  ];
  const rolling = new Map((maintenance?.observedSeries || []).map((r) => [r.date, r.kcal]));
  const lines = [header.join(',')];
  for (const d of trend?.days || []) {
    lines.push([
      d.date,
      fmt(d.weightKg), fmt(d.adjustedWeightKg), fmt(d.waterAdjustmentKg, 4),
      fmt(d.trendKg, 3), fmt(d.trendSmoothKg, 3),
      fmt(d.slopeKgPerDay * 7, 4), fmt(d.slopeSd * 7, 4),
      d.isOutlier ? '1' : '0',
      fmt(rolling.get(d.date), 0),
    ].join(','));
  }
  return lines.join('\n');
}

function fmt(v, decimals = 2) {
  return Number.isFinite(v) ? v.toFixed(decimals) : '';
}

/** Trigger a browser download without any dependency. */
export function downloadFile(filename, content, mime = 'text/csv') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
