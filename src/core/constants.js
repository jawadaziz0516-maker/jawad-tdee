/**
 * constants.js — physiological and unit constants.
 *
 * Every constant here carries its provenance. If a number cannot be traced to
 * a peer-reviewed source or a first-principles derivation, it does not belong
 * in this file — put it in `defaults.js` as a tunable assumption instead.
 *
 * @module core/constants
 */

/* ============================================================
   UNITS
   ============================================================ */

export const KG_PER_LB = 0.45359237;          // exact, NIST
export const LB_PER_KG = 1 / KG_PER_LB;
export const CM_PER_IN = 2.54;                // exact
export const KM_PER_MILE = 1.609344;          // exact
export const ML_PER_FL_OZ = 29.5735295625;    // exact (US fluid ounce)

/* ============================================================
   INDIRECT CALORIMETRY
   ============================================================ */

/**
 * Energy yield per litre of O2 consumed. Varies with substrate mix:
 * 4.686 kcal/L at RER 0.70 (pure fat) → 5.047 kcal/L at RER 1.00 (pure carb).
 * 5.0 is the conventional mixed-diet value embedded in the standard MET
 * equation, and is used here for internal consistency with that equation.
 * Ref: Weir JB. J Physiol. 1949;109(1-2):1-9.
 */
export const KCAL_PER_L_O2 = 5.0;

/**
 * 1 metabolic equivalent (MET) = 3.5 mL O2 · kg⁻¹ · min⁻¹.
 * Ref: Jetté M, et al. Clin Cardiol. 1990;13(8):555-565.
 *
 * NOTE: 1 MET is a *population convention*, not the individual's true resting
 * rate. For a person whose measured RMR differs from 3.5 mL/kg/min, MET-derived
 * costs carry that error. `energy/eat.js` corrects for this by subtracting the
 * individual's own BMR over the exercise duration rather than 1.0 MET.
 */
export const ML_O2_PER_MET_KG_MIN = 3.5;

/** kcal · kg⁻¹ · h⁻¹ per MET = 3.5 mL/kg/min × 60 min × 5 kcal/L ÷ 1000 mL/L */
export const KCAL_PER_MET_KG_HOUR =
  (ML_O2_PER_MET_KG_MIN * 60 * KCAL_PER_L_O2) / 1000; // = 1.05

/* ============================================================
   MACRONUTRIENT ENERGY (Atwater general factors)
   ============================================================ */

export const ATWATER = {
  protein: 4,   // kcal/g
  carb: 4,      // kcal/g (includes fibre under US labelling convention)
  fat: 9,       // kcal/g
  alcohol: 7,   // kcal/g
};

/**
 * Metabolisable energy actually yielded by dietary fibre, versus the 4 kcal/g
 * that US Nutrition Facts labelling attributes to it inside total carbohydrate.
 * Soluble fibre ferments to SCFA (~2 kcal/g); insoluble is largely unavailable.
 * Ref: EFSA NDA Panel. EFSA Journal. 2010;8(3):1462 (EU uses 2 kcal/g).
 *
 * Applied only when `settings.applyFibreCorrection` is on — see energy/tef.js.
 */
export const FIBRE_METABOLISABLE_KCAL_PER_G = 2;

/* ============================================================
   TISSUE ENERGY DENSITY & PARTITIONING
   ============================================================ */

/**
 * Energy density of the tissue gained or lost. These replace the folk
 * "3500 kcal per pound" rule, which assumes 100% adipose tissue and a static
 * expenditure — both false in practice.
 *
 * Adipose: ~87% lipid by mass × 9.4 kcal/g ≈ 9440 kcal/kg (4283 kcal/lb)
 * Lean:    hydrated protein, ~1810 kcal/kg (821 kcal/lb)
 * Ref: Hall KD. Int J Obes. 2008;32(3):573-576.
 */
export const TISSUE = {
  FAT_KCAL_PER_KG: 9440,
  LEAN_KCAL_PER_KG: 1810,
};

/**
 * Forbes' constant for the fat-free / fat mass partitioning of weight change.
 * dFFM/dFM = C / FM, i.e. the leaner you are, the larger the share of any
 * weight change that comes from lean tissue.
 * Ref: Forbes GB. Ann N Y Acad Sci. 2000;904:359-365.
 */
export const FORBES_C_KG = 10.4;

/* ============================================================
   AMBULATORY ENERGY COST
   ============================================================ */

/**
 * Net (above-resting) horizontal walking cost, derived from the ACSM walking
 * equation: VO2 = 0.1 · S + 3.5, where S is speed in m·min⁻¹.
 *   0.1 mL O2 · kg⁻¹ · m⁻¹ × 1000 m = 100 mL/kg/km = 0.1 L/kg/km
 *   0.1 L/kg/km × 5 kcal/L = 0.5 kcal · kg⁻¹ · km⁻¹
 * Ref: ACSM's Guidelines for Exercise Testing and Prescription, 11th ed.
 */
export const WALK_NET_KCAL_PER_KG_KM = 0.5;

/**
 * Net horizontal running cost, from the ACSM running equation
 * VO2 = 0.2 · S + 3.5 → 0.2 mL O2/kg/m → 1.0 kcal · kg⁻¹ · km⁻¹.
 * Running cost is famously near-independent of speed; walking is not.
 */
export const RUN_NET_KCAL_PER_KG_KM = 1.0;

/**
 * Stride length as a fraction of standing height, for converting step counts
 * to distance when the wearable reports only steps.
 * Ref: Bohannon RW. Age Ageing. 1997;26(1):15-19 (walking speed/stride norms).
 */
export const STRIDE_TO_HEIGHT_RATIO = 0.415;

/**
 * Energy premium of standing over sitting, ≈ 0.2 kcal/min for a ~80 kg adult,
 * normalised to body mass. Small per hour, meaningful across a work day.
 * Ref: Levine JA, et al. Am J Clin Nutr. 2000;72(6):1451-1454.
 */
export const STANDING_PREMIUM_KCAL_PER_KG_H = 0.15;

/* ============================================================
   METABOLIC ADAPTATION
   ============================================================ */

/**
 * Adaptive thermogenesis: the component of expenditure that falls beyond what
 * the loss of tissue mass alone explains, expressed as a fraction of the
 * sustained change in energy intake, with a first-order time constant.
 * Ref: Hall KD, et al. Am J Clin Nutr. 2011;93(5):989-994 (dynamic model);
 *      Rosenbaum M, Leibel RL. Int J Obes. 2010;34(S1):S47-S55.
 */
export const ADAPTATION = {
  /** Fraction of a sustained intake change absorbed by adaptation. */
  BETA: 0.12,
  /** Time constant of the adaptation response, days. */
  TAU_DAYS: 14,
  /** Hard ceiling on adaptation as a fraction of baseline maintenance. */
  MAX_FRACTION: 0.15,
};

/* ============================================================
   STATISTICS
   ============================================================ */

/** Scale factor making the median absolute deviation a consistent estimator
 *  of σ for normally distributed data. */
export const MAD_TO_SIGMA = 1.4826;

/** z for a two-sided 95% interval. */
export const Z_95 = 1.959964;

/** z for a two-sided 68% (±1σ) interval. */
export const Z_68 = 1.0;
