/**
 * dashboardView.js — the headline screen.
 *
 * Two design rules, in tension, resolved in this order:
 *
 *   1. Show the one number, and what to do about it today. Everything else is
 *      secondary. A screen that shows fourteen true things buries the two that
 *      change your behaviour.
 *   2. Never show a number without how much to trust it. False precision is
 *      how people conclude their metabolism is broken when the honest answer
 *      is "four weigh-ins is not enough data yet".
 *
 * So: a maintenance figure with its interval, today's target, and the weight
 * trend. The component breakdowns, evidence tables and diagnostics are real
 * work and still available — behind the Detailed switch in You, or inside
 * collapsed sections. They are not the daily view.
 *
 * @module ui/dashboardView
 */

import { card, statTile, segmentBar, confidencePill, detail, note, esc, field, selectField } from './components.js';
import { lineChart, monthTicks, horizontalBars } from './charts.js';
import { fmtInt, fmtNum, fmtSigned, unitSystem, round, cmToFeetInches } from '../core/units.js';
import { fmtDateRelative, todayISO } from '../core/time.js';
import { intakeForRate } from '../model/maintenance.js';
import { profileNeedsSetup } from '../data/schema.js';

export function renderDashboard(ctx) {
  const { snapshot, profile } = ctx;
  const u = unitSystem(profile.units);
  const detailed = profile.detailLevel === 'detailed';

  const banners = [
    profileNeedsSetup(profile) ? setupCard(ctx, u) : '',
    profile.demoLoaded ? demoBanner() : '',
  ].join('');

  if (!snapshot.hasData) return banners + emptyState();

  return [
    banners,
    heroCard(ctx),
    todayCard(ctx, u),
    weightCard(ctx, u),
    detailed ? componentsCard(ctx) : '',
    detailed ? balanceCard(ctx, u) : '',
    detailed ? qualityCard(ctx) : nudgeCard(ctx),
  ].join('');
}

/* ============================================================
   FIRST-RUN SETUP
   ============================================================
   Inline on the dashboard rather than buried in settings, because until these
   five things are right every number on this screen is about someone else. */

function setupCard(ctx, u) {
  const { profile } = ctx;
  const { feet, inches } = cmToFeetInches(profile.heightCm);

  return `
  <section class="card card--setup">
    <div class="card__body">
      <h2 class="card__title">First, a few things about you</h2>
      <p class="card__sub">Your height, age and sex set the starting estimate. Name and body fat are optional — you can change any of this later under You.</p>
      <form data-setup-form class="setup-form">
        <div class="grid grid--2">
          ${field({ label: 'Name', name: 'name', value: profile.name, type: 'text', placeholder: 'Optional' })}
          ${selectField({
            label: 'Units',
            name: 'units',
            value: profile.units,
            options: [
              { value: 'imperial', label: 'Pounds & feet' },
              { value: 'metric', label: 'Kilograms & cm' },
            ],
          })}
          ${selectField({
            label: 'Sex',
            name: 'sex',
            value: profile.sex,
            options: [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }],
          })}
          ${field({ label: 'Date of birth', name: 'birthDate', value: profile.birthDate, type: 'date' })}
          ${u.imperial
            ? `<div class="field field--split">
                <span class="field__label">Height</span>
                <div class="split">
                  <span class="field__input"><input type="number" name="heightFeet" value="${feet}" step="1" min="3" max="8" inputmode="numeric" /><span class="field__suffix">ft</span></span>
                  <span class="field__input"><input type="number" name="heightInches" value="${round(inches, 1)}" step="0.5" min="0" max="11.9" inputmode="decimal" /><span class="field__suffix">in</span></span>
                </div>
              </div>`
            : field({ label: 'Height', name: 'heightCm', value: round(profile.heightCm, 1), step: 0.5, suffix: 'cm' })}
          ${field({
            label: 'Body fat',
            name: 'bodyFatPct',
            value: profile.bodyFatPct,
            step: 0.5,
            suffix: '%',
            hint: 'Optional — leave blank if you do not know it.',
          })}
        </div>
        <button type="submit" class="btn">Save and continue</button>
      </form>
    </div>
  </section>`;
}

function demoBanner() {
  return `
  <section class="banner">
    <div>
      <b>You are looking at sample data.</b>
      <span>120 simulated days, not yours. Clear it before you start logging.</span>
    </div>
    <button class="btn btn--ghost" data-clear-demo>Clear it</button>
  </section>`;
}

/* ============================================================
   HERO
   ============================================================ */

function heroCard(ctx) {
  const { maintenance, profile } = { ...ctx.snapshot, profile: ctx.profile };

  if (!maintenance) {
    return card({
      title: 'Maintenance',
      body: `<p class="muted">Log a few days of weight and calories and this fills in.</p>`,
    });
  }

  const half = maintenance.ci.halfWidth;
  const weeks = maintenance.dataQuality.blocksUsable;

  // One sentence, chosen by how much evidence there actually is.
  const line =
    weeks < 2
      ? 'Still mostly a prediction from your height, weight and age. It will sharpen as you log.'
      : weeks < 6
        ? `Built from ${weeks} weeks of your own data. Another month will noticeably tighten it.`
        : `Built from ${weeks} weeks of your own weight and intake.`;

  return `
  <section class="card card--hero">
    <div class="hero">
      <div class="hero__label">Maintenance ${confidencePill(maintenance.confidence)}</div>
      <div class="hero__value num">${fmtInt(maintenance.kcal)}<span class="hero__unit">kcal</span></div>
      <div class="hero__ci num">give or take ${fmtInt(half)}</div>
    </div>
    <p class="hero__line">${esc(line)}</p>
    ${detail('Where this number came from', `
      <div class="stats stats--3">
        ${statTile({ label: 'From the equations', value: fmtInt(maintenance.prior.kcal), sub: `± ${fmtInt(1.96 * maintenance.prior.sd)}` })}
        ${statTile({ label: 'From your data', value: fmtInt(maintenance.kcal), sub: `± ${fmtInt(half)}` })}
        ${statTile({ label: 'Weeks used', value: String(weeks), sub: `of ${maintenance.dataQuality.blocksTotal} logged` })}
      </div>
      <p>The estimate starts at what the standard equations predict for someone your size, then moves
      toward what your weight and intake actually did. Right now your own data carries
      <b>${Math.round((1 - maintenance.weights.prior) * 100)}%</b> of the weight.</p>
      ${adaptationNote(maintenance)}
    `)}
    ${maintenance.clamped ? note('This was held back from moving further from the equations — usually a sign of a logging error. Check your recent weeks.', 'warn') : ''}
  </section>`;
}

function adaptationNote(maintenance) {
  const ratio = maintenance.adaptationRatio;
  if (!Number.isFinite(ratio)) return '';
  const pct = Math.round((ratio - 1) * 100);
  if (Math.abs(pct) < 6) return `<p>That is within 6% of the textbook prediction — nothing unusual.</p>`;
  if (pct < 0) {
    return `<p>Your weight behaves as though you burn about <b>${Math.abs(pct)}% less</b> than predicted.
      Under-reporting what you eat produces exactly this pattern and is far more common than a slow
      metabolism. Either way this number is still the right one to set targets from, because it is
      calibrated to how <em>you</em> log.</p>`;
  }
  return `<p>You appear to burn about <b>${pct}% more</b> than predicted. Usually that means more
    non-exercise movement than your occupation setting assumes, or over-reported portions.</p>`;
}

/* ============================================================
   TODAY
   ============================================================ */

function todayCard(ctx, u) {
  const { snapshot, profile } = ctx;
  const { adjusted, summary, composition } = snapshot;
  if (!adjusted) return '';

  const goal = profile.goal ?? { mode: 'maintain', weeklyRateKg: 0 };
  const goalTarget =
    goal.mode !== 'maintain' && snapshot.maintenance
      ? intakeForRate(snapshot.maintenance, goal.weeklyRateKg, {
          fatMassKg: composition?.fatMassKg ?? 20,
          resistanceSessionsPerWeek: composition?.resistanceSessionsPerWeek,
          proteinGPerKg: composition?.proteinGPerKg,
          applyTrainingAdjustment: profile.applyTrainingPartitioning !== false,
        })
      : null;

  const target = goalTarget ? goalTarget.kcal + (adjusted.adjusted - adjusted.base) : adjusted.adjusted;
  const eaten = summary.todayIntake;
  const logged = Number.isFinite(eaten);
  const remaining = target - (logged ? eaten : 0);

  const goalLabel =
    goal.mode === 'maintain'
      ? 'holding steady'
      : `${goal.mode === 'lose' ? 'losing' : 'gaining'} ${fmtNum(Math.abs(u.mass(goal.weeklyRateKg)), 2)} ${u.massLabel} a week`;

  const bigAdjustments = adjusted.parts.filter((p) => Math.abs(p.kcal) >= 40);

  return card({
    title: `Eat today`,
    subtitle: `To keep ${esc(goalLabel)}`,
    body: `
      <div class="target">
        <div class="target__main">
          <div class="target__value num">${fmtInt(target)}</div>
          <div class="target__unit">kcal today</div>
        </div>
        <div class="target__side">
          <div><span class="muted">Logged</span> <b class="num">${logged ? fmtInt(eaten) : '—'}</b></div>
          <div class="${!logged ? '' : remaining < 0 ? 'neg-strong' : 'pos-strong'}">
            <span class="muted">${logged && remaining < 0 ? 'Over by' : 'Left'}</span>
            <b class="num">${fmtInt(Math.abs(remaining))}</b>
          </div>
        </div>
      </div>
      ${bigAdjustments.length ? note(
        'Adjusted for ' +
          bigAdjustments
            .map((p) => {
              const what = p.id === 'steps' ? 'steps' : 'exercise';
              return `${p.kcal > 0 ? 'more' : 'less'} ${what} than usual (<b class="num">${fmtSigned(p.kcal)}</b>)`;
            })
            .join(' and ') +
          '.',
      ) : ''}
      ${detail('Why today is not just the maintenance number', `
        <p>The maintenance figure is an <em>average</em> that already contains your usual training and
        walking. Adding today's whole workout on top would charge you twice for it, so only the
        <em>difference</em> from a typical day is applied.</p>
        <p class="muted">A typical recent day for you: ${fmtInt(ctx.snapshot.maintenance?.habitualAverages.eatKcal)} kcal
        of exercise and ${fmtInt(ctx.snapshot.maintenance?.habitualAverages.steps)} steps.</p>
        ${goalTarget ? `<p>At this intake your deficit is <b class="num">${fmtSigned(goalTarget.dailyEnergy)}</b> kcal a day —
        realistically between <b class="num">${fmtSigned(goalTarget.actualDeficitRange.lower)}</b> and
        <b class="num">${fmtSigned(goalTarget.actualDeficitRange.upper)}</b>, given the uncertainty in maintenance.</p>` : ''}
      `)}
    `,
  });
}

/* ============================================================
   WEIGHT
   ============================================================ */

function weightCard(ctx, u) {
  const { trend, summary } = ctx.snapshot;
  if (!trend) return '';

  const days = trend.days;
  const window = Math.min(days.length, 90);
  const slice = days.slice(-window);
  const offset = days.length - window;

  const chart = lineChart({
    height: 220,
    xTicks: monthTicks(slice.map((d) => d.date)),
    yFormat: (v) => fmtNum(u.mass(v), 1),
    series: [
      {
        id: 'scale',
        type: 'scatter',
        color: 'var(--text-dim)',
        radius: 2.2,
        opacity: 0.55,
        data: slice.filter((d) => d.weightKg != null).map((d) => ({ x: d.index - offset, y: d.weightKg, flagged: d.isOutlier })),
      },
      {
        id: 'trend',
        type: 'line',
        color: 'var(--accent)',
        width: 2.4,
        data: slice.map((d) => ({ x: d.index - offset, y: d.trendSmoothKg })),
      },
    ],
  });

  const rate = summary.weeklyRateKg;
  const rateTone = !summary.rateIsSignificant ? 'neutral' : rate < 0 ? 'good' : 'bad';

  return card({
    title: 'Weight',
    subtitle: 'Dots are the scale. The line is the trend, with water weight filtered out.',
    body: `
      <div class="stats stats--3">
        ${statTile({ label: 'Trend', value: fmtNum(u.mass(summary.trendKg), 1), sub: u.massLabel })}
        ${statTile({ label: 'Per week', value: fmtSigned(u.mass(rate), 2), sub: u.massLabel, tone: rateTone })}
        ${statTile({
          label: 'Last 28 days',
          value: summary.change28 ? fmtSigned(u.mass(summary.change28.deltaKg), 1) : '—',
          sub: u.massLabel,
        })}
      </div>
      ${chart}
      ${!summary.rateIsSignificant ? note(
        'That rate is not yet distinguishable from flat — the uncertainty still spans zero. More weigh-ins narrow it faster than more time does.',
      ) : ''}
    `,
  });
}

/* ============================================================
   SIMPLE-MODE NUDGE
   ============================================================
   One thing to fix, not a list of six. */

function nudgeCard(ctx) {
  const { maintenance } = ctx.snapshot;
  if (!maintenance) return '';
  const worst = maintenance.dataQuality.issues.find((i) => i.level === 'warn');
  if (!worst) return '';
  return `<p class="nudge">${esc(worst.text)}</p>`;
}

/* ============================================================
   DETAILED-ONLY CARDS
   ============================================================ */

function componentsCard(ctx) {
  const { today } = ctx.snapshot;
  if (!today) return '';

  const segments = [
    { id: 'bmr', label: 'BMR', value: today.bmrKcal },
    { id: 'neat', label: 'Daily movement', value: today.neatKcal },
    { id: 'eat', label: 'Exercise', value: today.eatKcal },
    { id: 'tef', label: 'Digestion', value: today.tefKcal },
  ];

  const neatDetail = [
    { id: 'ambulatory', label: 'Steps', value: today.neat.ambulatoryKcal },
    { id: 'occupational', label: 'Work', value: today.neat.occupationalKcal },
    { id: 'postural', label: 'Standing', value: today.neat.posturalKcal },
    { id: 'spontaneous', label: 'Fidgeting', value: today.neat.spontaneousKcal },
  ].filter((s) => Math.abs(s.value) > 1);

  const sessions = today.eat.sessions
    .map((s) => `<li><span>${esc(s.label)}</span><b class="num">${fmtInt(s.netKcal)}</b><span class="muted">${esc(s.rationale)}</span></li>`)
    .join('');

  return card({
    title: 'Where the energy goes',
    subtitle: `${esc(fmtDateRelative(ctx.focusDate))} — ${fmtInt(today.maintenanceKcal)} kcal`,
    body: `
      ${segmentBar(segments, today.maintenanceKcal)}
      ${detail('Movement breakdown', `
        ${horizontalBars({ items: neatDetail, valueFormat: (v) => `${fmtInt(v)} kcal` })}
        <p class="muted">${today.neat.stepsEstimated
          ? 'No step count for this day, so this came from your lifestyle setting.'
          : `${fmtInt(today.neat.netSteps)} steps counted here — steps from logged workouts were removed so they are not charged twice.`}</p>
      `)}
      ${sessions ? detail('Exercise', `<ul class="sessions">${sessions}</ul>`) : ''}
      ${detail('Digestion (TEF)', `
        <p>Worked out from your actual macros rather than a flat percentage:
        <b class="num">${fmtInt(today.tef.kcal)}</b> kcal from ${fmtInt(today.tef.loggedKcal)} eaten
        (${(today.tef.fraction * 100).toFixed(1)}%). Protein costs far more to process than fat does.</p>
        ${horizontalBars({
          items: [
            { id: 'protein', label: 'Protein', value: today.tef.breakdown.protein },
            { id: 'carb', label: 'Carbs', value: today.tef.breakdown.carb },
            { id: 'fat', label: 'Fat', value: today.tef.breakdown.fat },
            { id: 'alcohol', label: 'Alcohol', value: today.tef.breakdown.alcohol },
            { id: 'other', label: 'Unlogged', value: today.tef.breakdown.unaccounted },
          ].filter((x) => x.value > 0.5),
          valueFormat: (v) => `${fmtInt(v)} kcal`,
        })}
      `)}
      ${today.caveats.length ? `<ul class="caveats">${today.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    `,
  });
}

function balanceCard(ctx, u) {
  const { summary } = ctx.snapshot;
  if (!Number.isFinite(summary.maintenanceKcal)) return '';

  const rows = [
    { label: 'Today', intake: summary.todayIntake, balance: summary.balanceToday, n: 1 },
    { label: 'Last 7 days', intake: summary.intake7, balance: summary.balance7, n: summary.intake7n },
    { label: 'Last 28 days', intake: summary.intake28, balance: summary.balance28, n: summary.intake28n },
  ]
    .map(
      (r) => `<tr>
        <td>${esc(r.label)}${r.n > 1 ? ` <span class="muted">(${r.n} logged)</span>` : ''}</td>
        <td class="num">${Number.isFinite(r.intake) ? fmtInt(r.intake) : '—'}</td>
        <td class="num ${r.balance == null ? '' : r.balance > 0 ? 'pos' : 'neg'}">${Number.isFinite(r.balance) ? fmtSigned(r.balance) : '—'}</td>
      </tr>`,
    )
    .join('');

  return card({
    title: 'Energy balance',
    body: `
      <table class="table">
        <thead><tr><th>Window</th><th class="num">Eaten</th><th class="num">vs maintenance</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${Number.isFinite(summary.impliedWeeklyKg) ? note(
        `Your last 7 days of eating imply <b class="num">${fmtSigned(u.mass(summary.impliedWeeklyKg), 2)} ${u.massLabel}/week</b>; ` +
        `the scale is doing <b class="num">${fmtSigned(u.mass(summary.weeklyRateKg), 2)}</b>. ` +
        (Math.abs(summary.impliedWeeklyKg - summary.weeklyRateKg) > 0.25
          ? 'The gap between those is what the estimate is currently resolving.'
          : 'Those agree, which means the estimate is well calibrated.'),
      ) : ''}
    `,
  });
}

function qualityCard(ctx) {
  const { maintenance } = ctx.snapshot;
  if (!maintenance?.dataQuality.issues.length) return '';
  const dq = maintenance.dataQuality;
  return card({
    title: 'What would sharpen this',
    body: `
      <div class="quality">
        <div class="quality__score num">${dq.score}<span>/100</span></div>
        <ul class="quality__list">
          ${dq.issues.map((i) => `<li class="quality__item quality__item--${esc(i.level)}">${esc(i.text)}</li>`).join('')}
        </ul>
      </div>`,
  });
}

/* ============================================================
   EMPTY STATE
   ============================================================ */

function emptyState() {
  return `
  <section class="card card--hero">
    <div class="hero">
      <div class="hero__label">Maintenance</div>
      <div class="hero__value num muted">—</div>
      <div class="hero__ci">Weigh in and log what you eat. This fills in.</div>
    </div>
    <div class="empty-steps">
      <ol>
        <li><b>Weigh daily</b> — first thing, after the bathroom, before eating. Same time every day matters more than the number.</li>
        <li><b>Log your calories.</b> Two weeks gives a first real estimate, six weeks a good one.</li>
        <li><b>Add steps and protein</b> when you can. Those two sharpen it most.</li>
      </ol>
    </div>
  </section>`;
}

/* ============================================================
   WIRING
   ============================================================ */

export function mountDashboard(root, ctx) {
  const setup = root.querySelector('[data-setup-form]');
  if (setup) {
    setup.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = {};
      for (const input of setup.querySelectorAll('input, select')) {
        if (!input.name) continue;
        data[input.name] = input.value === '' ? null : input.type === 'number' ? Number(input.value) : input.value;
      }
      const patch = {
        name: data.name ?? '',
        units: data.units,
        sex: data.sex,
        birthDate: data.birthDate,
        bodyFatPct: data.bodyFatPct,
        profileConfirmed: true,
      };
      if (data.heightFeet != null || data.heightInches != null) {
        patch.heightCm = (Number(data.heightFeet || 0) * 12 + Number(data.heightInches || 0)) * 2.54;
      } else if (data.heightCm != null) {
        patch.heightCm = data.heightCm;
      }
      ctx.store.updateProfile(patch);
      ctx.refresh();
    });
  }

  root.querySelector('[data-clear-demo]')?.addEventListener('click', async () => {
    await ctx.clearDemo();
  });
}
