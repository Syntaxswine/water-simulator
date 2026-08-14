// ---------------------------------------------------------------------------
// Waves: making them, and measuring what the bed did to them.
//
// The functions here are the THEORY the simulator is checked against, kept apart
// from the solver on purpose: nothing in this file reads the solver's state, and
// no expected value here is ever derived from a simulation. If a check imports
// its expected answer from the code that produced the answer, it has stopped
// being a check.
//
// ONE EXCEPTION, stated because the header used to claim "nothing in this file
// is used to advance the solution" and that was not true. The wavemakers --
// regularWave() and jonswapSea() -- hand etaExt/uExt to swe.mjs's flather()
// boundary, so they do drive the run. They are prescribed FORCING, not
// prediction: nothing measured is compared against them.
// ---------------------------------------------------------------------------

export const G = 9.80665;

/**
 * Solve the Airy dispersion relation omega^2 = g k tanh(k h) for k.
 *
 * This is the EXACT linear relation, and it is deliberately not what the
 * shallow-water solver obeys -- SWE gives omega = k sqrt(gh), the kh -> 0 limit.
 * Keeping the true relation here is what makes the model's error COMPUTABLE at a
 * given kh -- airy().shallowRatio below is that ratio, c_Airy / sqrt(gh) --
 * rather than quietly assumed away.
 *
 * Nothing here CORRECTS the dispersion. There is no Boussinesq mode anywhere in
 * this repository and no tools/dispersion.mjs; an earlier version of this comment
 * cited that file, and it has never existed. What the missing dispersion costs is
 * measured instead as a shoaling-exponent sweep in tools/waves.mjs planeBeach:
 * the fitted p in H ~ h^p runs +0.151, -0.210, -0.243, -0.243 for offshore
 * heights 0.8, 0.2, 0.05, 0.012 m, against Green's law p = -0.25.
 *
 * Those four are from running `node tools/waves.mjs planeBeach` on 2026-08-14.
 * The four printed here before were +0.152, -0.179, -0.236, -0.238, and the
 * H0 = 0.2 m case had drifted by 0.031 -- the shape of the finding is unchanged,
 * the number was not. The sweep is run with MANNING = 0 (fitExp passes 0), which
 * the old text did not say, so these are the dispersion error on its own; putting
 * friction back at H0 = 0.8 m moves the exponent 0.1509 -> 0.1534.
 *
 * Newton from the Guo (2002) initial guess. Counted 2026-08-14 over 99 (period,
 * depth) pairs spanning T = 4-20 s and h = 0.2-4000 m: 11 pairs converge in 1
 * iteration, 7 in 2, 22 in 3, 58 in 4 -- and ONE runs the full 40.
 *
 * That one is worth knowing about, and it does not merely run late -- it never
 * converges by this test and never will. T = 6 s in h = 500 m, kh = 55.91, where
 * one ulp is 7.105e-15. From iteration 1 onward kh limit-cycles between exactly
 * two doubles, 55.912197908161857640 and 55.912197908161843429, two ulps apart,
 * and |dkh| is 1.132e-14 on every single iteration -- permanently above the
 * 1e-14 the loop demands. The exit test is ABSOLUTE, and no absolute tolerance
 * finer than the number's own resolution can ever be met.
 *
 * The ANSWER is unaffected: worst relative residual of w^2 = g k tanh(kh) over
 * all 99 pairs is 3.60e-16, and both members of the cycle satisfy it. So this
 * costs 36 wasted iterations in deep water and nothing else. Left alone
 * deliberately -- a relative tolerance would fix it but would move kh by an ulp,
 * and this pass was for making the documentation match the code, not for moving
 * numbers the published results are fitted against.
 *
 * The docstring here previously said "converges in 3-4 iterations", which is
 * true of 80 of the 99 pairs and silent about the other 19.
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
 * A crest arriving at 40 degrees in 20 m of water is down to 16.71 degrees in
 * 4 m and 8.26 degrees in 1 m -- checked 2026-08-14 against this function, which
 * is why waves always seem to arrive straight at the beach.
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
  // UNSHOALED, and that matters. This is the depth at which a wave still H0 tall
  // would satisfy H = gamma h. A real wave shoals on the way in and arrives
  // taller, so this is a LOWER BOUND on the breaking depth. Re-checked 2026-08-14
  // for H0 = 0.8 m out of h0 = 20 m: this function returns 1.0256 m, while
  // solving the Green-shoaled form H0 (h0/h)^(1/4) = gamma h gives 1.8578 m
  // (where H = 1.4491 m and H/h = 0.7800, i.e. the root is right) -- a factor of
  // 1.8114. All three of those reproduced the numbers written here before.
  //
  // That form needs h0, which this signature does not take, so it is not computed
  // here; neither is the deep-water estimate H_b = 0.39 g^(1/5) (T H0^2)^(2/5)
  // (Komar & Gaughan), which the previous comment said was "reported separately"
  // and which nothing reports. For the record, at T = 14 s it gives 1.4801 m --
  // of HEIGHT, not depth, which is the trap in comparing it to the two above.
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
  // Normalise so Hs = 4 sqrt(m0) comes out exactly as requested. Checked
  // 2026-08-14 the hard way, by sampling etaExt over a 1 h record at dt = 0.05 s
  // and taking 4*sigma through waveStats(): requested 0.5, 1, 2 and 4 m come back
  // as 0.5000, 1.0000, 2.0000 and 4.0000 m, all to better than 0.005%. (Hsig from
  // zero-crossings lands at 0.485, 0.970, 1.940 and 3.879 -- about 3% below Hs,
  // which is the spectral-width difference waveStats() exists to expose, not an
  // error in this normalisation.)
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
