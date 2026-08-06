/**
 * settingsView.js — "You": your details, your goal, your data.
 *
 * Ordering is the design here. The things that are *about you* and that you
 * will actually want to correct come first, in plain language. The modelling
 * knobs are real and stay available, but they sit behind a disclosure — they
 * are inspectable, not a decision you have to make before the app works.
 *
 * @module ui/settingsView
 */

import { card, field, selectField, toggleField, note, detail, esc, toast, confirmAction } from './components.js';
import { unitSystem, round, fmtInt, fmtNum, cmToFeetInches, feetInchesToCm } from '../core/units.js';
import { BMR_FORMULA_IDS, BMR_FORMULAS, compareFormulas } from '../energy/bmr.js';
import { OCCUPATIONS, OCCUPATION_IDS, FIDGET_LEVELS, LIFESTYLE_LEVELS } from '../energy/neat.js';
import { DEFAULT_TEF_COEFFICIENTS, TEF_COEFFICIENT_RANGES } from '../energy/tef.js';
import { PROVIDERS, PROVIDER_IDS } from '../data/integrations.js';
import { exportCsv, exportAnalyticsCsv, importCsv, downloadFile } from '../data/csv.js';
import { generateDemoData, demoProfile } from '../data/demo.js';
import { ageOn, todayISO } from '../core/time.js';
import { WISHNOFSKY_KCAL_PER_LB } from '../model/bodyComposition.js';

export function renderSettings(ctx) {
  const { profile } = ctx;
  const u = unitSystem(profile.units);

  return `
    <form data-settings-form autocomplete="off">
      ${aboutCard(profile, u)}
      ${goalCard(profile, u)}
      ${dayCard(profile)}
      ${displayCard(profile)}
      ${advancedCard(ctx, profile, u)}
    </form>
    ${dataCard(ctx)}
    ${howItWorksCard(ctx, u)}
  `;
}

/* ============================================================
   ABOUT YOU
   ============================================================ */

function aboutCard(profile, u) {
  const { feet, inches } = cmToFeetInches(profile.heightCm);
  const age = ageOn(profile.birthDate);

  return card({
    title: 'About you',
    subtitle: 'These drive the estimate. Get them right; the rest can wait.',
    accent: true,
    body: `
      <div class="grid grid--2">
        ${field({ label: 'Name', name: 'name', value: profile.name, type: 'text', placeholder: 'Optional' })}
        ${selectField({
          label: 'Units',
          name: 'units',
          value: profile.units,
          options: [
            { value: 'imperial', label: 'Pounds, feet, miles' },
            { value: 'metric', label: 'Kilograms, cm, km' },
          ],
        })}
        ${selectField({
          label: 'Sex',
          name: 'sex',
          value: profile.sex,
          options: [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }],
          hint: 'Used as the metabolic equations define it. If it does not describe you, the app corrects for the offset within a few weeks of your own data.',
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
          hint: 'Optional. If you know it, the estimate uses better equations and models weight change more accurately.',
        })}
      </div>
      ${age != null ? note(`Age ${age}. Your BMR updates automatically as you age and as your weight changes — you never need to come back and adjust it.`) : ''}
    `,
  });
}

/* ============================================================
   GOAL
   ============================================================ */

function goalCard(profile, u) {
  const g = profile.goal ?? {};
  return card({
    title: 'Your goal',
    body: `
      <div class="grid grid--2">
        ${selectField({
          label: 'I want to',
          name: 'goal.mode',
          value: g.mode,
          options: [
            { value: 'maintain', label: 'Hold my weight' },
            { value: 'lose', label: 'Lose fat' },
            { value: 'gain', label: 'Gain weight' },
          ],
        })}
        ${g.mode !== 'maintain' ? field({
          label: `At (${u.massLabel} per week)`,
          name: 'goal.weeklyRate',
          value: g.weeklyRateKg == null ? null : round(Math.abs(u.mass(g.weeklyRateKg)), 2),
          step: 0.05,
          min: 0,
          hint: 'Around 0.5–1% of your body weight per week. Faster than that costs disproportionate muscle.',
        }) : ''}
        ${field({
          label: `Target weight (${u.massLabel})`,
          name: 'goal.targetWeight',
          value: g.targetWeightKg == null ? null : round(u.mass(g.targetWeightKg), 1),
          step: 0.5,
        })}
      </div>
    `,
  });
}

/* ============================================================
   YOUR TYPICAL DAY
   ============================================================ */

function dayCard(profile) {
  const occ = OCCUPATIONS[profile.occupation] ?? OCCUPATIONS.desk;
  return card({
    title: 'Your typical day',
    subtitle: 'How much you move outside of workouts. This varies more between people than anything else.',
    body: `
      <div class="grid grid--2">
        ${selectField({
          label: 'Work',
          name: 'occupation',
          value: profile.occupation,
          options: OCCUPATION_IDS.filter((id) => id !== 'custom').map((id) => ({ value: id, label: OCCUPATIONS[id].label })),
        })}
        ${selectField({
          label: 'When steps are missing, assume',
          name: 'lifestyle',
          value: profile.lifestyle,
          options: Object.values(LIFESTYLE_LEVELS).map((l) => ({ value: l.id, label: `${l.label} — ~${l.steps.toLocaleString()} steps` })),
        })}
        ${selectField({
          label: 'Restlessness',
          name: 'fidget',
          value: profile.fidget,
          options: Object.values(FIDGET_LEVELS).map((f) => ({ value: f.id, label: f.label })),
          hint: 'Fidgeting and pacing genuinely differ by hundreds of calories a day between people.',
        })}
      </div>
      ${note(esc(occ.note))}
    `,
  });
}

/* ============================================================
   DISPLAY
   ============================================================ */

function displayCard(profile) {
  return card({
    title: 'How much to show',
    body: `
      ${selectField({
        label: 'Detail level',
        name: 'detailLevel',
        value: profile.detailLevel,
        options: [
          { value: 'simple', label: 'Simple — the number and what to eat' },
          { value: 'detailed', label: 'Detailed — full breakdowns, evidence and extra charts' },
        ],
      })}
      ${profile.detailLevel === 'simple'
        ? note('Simple mode hides the component breakdowns, the evidence tables and the extra charts. Nothing is turned off — the maths is identical, you are just not being shown all of it.')
        : note('Detailed mode adds where every calorie is accounted for, the week-by-week evidence, and the full chart set.')}
    `,
  });
}

/* ============================================================
   ADVANCED
   ============================================================ */

function advancedCard(ctx, profile, u) {
  const c = { ...DEFAULT_TEF_COEFFICIENTS, ...(profile.tefCoefficients || {}) };
  const t = profile.trendParams ?? {};
  const e = profile.engineParams ?? {};
  const selected = BMR_FORMULAS[profile.bmrFormula] ?? BMR_FORMULAS.mifflin;

  const tefRow = (key, label) => {
    const [lo, hi] = TEF_COEFFICIENT_RANGES[key];
    return field({
      label: `${label} (${Math.round(lo * 100)}–${Math.round(hi * 100)}%)`,
      name: `tef.${key}`,
      value: round(c[key] * 100, 1),
      step: 0.5,
      min: 0,
      max: 40,
      suffix: '%',
    });
  };

  return card({
    title: 'Advanced',
    subtitle: 'The defaults are sound. These exist so they are inspectable, not because you need to change them.',
    body: detail('Open advanced settings', `
      <h4 class="subhead">Metabolic rate equation</h4>
      ${selectField({
        label: 'Equation',
        name: 'bmrFormula',
        value: profile.bmrFormula,
        options: BMR_FORMULA_IDS.map((id) => ({
          value: id,
          label: BMR_FORMULAS[id].label + (BMR_FORMULAS[id].needsBodyFat ? ' — needs body fat' : ''),
        })),
      })}
      ${note(esc(selected.notes))}

      <h4 class="subhead">Digestion (TEF) coefficients</h4>
      <div class="grid grid--2">
        ${tefRow('protein', 'Protein')}
        ${tefRow('carb', 'Carbs')}
        ${tefRow('fat', 'Fat')}
        ${tefRow('alcohol', 'Alcohol')}
      </div>
      ${toggleField({
        label: 'Count fibre at 2 kcal/g instead of 4',
        name: 'applyFibreCorrection',
        checked: profile.applyFibreCorrection,
        hint: 'Off by default. Only turn on if your food database counts fibre inside total carbs, or you will subtract it twice.',
      })}

      <h4 class="subhead">Model behaviour</h4>
      ${toggleField({
        label: 'Learn a water-retention correction from my data',
        name: 'applyWaterModel',
        checked: profile.applyWaterModel !== false,
        hint: 'Works out how much of your daily fluctuation is sodium, carbs, alcohol, training and sleep — then removes it from the trend. Needs 21 days of complete logging.',
      })}
      ${toggleField({
        label: 'Assume resistance training preserves muscle',
        name: 'applyTrainingPartitioning',
        checked: profile.applyTrainingPartitioning !== false,
        hint: 'An assumption, not an established constant. Turn off for the pure Forbes model.',
      })}
      ${toggleField({
        label: 'Trust my watch’s calorie numbers over the app’s estimate',
        name: 'trustWearable',
        checked: profile.trustWearable !== false,
      })}
      ${toggleField({
        label: 'Subtract workout steps from daily movement',
        name: 'subtractExerciseSteps',
        checked: profile.subtractExerciseSteps !== false,
        hint: 'On by default. Stops a logged run being charged twice — once as exercise and again through the steps your watch recorded during it.',
      })}
      <div class="grid grid--2">
        ${field({
          label: 'Trend responsiveness',
          name: 'trend.slopeSigma',
          value: t.slopeSigma,
          step: 0.0005,
          hint: 'How readily the trend accepts that your rate of change has changed. Higher reacts faster and is noisier.',
        })}
        ${field({
          label: 'Maintenance drift',
          name: 'engine.processSdPerDay',
          value: e.processSdPerDay,
          step: 1,
          suffix: 'kcal',
          hint: 'How fast the estimate is allowed to move. Lower freezes it; higher chases noise.',
        })}
      </div>
      <button type="button" class="btn btn--ghost" data-reset-params>Restore defaults</button>
    `),
  });
}

/* ============================================================
   DATA
   ============================================================ */

function dataCard(ctx) {
  const range = ctx.store.dateRange;
  const demo = ctx.profile.demoLoaded;

  return card({
    title: 'Your data',
    subtitle: range
      ? `${range.count} days logged, ${esc(range.first)} to ${esc(range.last)}. Stored ${esc(ctx.store.adapter.name.toLowerCase())}.`
      : 'Nothing logged yet.',
    body: `
      ${demo ? note('<b>Sample data is loaded.</b> These numbers are simulated, not yours. Clear it before you start logging for real.', 'warn') : ''}
      <div class="btnrow">
        <button type="button" class="btn btn--ghost" data-export-csv>Export CSV</button>
        <button type="button" class="btn btn--ghost" data-export-json>Backup</button>
        <label class="btn btn--ghost">Import CSV<input type="file" accept=".csv,text/csv" data-import-csv hidden /></label>
        <label class="btn btn--ghost">Restore<input type="file" accept=".json,application/json" data-import-json hidden /></label>
      </div>
      ${detail('More about import & export', `
        <p>CSV import is column-mapped rather than tied to one app. It recognises the headers used by
        MyFitnessPal, Cronometer, Withings, Renpho and Health Auto Export, and handles variants like
        "Energy (kcal)" or "Weight (lbs)". Rows sharing a date are merged, so a weight export and a
        nutrition export can be imported separately. Unreadable rows are reported, never silently dropped.</p>
        <button type="button" class="btn btn--ghost" data-export-analytics>Export the analysis (trend, rates, estimates)</button>
      `)}
      <hr class="rule" />
      <div class="btnrow">
        ${demo
          ? `<button type="button" class="btn" data-clear-demo>Clear sample data</button>`
          : `<button type="button" class="btn btn--ghost" data-load-demo>Load sample data</button>`}
        <button type="button" class="btn btn--danger" data-reset-all>Erase everything</button>
      </div>
      ${!demo ? note('Sample data is 120 simulated days generated from a known true expenditure — useful for seeing how the app behaves once it has history. It replaces your profile and log, and can be cleared again.') : ''}
    `,
  });
}

/* ============================================================
   HOW IT WORKS
   ============================================================ */

function howItWorksCard(ctx, u) {
  const { snapshot, profile } = ctx;
  const m = snapshot.maintenance;
  const comp = snapshot.composition;

  const formulaTable = (() => {
    if (!snapshot.hasData) return '';
    const state = {
      weightKg: snapshot.trend?.current.trendKg ?? 80,
      heightCm: profile.heightCm,
      age: ageOn(profile.birthDate) ?? 30,
      sex: profile.sex,
      bodyFatPct: comp?.bodyFatPct ?? profile.bodyFatPct,
    };
    const rows = compareFormulas(state)
      .map((c) => `<tr class="${c.id === profile.bmrFormula ? 'row--active' : ''}">
          <td>${esc(c.label)}${c.id === profile.bmrFormula ? ' <span class="tag">in use</span>' : ''}</td>
          <td class="num">${c.kcal != null ? fmtInt(c.kcal) : '<span class="muted">needs body fat</span>'}</td>
        </tr>`)
      .join('');
    return `<div class="tablewrap"><table class="table"><tbody>${rows}</tbody></table></div>`;
  })();

  const evidenceTable = m
    ? `<div class="tablewrap"><table class="table">
        <thead><tr><th>Week</th><th class="num">Eaten</th><th class="num">Rate</th><th class="num">Implies</th></tr></thead>
        <tbody>${[...m.blocks].reverse().slice(0, 8).map((b) => b.usable
          ? `<tr><td>${esc(b.startDate.slice(5))}</td><td class="num">${fmtInt(b.meanIntake)}</td>
             <td class="num">${fmtNum(u.mass(b.weeklyRateKg), 2)}</td><td class="num">${fmtInt(b.observedMaintenance)}</td></tr>`
          : `<tr class="row--muted"><td>${esc(b.startDate.slice(5))}</td><td colspan="3" class="muted">${esc(b.reason)}</td></tr>`).join('')}
        </tbody></table></div>`
    : '';

  return card({
    title: 'How this works',
    body: `
      ${detail('The short version', `
        <p>There are two ways to know how much you burn. The textbook equations predict it from your
        height, weight, age and activity — available immediately, but wrong by up to 10% for any
        individual. The other way is arithmetic: if you ate 2,500 a day and lost half a kilo a week,
        your expenditure was higher than 2,500, and by a calculable amount.</p>
        <p>The second method is far better once you have data, but it is buried under water-weight
        noise early on. So the app starts at the equations and moves toward the arithmetic as evidence
        accumulates, weighting each by how reliable it currently is. That is the whole idea.</p>
      `)}

      ${detail('Why the scale lies, and what is done about it', `
        <p>Daily weight is a real number wrapped in about a kilogram of noise, and the noise is not
        random. Each gram of stored glycogen holds roughly three grams of water. Sodium expands
        extracellular fluid for a day or two. Hard training holds water while muscle repairs. Short
        sleep raises cortisol, which does the same.</p>
        <p>Rather than smoothing over all of it, the app learns <em>your</em> pattern: after 21 days
        it fits your daily deviations against your logged sodium, carbs, alcohol, training and sleep,
        and removes the predictable part before updating the trend. The correction is capped and
        centred so it can never move your actual weight — only decide which days to listen to.</p>
        ${snapshot.trend?.waterModel.applied
          ? `<p><b>Currently active</b> — your covariates explain ${(snapshot.trend.waterModel.r2 * 100).toFixed(0)}% of your day-to-day variation.</p>`
          : `<p class="muted">Not active yet. ${esc(snapshot.trend?.waterModel.reason ?? '')}</p>`}
      `)}

      ${detail('Why not 3,500 calories per pound', `
        <p>That rule assumes every pound is pure fat and that your expenditure never changes. Neither
        holds. Weight change is a mix of fat and lean tissue, and the mix depends on how lean you
        already are — lean tissue is mostly water and stores about a fifth as much energy.</p>
        ${comp?.density ? `<p>For your body composition the real figure is
          <b class="num">${fmtInt(u.imperial ? comp.density.kcalPerLb : comp.density.kcalPerKg)}</b> kcal
          per ${u.imperial ? 'pound' : 'kilogram'}, not ${WISHNOFSKY_KCAL_PER_LB.toLocaleString()} —
          about ${Math.abs(Math.round(((comp.density.kcalPerLb - WISHNOFSKY_KCAL_PER_LB) / WISHNOFSKY_KCAL_PER_LB) * 100))}%
          ${comp.density.kcalPerLb < WISHNOFSKY_KCAL_PER_LB ? 'lower' : 'higher'}.</p>` : ''}
      `)}

      ${formulaTable ? detail('The metabolic rate equations, side by side', `
        ${formulaTable}
        <p class="muted">They disagree, which is the point. That spread is roughly the uncertainty in
        any equation-based estimate, and it is why your own data is eventually allowed to overrule them.</p>
      `) : ''}

      ${evidenceTable ? detail('Week-by-week evidence', `
        ${evidenceTable}
        <p class="muted">A week counts only if you logged intake on at least 60% of days and weighed in
        at least twice. Weeks that miss the bar are shown with the reason rather than quietly dropped.</p>
      `) : ''}

      ${detail('What this number is not', `
        <p>It is maintenance <em>in the units you log in</em>. Most people under-record what they eat —
        studies using doubly-labelled water put the average near 20%. If you do that consistently, this
        number sits below your true expenditure by the same margin, which is exactly what you want:
        you will set targets in the same units you log in, so the bias cancels out.</p>
        <p>Do not compare it to an online TDEE calculator and conclude anything about your metabolism.</p>
      `)}

      ${detail('Where the data can come from', `
        <ul class="providers">
          ${PROVIDER_IDS.map((id) => {
            const p = PROVIDERS[id];
            const ok = p.status === 'available';
            return `<li class="provider"><div class="provider__head"><b>${esc(p.label)}</b>
              <span class="pill pill--${ok ? 'high' : 'low'}">${ok ? 'Available' : 'CSV only'}</span></div>
              <p class="muted">${esc(p.notes)}</p></li>`;
          }).join('')}
        </ul>
      `)}

      <p><a href="tests/index.html" class="link">Run the verification suite →</a>
      <span class="muted">108 checks, including recovering a known expenditure from simulated data.</span></p>
    `,
  });
}

/* ============================================================
   WIRING
   ============================================================ */

export function mountSettings(root, ctx) {
  const { store } = ctx;
  const form = root.querySelector('[data-settings-form]');

  if (form) {
    form.addEventListener('change', () => {
      const u = unitSystem(store.profile.units);
      const data = {};
      const nested = { tef: {}, trend: {}, engine: {}, goal: {} };

      for (const input of form.querySelectorAll('input, select, textarea')) {
        if (!input.name) continue;
        const raw = input.type === 'checkbox' ? input.checked : input.value;
        const value = input.type === 'checkbox' ? raw : raw === '' ? null : input.type === 'number' ? Number(raw) : raw;
        const [head, tail] = input.name.split('.');
        if (tail && nested[head]) nested[head][tail] = value;
        else data[input.name] = value;
      }

      if (data.heightFeet != null || data.heightInches != null) {
        data.heightCm = feetInchesToCm(data.heightFeet ?? 0, data.heightInches ?? 0);
      }
      delete data.heightFeet;
      delete data.heightInches;

      const patch = { ...data };
      // Any deliberate edit here counts as confirming the profile, which
      // retires the first-run prompt on the dashboard.
      patch.profileConfirmed = true;

      if (Object.keys(nested.tef).length) {
        patch.tefCoefficients = { ...store.profile.tefCoefficients };
        for (const [k, v] of Object.entries(nested.tef)) if (v != null) patch.tefCoefficients[k] = v / 100;
      }
      if (Object.keys(nested.trend).length) patch.trendParams = { ...store.profile.trendParams, ...nested.trend };
      if (Object.keys(nested.engine).length) patch.engineParams = { ...store.profile.engineParams, ...nested.engine };

      if (Object.keys(nested.goal).length) {
        const goal = { ...store.profile.goal, ...nested.goal };
        if (nested.goal.weeklyRate !== undefined) {
          // The rate field is entered as a magnitude; direction comes from mode.
          const magnitude = nested.goal.weeklyRate == null ? 0 : Math.abs(u.massIn(nested.goal.weeklyRate));
          goal.weeklyRateKg = magnitude;
          delete goal.weeklyRate;
        }
        if (nested.goal.targetWeight !== undefined) {
          goal.targetWeightKg = nested.goal.targetWeight == null ? null : u.massIn(nested.goal.targetWeight);
          delete goal.targetWeight;
        }
        const magnitude = Math.abs(goal.weeklyRateKg ?? 0);
        if (goal.mode === 'lose') goal.weeklyRateKg = -magnitude;
        else if (goal.mode === 'gain') goal.weeklyRateKg = magnitude;
        else goal.weeklyRateKg = 0;
        patch.goal = goal;
      }

      store.updateProfile(patch);
      ctx.refresh({ keepScroll: true });
    });
  }

  root.addEventListener('click', async (event) => {
    const target = event.target;

    if (target.closest('[data-export-csv]')) {
      downloadFile(`ember-log-${todayISO()}.csv`, exportCsv(store.entries));
      toast('Log exported.');
    }

    if (target.closest('[data-export-analytics]')) {
      const { trend, maintenance } = ctx.snapshot;
      if (!trend) return toast('Nothing to export yet.', 'warn');
      downloadFile(`ember-analysis-${todayISO()}.csv`, exportAnalyticsCsv({ trend, maintenance }));
      toast('Analysis exported.');
    }

    if (target.closest('[data-export-json]')) {
      downloadFile(`ember-backup-${todayISO()}.json`, store.exportJson(), 'application/json');
      toast('Backup saved.');
    }

    if (target.closest('[data-load-demo]')) {
      if (store.entries.length && !confirmAction('This replaces your profile and your logged days with 120 simulated ones. You can clear it again afterwards. Continue?')) return;
      const { days, truth } = generateDemoData();
      store.updateProfile({ ...demoProfile(), demoLoaded: true, profileConfirmed: true });
      store.upsertDays(days, { replace: true });
      toast(`Sample data loaded — its true expenditure was ${Math.round(truth.meanTrueTdee)} kcal.`);
      ctx.refresh();
    }

    if (target.closest('[data-clear-demo]')) {
      await ctx.clearDemo();
    }

    if (target.closest('[data-reset-params]')) {
      store.updateProfile({ trendParams: undefined, engineParams: undefined, tefCoefficients: undefined });
      toast('Model settings restored to defaults.');
      ctx.refresh();
    }

    if (target.closest('[data-reset-all]')) {
      if (!confirmAction('Erase every logged day and reset all settings? This cannot be undone.')) return;
      await store.reset();
      toast('Everything erased.');
      ctx.refresh();
    }
  });

  const csvInput = root.querySelector('[data-import-csv]');
  csvInput?.addEventListener('change', async () => {
    const file = csvInput.files?.[0];
    if (!file) return;
    const result = importCsv(await file.text());
    if (!result.days.length) {
      toast(result.errors[0]?.message ?? 'Nothing could be read from that file.', 'warn');
      return;
    }
    const { imported } = store.upsertDays(result.days);
    const errors = result.errors.length ? `, ${result.errors.length} rows skipped` : '';
    toast(`Imported ${imported} days${errors}.`);
    csvInput.value = '';
    ctx.refresh();
  });

  const jsonInput = root.querySelector('[data-import-json]');
  jsonInput?.addEventListener('change', async () => {
    const file = jsonInput.files?.[0];
    if (!file) return;
    if (!confirmAction('Restoring a backup replaces everything currently logged. Continue?')) {
      jsonInput.value = '';
      return;
    }
    try {
      const { days } = await store.importJson(await file.text());
      toast(`Restored ${days} days.`);
    } catch (err) {
      toast(`That file could not be read: ${err.message}`, 'warn');
    }
    jsonInput.value = '';
    ctx.refresh();
  });
}
