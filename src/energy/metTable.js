/**
 * metTable.js — activity catalogue with MET values.
 *
 * MET values follow the 2011 Compendium of Physical Activities:
 *   Ainsworth BE, et al. Med Sci Sports Exerc. 2011;43(8):1575-1581.
 *
 * Each activity declares a MET *range* rather than a point value, because
 * "cycling" spanning 4 to 16 METs is the single largest source of error in
 * MET-based estimation. RPE (rating of perceived exertion, Borg CR10) maps the
 * session onto that range; where distance and duration are both known, a
 * speed-based equation supersedes the table entirely.
 *
 * @module energy/metTable
 */

/**
 * @typedef {Object} Activity
 * @property {string} id
 * @property {string} label
 * @property {string} group
 * @property {number} metLow      MET at RPE 1
 * @property {number} metTypical  MET at RPE ~5, used when RPE is absent
 * @property {number} metHigh     MET at RPE 10
 * @property {'walk'|'run'|'cycle'|null} speedModel  enables distance-based costing
 * @property {boolean} producesSteps  whether a wrist/phone tracker counts steps
 * @property {string} [note]
 */

/** @type {Record<string, Activity>} */
export const ACTIVITIES = {
  weights: {
    id: 'weights',
    label: 'Weight lifting',
    group: 'Strength',
    metLow: 3.0,
    metTypical: 4.5,
    metHigh: 6.0,
    speedModel: null,
    producesSteps: false,
    note:
      'Compendium: 3.5 METs light-to-moderate, 6.0 METs vigorous. Note that ' +
      'the MET value applies to the whole session including rest between sets, ' +
      'so log total gym time, not time under tension. Resistance training also ' +
      'raises post-exercise expenditure (EPOC) by roughly 5–10% of session ' +
      'cost, which is small and is left out here rather than guessed at.',
  },
  circuit: {
    id: 'circuit',
    label: 'Circuit training',
    group: 'Strength',
    metLow: 4.0,
    metTypical: 7.0,
    metHigh: 9.0,
    speedModel: null,
    producesSteps: false,
  },
  hiit: {
    id: 'hiit',
    label: 'HIIT',
    group: 'Conditioning',
    metLow: 6.0,
    metTypical: 9.0,
    metHigh: 12.0,
    speedModel: null,
    producesSteps: false,
    note:
      'MET tables handle intervals poorly: the average intensity over a session ' +
      'that alternates 12 METs and standing rest is not a stable number. If you ' +
      'have average heart rate for the session, that estimate is materially ' +
      'better than this one.',
  },
  running: {
    id: 'running',
    label: 'Running',
    group: 'Endurance',
    metLow: 6.0,
    metTypical: 9.8,
    metHigh: 16.0,
    speedModel: 'run',
    producesSteps: true,
  },
  walking: {
    id: 'walking',
    label: 'Walking',
    group: 'Endurance',
    metLow: 2.0,
    metTypical: 3.5,
    metHigh: 6.3,
    speedModel: 'walk',
    producesSteps: true,
  },
  hiking: {
    id: 'hiking',
    label: 'Hiking',
    group: 'Endurance',
    metLow: 4.0,
    metTypical: 6.0,
    metHigh: 8.5,
    speedModel: null,
    producesSteps: true,
    note: 'Elevation dominates; the Compendium value assumes rolling terrain.',
  },
  cycling: {
    id: 'cycling',
    label: 'Cycling',
    group: 'Endurance',
    metLow: 4.0,
    metTypical: 8.0,
    metHigh: 15.8,
    speedModel: 'cycle',
    producesSteps: false,
  },
  swimming: {
    id: 'swimming',
    label: 'Swimming',
    group: 'Endurance',
    metLow: 4.5,
    metTypical: 7.0,
    metHigh: 11.0,
    speedModel: null,
    producesSteps: false,
    note:
      'Wrist trackers are unreliable in water and heart rate runs lower in the ' +
      'horizontal position for the same oxygen cost — prefer the MET estimate ' +
      'here over a wearable number unless the device is swim-specific.',
  },
  rowing: {
    id: 'rowing',
    label: 'Rowing',
    group: 'Endurance',
    metLow: 4.8,
    metTypical: 7.0,
    metHigh: 12.0,
    speedModel: null,
    producesSteps: false,
  },
  soccer: {
    id: 'soccer',
    label: 'Soccer',
    group: 'Sport',
    metLow: 5.0,
    metTypical: 7.0,
    metHigh: 10.0,
    speedModel: null,
    producesSteps: true,
    note: 'Compendium: 7.0 METs casual, 10.0 METs competitive.',
  },
  basketball: {
    id: 'basketball',
    label: 'Basketball',
    group: 'Sport',
    metLow: 4.5,
    metTypical: 6.5,
    metHigh: 9.3,
    speedModel: null,
    producesSteps: true,
    note: 'Compendium: 6.5 METs general, 8.0 game, 4.5 shooting around.',
  },
  tennis: {
    id: 'tennis',
    label: 'Tennis',
    group: 'Sport',
    metLow: 4.5,
    metTypical: 7.3,
    metHigh: 9.0,
    speedModel: null,
    producesSteps: true,
  },
  boxing: {
    id: 'boxing',
    label: 'Boxing / martial arts',
    group: 'Sport',
    metLow: 5.5,
    metTypical: 8.5,
    metHigh: 12.8,
    speedModel: null,
    producesSteps: false,
  },
  elliptical: {
    id: 'elliptical',
    label: 'Elliptical / stair climber',
    group: 'Conditioning',
    metLow: 4.6,
    metTypical: 6.5,
    metHigh: 9.0,
    speedModel: null,
    producesSteps: false,
  },
  yoga: {
    id: 'yoga',
    label: 'Yoga / mobility',
    group: 'Recovery',
    metLow: 2.0,
    metTypical: 3.0,
    metHigh: 4.5,
    speedModel: null,
    producesSteps: false,
  },
  custom: {
    id: 'custom',
    label: 'Custom activity',
    group: 'Other',
    metLow: 2.0,
    metTypical: 5.0,
    metHigh: 10.0,
    speedModel: null,
    producesSteps: false,
    note: 'Set the MET value by hand, or log wearable calories directly.',
  },
};

export const ACTIVITY_IDS = Object.keys(ACTIVITIES);

/** Activities grouped for a <select> with <optgroup>. */
export function activityGroups() {
  const groups = new Map();
  for (const id of ACTIVITY_IDS) {
    const a = ACTIVITIES[id];
    if (!groups.has(a.group)) groups.set(a.group, []);
    groups.get(a.group).push(a);
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }));
}

/**
 * Interpolate a MET value from RPE on the Borg CR10 scale.
 * RPE 5 is pinned to the activity's typical value, with the low and high ends
 * anchoring RPE 1 and RPE 10, so the mapping is piecewise linear rather than a
 * straight line across the full range.
 *
 * @param {Activity} activity
 * @param {number|null} rpe  1–10
 */
export function metFromRpe(activity, rpe) {
  if (rpe == null || !Number.isFinite(rpe)) return activity.metTypical;
  const r = Math.min(10, Math.max(1, rpe));
  if (r <= 5) {
    const t = (r - 1) / 4;
    return activity.metLow + t * (activity.metTypical - activity.metLow);
  }
  const t = (r - 5) / 5;
  return activity.metTypical + t * (activity.metHigh - activity.metTypical);
}

/* ============================================================
   SPEED-BASED MET (supersedes the table when distance is known)
   ============================================================ */

/**
 * ACSM metabolic equations, expressed as METs.
 *   Walking: VO2 = 0.1·S + 3.5          (S in m·min⁻¹, valid 50–100 m/min)
 *   Running: VO2 = 0.2·S + 3.5          (valid ≥134 m/min, and ≥80 if jogging)
 * Cycling has no comparable speed equation without power data, so it uses a
 * Compendium speed-bracket lookup.
 *
 * @param {'walk'|'run'|'cycle'} model
 * @param {number} speedKmh
 * @returns {number|null} METs
 */
export function metFromSpeed(model, speedKmh) {
  if (!Number.isFinite(speedKmh) || speedKmh <= 0) return null;
  const mPerMin = (speedKmh * 1000) / 60;

  if (model === 'walk') return (0.1 * mPerMin + 3.5) / 3.5;
  if (model === 'run') return (0.2 * mPerMin + 3.5) / 3.5;

  if (model === 'cycle') {
    // Compendium 01010–01080 speed brackets, km/h.
    if (speedKmh < 16) return 4.0;
    if (speedKmh < 19.2) return 6.8;
    if (speedKmh < 22.4) return 8.0;
    if (speedKmh < 25.6) return 10.0;
    if (speedKmh < 30.6) return 12.0;
    return 15.8;
  }
  return null;
}

/**
 * Walking and running overlap between roughly 7 and 8 km/h, where the ACSM
 * walking equation stops being valid. Pick the model that matches the gait
 * the user selected, but guard the walking equation above its valid range.
 */
export function speedModelIsValid(model, speedKmh) {
  if (model === 'walk') return speedKmh >= 2.4 && speedKmh <= 8.0;
  if (model === 'run') return speedKmh >= 4.8 && speedKmh <= 25;
  if (model === 'cycle') return speedKmh >= 5 && speedKmh <= 50;
  return false;
}
