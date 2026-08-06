/**
 * regression.js — small dense linear algebra and ridge regression.
 *
 * Used by model/trendWeight.js to learn how much of each day's scale deviation
 * is attributable to water-shifting covariates (sodium, carbohydrate, alcohol,
 * hard training, poor sleep) rather than to a real change in tissue mass.
 *
 * Ridge rather than OLS because the covariates are correlated with each other
 * — a big carbohydrate day is usually also a big sodium day — and because with
 * six predictors and forty observations OLS will happily fit noise.
 *
 * @module stats/regression
 */

/**
 * Solve A·x = b by Gaussian elimination with partial pivoting.
 * @param {number[][]} A  square, n×n
 * @param {number[]} b
 * @returns {number[]|null} null if singular
 */
export function solve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  // Elimination ran against every row, not just those below the pivot, so M is
  // now diagonal and each unknown reads straight off.
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Ridge regression with standardised predictors and an unpenalised intercept.
 *
 * @param {number[][]} X   n rows × p columns, no intercept column
 * @param {number[]} y     length n
 * @param {number} lambda  penalty on the standardised scale
 * @returns {{
 *   coefficients: number[],   in ORIGINAL predictor units
 *   intercept: number,
 *   standardised: number[],   comparable across predictors
 *   means: number[], sds: number[],
 *   r2: number, n: number, p: number,
 *   predict: (row: number[]) => number,
 *   residualSd: number
 * }|null}
 */
export function ridge(X, y, lambda = 1.0) {
  const n = X.length;
  if (!n || !X[0]) return null;
  const p = X[0].length;
  if (n <= p + 1) return null;

  // Standardise predictors; centre the response.
  const means = [];
  const sds = [];
  for (let j = 0; j < p; j++) {
    const col = X.map((r) => r[j]);
    const m = col.reduce((s, v) => s + v, 0) / n;
    const sd = Math.sqrt(col.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, n - 1));
    means.push(m);
    sds.push(sd > 1e-9 ? sd : 1); // constant column → leave it alone
  }
  const Z = X.map((r) => r.map((v, j) => (v - means[j]) / sds[j]));
  const yMean = y.reduce((s, v) => s + v, 0) / n;
  const yc = y.map((v) => v - yMean);

  // (ZᵀZ + λI) β = Zᵀ y
  const ZtZ = Array.from({ length: p }, () => new Array(p).fill(0));
  const Zty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      Zty[j] += Z[i][j] * yc[i];
      for (let k = j; k < p; k++) ZtZ[j][k] += Z[i][j] * Z[i][k];
    }
  }
  for (let j = 0; j < p; j++) {
    for (let k = 0; k < j; k++) ZtZ[j][k] = ZtZ[k][j];
    ZtZ[j][j] += lambda;
  }

  const beta = solve(ZtZ, Zty);
  if (!beta) return null;

  // Back out to original units.
  const coefficients = beta.map((b, j) => b / sds[j]);
  const intercept = yMean - coefficients.reduce((s, c, j) => s + c * means[j], 0);
  const predict = (row) => intercept + row.reduce((s, v, j) => s + v * coefficients[j], 0);

  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    sse += (y[i] - predict(X[i])) ** 2;
    sst += (y[i] - yMean) ** 2;
  }

  return {
    coefficients,
    intercept,
    standardised: beta,
    means,
    sds,
    r2: sst > 0 ? 1 - sse / sst : 0,
    n,
    p,
    predict,
    residualSd: Math.sqrt(sse / Math.max(1, n - p - 1)),
  };
}

/**
 * Choose λ by leave-one-out-ish k-fold cross-validation over a log grid.
 * Prevents the water-retention model from over-fitting a short log, which
 * would produce confident, wrong corrections in the first few weeks.
 *
 * @returns {{lambda: number, cvError: number, model: ReturnType<typeof ridge>}|null}
 */
export function ridgeCV(X, y, lambdas = [0.1, 0.3, 1, 3, 10, 30, 100], folds = 5) {
  const n = X.length;
  if (n < 12) return null;
  const k = Math.min(folds, n);

  // Deterministic interleaved fold assignment — no RNG, so results are stable
  // across reloads, which matters when the user is watching a number.
  const foldOf = (i) => i % k;

  let best = null;
  for (const lambda of lambdas) {
    let err = 0;
    let count = 0;
    for (let f = 0; f < k; f++) {
      const Xtr = [], ytr = [], Xte = [], yte = [];
      for (let i = 0; i < n; i++) {
        if (foldOf(i) === f) { Xte.push(X[i]); yte.push(y[i]); }
        else { Xtr.push(X[i]); ytr.push(y[i]); }
      }
      const m = ridge(Xtr, ytr, lambda);
      if (!m) continue;
      for (let i = 0; i < Xte.length; i++) {
        err += (yte[i] - m.predict(Xte[i])) ** 2;
        count += 1;
      }
    }
    if (!count) continue;
    const cvError = err / count;
    if (!best || cvError < best.cvError) best = { lambda, cvError };
  }
  if (!best) return null;
  const model = ridge(X, y, best.lambda);
  return model ? { ...best, model } : null;
}
