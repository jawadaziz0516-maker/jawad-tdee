/**
 * trendsView.js — the charts.
 *
 * Simple mode shows three: what your weight is doing, how the estimate settled,
 * and where you end up if you keep eating this way. Those answer the questions
 * people actually have. Detailed mode adds intake, daily balance, exercise and
 * the weekly table.
 *
 * Each chart's caption says what question it answers. An unlabelled line is
 * decoration.
 *
 * @module ui/trendsView
 */

import { card, note, detail, esc, statTile } from './components.js';
import { lineChart, divergingBars, monthTicks } from './charts.js';
import { unitSystem, fmtInt, fmtNum, fmtSigned } from '../core/units.js';
import { fmtDateShort, startOfWeek } from '../core/time.js';
import { mean } from '../stats/descriptive.js';
import { projectWithUncertainty } from '../model/projection.js';

const RANGES = [
  { id: '30', label: '30d', days: 30 },
  { id: '90', label: '90d', days: 90 },
  { id: '180', label: '6m', days: 180 },
  { id: 'all', label: 'All', days: Infinity },
];

export function renderTrends(ctx) {
  const { snapshot, profile } = ctx;
  const u = unitSystem(profile.units);
  const detailed = profile.detailLevel === 'detailed';

  if (!snapshot.hasData || !snapshot.trend) {
    return card({ title: 'Trends', body: '<p class="muted">Nothing to plot yet — log a few days first.</p>' });
  }

  const range = ctx.state.trendRange ?? '90';
  const days = RANGES.find((r) => r.id === range)?.days ?? 90;
  const all = snapshot.trend.days;
  const slice = Number.isFinite(days) ? all.slice(-days) : all;
  const offset = all.length - slice.length;
  const xTicks = monthTicks(slice.map((d) => d.date));
  const byDate = new Map(ctx.store.entries.map((d) => [d.date, d]));

  return [
    `<div class="rangebar">${RANGES.map(
      (r) => `<button class="chip${r.id === range ? ' is-active' : ''}" data-range="${r.id}">${esc(r.label)}</button>`,
    ).join('')}</div>`,
    weightChart(slice, offset, xTicks, u, detailed),
    maintenanceChart(ctx, slice, offset, xTicks),
    projectionCard(ctx, u, detailed),
    detailed ? intakeChart(ctx, slice, offset, xTicks, byDate) : '',
    detailed ? balanceChart(ctx, slice, offset, xTicks, byDate, u) : '',
    detailed ? periodTable(ctx, u) : '',
  ].join('');
}

/* ============================================================
   WEIGHT
   ============================================================ */

function weightChart(slice, offset, xTicks, u, detailed) {
  const series = [
    {
      id: 'raw',
      label: 'Scale',
      type: 'scatter',
      color: 'var(--text-dim)',
      radius: 2.2,
      opacity: 0.55,
      data: slice.filter((d) => d.weightKg != null).map((d) => ({ x: d.index - offset, y: d.weightKg, flagged: d.isOutlier })),
    },
    {
      id: 'trend',
      label: 'Trend',
      type: 'line',
      color: 'var(--accent)',
      width: 2.4,
      data: slice.map((d) => ({ x: d.index - offset, y: d.trendSmoothKg })),
    },
  ];

  if (detailed) {
    series.splice(1, 0, {
      id: 'adjusted',
      label: 'After water correction',
      type: 'scatter',
      color: 'var(--accent-soft-solid)',
      radius: 1.6,
      opacity: 0.7,
      data: slice
        .filter((d) => d.adjustedWeightKg != null && Math.abs(d.waterAdjustmentKg) > 0.05)
        .map((d) => ({ x: d.index - offset, y: d.adjustedWeightKg })),
    });
  }

  return card({
    title: 'Weight',
    subtitle: 'Is my weight actually moving?',
    body: lineChart({
      height: 280,
      xTicks,
      yFormat: (v) => fmtNum(u.mass(v), 1),
      series,
      bands: [
        {
          id: 'ci',
          color: 'var(--accent)',
          opacity: 0.12,
          data: slice.map((d) => ({
            x: d.index - offset,
            lower: d.trendSmoothKg - 1.96 * d.smoothLevelSd,
            upper: d.trendSmoothKg + 1.96 * d.smoothLevelSd,
          })),
        },
      ],
    }),
  });
}

/* ============================================================
   MAINTENANCE CONVERGENCE
   ============================================================ */

function maintenanceChart(ctx, slice, offset, xTicks) {
  const m = ctx.snapshot.maintenance;
  if (!m) return '';
  const detailed = ctx.profile.detailLevel === 'detailed';

  const dateIndex = new Map(ctx.snapshot.trend.days.map((d, i) => [d.date, i]));
  const posteriorPoints = [];
  const bandPoints = [];
  for (const step of m.trace) {
    const idx = dateIndex.get(step.meta?.endDate);
    if (idx == null) continue;
    const x = idx - offset;
    if (x < 0) continue;
    const sd = Math.sqrt(step.posterior.variance);
    posteriorPoints.push({ x, y: step.posterior.mean });
    bandPoints.push({ x, lower: step.posterior.mean - 1.96 * sd, upper: step.posterior.mean + 1.96 * sd });
  }

  const series = [
    {
      id: 'weekly',
      label: 'Weekly reading',
      type: 'scatter',
      color: 'var(--text-dim)',
      radius: 3.2,
      opacity: 0.65,
      data: m.blocks
        .filter((b) => b.usable)
        .map((b) => ({ x: (dateIndex.get(b.endDate) ?? -1) - offset, y: b.observedMaintenance }))
        .filter((p) => p.x >= 0),
    },
    {
      id: 'posterior',
      label: 'Estimate',
      type: 'line',
      color: 'var(--accent)',
      width: 2.6,
      data: posteriorPoints,
    },
  ];

  if (detailed) {
    series.splice(1, 0, {
      id: 'prior',
      label: 'Textbook prediction',
      type: 'line',
      color: 'var(--info)',
      width: 1.5,
      dash: '6 4',
      data: slice.map((d) => ({ x: d.index - offset, y: m.prior.kcal })),
    });
  }

  return card({
    title: 'How the estimate settled',
    subtitle: 'Did it converge, or is it still moving?',
    body: `
      ${lineChart({
        height: 260,
        xTicks,
        yFormat: (v) => fmtInt(v),
        series,
        bands: [{ id: 'ci', color: 'var(--accent)', opacity: 0.14, data: bandPoints }],
      })}
      ${note(
        'Each grey dot is one week of your eating measured against what your weight did. The line is ' +
        'the running estimate, and the band is how sure it is. Both should settle as weeks accumulate.',
      )}
    `,
  });
}

/* ============================================================
   PROJECTION
   ============================================================ */

function projectionCard(ctx, u, detailed) {
  const { snapshot, profile, state } = ctx;
  const m = snapshot.maintenance;
  const startWeightKg = snapshot.trend?.current.trendKg;
  if (!m || !startWeightKg) return '';

  const intake = state.projectionIntake ?? Math.round(m.kcal - 400);
  const horizon = state.projectionDays ?? 120;

  const { central, fast, slow } = projectWithUncertainty({
    maintenance: m,
    startWeightKg,
    bodyFatPct: snapshot.composition?.bodyFatPct ?? 22,
    intakeKcal: intake,
    dMaintenanceDKg: m.prior.dMaintenanceDKg,
    days: horizon,
    options: {
      applyAdaptation: true,
      resistanceSessionsPerWeek: snapshot.composition?.resistanceSessionsPerWeek ?? 0,
      proteinGPerKg: snapshot.composition?.proteinGPerKg ?? 0,
      applyTrainingPartitioning: profile.applyTrainingPartitioning !== false,
    },
  });

  const series = [
    {
      id: 'model',
      label: 'Projected',
      type: 'line',
      color: 'var(--accent)',
      width: 2.6,
      data: central.days.map((d) => ({ x: d.day, y: d.weightKg })),
    },
  ];

  if (detailed) {
    const naive = [];
    for (let d = 1; d <= horizon; d++) {
      naive.push({ x: d, y: startWeightKg + (((intake - m.kcal) * d) / 3500) * 0.45359237 });
    }
    series.unshift({
      id: 'naive',
      label: '3,500 kcal/lb rule',
      type: 'line',
      color: 'var(--danger)',
      width: 1.4,
      dash: '5 4',
      opacity: 0.75,
      data: naive,
    });
  }

  const s = central.summary;

  return card({
    title: 'If you keep eating this way',
    subtitle: 'Drag to try a different intake.',
    body: `
      <div class="projection-controls">
        <input type="range" min="${Math.round(m.kcal - 1200)}" max="${Math.round(m.kcal + 800)}" step="25"
          value="${intake}" data-projection-intake aria-label="Daily intake" />
        <div class="projection-readout">
          <b class="num">${fmtInt(intake)}</b> kcal a day
          <span class="muted num">(${fmtSigned(intake - m.kcal)} vs maintenance)</span>
        </div>
        <div class="chips">
          ${[60, 120, 180, 365].map((d) => `<button class="chip${d === horizon ? ' is-active' : ''}" data-projection-days="${d}">${d === 365 ? '1y' : `${d}d`}</button>`).join('')}
        </div>
      </div>

      ${lineChart({
        height: 250,
        yFormat: (v) => fmtNum(u.mass(v), 1),
        xTicks: [0, 30, 60, 90, 120, 180, 270, 365].filter((d) => d <= horizon).map((d) => ({ x: d, label: d === 0 ? 'now' : `${d}d` })),
        series,
        bands: [
          {
            id: 'ci',
            color: 'var(--accent)',
            opacity: 0.13,
            data: central.days.map((d, i) => ({
              x: d.day,
              lower: Math.min(fast.days[i].weightKg, slow.days[i].weightKg),
              upper: Math.max(fast.days[i].weightKg, slow.days[i].weightKg),
            })),
          },
        ],
      })}

      <div class="stats stats--3">
        ${statTile({ label: `In ${horizon} days`, value: fmtNum(u.mass(s.endWeightKg), 1), sub: `${u.massLabel} (${fmtSigned(u.mass(s.deltaKg), 1)})` })}
        ${statTile({ label: 'Per week', value: fmtSigned(u.mass(s.averageWeeklyKg), 2), sub: u.massLabel })}
        ${statTile({ label: 'Burn by then', value: fmtInt(s.endTdee), sub: `kcal (${fmtSigned(s.endTdee - m.kcal)})` })}
      </div>

      ${note(
        `Weight loss slows down on its own: a lighter body costs less to run, and your metabolism ` +
        `adapts. By day ${horizon} you would be burning <b class="num">${fmtInt(Math.abs(s.endTdee - m.kcal))}</b> kcal ` +
        `a day less than today. The shaded band is the uncertainty in your maintenance carried forward.`,
      )}
      ${detailed ? note(
        `The 3,500 kcal/lb rule would promise <b class="num">${fmtSigned(u.mass(s.naiveDeltaKg), 1)} ${u.massLabel}</b> — ` +
        `an overstatement of <b class="num">${fmtNum(Math.abs(u.mass(s.naiveOverstatementKg)), 1)} ${u.massLabel}</b>.`,
      ) : ''}
    `,
  });
}

/* ============================================================
   DETAILED-ONLY CHARTS
   ============================================================ */

function intakeChart(ctx, slice, offset, xTicks, byDate) {
  const m = ctx.snapshot.maintenance;
  const intake = slice
    .map((d) => ({ x: d.index - offset, y: byDate.get(d.date)?.intake?.kcal }))
    .filter((p) => Number.isFinite(p.y));
  if (!intake.length) return '';

  const rolling7 = [];
  for (let i = 0; i < slice.length; i++) {
    const window = [];
    for (let k = Math.max(0, i - 6); k <= i; k++) {
      const v = byDate.get(slice[k].date)?.intake?.kcal;
      if (Number.isFinite(v)) window.push(v);
    }
    if (window.length >= 4) rolling7.push({ x: slice[i].index - offset, y: mean(window) });
  }

  return card({
    title: 'What you ate',
    body: lineChart({
      height: 240,
      xTicks,
      yFormat: (v) => fmtInt(v),
      series: [
        { id: 'daily', label: 'Daily', type: 'scatter', color: 'var(--text-dim)', radius: 2, opacity: 0.5, data: intake },
        { id: 'avg', label: '7-day average', type: 'line', color: 'var(--good)', width: 2.2, data: rolling7 },
      ],
      rules: m ? [{ y: m.kcal, label: `Maintenance ${fmtInt(m.kcal)}`, color: 'var(--accent)', dash: '5 4' }] : [],
    }),
  });
}

function balanceChart(ctx, slice, offset, xTicks, byDate, u) {
  const m = ctx.snapshot.maintenance;
  if (!m) return '';
  const data = slice
    .map((d) => {
      const kcal = byDate.get(d.date)?.intake?.kcal;
      if (!Number.isFinite(kcal)) return null;
      return { x: d.index - offset, y: kcal - m.kcal, label: fmtDateShort(d.date) };
    })
    .filter(Boolean);
  if (!data.length) return '';

  const cumulative = data.reduce((s, p) => s + p.y, 0);
  const impliedKg = cumulative / ctx.snapshot.summary.kcalPerKg;

  return card({
    title: 'Daily surplus and deficit',
    body: `
      ${divergingBars({ data, height: 210, xTicks, yFormat: (v) => fmtSigned(v) })}
      ${note(
        `Cumulative balance over this window: <b class="num">${fmtSigned(cumulative)}</b> kcal, implying ` +
        `<b class="num">${fmtSigned(u.mass(impliedKg), 2)} ${u.massLabel}</b>. Your trend actually moved ` +
        `<b class="num">${fmtSigned(u.mass(slice[slice.length - 1].trendKg - slice[0].trendKg), 2)} ${u.massLabel}</b>.`,
      )}
    `,
  });
}

function periodTable(ctx, u) {
  const { trend, maintenance } = ctx.snapshot;
  const byDate = new Map(ctx.store.entries.map((d) => [d.date, d]));

  const weeks = new Map();
  for (const d of trend.days) {
    const key = startOfWeek(d.date);
    if (!weeks.has(key)) weeks.set(key, { start: key, days: [], intakes: [] });
    const w = weeks.get(key);
    w.days.push(d);
    const kcal = byDate.get(d.date)?.intake?.kcal;
    if (Number.isFinite(kcal)) w.intakes.push(kcal);
  }

  const rows = [...weeks.values()]
    .slice(-12)
    .reverse()
    .map((w) => {
      const first = w.days[0];
      const last = w.days[w.days.length - 1];
      const delta = last.trendSmoothKg - first.trendSmoothKg;
      const avgIntake = w.intakes.length ? mean(w.intakes) : null;
      const balance = avgIntake != null && maintenance ? avgIntake - maintenance.kcal : null;
      return `<tr>
        <td>${esc(fmtDateShort(w.start))}</td>
        <td class="num">${avgIntake != null ? fmtInt(avgIntake) : '—'}<span class="muted"> (${w.intakes.length})</span></td>
        <td class="num">${fmtNum(u.mass(last.trendSmoothKg), 1)}</td>
        <td class="num ${delta < 0 ? 'neg' : delta > 0 ? 'pos' : ''}">${fmtSigned(u.mass(delta), 2)}</td>
        <td class="num ${balance == null ? '' : balance > 0 ? 'pos' : 'neg'}">${balance != null ? fmtSigned(balance) : '—'}</td>
      </tr>`;
    })
    .join('');

  return card({
    title: 'Week by week',
    body: `<div class="tablewrap"><table class="table">
      <thead><tr><th>Week of</th><th class="num">Avg eaten</th><th class="num">Trend</th><th class="num">Change</th><th class="num">Balance</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`,
  });
}

/* ============================================================
   WIRING
   ============================================================ */

export function mountTrends(root, ctx) {
  root.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-range]');
    if (chip) {
      ctx.state.trendRange = chip.dataset.range;
      ctx.refresh({ keepScroll: true });
      return;
    }
    const days = event.target.closest('[data-projection-days]');
    if (days) {
      ctx.state.projectionDays = Number(days.dataset.projectionDays);
      ctx.refresh({ keepScroll: true });
    }
  });

  const slider = root.querySelector('[data-projection-intake]');
  slider?.addEventListener('input', () => {
    ctx.state.projectionIntake = Number(slider.value);
    ctx.refresh({ keepScroll: true });
  });
}
