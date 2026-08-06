/**
 * charts.js — SVG chart primitives.
 *
 * Hand-rolled rather than a charting library, for three reasons: the app ships
 * as static files with no build step and no CDN dependency; the charts need to
 * render confidence bands and down-weighted outliers, which most small
 * libraries do not do natively; and colours come from CSS custom properties so
 * light and dark themes work without re-rendering.
 *
 * Charts are drawn in a fixed viewBox coordinate space and scaled by CSS, so
 * they are responsive without a resize observer.
 *
 * @module ui/charts
 */

import { esc } from './components.js';
import { fmtInt, fmtNum } from '../core/units.js';
import { fromISODate } from '../core/time.js';

/* ============================================================
   SCALES & TICKS
   ============================================================ */

/** Human-friendly tick values covering [min, max]. */
export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const rawStep = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  const step = (normalised >= 7.5 ? 10 : normalised >= 3.5 ? 5 : normalised >= 1.5 ? 2 : 1) * magnitude;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.001; v += step) {
    ticks.push(Math.round(v / step) * step);
  }
  return ticks;
}

function extent(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Number.isFinite(lo) ? [lo, hi] : [0, 1];
}

/* ============================================================
   LINE / AREA / SCATTER CHART
   ============================================================ */

/**
 * @typedef {Object} Series
 * @property {string} id
 * @property {string} label
 * @property {'line'|'scatter'|'area'|'step'} [type]
 * @property {Array<{x:number, y:number, flagged?:boolean}>} data
 * @property {string} [color]    any CSS colour, usually a var()
 * @property {number} [width]
 * @property {string} [dash]
 * @property {number} [radius]   scatter only
 * @property {number} [opacity]
 *
 * @param {Object} config
 * @param {Series[]} config.series
 * @param {Array<{id:string, data:Array<{x:number, lower:number, upper:number}>, color?:string, opacity?:number}>} [config.bands]
 * @param {Array<{y:number, label?:string, color?:string, dash?:string}>} [config.rules]
 * @param {Array<{x:number, label:string}>} [config.xTicks]
 * @param {[number,number]} [config.yDomain]
 * @param {[number,number]} [config.xDomain]
 * @param {(v:number)=>string} [config.yFormat]
 * @param {number} [config.height]
 * @param {string} [config.title]
 * @returns {string} SVG markup
 */
export function lineChart(config) {
  const {
    series = [],
    bands = [],
    rules = [],
    xTicks = [],
    yFormat = (v) => fmtNum(v, 0),
    height = 300,
    width = 860,
    padding = { top: 16, right: 16, bottom: 30, left: 52 },
    title = '',
    yTickCount = 5,
    zeroBaseline = false,
  } = config;

  const allX = [];
  const allY = [];
  for (const s of series) {
    for (const p of s.data || []) {
      if (Number.isFinite(p.x)) allX.push(p.x);
      if (Number.isFinite(p.y)) allY.push(p.y);
    }
  }
  for (const b of bands) {
    for (const p of b.data || []) {
      if (Number.isFinite(p.x)) allX.push(p.x);
      if (Number.isFinite(p.lower)) allY.push(p.lower);
      if (Number.isFinite(p.upper)) allY.push(p.upper);
    }
  }
  for (const r of rules) if (Number.isFinite(r.y)) allY.push(r.y);

  if (!allX.length || !allY.length) {
    return `<div class="chart chart--empty">Not enough data yet.</div>`;
  }

  const [x0, x1] = config.xDomain ?? extent(allX);
  let [y0, y1] = config.yDomain ?? extent(allY);
  if (zeroBaseline) {
    y0 = Math.min(0, y0);
    y1 = Math.max(0, y1);
  }
  // Breathing room, so the top series is not welded to the frame.
  const pad = (y1 - y0) * 0.08 || 1;
  y0 -= pad;
  y1 += pad;

  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const sx = (x) => padding.left + ((x - x0) / (x1 - x0 || 1)) * plotW;
  const sy = (y) => padding.top + plotH - ((y - y0) / (y1 - y0 || 1)) * plotH;

  const yTicks = niceTicks(y0 + pad, y1 - pad, yTickCount);

  const parts = [];

  /* --- grid & y axis --- */
  for (const t of yTicks) {
    const y = sy(t);
    parts.push(
      `<line class="chart__grid" x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}" />`,
      `<text class="chart__ytick" x="${padding.left - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(yFormat(t))}</text>`,
    );
  }

  /* --- x ticks --- */
  for (const t of xTicks) {
    const x = sx(t.x);
    if (x < padding.left - 1 || x > width - padding.right + 1) continue;
    parts.push(
      `<line class="chart__grid chart__grid--v" x1="${x.toFixed(1)}" y1="${padding.top}" x2="${x.toFixed(1)}" y2="${padding.top + plotH}" />`,
      `<text class="chart__xtick" x="${x.toFixed(1)}" y="${height - 10}" text-anchor="middle">${esc(t.label)}</text>`,
    );
  }

  /* --- confidence bands (drawn first, behind everything) --- */
  for (const band of bands) {
    const pts = (band.data || []).filter((p) => Number.isFinite(p.lower) && Number.isFinite(p.upper));
    if (pts.length < 2) continue;
    const top = pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.upper).toFixed(1)}`).join(' L');
    const bottom = [...pts].reverse().map((p) => `${sx(p.x).toFixed(1)},${sy(p.lower).toFixed(1)}`).join(' L');
    parts.push(
      `<path class="chart__band" d="M${top} L${bottom} Z" fill="${band.color || 'var(--accent)'}" opacity="${band.opacity ?? 0.13}" />`,
    );
  }

  /* --- reference rules --- */
  for (const rule of rules) {
    const y = sy(rule.y);
    parts.push(
      `<line class="chart__rule" x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}"
        stroke="${rule.color || 'var(--text-dim)'}" stroke-dasharray="${rule.dash || '4 4'}" />`,
    );
    if (rule.label) {
      parts.push(
        `<text class="chart__rulelabel" x="${width - padding.right - 4}" y="${(y - 5).toFixed(1)}" text-anchor="end">${esc(rule.label)}</text>`,
      );
    }
  }

  /* --- series --- */
  for (const s of series) {
    const data = (s.data || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!data.length) continue;
    const color = s.color || 'var(--accent)';

    if (s.type === 'scatter') {
      for (const p of data) {
        parts.push(
          `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${p.flagged ? (s.radius ?? 2.4) + 1.2 : s.radius ?? 2.4}"
            fill="${p.flagged ? 'none' : color}"
            ${p.flagged ? `stroke="${color}" stroke-width="1.2" stroke-dasharray="2 1.5"` : ''}
            opacity="${s.opacity ?? 0.75}" />`,
        );
      }
      continue;
    }

    // Split on gaps so a missing stretch is not bridged by a fake straight line.
    const segments = [];
    let run = [];
    let lastX = null;
    for (const p of data) {
      if (lastX != null && p.x - lastX > (config.gapThreshold ?? Infinity)) {
        if (run.length) segments.push(run);
        run = [];
      }
      run.push(p);
      lastX = p.x;
    }
    if (run.length) segments.push(run);

    for (const seg of segments) {
      const d = seg
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
        .join(' ');
      if (s.type === 'area') {
        const base = sy(Math.max(y0, 0));
        parts.push(
          `<path d="${d} L${sx(seg[seg.length - 1].x).toFixed(1)},${base.toFixed(1)} L${sx(seg[0].x).toFixed(1)},${base.toFixed(1)} Z"
            fill="${color}" opacity="${s.opacity ?? 0.15}" />`,
        );
      }
      parts.push(
        `<path d="${d}" fill="none" stroke="${color}" stroke-width="${s.width ?? 2}"
          stroke-linecap="round" stroke-linejoin="round"
          ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} opacity="${s.opacity ?? 1}" />`,
      );
    }
  }

  const legend = series
    .filter((s) => s.label)
    .map(
      (s) =>
        `<li><i style="background:${s.color || 'var(--accent)'};${s.dash ? 'opacity:.6' : ''}"></i>${esc(s.label)}</li>`,
    )
    .join('');

  return `
    <figure class="chart">
      ${title ? `<figcaption class="chart__title">${esc(title)}</figcaption>` : ''}
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title || 'chart')}" preserveAspectRatio="xMidYMid meet">
        ${parts.join('\n')}
      </svg>
      ${legend ? `<ul class="chart__legend">${legend}</ul>` : ''}
    </figure>`;
}

/* ============================================================
   DIVERGING BAR CHART
   ============================================================ */

/**
 * Bars around a zero baseline — for daily energy balance, where the sign is
 * the whole message.
 *
 * @param {{data: Array<{x:number, y:number, label?:string}>, height?:number, yFormat?:Function, title?:string, positiveColor?:string, negativeColor?:string, xTicks?:Array}} config
 */
export function divergingBars(config) {
  const {
    data = [],
    height = 220,
    width = 860,
    padding = { top: 14, right: 16, bottom: 28, left: 52 },
    yFormat = (v) => fmtInt(v),
    title = '',
    positiveColor = 'var(--warn)',
    negativeColor = 'var(--good)',
    xTicks = [],
  } = config;

  const points = data.filter((p) => Number.isFinite(p.y) && Number.isFinite(p.x));
  if (!points.length) return `<div class="chart chart--empty">Not enough data yet.</div>`;

  const [x0, x1] = extent(points.map((p) => p.x));
  const maxAbs = Math.max(...points.map((p) => Math.abs(p.y))) || 1;
  const y0 = -maxAbs * 1.1;
  const y1 = maxAbs * 1.1;

  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const sx = (x) => padding.left + ((x - x0) / (x1 - x0 || 1)) * plotW;
  const sy = (y) => padding.top + plotH - ((y - y0) / (y1 - y0)) * plotH;

  const barW = Math.max(1.2, Math.min(10, (plotW / Math.max(1, points.length)) * 0.7));
  const zeroY = sy(0);
  const parts = [];

  for (const t of niceTicks(y0, y1, 4)) {
    parts.push(
      `<line class="chart__grid" x1="${padding.left}" y1="${sy(t).toFixed(1)}" x2="${width - padding.right}" y2="${sy(t).toFixed(1)}" />`,
      `<text class="chart__ytick" x="${padding.left - 8}" y="${(sy(t) + 3.5).toFixed(1)}" text-anchor="end">${esc(yFormat(t))}</text>`,
    );
  }
  for (const t of xTicks) {
    const x = sx(t.x);
    if (x < padding.left - 1 || x > width - padding.right + 1) continue;
    parts.push(`<text class="chart__xtick" x="${x.toFixed(1)}" y="${height - 9}" text-anchor="middle">${esc(t.label)}</text>`);
  }

  for (const p of points) {
    const y = sy(p.y);
    const top = Math.min(y, zeroY);
    const h = Math.max(1, Math.abs(y - zeroY));
    parts.push(
      `<rect x="${(sx(p.x) - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"
        rx="1.5" fill="${p.y >= 0 ? positiveColor : negativeColor}" opacity="0.8">
        <title>${esc(p.label || '')}${p.label ? ': ' : ''}${esc(yFormat(p.y))}</title>
      </rect>`,
    );
  }

  parts.push(
    `<line x1="${padding.left}" y1="${zeroY.toFixed(1)}" x2="${width - padding.right}" y2="${zeroY.toFixed(1)}"
      stroke="var(--border-strong)" stroke-width="1.2" />`,
  );

  return `
    <figure class="chart">
      ${title ? `<figcaption class="chart__title">${esc(title)}</figcaption>` : ''}
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title || 'chart')}">
        ${parts.join('\n')}
      </svg>
    </figure>`;
}

/* ============================================================
   HORIZONTAL BAR (component comparison)
   ============================================================ */

export function horizontalBars({ items, valueFormat = fmtInt, title = '' }) {
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  const rows = items
    .map(
      (i) => `
      <li class="hbar">
        <span class="hbar__label">${esc(i.label)}</span>
        <span class="hbar__track">
          <span class="hbar__fill hbar__fill--${esc(i.id || 'default')}" style="width:${((Math.abs(i.value) / max) * 100).toFixed(1)}%"></span>
        </span>
        <span class="hbar__value num">${esc(valueFormat(i.value))}</span>
      </li>`,
    )
    .join('');
  return `${title ? `<h3 class="chart__title">${esc(title)}</h3>` : ''}<ul class="hbars">${rows}</ul>`;
}

/* ============================================================
   SPARKLINE
   ============================================================ */

export function sparkline(values, { width = 120, height = 28, color = 'var(--accent)' } = {}) {
  const data = values.filter(Number.isFinite);
  if (data.length < 2) return '';
  const [lo, hi] = extent(data);
  const span = hi - lo || 1;
  const d = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * (width - 2) + 1;
      const y = height - 2 - ((v - lo) / span) * (height - 4);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" aria-hidden="true">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/* ============================================================
   DATE AXIS HELPER
   ============================================================ */

/**
 * Month-start tick marks for a date-indexed series, thinned so labels never
 * collide on a phone.
 *
 * @param {string[]} dates  ISO dates, one per x index
 * @param {number} maxTicks
 */
export function monthTicks(dates, maxTicks = 6) {
  const candidates = [];
  let lastMonth = null;
  dates.forEach((iso, i) => {
    const d = fromISODate(iso);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (key !== lastMonth) {
      candidates.push({ x: i, label: d.toLocaleDateString('en-US', { month: 'short' }) });
      lastMonth = key;
    }
  });
  if (candidates.length <= maxTicks) return candidates;
  const stride = Math.ceil(candidates.length / maxTicks);
  return candidates.filter((_, i) => i % stride === 0);
}
