# Ember — maintenance intelligence

An adaptive maintenance-calorie tracker. It estimates your true total daily
energy expenditure by combining validated physiological equations with what
your own weight and intake actually did, and it gets more accurate the longer
you use it.

This is not a TDEE calculator. A calculator asks for your height and an
"activity level", multiplies, and hands you a number that is wrong by ±400 kcal
and stays wrong. Ember treats that number as a *starting hypothesis* and
revises it against evidence.

**Zero dependencies. No build step. Runs offline.** Native ES modules served as
static files.

---

## The core idea

Two independent sources of information about your expenditure exist:

| | What it is | Strength | Weakness |
|---|---|---|---|
| **Physiological model** | BMR + NEAT + EAT + TEF from published equations | Works from day one | ±8–10% on BMR alone; NEAT is nearly unknowable a priori |
| **Energy balance** | intake − (energy stored as tissue) | Measures *you*, not a population | Needs weeks of data; buried in scale noise |

Ember runs both, and combines them with a Bayesian filter that weights each by
how good it is. Early on the estimate sits near the equations. As logged weeks
accumulate, the evidence takes over — and the reported confidence interval
narrows to match. The dashboard shows the exact split, so you always know how
much of the number is prediction and how much is measurement.

---

## Using it

Four screens:

- **Today** — your maintenance figure with its margin, what to eat today, and your weight trend. That's it.
- **Log** — weight, calories, protein, steps. Everything else is one tap away under *More*.
- **Trends** — is my weight moving, did the estimate settle, where does this end up.
- **You** — your details, your goal, your data. Model internals live under *Advanced*; the science lives under *How this works*.

On first run it asks for height, date of birth and sex, because until those are right every number is about someone else. All of it stays editable under **You**.

**Simple is the default.** The full component breakdowns, week-by-week evidence tables and extra charts are real work and still there — switch *You → How much to show* to Detailed. The maths is identical either way; you're just choosing how much of it to look at.

## What it does that generic trackers do not

**Trend weight from a Kalman filter, not a moving average.** A 7-day rolling
mean lags half a window, gives you no rate estimate, and offers no uncertainty.
A local linear trend model tracks level and rate jointly, handles missing days
natively, and produces the rate variance the maintenance engine needs to size
its confidence interval. See [`src/stats/kalman.js`](src/stats/kalman.js).

**It learns your personal water-retention signature.** After 21 days of
complete logging, a cross-validated ridge regression fits your daily deviation
from trend against sodium, carbohydrate, alcohol, previous-day training load,
sleep deficit and stress. Each reading is corrected before it reaches the
filter — capped at 1.5% of body mass and mean-centred, so it can never shift
your absolute weight, only redistribute which days the trend listens to. On the
bundled demo data these covariates explain ~40% of daily variation. See
[`src/model/trendWeight.js`](src/model/trendWeight.js).

**TEF from actual macros, solved as a fixed point.** Most tools add a flat 10%.
A 200 g protein day and a 60 g protein day at identical calories differ by
100–150 kcal of thermic cost. And because TEF is a fraction of intake while
maintenance is what we are solving for, the correct closure is
`M = (BMR + NEAT + EAT) / (1 − f)`, not `× 1.10`.

**No 3,500 kcal per pound.** Tissue energy density is derived from Forbes'
partitioning relation applied to your current fat mass. For a lean person the
real figure is closer to 2,900 kcal/lb; with substantial fat mass it approaches
3,600. See [`src/model/bodyComposition.js`](src/model/bodyComposition.js).

**Exercise is never double-counted.** EAT is net of your own resting rate for
the session duration, and steps attributable to a logged run are removed from
NEAT before the ambulatory cost is computed. Skipping either produces a
permanent overestimate of a few hundred kcal a day for anyone who trains.

**Outliers are down-weighted, not deleted.** A 1.4 kg jump after a salty meal
is real water and carries genuine, diluted information. Huber weighting keeps
it in the filter at reduced influence; only physically implausible readings
(units mix-ups, typos) are rejected outright.

**Non-overlapping evidence.** The filter updates on weekly blocks, not rolling
windows. Rolling windows would feed the same days in seven times over and make
the interval look √7 tighter than the evidence supports. The rolling view still
exists on the Trends screen — it just does not get to vote.

---

## Accuracy — the actual claim

`tests/tests.js` generates a synthetic person whose true expenditure is a number
*we chose*, runs their body forward under real energy-balance physics, then
corrupts the observations the way reality does: water shifts from sodium and
carbohydrate, scale noise, missed weigh-ins, unlogged days.

The engine then has to recover the number.

```
✓ recovers true expenditure within ±100 kcal — cut, 2,500 kcal
✓ recovers true expenditure within ±100 kcal — maintenance, 2,900 kcal
✓ recovers true expenditure within ±100 kcal — surplus, 3,300 kcal
✓ recovers true expenditure within ±100 kcal — low maintenance
✓ reports an interval that actually contains the truth
✓ gets more accurate with more data, which is the entire premise
✓ converges toward intake when weight is genuinely stable
```

108 assertions total. Open [`tests/index.html`](tests/index.html) in a browser
to run them — no test runner, no install.

---

## What "maintenance" means here

**The adaptive estimate is maintenance in the units you log in.**

Doubly-labelled-water studies put average intake under-reporting near 20%
(Lichtman 1992). If your tracking systematically misses 10% of what you eat,
this number sits 10% below your true expenditure — and that is the *useful*
behaviour, because you will set targets in the same units you log in, so the
bias cancels.

Do not compare it against an online calculator and conclude your metabolism is
broken. The Model screen shows the ratio of observed to predicted expenditure;
values outside 0.85–1.15 almost always indicate logging bias rather than
physiology.

---

## Architecture

Strict layering. Nothing in `ui/` imports a statistics module directly;
everything goes through the `model/engine.js` façade.

```
src/
├── core/                 units, dates, physiological constants (all cited)
│   ├── constants.js
│   ├── units.js
│   └── time.js
├── energy/               the physiological model
│   ├── bmr.js            Mifflin, Harris–Benedict, Katch, Cunningham, Ten Haaf
│   ├── neat.js           steps + occupation + posture + spontaneous
│   ├── metTable.js       Compendium activities with MET ranges
│   ├── eat.js            wearable → heart rate → pace → MET, in that order
│   ├── tef.js            macro-specific thermic cost, fixed-point solve
│   └── tdee.js           composition, with double-count guards
├── stats/                the statistical machinery
│   ├── descriptive.js    means, medians, MAD, OLS, Theil–Sen
│   ├── smoothing.js      EWMA, Holt
│   ├── kalman.js         local linear trend + RTS smoother
│   ├── regression.js     ridge with k-fold CV
│   ├── outliers.js       Hampel, Huber, plausibility
│   └── bayes.js          conjugate Gaussian updating
├── model/                domain modelling
│   ├── bodyComposition.js  Forbes partitioning, tissue energy density
│   ├── trendWeight.js      Kalman + learned water correction
│   ├── maintenance.js      the adaptive engine
│   ├── projection.js       forward simulation with adaptation
│   └── engine.js           memoised façade for the UI
├── data/                 persistence and portability
│   ├── schema.js         validation, normalisation, migration
│   ├── store.js          repository + adapter interface
│   ├── supabaseAdapter.js  optional cloud sync, plain fetch
│   ├── csv.js            column-mapped import, two export formats
│   ├── integrations.js   provider contract for wearables
│   └── demo.js           ground-truth synthetic data
├── ui/                   views (pure functions of a context object)
└── app.js                shell, routing, render loop
```

**Swapping a formula** means adding an entry to the registry in `bmr.js` — no
consumer changes. **Swapping storage** means implementing four methods
(`load`, `save`, `clear`, `name`). **Adding a wearable** means implementing
`connect` / `fetchRange` / `normalise` and registering it.

---

## Running it

Any static server:

```bash
python3 -m http.server -d tdee-tracker 5176
```

Then open `http://localhost:5176`. ES modules need HTTP — opening
`index.html` from the filesystem will not work.

Deploying to Vercel: point it at this directory, no build command, no output
directory. `vercel.json` is already configured.

### Optional cloud sync

Everything works offline against `localStorage` by default. For sync across
devices:

1. Run [`schema.sql`](schema.sql) in the Supabase SQL editor.
2. Create `config.js` next to `index.html`:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_ANON_KEY: "...",
  PROFILE_ID: "jawad",
};
```

3. Uncomment the `<script src="config.js">` tag in `index.html`. It ships
   commented out because a missing `config.js` 404s, and with
   `X-Content-Type-Options: nosniff` set that logs a console error on every
   page load for a file most installs never have.

`config.js` is gitignored — keep it that way, the repo is public.

The adapter uses plain `fetch` against PostgREST — no SDK, no script tag. It
keeps a local mirror, so a network failure degrades to offline rather than to
data loss. **Read the RLS section of `schema.sql` before using it**: the
default policies match the other trackers in this repo (anon role, profiles
identified by a text id), which is appropriate for a private tracker on an
unguessable URL and not for anything you consider sensitive.

---

## Getting a good estimate quickly

In rough order of value per unit of effort:

1. **Weigh daily**, same conditions — first thing, after the bathroom, before
   eating. More weigh-ins narrow the interval faster than more elapsed time.
2. **Log intake every day**, including the bad ones. An unlogged day widens the
   interval more than an inaccurate one, because the engine has to assume a
   wide distribution for what you ate.
3. **Log steps.** NEAT is the most variable component of expenditure and step
   count is the only cheap handle on it.
4. **Log protein.** It is most of the TEF signal.
5. **Log sodium and sleep** if you want the water-retention model, which needs
   21 complete days before it activates.

Expect a usable estimate at two weeks, a good one at six, and a genuinely tight
one (±60–80 kcal) after three months of consistent logging.

---

## Modelling assumptions, stated plainly

These are the places where the model could be wrong. All are exposed as
settings.

- **Resistance-training partitioning** shifts the lean fraction of weight change
  by up to ±0.12 when training and protein intake are both adequate. Forbes'
  relation was fitted mostly to untrained weight loss; this adjustment is a
  reasonable extrapolation, not an established constant. Switch it off for the
  pure model.
- **Adaptive thermogenesis** is modelled as β = 0.12 of a sustained intake
  change with a 14-day time constant, capped at 15% of maintenance. Individual
  responses vary widely.
- **Sleep and stress do not adjust expenditure.** The evidence for a
  quantifiable daily effect is too weak. They are used only to explain scale
  noise, which is well supported.
- **MET values are population averages.** "Cycling, moderate" spans a two-fold
  range of real intensities. Heart rate is better where it applies; a device
  figure you trust is better still.
- **Heart-rate energy estimation is refused for lifting**, where heart rate
  reflects pressor response rather than oxygen cost.
- **The estimate is clamped** at 4 prior SDs from the physiological prediction.
  Travelling further usually means a logging error, not a metabolism.

---

## Key references

- Mifflin MD, et al. *Am J Clin Nutr.* 1990;51(2):241-247 — BMR
- Roza AM, Shizgal HM. *Am J Clin Nutr.* 1984;40(1):168-182 — Harris–Benedict revision
- Cunningham JJ. *Am J Clin Nutr.* 1980;33(11):2372-2374 — FFM-based BMR
- Ten Haaf T, Weijs PJM. *PLoS One.* 2014;9(9):e108460 — athlete BMR
- Ainsworth BE, et al. *Med Sci Sports Exerc.* 2011;43(8):1575-1581 — MET compendium
- Keytel LR, et al. *J Sports Sci.* 2005;23(3):289-297 — HR energy expenditure
- Levine JA, et al. *Science.* 1999;283(5399):212-214 — NEAT
- Westerterp KR. *Nutr Metab (Lond).* 2004;1(1):5 — diet-induced thermogenesis
- Forbes GB. *Ann N Y Acad Sci.* 2000;904:359-365 — body-composition partitioning
- Hall KD. *Int J Obes.* 2008;32(3):573-576 — energy density of weight change
- Hall KD, et al. *Lancet.* 2011;378(9793):826-837 — dynamic weight model
- Thomas DM, et al. *Am J Clin Nutr.* 2010;92(6):1326-1331 — why 3,500 kcal/lb fails
- Lichtman SW, et al. *N Engl J Med.* 1992;327(27):1893-1898 — intake under-reporting
- Harvey AC. *Structural Time Series Models and the Kalman Filter.* CUP; 1989

---

## Not medical advice

This is a personal measurement tool. It models energy balance; it does not
account for medication, endocrine conditions, pregnancy, or eating disorders,
and it should not be used to manage any of them.
