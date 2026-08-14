// ---------------------------------------------------------------------------
// Waves: making them, and measuring what the bed did to them.
//
// The functions here are the THEORY the simulator is checked against, kept apart
// from the solver on purpose. Nothing in this file is used to advance the
// solution; it only predicts and measures. If a check ever imports its expected
// answer from the code that produced the answer, it has stopped being a check.
// ---------------------------------------------------------------------------

export const G = 9.80665;

/**
 * Solve the Airy dispersion relation omega^2 = g k tanh(k h) for k.
 *
 * This is the EXACT linear relation, and it is deliberately not what the
 * shallow-water solver obeys -- SWE gives omega = k sqrt(gh), the kh -> 0 limit.
 * Keeping the true relation here is what lets tools/dispersion.mjs state how
 * wrong the model is at a given kh instead of quietly assuming it is right.
 *
 * Newton from the Guo (2002) initial guess; converges in 3-4 iterations.
 */
export function waveNumber(period, depth) {
  const w = 2 * Math.PI / period;
  const x = w * Math.sqrt(depth / G);
  let kh = x * x * Math.pow(1 - Math.exp(-Math.pow(x, 2.4908)), -0.4015);
  for (let n = 0; n < 40; n++) {
    const t = Math.tanh(kh);
    const f = G * kh * t / depth - w * w;
    const df = G * (t + kh * (1 - t * t)) / depth;
    const d = f / df;
    kh -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  return kh / depth;
}

/** Everything linear theory says about a wave of this period in this depth. */
export function airy(period, depth) {
  const k = waveNumber(period, depth);
  const kh = k * depth;
  const w = 2 * Math.PI / period;
  const c = w / k;
  const n = 0.5 * (1 + 2 * kh / Math.sinh(2 * kh));
  return {
    k, kh, wavelength: 2 * Math.PI / k, celerity: c,
    groupSpeed: n * c, n,
    // How far from the shallow-water limit are we? SWE assume this is 1.
    shallowRatio: c / Math.sqrt(G * depth),
    regime: kh < 0.5 ? 'shallow' : kh > Math.PI ? 'deep' : 'intermediate',
  };
}

/**
 * Shoaling coefficient from conservation of energy flux, Ks = sqrt(cg0/cg).
 *
 * In the shallow-water limit cg = sqrt(gh) and this collapses to Green's law,
 * Ks = (h0/h)^(1/4). Both forms are given because the SWE solver can only ever
 * reproduce the second one, and a check that compared it to the first in
 * intermediate water would be measuring the model's known limitation and
 * calling it an error.
 */
export function shoalingCoefficient(period, depth0, depth) {
  const a0 = airy(period, depth0), a = airy(period, depth);
  return Math.sqrt(a0.groupSpeed / a.groupSpeed);
}
export function greensLaw(depth0, depth) { return Math.pow(depth0 / depth, 0.25); }

/**
 * Snell's law for wave refraction: sin(theta)/c is invariant along a ray.
 * With c = sqrt(gh) in shallow water, sin(theta) = sin(theta0) * sqrt(h/h0).
 * A crest arriving at 40 degrees in 20 m of water is down to 17 degrees in 4 m,
 * which is why waves always seem to arrive straight at the beach.
 */
export function snellAngle(theta0, c0, c) {
  const s = Math.sin(theta0) * c / c0;
  return Math.asin(Math.max(-1, Math.min(1, s)));
}

/** Refraction coefficient from the convergence of rays between two contours. */
export function refractionCoefficient(theta0, theta) {
  return Math.sqrt(Math.cos(theta0) / Math.cos(theta));
}

/**
 * Depth-limited breaking. gamma = H/h at breaking; 0.78 is McCowan's solitary-
 * wave value and the usual default, but the real index depends on the slope and
 * the offshore steepness (Battjes & Stive), so this is a band, not a constant.
 */
export const BREAKER_INDEX = 0.78;
export function breakingDepth(H0, gamma = BREAKER_INDEX) {
  // Shoal by Green's law until H = gamma*h. H0 (h0/h)^(1/4) = gamma h has no
  // closed form in h without h0, so this is solved for the deep-water form
  // H_b = 0.39 g^(1/5) (T H0^2)^(2/5) (Komar & Gaughan) -- reported separately.
  return H0 / gamma;
}

/**
 * A regular wave train for the offshore boundary.
 *
 * `etaExt` and `uExt` feed src/swe.mjs's flather() condition. The velocity uses
 * the SHALLOW-WATER celerity sqrt(g/h), because that is the characteristic the
 * solver actually transports; pairing an Airy celerity with an SWE solver puts
 * the elevation and velocity out of step and radiates a spurious reflected wave
 * from the boundary on every cycle.
 *
 * `rampPeriods` fades the forcing in. Starting a wavemaker at full amplitude
 * launches a bore, and that bore runs ahead of the wave train and breaks first,
 * which looks exactly like an unexpectedly early surf zone.
 */
export function regularWave({ height, period, depth, rampPeriods = 3, msl = 0 }) {
  const w = 2 * Math.PI / period;
  const a = height / 2;
  const c = Math.sqrt(G / depth);
  const ramp = (t) => Math.min(1, t / (rampPeriods * period));
  const eta = (t) => msl + ramp(t) * a * Math.cos(w * t);
  return {
    etaExt: eta,
    uExt: (t) => c * (eta(t) - msl),
    airy: airy(period, depth),
    height, period, depth,
  };
}

/**
 * An irregular sea from a JONSWAP spectrum.
 *
 * Real waves are not a sine. A field of independent components with random
 * phases produces groups -- the "sets" every surfer knows -- and groups matter
 * physically, because the largest wave in a group breaks furthest out. Phases
 * come from a seeded generator, never Math.random(), so a sea state is
 * reproducible from its seed.
 */
export function jonswapSea({ Hs, Tp, depth, seed = 1, nComponents = 60, gamma = 3.3, msl = 0 }) {
  let s = (seed >>> 0) || 1;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const wp = 2 * Math.PI / Tp;
  const wLo = 0.5 * wp, wHi = 3.5 * wp;
  const dw = (wHi - wLo) / nComponents;
  const comps = [];
  let m0 = 0;
  for (let n = 0; n < nComponents; n++) {
    const w = wLo + (n + 0.5) * dw;
    const sigma = w <= wp ? 0.07 : 0.09;
    const r = Math.exp(-((w - wp) ** 2) / (2 * sigma * sigma * wp * wp));
    // Unscaled JONSWAP: alpha g^2 w^-5 exp(-5/4 (wp/w)^4) gamma^r
    const S = Math.pow(w, -5) * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(gamma, r);
    comps.push({ w, S, phase: 2 * Math.PI * rnd() });
    m0 += S * dw;
  }
  // Normalise so Hs = 4 sqrt(m0) comes out exactly as requested.
  const scale = (Hs / 4) ** 2 / m0;
  for (const c of comps) c.amp = Math.sqrt(2 * c.S * scale * dw);
  const c0 = Math.sqrt(G / depth);
  const eta = (t) => { let e = 0; for (const c of comps) e += c.amp * Math.cos(c.w * t - c.phase); return msl + e; };
  return {
    etaExt: eta,
    uExt: (t) => c0 * (eta(t) - msl),
    Hs, Tp, depth, seed, components: comps.length,
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Wave height from a surface time series.
 *
 * Reports BOTH the zero-crossing statistics and 4*sigma. They agree for a narrow
 * spectrum and diverge for a broad one, and quoting only one of them hides which
 * situation you are in. `Hrms`-style 4*sigma is the robust one for irregular
 * seas; crest-to-trough is the honest one for a regular wave train.
 */
export function waveStats(series, dt) {
  const n = series.length;
  if (n < 8) return null;
  let mean = 0;
  for (const v of series) mean += v;
  mean /= n;
  let var2 = 0;
  for (const v of series) var2 += (v - mean) ** 2;
  var2 /= n;
  const sigma = Math.sqrt(var2);

  // zero up-crossings on the de-meaned signal
  const cross = [];
  for (let i = 1; i < n; i++) {
    const a = series[i - 1] - mean, b = series[i] - mean;
    if (a <= 0 && b > 0) cross.push(i - 1 + a / (a - b));
  }
  const heights = [];
  for (let c = 0; c + 1 < cross.length; c++) {
    let hi = -Infinity, lo = Infinity;
    for (let i = Math.ceil(cross[c]); i <= Math.floor(cross[c + 1]); i++) {
      if (series[i] > hi) hi = series[i];
      if (series[i] < lo) lo = series[i];
    }
    if (isFinite(hi) && isFinite(lo)) heights.push(hi - lo);
  }
  heights.sort((a, b) => b - a);
  const third = Math.max(1, Math.round(heights.length / 3));
  return {
    mean, sigma,
    H4sigma: 4 * sigma,
    Hmean: heights.length ? heights.reduce((a, b) => a + b, 0) / heights.length : 0,
    Hsig: heights.length ? heights.slice(0, third).reduce((a, b) => a + b, 0) / third : 0,
    Hmax: heights.length ? heights[0] : 0,
    nWaves: heights.length,
    period: cross.length > 1 ? (cross[cross.length - 1] - cross[0]) * dt / (cross.length - 1) : 0,
  };
}
