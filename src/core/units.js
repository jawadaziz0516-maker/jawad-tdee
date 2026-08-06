/**
 * units.js — unit conversion and display formatting.
 *
 * All internal computation is metric (kg, cm, km, mL, kcal). Conversion to the
 * user's preferred display units happens only at the UI boundary.
 *
 * @module core/units
 */

import { KG_PER_LB, LB_PER_KG, CM_PER_IN, KM_PER_MILE, ML_PER_FL_OZ } from './constants.js';

/* ---------- mass ---------- */

export const lbToKg = (lb) => lb * KG_PER_LB;
export const kgToLb = (kg) => kg * LB_PER_KG;

/* ---------- length ---------- */

export const inToCm = (inches) => inches * CM_PER_IN;
export const cmToIn = (cm) => cm / CM_PER_IN;
export const milesToKm = (mi) => mi * KM_PER_MILE;
export const kmToMiles = (km) => km / KM_PER_MILE;

/* ---------- volume ---------- */

export const flOzToMl = (oz) => oz * ML_PER_FL_OZ;
export const mlToFlOz = (ml) => ml / ML_PER_FL_OZ;

/* ---------- feet/inches helpers ---------- */

export function feetInchesToCm(feet, inches) {
  return inToCm(Number(feet || 0) * 12 + Number(inches || 0));
}

export function cmToFeetInches(cm) {
  const totalIn = cmToIn(cm);
  const feet = Math.floor(totalIn / 12);
  return { feet, inches: Math.round((totalIn - feet * 12) * 10) / 10 };
}

/* ============================================================
   UNIT SYSTEM ADAPTER
   ============================================================
   The UI asks this adapter for labels and conversions rather than branching
   on `settings.units` at every call site. */

/**
 * @param {'metric'|'imperial'} system
 */
export function unitSystem(system) {
  const imperial = system === 'imperial';
  return {
    system,
    imperial,
    massLabel: imperial ? 'lb' : 'kg',
    lengthLabel: imperial ? 'in' : 'cm',
    distanceLabel: imperial ? 'mi' : 'km',
    volumeLabel: imperial ? 'fl oz' : 'mL',

    /** Internal kg → display number. */
    mass: (kg) => (kg == null ? null : imperial ? kgToLb(kg) : kg),
    /** Display number → internal kg. */
    massIn: (v) => (v == null ? null : imperial ? lbToKg(v) : v),

    length: (cm) => (cm == null ? null : imperial ? cmToIn(cm) : cm),
    lengthIn: (v) => (v == null ? null : imperial ? inToCm(v) : v),

    distance: (km) => (km == null ? null : imperial ? kmToMiles(km) : km),
    distanceIn: (v) => (v == null ? null : imperial ? milesToKm(v) : v),

    volume: (ml) => (ml == null ? null : imperial ? mlToFlOz(ml) : ml),
    volumeIn: (v) => (v == null ? null : imperial ? flOzToMl(v) : v),
  };
}

/* ============================================================
   FORMATTING
   ============================================================ */

/**
 * Round to a fixed number of decimals, returning a Number (not a string).
 */
export function round(value, decimals = 0) {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Integer with thousands separators — for kcal, steps. */
export function fmtInt(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

/** Fixed-decimal number, em-dash for missing. */
export function fmtNum(value, decimals = 1) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Always-signed number, e.g. "+312" / "−148" (true minus sign). */
export function fmtSigned(value, decimals = 0) {
  if (value == null || !Number.isFinite(value)) return '—';
  const rounded = round(value, decimals);
  const body = Math.abs(rounded).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  if (rounded > 0) return `+${body}`;
  if (rounded < 0) return `−${body}`;
  return decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0';
}

/** Percentage from a fraction: 0.153 → "15.3%" */
export function fmtPct(fraction, decimals = 1) {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return `${fmtNum(fraction * 100, decimals)}%`;
}

/** Minutes → "1h 15m" */
export function fmtDuration(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
