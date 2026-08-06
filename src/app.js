/**
 * app.js — application shell.
 *
 * Owns routing, the store, and the render loop. Views are pure functions of a
 * context object; this file is the only place that knows about the DOM root,
 * the URL, or the order things happen in.
 *
 * @module app
 */

import { Store, LocalStorageAdapter } from './data/store.js';
import { analyse } from './model/engine.js';
import { toast, esc } from './ui/components.js';
import { renderDashboard, mountDashboard } from './ui/dashboardView.js';
import { renderLog, mountLog } from './ui/logView.js';
import { renderTrends, mountTrends } from './ui/trendsView.js';
import { renderSettings, mountSettings } from './ui/settingsView.js';
import { todayISO, fmtDateRelative } from './core/time.js';
import { unitSystem, fmtInt, fmtNum } from './core/units.js';
import { defaultProfile } from './data/schema.js';

/**
 * Four tabs. There were five; "Model" was a whole screen of evidence tables
 * that answered a question most people ask once. It now lives as collapsed
 * sections under You → How this works, and its projection moved to Trends,
 * where a forward-looking chart belongs.
 */
const VIEWS = {
  today: { id: 'today', label: 'Today', icon: '◍', render: renderDashboard, mount: mountDashboard },
  log: { id: 'log', label: 'Log', icon: '✎', render: renderLog, mount: mountLog },
  trends: { id: 'trends', label: 'Trends', icon: '◈', render: renderTrends, mount: mountTrends },
  you: { id: 'you', label: 'You', icon: '☺', render: renderSettings, mount: mountSettings },
};

/** Routes that existed before the tabs were consolidated. */
const VIEW_ALIASES = { settings: 'you', model: 'trends' };

const THEME_KEY = 'ember.theme';

class App {
  constructor(root) {
    this.root = root;
    this.store = null;
    this.view = 'today';
    this.focusDate = todayISO();
    /** Ephemeral per-view UI state that should survive a re-render but not a
     *  reload — chart ranges, projection slider position. */
    this.state = { trendRange: '90' };
    this.snapshot = null;
    this.rendering = false;
  }

  async start() {
    this.applyStoredTheme();

    const adapter = await this.chooseAdapter();
    this.store = new Store(adapter);
    await this.store.init();

    this.store.subscribe((_db, reason) => {
      if (reason === 'error') toast(this.store.lastError ?? 'Could not save.', 'warn');
    });

    window.addEventListener('hashchange', () => this.readRoute());
    this.readRoute();

    // Save any pending edit before the tab goes away.
    window.addEventListener('pagehide', () => this.store.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.store.flush();
    });

    this.refresh();
  }

  /** Supabase if config.js supplied credentials; otherwise this device. */
  async chooseAdapter() {
    const config = window.APP_CONFIG;
    if (config?.SUPABASE_URL && config?.SUPABASE_ANON_KEY) {
      try {
        const { SupabaseAdapter } = await import('./data/supabaseAdapter.js');
        return new SupabaseAdapter({
          supabaseUrl: config.SUPABASE_URL,
          supabaseAnonKey: config.SUPABASE_ANON_KEY,
          profileId: config.PROFILE_ID || 'default',
        });
      } catch (err) {
        console.error('[app] Supabase adapter failed to load, using local storage:', err);
      }
    }
    return new LocalStorageAdapter();
  }

  /* ---------- routing ---------- */

  readRoute() {
    const hash = location.hash.replace(/^#\/?/, '');
    const [raw, param] = hash.split('/');
    const view = VIEW_ALIASES[raw] ?? raw;
    if (VIEWS[view]) this.view = view;
    if (param && /^\d{4}-\d{2}-\d{2}$/.test(param)) this.focusDate = param;
    this.refresh();
  }

  /**
   * Remove the sample dataset and hand the profile back to the user.
   *
   * Loading the demo overwrites the profile — it has to, or the estimate would
   * be built from a stranger's body. Clearing it therefore has to restore the
   * defaults too, and re-arm the first-run prompt, otherwise the app would
   * keep quietly presenting the demo person's height and age as yours.
   */
  async clearDemo() {
    const base = defaultProfile();
    this.store.db.days = {};
    this.store.updateProfile({
      ...base,
      units: this.store.profile.units, // a unit preference is genuinely theirs
      demoLoaded: false,
      profileConfirmed: false,
    });
    await this.store.flush();
    toast('Sample data cleared. Your details are next.');
    // Set the view before touching the hash: navigate() alone routes via the
    // hashchange event, which lands a tick later and flashes the old screen.
    this.view = 'today';
    this.navigate('today');
    this.refresh();
  }

  navigate(view, param) {
    const next = param ? `#/${view}/${param}` : `#/${view}`;
    if (location.hash === next) {
      this.view = view;
      this.refresh();
    } else {
      location.hash = next;
    }
  }

  setFocusDate(date) {
    this.focusDate = date;
    if (this.view === 'log') this.navigate('log', date);
    else this.refresh();
  }

  /* ---------- theme ---------- */

  applyStoredTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    document.documentElement.dataset.theme = stored ?? (prefersLight ? 'light' : 'dark');
  }

  toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      next === 'dark' ? '#0a0908' : '#f8f5ef',
    );
    this.refresh({ keepScroll: true });
  }

  /* ---------- render ---------- */

  get context() {
    return {
      store: this.store,
      profile: this.store.profile,
      snapshot: this.snapshot,
      focusDate: this.focusDate,
      state: this.state,
      refresh: (options) => this.refresh(options),
      setFocusDate: (date) => this.setFocusDate(date),
      navigate: (view, param) => this.navigate(view, param),
      clearDemo: () => this.clearDemo(),
    };
  }

  refresh(options = {}) {
    // Re-entrancy guard: a view's mount handler calling refresh() during the
    // render that created it would otherwise recurse.
    if (this.rendering) return;
    this.rendering = true;

    const scroll = options.keepScroll ? window.scrollY : 0;
    const activeName = options.keepScroll ? document.activeElement?.name : null;
    const selectionStart = document.activeElement?.selectionStart;

    try {
      this.snapshot = analyse(this.store.entries, this.store.profile, this.focusDate);
      const view = VIEWS[this.view] ?? VIEWS.today;
      const ctx = this.context;

      this.root.innerHTML = `
        ${this.renderHeader(ctx)}
        <main class="main" id="main">${view.render(ctx)}</main>
        ${this.renderNav()}
      `;

      this.wireShell();

      // Views mount against #main, never against #app. #app survives every
      // render, so a delegated listener attached there would accumulate one
      // copy per render — and a single click would fire N times.
      view.mount?.(this.root.querySelector('#main'), ctx);

      if (options.keepScroll) {
        window.scrollTo(0, scroll);
        if (activeName) {
          const restored = this.root.querySelector(`[name="${CSS.escape(activeName)}"]`);
          if (restored && typeof restored.focus === 'function') {
            restored.focus({ preventScroll: true });
            if (selectionStart != null && restored.setSelectionRange && restored.type !== 'number') {
              try { restored.setSelectionRange(selectionStart, selectionStart); } catch { /* unsupported type */ }
            }
          }
        }
      }
    } catch (err) {
      console.error('[app] render failed:', err);
      this.root.innerHTML = `
        <main class="main">
          <section class="card">
            <h2 class="card__title">Something broke while rendering</h2>
            <p class="muted">${esc(err.message)}</p>
            <pre class="trace">${esc(err.stack ?? '')}</pre>
            <p class="muted">Your data is safe — it is stored separately from the view. Reloading usually clears this.</p>
          </section>
        </main>`;
    } finally {
      this.rendering = false;
    }
  }

  renderHeader(ctx) {
    const u = unitSystem(ctx.profile.units);
    const s = ctx.snapshot?.summary;
    const isDark = document.documentElement.dataset.theme === 'dark';

    const strip = s && Number.isFinite(s.trendKg)
      ? `<div class="topline">
           <span><b class="num">${fmtNum(u.mass(s.trendKg), 1)}</b> ${esc(u.massLabel)}</span>
           <span class="topline__sep"></span>
           <span class="${s.weeklyRateKg < 0 ? 'neg' : s.weeklyRateKg > 0 ? 'pos' : ''}">
             <b class="num">${s.weeklyRateKg >= 0 ? '+' : '−'}${fmtNum(Math.abs(u.mass(s.weeklyRateKg)), 2)}</b> ${esc(u.massLabel)}/wk
           </span>
           ${Number.isFinite(s.maintenanceKcal) ? `<span class="topline__sep"></span>
             <span><b class="num">${fmtInt(s.maintenanceKcal)}</b> kcal</span>` : ''}
         </div>`
      : '';

    return `
      <header class="topbar">
        <div class="topbar__row">
          <div class="brand">
            <span class="brand__mark">E</span>
            <span class="brand__name">Ember</span>
          </div>
          <button class="iconbtn" data-toggle-theme aria-label="Switch theme">${isDark ? '☀' : '☾'}</button>
        </div>
        ${strip}
      </header>`;
  }

  renderNav() {
    const items = Object.values(VIEWS)
      .map(
        (v) => `
        <button class="navbtn${v.id === this.view ? ' is-active' : ''}" data-view="${v.id}">
          <span class="navbtn__icon" aria-hidden="true">${v.icon}</span>
          <span class="navbtn__label">${esc(v.label)}</span>
        </button>`,
      )
      .join('');
    return `<nav class="nav" aria-label="Sections">${items}</nav>`;
  }

  wireShell() {
    this.root.querySelector('[data-toggle-theme]')?.addEventListener('click', () => this.toggleTheme());
    for (const btn of this.root.querySelectorAll('[data-view]')) {
      btn.addEventListener('click', () => this.navigate(btn.dataset.view, btn.dataset.view === 'log' ? this.focusDate : null));
    }
  }
}

/* ============================================================
   BOOT
   ============================================================ */

const app = new App(document.getElementById('app'));
app.start().catch((err) => {
  console.error('[app] failed to start:', err);
  document.getElementById('app').innerHTML =
    `<main class="main"><section class="card"><h2 class="card__title">Could not start</h2>
     <p class="muted">${esc(err.message)}</p></section></main>`;
});

// Exposed for debugging from the console; not part of any public interface.
window.__ember = app;
