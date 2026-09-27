// stats.js — small, dependency-free statistics used by the measures engine:
// the normal CDF and its inverse, weighted medians, and percentile lookup
// against a cell's published quantiles.

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

// Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf; |error| < 1.5e-7).
export function phi(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// Inverse normal CDF (Acklam's rational approximation, |rel error| < 1.2e-9).
export function phiInv(p) {
  if (!(p > 0 && p < 1)) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    return NaN;
  }
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= ph) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// Percentile (2–98) → z, and back. The clamp keeps a single 100 % run from
// becoming an infinite z.
export function pctToZ(pct) {
  return phiInv(clamp(pct, 2, 98) / 100);
}
export function zToPct(z) {
  return 100 * phi(z);
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// Weighted quantile of (value, weight) pairs by cumulative weight, linear
// between neighbours. q in [0, 1]. Returns null for an empty input.
export function weightedQuantile(values, weights, q) {
  const pairs = values.map((v, i) => [v, weights?.[i] ?? 1])
    .filter(([v, w]) => Number.isFinite(v) && w > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!pairs.length) return null;
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  const target = q * total;
  let acc = 0;
  for (let i = 0; i < pairs.length; i++) {
    acc += pairs[i][1];
    if (acc > target + 1e-12) return pairs[i][0];
    if (Math.abs(acc - target) <= 1e-12) {
      // the cumulative weight lands exactly between two points: average them
      return i + 1 < pairs.length ? (pairs[i][0] + pairs[i + 1][0]) / 2 : pairs[i][0];
    }
  }
  return pairs[pairs.length - 1][0];
}

export function weightedMedian(values, weights) {
  return weightedQuantile(values, weights, 0.5);
}

// Effective sample size of a weighted sample: (Σw)² / Σw².
export function effectiveN(weights) {
  const s = weights.reduce((a, w) => a + w, 0);
  const s2 = weights.reduce((a, w) => a + w * w, 0);
  return s2 > 0 ? (s * s) / s2 : 0;
}

// Where does `value` sit against a cell's published quantiles?
// quantiles: the percentile levels (e.g. [5,10,25,50,75,90,95]); qv: the
// values at those levels. Piecewise linear between neighbours, clamped to
// [2, 98] because the tails are not published. higherIsBetter flips the
// scale so that "better" is always a higher percentile.
export function percentileInCell(quantiles, qv, value, higherIsBetter = true) {
  if (!Array.isArray(quantiles) || !Array.isArray(qv) || qv.length !== quantiles.length || !qv.length) return null;
  if (!Number.isFinite(value)) return null;
  let pct;
  if (value <= qv[0]) pct = quantiles[0];
  else if (value >= qv[qv.length - 1]) pct = quantiles[quantiles.length - 1];
  else {
    pct = quantiles[quantiles.length - 1];
    for (let i = 1; i < qv.length; i++) {
      if (value <= qv[i]) {
        const span = qv[i] - qv[i - 1];
        const frac = span > 0 ? (value - qv[i - 1]) / span : 1;
        pct = quantiles[i - 1] + (quantiles[i] - quantiles[i - 1]) * frac;
        break;
      }
    }
  }
  if (!higherIsBetter) pct = 100 - pct;
  return clamp(pct, 2, 98);
}

// Robust z against a cell: (v − p50) / (IQR / 1.349).
export function robustZ(quantiles, qv, value) {
  const at = (p) => { const i = quantiles.indexOf(p); return i >= 0 ? qv[i] : null; };
  const p50 = at(50), p25 = at(25), p75 = at(75);
  if ([p50, p25, p75].some((x) => x === null) || p75 <= p25) return null;
  return (value - p50) / ((p75 - p25) / 1.349);
}
