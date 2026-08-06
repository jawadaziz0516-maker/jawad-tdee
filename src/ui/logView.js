/**
 * logView.js — daily entry.
 *
 * Saves on change, no Save button. Logging friction is the binding constraint
 * on the whole application: an estimate built from four days a week is
 * materially worse than one built from seven, so every avoidable tap is an
 * accuracy cost.
 *
 * Which is also why only four fields are visible by default. Weight, calories,
 * protein and steps carry almost all of the signal; sodium, fibre and stress
 * are genuinely useful but nobody logs them if they have to scroll past them
 * every day. They sit one tap away under "More".
 *
 * @module ui/logView
 */

import { card, field, selectField, textareaField, segmented, esc, note, detail } from './components.js';
import { unitSystem, fmtInt, round } from '../core/units.js';
import { fmtDateRelative, todayISO, addDays } from '../core/time.js';
import { activityGroups, ACTIVITIES } from '../energy/metTable.js';
import { estimateExercise } from '../energy/eat.js';
import { plausibilityCheck } from '../stats/outliers.js';

export function renderLog(ctx) {
  const { store, focusDate, profile } = ctx;
  const u = unitSystem(profile.units);
  const day = store.getOrCreateDay(focusDate);
  const isToday = focusDate === todayISO();

  return `
    <div class="datebar">
      <button class="iconbtn" data-nav-day="-1" aria-label="Previous day">‹</button>
      <div class="datebar__center">
        <span class="datebar__label">${esc(fmtDateRelative(focusDate))}</span>
        <input type="date" class="datebar__input" data-date-input value="${esc(focusDate)}" max="${esc(todayISO())}" />
      </div>
      <button class="iconbtn" data-nav-day="1" aria-label="Next day"${isToday ? ' disabled' : ''}>›</button>
    </div>

    <form data-day-form autocomplete="off">
      ${essentialsCard(day, u, ctx)}
      ${exerciseCard(day, ctx, u)}
      ${moreCard(day, u, profile)}
      ${notesCard(day)}
    </form>
  `;
}

/* ============================================================
   THE FOUR THAT MATTER
   ============================================================ */

function essentialsCard(day, u, ctx) {
  const i = day.intake || {};
  // One decimal. Converting kg→lb for display otherwise surfaces artefacts
  // like "167.99" that read as false precision on a scale that shows 168.0.
  const displayWeight = day.weightKg == null ? null : round(u.mass(day.weightKg), 1);

  // Plausibility against the most recent earlier reading.
  let warning = '';
  const previous = [...ctx.store.entries]
    .filter((d) => d.date < day.date && Number.isFinite(d.weightKg))
    .pop();
  if (day.weightKg != null && previous) {
    const check = plausibilityCheck(day.weightKg, previous.weightKg, 1);
    if (!check.ok) warning = note(check.issues.join(' '), check.severity === 'error' ? 'warn' : 'info');
  }

  return card({
    body: `
      <div class="grid grid--2">
        ${field({
          label: 'Weight',
          name: 'weightKg',
          value: displayWeight,
          step: u.imperial ? 0.2 : 0.1,
          suffix: u.massLabel,
          hint: 'Same time every day — first thing, after the bathroom, before eating or drinking. Consistency matters far more than the number.',
        })}
        ${field({ label: 'Calories', name: 'intake.kcal', value: i.kcal, step: 10, suffix: 'kcal' })}
        ${field({
          label: 'Protein',
          name: 'intake.protein',
          value: i.protein,
          step: 1,
          suffix: 'g',
          hint: 'The most valuable macro to log — protein costs far more energy to digest than carbs or fat, and that difference is worth 100+ kcal a day.',
        })}
        ${field({
          label: 'Steps',
          name: 'steps',
          value: day.steps,
          step: 100,
          hint: 'The best single handle on how much you move outside workouts, which varies more between people than anything else.',
        })}
      </div>
      ${warning}
    `,
  });
}

/* ============================================================
   EXERCISE
   ============================================================ */

function exerciseCard(day, ctx, u) {
  const { profile, snapshot } = ctx;
  const bmrKcal = snapshot?.today?.bmrKcal ?? 1700;
  const weightKg = snapshot?.trend?.current.trendKg ?? day.weightKg ?? 80;
  const detailed = profile.detailLevel === 'detailed';

  const groups = activityGroups().map((g) => ({
    group: g.group,
    items: g.items.map((a) => ({ value: a.id, label: a.label })),
  }));

  const rows = (day.exercise || [])
    .map((ex, index) => {
      const activity = ACTIVITIES[ex.activityId] ?? ACTIVITIES.custom;
      const est = estimateExercise(ex, {
        weightKg, bmrKcal, age: 30, sex: profile.sex,
        heightCm: profile.heightCm, vo2max: profile.vo2max,
      }, { trustWearable: profile.trustWearable !== false });

      return `
      <div class="exercise" data-exercise-index="${index}">
        <div class="exercise__head">
          <span class="exercise__badge exercise__badge--${esc(est.source)}">${esc(sourceLabel(est.source))}</span>
          <b class="num">${fmtInt(est.netKcal)} kcal</b>
          <button type="button" class="iconbtn iconbtn--ghost" data-remove-exercise="${index}" aria-label="Remove">×</button>
        </div>
        <div class="grid grid--2">
          ${selectField({ label: 'Activity', name: `ex.${index}.activityId`, value: ex.activityId, options: groups })}
          ${field({ label: 'Minutes', name: `ex.${index}.minutes`, value: ex.minutes, step: 5, suffix: 'min' })}
        </div>
        ${detail('Make this more accurate', `
          <div class="grid grid--2">
            ${activity.speedModel ? field({
              label: 'Distance',
              name: `ex.${index}.distanceKm`,
              value: ex.distanceKm == null ? null : round(u.distance(ex.distanceKm), 2),
              step: 0.1,
              suffix: u.distanceLabel,
            }) : ''}
            ${field({
              label: 'Average heart rate',
              name: `ex.${index}.avgHr`,
              value: ex.avgHr,
              step: 1,
              suffix: 'bpm',
              hint: 'Beats the generic table for steady cardio. Ignored for lifting, where heart rate spikes without a matching energy cost.',
            })}
            ${field({ label: 'How hard (1–10)', name: `ex.${index}.rpe`, value: ex.rpe, step: 1, min: 1, max: 10 })}
            ${field({
              label: 'Watch calories',
              name: `ex.${index}.wearableKcal`,
              value: ex.wearableKcal,
              step: 10,
              suffix: 'kcal',
              hint: 'Overrides the app’s estimate entirely.',
            })}
            ${ex.activityId === 'custom' ? field({ label: 'MET value', name: `ex.${index}.customMet`, value: ex.customMet, step: 0.1 }) : ''}
          </div>
          <label class="check">
            <input type="checkbox" name="ex.${index}.wearableIsNet"${ex.wearableIsNet ? ' checked' : ''} />
            <span>That watch figure already excludes resting burn (Apple “Active Energy”, Garmin “Active Calories”)</span>
          </label>
          <p class="muted">${esc(est.rationale)}</p>
        `)}
        ${detailed ? `<p class="exercise__rationale muted">${esc(est.rationale)}</p>` : ''}
      </div>`;
    })
    .join('');

  return card({
    title: 'Exercise',
    body: `
      ${rows || '<p class="muted">Nothing logged for this day.</p>'}
      <button type="button" class="btn btn--ghost" data-add-exercise>+ Add a session</button>
    `,
  });
}

function sourceLabel(source) {
  return { wearable: 'Watch', heartRate: 'Heart rate', speed: 'Pace', met: 'Estimated' }[source] ?? source;
}

/* ============================================================
   EVERYTHING ELSE
   ============================================================ */

function moreCard(day, u, profile) {
  const i = day.intake || {};
  const macroKcal = (i.protein || 0) * 4 + (i.carbs || 0) * 4 + (i.fat || 0) * 9 + (i.alcohol || 0) * 7;
  const diff = Number.isFinite(i.kcal) && macroKcal > 0 ? i.kcal - macroKcal : null;

  const body = `
    <h4 class="subhead">Rest of the macros</h4>
    <div class="grid grid--2">
      ${field({ label: 'Carbs', name: 'intake.carbs', value: i.carbs, step: 1, suffix: 'g' })}
      ${field({ label: 'Fat', name: 'intake.fat', value: i.fat, step: 1, suffix: 'g' })}
      ${field({ label: 'Fibre', name: 'intake.fiber', value: i.fiber, step: 1, suffix: 'g' })}
      ${field({
        label: 'Alcohol',
        name: 'intake.alcohol',
        value: i.alcohol,
        step: 1,
        suffix: 'g',
        hint: 'Grams of ethanol — a standard drink is about 14 g.',
      })}
    </div>
    ${diff != null && Math.abs(diff) > 60 ? note(
      `Your macros account for ${fmtInt(macroKcal)} of the ${fmtInt(i.kcal)} calories logged.`,
    ) : ''}

    <h4 class="subhead">Body</h4>
    ${field({
      label: 'Body fat',
      name: 'bodyFatPct',
      value: day.bodyFatPct,
      step: 0.1,
      suffix: '%',
      hint: 'Only if you measured it today.',
    })}

    <h4 class="subhead">Why the scale might be off today</h4>
    ${note('These do not change your calorie burn. They let the app work out how much of a weird scale reading is water rather than fat.')}
    <div class="grid grid--2">
      ${field({ label: 'Sleep', name: 'sleepHours', value: day.sleepHours, step: 0.25, suffix: 'h' })}
      ${field({ label: 'Sodium', name: 'sodiumMg', value: day.sodiumMg, step: 100, suffix: 'mg' })}
      ${field({
        label: 'Water',
        name: 'waterMl',
        value: day.waterMl == null ? null : round(u.volume(day.waterMl), 0),
        step: u.imperial ? 8 : 250,
        suffix: u.volumeLabel,
      })}
      ${field({
        label: 'Movement override',
        name: 'neatOverrideKcal',
        value: day.neatOverrideKcal,
        step: 25,
        suffix: 'kcal',
        hint: 'Replaces the app’s non-exercise estimate for this day.',
      })}
    </div>
    ${segmented({
      label: 'Stress',
      name: 'stress',
      value: day.stress,
      options: [1, 2, 3, 4, 5].map((v) => ({ value: v, label: String(v) })),
    })}
    ${segmented({
      label: 'Sleep quality',
      name: 'sleepQuality',
      value: day.sleepQuality,
      options: [1, 2, 3, 4, 5].map((v) => ({ value: v, label: String(v) })),
    })}
  `;

  // In detailed mode these are expanded by default; in simple mode they are a
  // single tap away and stay out of the daily path.
  return card({
    body: profile.detailLevel === 'detailed'
      ? body
      : detail('More — macros, sleep, sodium, stress', body),
  });
}

function notesCard(day) {
  return card({
    body: textareaField({
      label: 'Notes',
      name: 'notes',
      value: day.notes,
      rows: 2,
      placeholder: 'Travel, illness, a big meal out — anything that might explain a reading later.',
    }),
  });
}

/* ============================================================
   EVENT WIRING
   ============================================================ */

export function mountLog(root, ctx) {
  const { store, profile } = ctx;
  const u = unitSystem(profile.units);
  const form = root.querySelector('[data-day-form]');
  if (!form) return;

  const commit = (name, rawValue, type) => {
    const date = ctx.focusDate;
    const day = store.getOrCreateDay(date);

    const exMatch = name.match(/^ex\.(\d+)\.(.+)$/);
    if (exMatch) {
      const [, idxStr, key] = exMatch;
      const index = Number(idxStr);
      const list = [...(day.exercise || [])];
      if (!list[index]) return;
      let value = rawValue;
      if (key === 'wearableIsNet') value = rawValue === true;
      else if (value === '' || value == null) value = null;
      else value = key === 'activityId' ? value : Number(value);
      if (key === 'distanceKm' && value != null) value = u.distanceIn(value);
      list[index] = { ...list[index], [key]: value };
      store.updateDay(date, { exercise: list });
      ctx.refresh({ keepScroll: true });
      return;
    }

    let value = rawValue === '' || rawValue == null ? null : rawValue;
    if (type === 'number' && value != null) value = Number(value);
    if (name === 'weightKg' && value != null) value = u.massIn(value);
    if (name === 'waterMl' && value != null) value = u.volumeIn(value);

    if (name.startsWith('intake.')) store.updateDay(date, { intake: { [name.slice(7)]: value } });
    else store.updateDay(date, { [name]: value });

    ctx.refresh({ keepScroll: true });
  };

  form.addEventListener('change', (event) => {
    const input = event.target;
    if (!input.name) return;
    commit(input.name, input.type === 'checkbox' ? input.checked : input.value, input.type);
  });

  // Commit on blur too, so a value typed and then navigated away from is never
  // lost to a view change.
  form.addEventListener('blur', (event) => {
    const input = event.target;
    if (!input.name || input.tagName === 'SELECT' || input.type === 'checkbox') return;
    commit(input.name, input.value, input.type);
  }, true);

  root.addEventListener('click', (event) => {
    const seg = event.target.closest('[data-seg]');
    if (seg) {
      const wasActive = seg.classList.contains('is-active');
      store.updateDay(ctx.focusDate, { [seg.dataset.seg]: wasActive ? null : Number(seg.dataset.value) });
      ctx.refresh({ keepScroll: true });
      return;
    }

    if (event.target.closest('[data-add-exercise]')) {
      const day = store.getOrCreateDay(ctx.focusDate);
      store.updateDay(ctx.focusDate, {
        exercise: [...(day.exercise || []), { activityId: 'weights', minutes: 60, rpe: 7 }],
      });
      ctx.refresh({ keepScroll: true });
      return;
    }

    const remove = event.target.closest('[data-remove-exercise]');
    if (remove) {
      const index = Number(remove.dataset.removeExercise);
      const day = store.getOrCreateDay(ctx.focusDate);
      store.updateDay(ctx.focusDate, { exercise: (day.exercise || []).filter((_, i) => i !== index) });
      ctx.refresh({ keepScroll: true });
      return;
    }

    const nav = event.target.closest('[data-nav-day]');
    if (nav) {
      const next = addDays(ctx.focusDate, Number(nav.dataset.navDay));
      if (next <= todayISO()) ctx.setFocusDate(next);
    }
  });

  root.querySelector('[data-date-input]')?.addEventListener('change', (event) => {
    if (event.target.value) ctx.setFocusDate(event.target.value);
  });
}
