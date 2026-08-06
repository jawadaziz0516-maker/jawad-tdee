/**
 * store.js — persistence and application state.
 *
 * Storage sits behind an adapter interface with exactly four methods, so
 * swapping localStorage for Supabase (or IndexedDB, or a file) touches nothing
 * outside this file. The Supabase adapter in supabaseAdapter.js implements the
 * same contract and is a drop-in once credentials exist.
 *
 *   interface StorageAdapter {
 *     load(): Promise<object|null>
 *     save(db: object): Promise<void>
 *     clear(): Promise<void>
 *     readonly name: string
 *   }
 *
 * The store is the single source of truth. Views subscribe; nothing mutates
 * state directly.
 *
 * @module data/store
 */

import { emptyDatabase, migrate, normaliseDay, normaliseProfile, emptyDay, isDayEmpty, STORAGE_KEY } from './schema.js';
import { todayISO } from '../core/time.js';

/* ============================================================
   ADAPTERS
   ============================================================ */

export class LocalStorageAdapter {
  constructor(key = STORAGE_KEY) {
    this.key = key;
    this.name = 'This device';
  }

  async load() {
    try {
      const raw = localStorage.getItem(this.key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.error('[store] Could not read local storage:', err);
      return null;
    }
  }

  async save(db) {
    try {
      localStorage.setItem(this.key, JSON.stringify(db));
    } catch (err) {
      // QuotaExceededError is the realistic failure here. Surfacing it matters:
      // silently failing to save a day of logging is the worst outcome.
      console.error('[store] Could not write local storage:', err);
      throw new Error('Could not save — device storage may be full.');
    }
  }

  async clear() {
    localStorage.removeItem(this.key);
  }
}

/** In-memory adapter, for tests and for the demo dataset. */
export class MemoryAdapter {
  constructor(initial = null) {
    this.db = initial;
    this.name = 'Memory';
  }
  async load() { return this.db; }
  async save(db) { this.db = JSON.parse(JSON.stringify(db)); }
  async clear() { this.db = null; }
}

/* ============================================================
   STORE
   ============================================================ */

export class Store {
  /**
   * @param {{load:Function, save:Function, clear:Function, name:string}} adapter
   */
  constructor(adapter = new LocalStorageAdapter()) {
    this.adapter = adapter;
    this.db = emptyDatabase();
    this.listeners = new Set();
    this.saveTimer = null;
    this.lastError = null;
  }

  /* ---------- lifecycle ---------- */

  async init() {
    const raw = await this.adapter.load();
    this.db = migrate(raw ?? emptyDatabase());
    this.emit('init');
    return this.db;
  }

  /** Debounced write — form typing should not hammer storage. */
  scheduleSave(delay = 400) {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), delay);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    this.db.updatedAt = new Date().toISOString();
    try {
      await this.adapter.save(this.db);
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      this.emit('error');
    }
  }

  /* ---------- subscription ---------- */

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(reason = 'change') {
    for (const fn of this.listeners) {
      try {
        fn(this.db, reason);
      } catch (err) {
        console.error('[store] listener threw:', err);
      }
    }
  }

  /* ---------- reads ---------- */

  get profile() {
    return this.db.profile;
  }

  /** All days, ascending by date. */
  get entries() {
    return Object.values(this.db.days).sort((a, b) => a.date.localeCompare(b.date));
  }

  getDay(date) {
    return this.db.days[date] ?? null;
  }

  /** The day record for `date`, creating a blank one if it does not exist.
   *  Not persisted until something is written to it. */
  getOrCreateDay(date = todayISO()) {
    return this.db.days[date] ?? emptyDay(date);
  }

  get dateRange() {
    const dates = Object.keys(this.db.days).sort();
    return dates.length ? { first: dates[0], last: dates[dates.length - 1], count: dates.length } : null;
  }

  /* ---------- writes ---------- */

  updateProfile(patch) {
    this.db.profile = normaliseProfile({ ...this.db.profile, ...patch });
    this.scheduleSave();
    this.emit('profile');
    return this.db.profile;
  }

  /**
   * Merge a patch into a day. Nested `intake` is merged rather than replaced,
   * so a form that only knows about protein cannot wipe the calorie field.
   */
  updateDay(date, patch) {
    const existing = this.db.days[date] ?? emptyDay(date);
    const merged = {
      ...existing,
      ...patch,
      date,
      intake: { ...existing.intake, ...(patch.intake || {}) },
      updatedAt: new Date().toISOString(),
    };
    const normalised = normaliseDay(merged);
    if (!normalised) return null;

    if (isDayEmpty(normalised)) {
      delete this.db.days[date];
    } else {
      this.db.days[date] = normalised;
    }
    this.scheduleSave();
    this.emit('day');
    return this.db.days[date] ?? null;
  }

  deleteDay(date) {
    delete this.db.days[date];
    this.scheduleSave();
    this.emit('day');
  }

  /** Bulk upsert — used by CSV import and the demo generator. */
  upsertDays(days, { replace = false } = {}) {
    if (replace) this.db.days = {};
    let imported = 0;
    let skipped = 0;
    for (const raw of days) {
      const existing = this.db.days[raw.date];
      const merged = existing
        ? { ...existing, ...raw, intake: { ...existing.intake, ...(raw.intake || {}) } }
        : raw;
      const n = normaliseDay(merged);
      if (n && !isDayEmpty(n)) {
        this.db.days[n.date] = n;
        imported += 1;
      } else {
        skipped += 1;
      }
    }
    this.scheduleSave(0);
    this.emit('import');
    return { imported, skipped };
  }

  async reset() {
    this.db = emptyDatabase();
    await this.adapter.clear();
    await this.flush();
    this.emit('reset');
  }

  /* ---------- portability ---------- */

  /** Full backup, including settings. */
  exportJson() {
    return JSON.stringify(this.db, null, 2);
  }

  async importJson(text, { replace = true } = {}) {
    const parsed = JSON.parse(text);
    const migrated = migrate(parsed);
    if (replace) {
      this.db = migrated;
    } else {
      this.db.profile = migrated.profile;
      this.upsertDays(Object.values(migrated.days));
    }
    await this.flush();
    this.emit('import');
    return { days: Object.keys(migrated.days).length };
  }
}

/**
 * Adapter selection. Local storage is the default because it needs no account
 * and works offline; the Supabase path is opt-in and additive.
 */
export function createAdapter(config = {}) {
  if (config.supabaseUrl && config.supabaseAnonKey) {
    // Lazily imported so the Supabase client is never fetched unless configured.
    return import('./supabaseAdapter.js').then((m) => new m.SupabaseAdapter(config));
  }
  return Promise.resolve(new LocalStorageAdapter());
}
