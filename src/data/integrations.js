/**
 * integrations.js — the extension point for external data sources.
 *
 * No provider is implemented here, and that is deliberate: every one of them
 * needs either an OAuth client secret (which cannot live in a static site) or
 * a native shell (Apple Health). What this file provides is the contract they
 * will implement, so adding one later is a new file plus a registry entry
 * rather than a refactor.
 *
 *   interface Provider {
 *     id, label, status, capabilities[], docsUrl, notes
 *     connect(config): Promise<Session>
 *     fetchRange(session, startISO, endISO): Promise<RawRecord[]>
 *     normalise(raw): PartialDay[]      // → the schema.js day shape
 *   }
 *
 * `normalise` is the important half. Every provider disagrees about units,
 * timezones and what "active calories" means; the contract is that whatever
 * comes out of `normalise` is already in the app's internal representation
 * (kg, kcal, ISO local dates, exercise net of resting metabolism).
 *
 * @module data/integrations
 */

/**
 * @typedef {'available'|'planned'|'needsNativeShell'|'needsServer'} ProviderStatus
 */

export const PROVIDERS = {
  csv: {
    id: 'csv',
    label: 'CSV import',
    status: 'available',
    capabilities: ['weight', 'nutrition', 'steps', 'sleep', 'exercise'],
    notes:
      'Column-mapped import that already handles MyFitnessPal, Cronometer, ' +
      'Withings and Renpho exports. The universal fallback: every service ' +
      'below can export CSV today.',
    docsUrl: null,
  },
  appleHealth: {
    id: 'appleHealth',
    label: 'Apple Health',
    status: 'needsNativeShell',
    capabilities: ['weight', 'steps', 'workouts', 'sleep', 'activeEnergy', 'bodyFat'],
    notes:
      'HealthKit has no web API — reading it requires a native iOS container ' +
      'or a bridge app such as Health Auto Export writing to a shared folder. ' +
      'Until then, Health Auto Export → CSV covers the same ground.',
    docsUrl: 'https://developer.apple.com/documentation/healthkit',
  },
  googleFit: {
    id: 'googleFit',
    label: 'Google Fit / Health Connect',
    status: 'needsServer',
    capabilities: ['weight', 'steps', 'workouts', 'activeEnergy'],
    notes:
      'Google deprecated the Fit REST API in favour of Health Connect, which ' +
      'is Android-local. Either path needs an OAuth exchange that cannot be ' +
      'done from a static page without exposing a client secret.',
    docsUrl: 'https://developer.android.com/health-and-fitness/guides/health-connect',
  },
  garmin: {
    id: 'garmin',
    label: 'Garmin Connect',
    status: 'needsServer',
    capabilities: ['weight', 'steps', 'workouts', 'sleep', 'stress', 'heartRate'],
    notes:
      'The Health API requires partner approval and server-side OAuth 1.0a. ' +
      'Garmin’s own export produces CSV that imports today.',
    docsUrl: 'https://developer.garmin.com/gc-developer-program/health-api/',
  },
  fitbit: {
    id: 'fitbit',
    label: 'Fitbit',
    status: 'needsServer',
    capabilities: ['weight', 'steps', 'workouts', 'sleep', 'activeEnergy'],
    notes:
      'Web API with OAuth 2.0 PKCE, which a static page can *almost* do — the ' +
      'token refresh still wants a server. The most tractable of the wearables.',
    docsUrl: 'https://dev.fitbit.com/build/reference/web-api/',
  },
  whoop: {
    id: 'whoop',
    label: 'WHOOP',
    status: 'needsServer',
    capabilities: ['workouts', 'sleep', 'strain', 'heartRate'],
    notes:
      'Reports strain rather than calories directly; its day-level energy ' +
      'figure would need mapping onto the EAT/NEAT split this app maintains, ' +
      'rather than being trusted wholesale.',
    docsUrl: 'https://developer.whoop.com/',
  },
  cronometer: {
    id: 'cronometer',
    label: 'Cronometer',
    status: 'needsServer',
    capabilities: ['nutrition', 'weight'],
    notes:
      'The best nutrition data available — full micronutrients and honest ' +
      'fibre handling. Its daily-summary CSV export maps cleanly onto the ' +
      'importer today.',
    docsUrl: 'https://cronometer.com/',
  },
  myFitnessPal: {
    id: 'myFitnessPal',
    label: 'MyFitnessPal',
    status: 'needsServer',
    capabilities: ['nutrition', 'weight', 'exercise'],
    notes:
      'Public API access has been closed to new applications for years. CSV ' +
      'export from a Premium account is the practical route.',
    docsUrl: null,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/** Everything that can actually move data today. */
export function availableProviders() {
  return PROVIDER_IDS.map((id) => PROVIDERS[id]).filter((p) => p.status === 'available');
}

/**
 * Register a provider implementation at runtime. Kept as a mutable registry so
 * a future module can add itself without this file knowing it exists.
 */
const implementations = new Map();

export function registerProvider(id, implementation) {
  if (!PROVIDERS[id]) {
    throw new Error(`Unknown provider "${id}" — add a descriptor to PROVIDERS first.`);
  }
  const required = ['connect', 'fetchRange', 'normalise'];
  for (const method of required) {
    if (typeof implementation[method] !== 'function') {
      throw new Error(`Provider "${id}" is missing ${method}().`);
    }
  }
  implementations.set(id, implementation);
  PROVIDERS[id].status = 'available';
}

export function getProvider(id) {
  return implementations.get(id) ?? null;
}

/**
 * Merge imported partial days into existing records without clobbering.
 *
 * The precedence rule matters and is worth stating: a value the user typed
 * beats a value a device inferred. Someone who corrects their weight by hand
 * should not have the next sync overwrite it.
 *
 * @param {Object} existing
 * @param {Object} incoming
 * @param {{preferExisting?: boolean}} [options]
 */
export function mergeDay(existing, incoming, options = {}) {
  const { preferExisting = true } = options;
  if (!existing) return incoming;
  if (!incoming) return existing;

  const pick = (a, b) => {
    if (preferExisting) return a != null ? a : b;
    return b != null ? b : a;
  };

  return {
    ...existing,
    ...incoming,
    date: existing.date,
    weightKg: pick(existing.weightKg, incoming.weightKg),
    bodyFatPct: pick(existing.bodyFatPct, incoming.bodyFatPct),
    steps: pick(existing.steps, incoming.steps),
    sleepHours: pick(existing.sleepHours, incoming.sleepHours),
    sodiumMg: pick(existing.sodiumMg, incoming.sodiumMg),
    waterMl: pick(existing.waterMl, incoming.waterMl),
    stress: pick(existing.stress, incoming.stress),
    intake: {
      kcal: pick(existing.intake?.kcal, incoming.intake?.kcal),
      protein: pick(existing.intake?.protein, incoming.intake?.protein),
      carbs: pick(existing.intake?.carbs, incoming.intake?.carbs),
      fat: pick(existing.intake?.fat, incoming.intake?.fat),
      fiber: pick(existing.intake?.fiber, incoming.intake?.fiber),
      alcohol: pick(existing.intake?.alcohol, incoming.intake?.alcohol),
    },
    // Exercise is additive, de-duplicated on activity + duration so a repeated
    // sync does not double the day's training.
    exercise: dedupeExercise([...(existing.exercise || []), ...(incoming.exercise || [])]),
    notes: existing.notes || incoming.notes || '',
  };
}

function dedupeExercise(list) {
  const seen = new Set();
  const out = [];
  for (const e of list) {
    const key = `${e.activityId}|${e.minutes}|${e.distanceKm ?? ''}|${e.wearableKcal ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
