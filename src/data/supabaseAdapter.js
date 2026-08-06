/**
 * supabaseAdapter.js — optional cloud sync.
 *
 * Implements the same four-method contract as LocalStorageAdapter, using plain
 * `fetch` against Supabase's PostgREST endpoint. No SDK, no bundler, no script
 * tag — the whole client is the forty lines below, which keeps the app a
 * single static directory with zero dependencies.
 *
 * ENABLING IT
 *   1. Run schema.sql in the Supabase SQL editor.
 *   2. Create config.js next to index.html:
 *        window.APP_CONFIG = {
 *          SUPABASE_URL: "https://xxxx.supabase.co",
 *          SUPABASE_ANON_KEY: "...",
 *          PROFILE_ID: "jawad",
 *        };
 *   3. Reload. The store picks it up automatically via createAdapter().
 *
 * The anon key is designed to be public; the row-level security policies in
 * schema.sql are what actually constrain access. Read that file before putting
 * anything sensitive in here.
 *
 * @module data/supabaseAdapter
 */

export class SupabaseAdapter {
  /**
   * @param {{supabaseUrl: string, supabaseAnonKey: string, profileId?: string, table?: string}} config
   */
  constructor(config) {
    this.url = String(config.supabaseUrl).replace(/\/$/, '');
    this.key = config.supabaseAnonKey;
    this.profileId = config.profileId || 'default';
    this.table = config.table || 'tdee_state';
    this.name = 'Supabase';
    this.online = true;
    /** Local mirror, so a network failure degrades to offline rather than to
     *  data loss. Every successful save also writes here. */
    this.fallbackKey = `ember.tdee.mirror.${this.profileId}`;
  }

  get headers() {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    };
  }

  get endpoint() {
    return `${this.url}/rest/v1/${this.table}`;
  }

  async load() {
    try {
      const res = await fetch(
        `${this.endpoint}?profile_id=eq.${encodeURIComponent(this.profileId)}&select=data,updated_at`,
        { headers: this.headers },
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const rows = await res.json();
      this.online = true;
      const remote = rows?.[0]?.data ?? null;
      if (remote) this.#mirror(remote);
      return remote ?? this.#readMirror();
    } catch (err) {
      console.warn('[supabase] load failed, falling back to local mirror:', err.message);
      this.online = false;
      return this.#readMirror();
    }
  }

  async save(db) {
    this.#mirror(db);
    try {
      const res = await fetch(`${this.endpoint}?on_conflict=profile_id`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify([
          { profile_id: this.profileId, data: db, updated_at: new Date().toISOString() },
        ]),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      this.online = true;
    } catch (err) {
      this.online = false;
      // Not fatal: the mirror already holds the data, so the next successful
      // save carries it up. Surfaced so the UI can show a sync indicator.
      console.warn('[supabase] save failed, kept locally:', err.message);
      throw new Error('Saved on this device — cloud sync is unreachable.');
    }
  }

  async clear() {
    localStorage.removeItem(this.fallbackKey);
    try {
      await fetch(`${this.endpoint}?profile_id=eq.${encodeURIComponent(this.profileId)}`, {
        method: 'DELETE',
        headers: this.headers,
      });
    } catch (err) {
      console.warn('[supabase] clear failed:', err.message);
    }
  }

  #mirror(db) {
    try {
      localStorage.setItem(this.fallbackKey, JSON.stringify(db));
    } catch { /* quota — the remote copy is authoritative anyway */ }
  }

  #readMirror() {
    try {
      const raw = localStorage.getItem(this.fallbackKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}
