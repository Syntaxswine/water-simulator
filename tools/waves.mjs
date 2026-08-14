// ---------------------------------------------------------------------------
// What the bed does to the waves.
//
// Seven cases, each chosen to make one process dominant so it can be measured
// on its own rather than inferred from a pretty picture:
//
//   plane beach       shoaling against Green's law, then depth-limited breaking
//   oblique beach     SNELL'S LAW: the crest angle measured from the phase field
//   barred beach      break / reform / break -- two surf zones
//   headland and bay  refraction FOCUSING energy on the point
//   submarine canyon  refraction DEFOCUSING, the same law with the other sign
//   offshore shoal    a caustic behind the bank (Berkhoff's experiment)
//   fringing reef     wave setup in the lagoon from breaking momentum flux
//
// plus `damping`, which is not a case but the instrument the cases are judged
// with: how much of a wave is left after it has travelled a given distance at a
// given resolution.
//
// The quantitative claims are asserted. The qualitative ones are printed with
// their numbers and NOT asserted, because a threshold invented to make a
// picture pass is not a test. As it stands `shoal` is printed-not-asserted in
// full and says why in its own words; every other case asserts.
//
//   node tools/waves.mjs [case]
//
// WHAT WAS WRONG BEFORE, all of it found by a reviewer running the file:
//
//   * Gauges were recorded on every round(ny/24)th row, and headlandBay and
//     submarineCanyon then asked for rows that were not among them. rec.get()
//     returned undefined and both cases died on a fallback assert having
//     measured nothing. Rows are now snapped by a helper that THROWS if asked
//     for something it did not record.
//   * headlandBay had the headland and the bay the wrong way round. The
//     shoreline is at x = 963 m at j = 0 and x = 2203 m at j = 160 and the
//     waves come from x = 0, so j = 0 is the point, not the bay.
//   * barredBeach hunted for the bar as "the shallowest cell in 1200 < x < 1650"
//     and found the landward end of the window (x = 1648.75 m, h = 3.46 m)
//     rather than the crest (x = 1476 m, h = 4.36 m), which made the trough come
//     out shallower than the crest. It now reads barAt from the bathymetry and
//     verifies a genuine local minimum.
//   * Three cases ran below the resolution floor and asserted anyway, one of
//     them a 3.7% effect on gauges that had lost 81% of the incident wave.
//     Every case now prints what it kept, and every two-gauge comparison is
//     divided by a one-dimensional control that contains no refraction at all.
//     headlandBay and submarineCanyon are now at the floor and assert;
//     `shoal` cannot get there without destroying the effect it exists to show,
//     so it measures and states that it is not a test.
//   * The headland/bay ratio was 2.36 at 19.3 cells/wavelength. Most of that was
//     the bay gauge being 1238 m further from the wavemaker through a grid that
//     eats 5% of the wave per wavelength. At 40.3 cells/wavelength, and with the
//     path difference divided out by the 1D control, it is 1.46.
//   * Every absolute height was 41% too big: 4*sigma is Hm0, which equals
//     sqrt(2)*H for a monochromatic wave. See heights() below.
// ---------------------------------------------------------------------------

import { ShallowWater, flather, reflect, periodic, makeSponge, G } from '../src/swe.mjs';
import { shoreline } from '../src/shorelines.mjs';
import {
  regularWave, greensLaw, airy, waveStats, snellAngle, refractionCoefficient, BREAKER_INDEX,
} from '../src/waves.mjs';

let checks = 0, failures = 0;
function check(label, got, want, tol, note = '') {
  checks++;
  const rel = Math.abs(want) > 1e-12 ? Math.abs(got - want) / Math.abs(want) : Math.abs(got - want);
  const ok = rel <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} got ${f(got)}  want ${f(want)}  rel ${(100 * rel).toFixed(2)}%${note ? '   ' + note : ''}`);
}
function assert(label, ok, note = '') {
  checks++; if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${note ? '   ' + note : ''}`);
}
function f(v) { const a = Math.abs(v); return a === 0 ? '0' : (a < 1e-3 || a >= 1e5) ? v.toExponential(3) : v.toFixed(4); }
const deg = (r) => (180 * r / Math.PI);

// ===========================================================================
// The resolution floor, and how much wave is left when it arrives
// ===========================================================================
//
// ONE NUMBER: 40 cells per wavelength. tools/verify.mjs section 8 measures the
// amplitude a wave retains over fifteen wavelengths on a periodic domain and
// calls 40 "the documented minimum resolution for a wave result". This file
// used to print 35 in its warning while verify.mjs asserted 40; they now agree.
const RES_FLOOR = 40;

// But cells-per-wavelength is not by itself enough to judge a coastal result.
// What a gauge sees is the damping ACCUMULATED along its whole path from the
// wavemaker, and on any beach the resolution falls to zero at the shoreline, so
// a single offshore number describes the easiest part of the journey. The
// instrument below measures retention per wavelength as a function of
// resolution and integrates it along the transect a gauge actually sits on.
//
// This measures the solver against itself. It is NOT a physics check and is
// never asserted against; it exists to decide which comparisons are worth
// asserting and to size the confounds in the ones that are. Two caveats stated
// up front: it is a LINEAR measurement (A/h = 0.0017), so a real finite-
// amplitude wave loses more; and it assumes the depth varies slowly, so it is
// an estimate of the confound, not a correction to be divided out. The 1D
// transect control further down is the thing that actually gets divided out.
const DAMP = new Map();
function retainedPerWavelength(cpw, dyOverDx = 1) {
  const key = `${Math.max(6, Math.min(240, Math.round(cpw)))}:${dyOverDx}`;
  if (DAMP.has(key)) return DAMP.get(key);
  const c = Number(key.split(':')[0]);
  const h0 = 12, A = 0.02, T = 10, nL = 10;
  const c0 = Math.sqrt(G * h0), Lw = c0 * T;
  const nx = Math.round(c * 4), dx = Lw / c;
  const sim = new ShallowWater({ nx, ny: 1, dx, dy: dx * dyOverDx, bed: () => -h0, eta0: 0, manning: 0, cfl: 0.45 });
  const k = 2 * Math.PI / Lw;
  for (let i = 0; i < nx; i++) {
    const x = (i + 0.5) * dx, e = A * Math.cos(k * x), kk = sim.idx(i, 0);
    sim.h[kk] = h0 + e; sim.hu[kk] = c0 * e;
  }
  sim.boundaries = { west: periodic, east: periodic, south: periodic, north: periodic };
  while (sim.t < nL * T) sim.step(Math.min(sim.maxDt(), nL * T - sim.t));
  let m = 0; for (let i = 0; i < nx; i++) m = Math.max(m, Math.abs(sim.eta(i, 0)));
  const v = Math.pow(m / A, 1 / nL);
  DAMP.set(key, v);
  return v;
}

/** Wavelengths travelled and linear amplitude retained from x0 to xEnd along a depth profile. */
function pathDamping(depthAt, x0, xEnd, dx, period, dyOverDx = 1) {
  let nL = 0, lnKeep = 0;
  for (let x = x0; x < xEnd; x += dx) {
    const h = depthAt(x);
    if (!(h > 0.05)) break;
    const L = Math.sqrt(G * h) * period;
    const step = dx / L;
    nL += step;
    lnKeep += step * Math.log(retainedPerWavelength(L / dx, dyOverDx));
  }
  return { nL, kept: Math.exp(lnKeep) };
}

// ===========================================================================
// Wave height: which one, and why it matters
// ===========================================================================
//
// waveStats returns both, and for a REGULAR wave train the difference is not a
// detail. For a sinusoid of crest-to-trough height H the standard deviation is
// H/(2*sqrt(2)), so 4*sigma = sqrt(2)*H = 1.414*H exactly. 4*sigma is Hm0,
// which is defined for a narrow-banded RANDOM sea, where it estimates the
// significant height; applied to a monochromatic wave it reads 41% high by
// construction.
//
// The old fringingReef case printed "offshore H = 2.24 m" for a requested
// 1.6 m and left the 1.40x unexplained. That is this factor. It also inflated
// every H/h in the file, i.e. every comparison against the breaking index.
//
// So: crest-to-trough is the height used wherever a number is compared with
// something absolute -- a breaking index, a requested height, a setup fraction.
// 4*sigma is printed beside it and their ratio is CHECKED against sqrt(2)
// offshore, which is a real test: it only holds while the record is a clean
// sinusoid, and it drifts as soon as harmonics or a second frequency arrive.
function heights(series, dt) {
  const st = waveStats(series, dt);
  if (!st) return null;
  return { H: st.Hmean, H4sigma: st.H4sigma, mean: st.mean, n: st.nWaves, period: st.period, st };
}

// ===========================================================================
// Running a shoreline
// ===========================================================================

/**
 * Advance a grid under a regular wave arriving from the west (deep) side.
 *
 * Gauges record for the LAST `analyse` periods only. The first crossing of the
 * domain sets up the standing pattern between the wavemaker and the beach, and
 * statistics taken during it describe the transient rather than the sea state.
 */
function simulate({
  bed, nx, ny, dx, dy, h0, height, period, periods, analyse,
  msl = 0, manning = 0.022, rowsEvery = null, rowList = null, sponge = null, west = null,
  east = null, quiet = false, indent = '        ',
}) {
  const sim = new ShallowWater({ nx, ny, dx, dy, bed, eta0: msl, manning });
  const wm = regularWave({ height, period, depth: h0, rampPeriods: 3, msl });
  sim.boundaries = {
    west: west ? west({ sim, wm, h0, period, height, msl }) : flather(wm.etaExt, wm.uExt),
    // reflect is right where the domain ends in dry land, which is every case
    // with a beach in it. `shoal` ends in 10 m of open water and needs a real
    // radiation condition; see there.
    east: east === 'radiate' ? flather(() => msl, () => 0) : reflect,
    south: periodic, north: periodic,
  };
  // NO SPONGE ON THE WAVEMAKER BOUNDARY. A sponge relaxes the surface toward a
  // reference, so putting one where the waves come IN damps the incident wave
  // before it ever enters -- measured, a requested 0.8 m wave arrived as 0.16 m.
  // Flather already lets the reflected wave out; that is what it is for. A
  // sponge on the far side is a different matter and `shoal` needs one, because
  // it is the only case with no beach to absorb the wave.
  if (sponge) sim.forcing = makeSponge(sim, { side: 'east', etaRef: msl, ...sponge });

  const Lw = Math.sqrt(G * h0) * period;
  const cpw = Lw / dx;
  const a0 = airy(period, h0);
  if (!quiet) {
    console.log(`${indent}grid ${nx}x${ny} at ${dx}x${dy} m; T = ${period.toFixed(2)} s in ${h0} m -> L = ${Lw.toFixed(0)} m, ` +
      `${cpw.toFixed(1)} cells/wavelength (floor ${RES_FLOOR}${cpw < RES_FLOOR ? ' -- UNDER IT' : ''})`);
    console.log(`${indent}kh = ${a0.kh.toFixed(2)} (${a0.regime}); the SWE celerity runs this wave ` +
      `${(100 * (1 / a0.shallowRatio - 1)).toFixed(1)}% fast against Airy -- that error is the MODEL, not the grid`);
  }

  const T = periods * period, T0 = (periods - analyse) * period;
  const dtRec = period / 40;
  const stride = rowsEvery ?? Math.max(1, Math.round(ny / 24));
  const rows = [];
  if (rowList) for (const j of rowList) rows.push(j);
  else for (let j = 0; j < ny; j += stride) rows.push(j);
  rows.sort((a, b) => a - b);
  const rec = new Map();
  for (let i = 0; i < nx; i++) for (const j of rows) rec.set(i + ':' + j, []);

  let next = T0;
  while (sim.t < T) {
    sim.step(Math.min(sim.maxDt(), Math.max(1e-6, Math.min(T, next) - sim.t)));
    if (sim.t >= next && sim.t >= T0) {
      for (let i = 0; i < nx; i++) for (const j of rows) rec.get(i + ':' + j).push(sim.eta(i, j));
      next += dtRec;
    } else if (sim.t >= next) next += dtRec;
  }

  const r = {
    sim, rec, rows, wm, dtRec, h0, nx, ny, dx, dy, period, cpw, height,

    /** Nearest RECORDED row to j. Throws rather than handing back a row that does not exist. */
    snapRow(j) {
      if (!rows.length) throw new Error('no gauge rows were recorded');
      let best = rows[0];
      for (const q of rows) if (Math.abs(q - j) < Math.abs(best - j)) best = q;
      return best;
    },
    rowAtY(y) { return this.snapRow(Math.round(y / dy - 0.5)); },

    /**
     * The recorded series at (i,j), or an exception.
     *
     * The old code did `rec.get(key)` and let `undefined` propagate into a
     * fallback assert(..., false), so a case that asked for an unrecorded row
     * reported a failed physics check when what had actually happened was that
     * nothing was measured. Asking for a row that was not recorded is a
     * programming error and now says so.
     */
    series(i, j) {
      const s = rec.get(i + ':' + j);
      if (!s) throw new Error(`no gauge at (${i}, ${j}); recorded rows are [${rows.slice(0, 6)}${rows.length > 6 ? ', ...' : ''}] ` +
        `(every ${stride} of ${ny}). Use snapRow()/rowAtY().`);
      if (s.length < 8) throw new Error(`gauge (${i}, ${j}) has ${s.length} samples`);
      return s;
    },
    at(i, j) { return heights(this.series(i, j), dtRec); },

    /** Complex amplitude at the forcing frequency: [Re, Im]. Phase gradients give k. */
    phasor(i, j) {
      const s = this.series(i, j);
      const w = 2 * Math.PI / period;
      let re = 0, im = 0;
      for (let n = 0; n < s.length; n++) { const t = n * dtRec; re += s[n] * Math.cos(w * t); im -= s[n] * Math.sin(w * t); }
      return [2 * re / s.length, 2 * im / s.length];
    },

    /**
     * The most SEAWARD crossing of a depth contour along a row.
     *
     * The old version scanned inward from the east wall and returned the first
     * cell deeper than the target. On the submarine canyon axis that was
     * i = 319 of 320 -- the last cell, hard against the reflecting east wall,
     * holding 44.99 m of water -- and the case called it "the h = 8 m contour".
     * A row that never gets shallower than the target has no such contour and
     * this now says so instead of returning the wall.
     */
    contour(j, target) {
      for (let i = 0; i < nx; i++) {
        if (sim.depth(i, j) < target) {
          if (i === 0) throw new Error(`row j=${j} is already shallower than ${target} m at the offshore boundary`);
          return i - 1;
        }
      }
      throw new Error(`row j=${j} never gets shallower than ${target} m: there is no h = ${target} m contour on it`);
    },

    /** Depth along a row as a function of x, for pathDamping(). */
    depthAlong(j) { return (x) => { const i = Math.min(nx - 1, Math.max(0, Math.floor(x / dx))); return sim.depth(i, j); }; },
  };
  return r;
}

/** Run a named shoreline. `build` overrides bathymetry parameters, `domain` the grid. */
function run(name, { build = {}, domain = null, res = 1, ...opts } = {}) {
  const { bed, meta } = shoreline(name, { ...build, ...(domain ? { domain } : {}) });
  const d = meta.domain;
  const r = simulate({
    bed,
    nx: Math.round(d.nx * res), ny: Math.round(d.ny * res),
    dx: d.dx / res, dy: d.dy / res,
    h0: meta.offshoreDepth, ...opts,
  });
  r.meta = meta;
  r.params = meta.params;
  return r;
}

/**
 * THE NO-REFRACTION NULL.
 *
 * A focusing ratio compares two gauges that are not the same distance from the
 * wavemaker. On headlandBay the h = 6 m contour is at x = 682 m on the headland
 * and x = 1920 m in the bay: 1238 m of extra path for the bay gauge, and the
 * wave is damped along it, so part of any "focusing" is the bay gauge simply
 * being further away. At the resolution that case used to run (19.3 cells per
 * wavelength, 0.9505 retained per wavelength measured above) that path
 * difference alone is worth a factor of about 1.6 against a claimed 2.36.
 *
 * The control runs the SAME cross-shore profile in one dimension, at the same
 * dx, dy, wave and friction. One dimension cannot transfer energy alongshore,
 * so whatever ratio two transects show there is shoaling + friction + numerical
 * damping over their different paths and nothing else. Dividing the 2D ratio by
 * the 1D ratio leaves refraction.
 *
 * The control is not perfect -- it has its own beach reflection and its own
 * timestep -- so both transects are forced onto a common dt cap, and the pair is
 * run and reported together so the reader can see the null as well as the
 * signal.
 */
function controls(r, js, opts) {
  const out = new Map();
  for (const j of js) {
    out.set(j, simulate({
      // The bed the 2D run is actually using along that row, read straight out
      // of the grid rather than re-evaluated from the shoreline function, so the
      // control cannot silently be a different bathymetry.
      bed: (x) => r.sim.b[r.sim.idx(Math.min(r.nx - 1, Math.max(0, Math.floor(x / r.dx))), j)],
      nx: r.nx, ny: 4, dx: r.dx, dy: r.dy, h0: r.h0, height: r.height, period: r.period,
      periods: opts.periods, analyse: opts.analyse, manning: opts.manning ?? 0.022,
      // The control has to carry the SAME boundary treatment as the run it is
      // the null for. Measured on `shoal` when it did not: the 1D transect kept
      // a reflecting east wall while the 2D run had a sponge, so the two had
      // different standing patterns and the reference row came out at 0.756x its
      // own control 620 m away from the bank, where it should have been 1.
      msl: opts.msl ?? 0, sponge: opts.sponge ?? null, east: opts.east ?? null, quiet: true,
    }));
  }
  return out;
}

/**
 * Measured height divided by the height the SAME transect gives with no
 * refraction available to it. Greater than 1 is focusing, less than 1 shelter.
 */
function gainAt(r, ctl, j, D) {
  const twoD = r.at(r.contour(j, D), j).H;
  const c = ctl.get(j);
  const oneD = c.at(c.contour(0, D), 0).H;
  return { twoD, oneD, gain: twoD / oneD, i: r.contour(j, D) };
}
function gainAtColumn(r, ctl, j, i) {
  const twoD = r.at(i, j).H, oneD = ctl.get(j).at(i, 0).H;
  return { twoD, oneD, gain: twoD / oneD, i };
}

/**
 * Height and mean level along x, averaged over the recorded rows.
 *
 * `depth` is the depth the model is running in at the end of the record and is
 * the right one for H/h; `bedDepth` is the STILL-WATER depth, and it is the only
 * one a geometric search for a bar crest can use. Searching for a local minimum
 * of `depth` finds the wave-induced set-down instead: measured, it put the crest
 * of the sandbar at x = 51.25 m in 11.68 m of water, 1400 m seaward of the bar.
 */
function profileAlongX(r) {
  const out = [];
  for (let i = 0; i < r.nx; i++) {
    let H = 0, H4 = 0, mean = 0, n = 0, depth = 0, bedDepth = 0, nw = 0;
    for (const j of r.rows) {
      const s = r.rec.get(i + ':' + j);
      if (!s || s.length < 8) continue;
      const st = heights(s, r.dtRec);
      if (!st) continue;
      H += st.H; H4 += st.H4sigma; mean += st.mean; nw += st.n; n++;
      depth += r.sim.depth(i, j);
      bedDepth += -r.sim.b[r.sim.idx(i, j)];
    }
    out.push(n ? {
      x: (i + 0.5) * r.dx, H: H / n, H4sigma: H4 / n, mean: mean / n,
      depth: depth / n, bedDepth: bedDepth / n, nWaves: nw / n,
    } : null);
  }
  return out;
}

/**
 * Smooth a profile over one LOCAL wavelength.
 *
 * A beach reflects, and the partial standing pattern it sets up is fixed in
 * space, so an unsmoothed gauge reports its position in that pattern instead of
 * the wave height.
 */
function smoothOverWavelength(prof, dx, period) {
  return prof.map((p, i) => {
    const Lloc = Math.sqrt(G * p.depth) * period;
    const half = Math.max(1, Math.round(0.5 * Lloc / dx));
    let H = 0, m = 0, n = 0;
    for (let q = Math.max(0, i - half); q <= Math.min(prof.length - 1, i + half); q++) { H += prof[q].H; m += prof[q].mean; n++; }
    return { ...p, H: H / n, mean: m / n, cellsPerL: Lloc / dx };
  });
}

const only = process.argv[2];
const want = (k) => !only || only === k;

// ===========================================================================
if (want('damping')) {
  console.log('');
  console.log('=== the instrument: numerical damping vs resolution =================');
  console.log('');
  console.log('        Amplitude retained per wavelength travelled, measured on a periodic');
  console.log('        domain with no boundaries in it. This is the solver measured against');
  console.log('        itself -- a REGRESSION INSTRUMENT, not a physics check -- and nothing');
  console.log('        below is asserted against it. It is used to size the confounds.');
  console.log('');
  console.log('        cells/L   retained per L   over 15 L');
  for (const cpw of [10, 15, 20, 25, 30, RES_FLOOR, 60, 80]) {
    const p = retainedPerWavelength(cpw);
    console.log(`        ${String(cpw).padStart(7)}   ${p.toFixed(4).padStart(14)}   ${(100 * Math.pow(p, 15)).toFixed(1).padStart(6)}%`);
  }
  // Self-check: the path integral above assumes the decay is EXPONENTIAL in
  // distance, i.e. that the per-wavelength figure does not depend on how far
  // the wave was made to travel. If it does, the integral is meaningless.
  const short = (() => {
    const h0 = 12, A = 0.02, T = 10, nL = 4, cpw = 30;
    const c0 = Math.sqrt(G * h0), Lw = c0 * T, nx = cpw * 4, dx = Lw / cpw;
    const sim = new ShallowWater({ nx, ny: 1, dx, bed: () => -h0, eta0: 0, manning: 0, cfl: 0.45 });
    const k = 2 * Math.PI / Lw;
    for (let i = 0; i < nx; i++) { const x = (i + 0.5) * dx, e = A * Math.cos(k * x); sim.h[sim.idx(i, 0)] = h0 + e; sim.hu[sim.idx(i, 0)] = c0 * e; }
    sim.boundaries = { west: periodic, east: periodic, south: periodic, north: periodic };
    while (sim.t < nL * T) sim.step(Math.min(sim.maxDt(), nL * T - sim.t));
    let m = 0; for (let i = 0; i < nx; i++) m = Math.max(m, Math.abs(sim.eta(i, 0)));
    return Math.pow(m / A, 1 / nL);
  })();
  check('the decay is exponential (per-L figure independent of path length)',
    short, retainedPerWavelength(30), 0.01, 'measured over 4 L vs over 10 L at 30 cells/L');
}

// ===========================================================================
if (want('planeBeach')) {
  console.log('');
  console.log('=== plane beach: shoaling (Green) and depth-limited breaking ========');
  console.log('');
  //
  // Shoaling is tested as an AMPLITUDE SWEEP, and that is the honest form of the
  // test for this model.
  //
  // The shallow-water equations have no frequency dispersion. Nothing balances
  // the nonlinear steepening that makes a crest travel faster than a trough, so a
  // finite-amplitude wave sharpens into a bore and the Riemann solver dissipates
  // it -- before it ever reaches the depth-limited breaking point. Real waves are
  // held together by dispersion until H/h ~ 0.8; that difference is precisely why
  // Boussinesq models exist for the nearshore.
  //
  // So the model is checked where it is VALID -- the small-amplitude limit, where
  // Green's law must be recovered -- and the finite-amplitude departure is
  // measured and printed rather than hidden. Measured with 4*sigma heights: the
  // fitted exponent went +0.15, -0.18, -0.24, -0.24 as the offshore height went
  // 0.8, 0.2, 0.05, 0.012 m, against Green's -0.25. Bed friction is NOT the
  // cause: switching Manning off moved the H = 0.8 m case from 0.154 to 0.152.
  // The switch to crest-to-trough heights cannot change a fitted EXPONENT --
  // sqrt(2) is a constant factor and drops out of d(logH)/d(logh) -- so those
  // numbers stand.
  const fitExp = (H0, manning) => {
    const r = run('planeBeach', { height: H0, period: 14, periods: 30, analyse: 12, manning });
    const prof = profileAlongX(r).filter(p => p && p.depth > 0.3);
    const sm = smoothOverWavelength(prof, r.dx, r.period);
    const band = sm.filter(p => p.depth < 10 && p.depth > 3 && p.cellsPerL >= 30 && p.H / p.depth < BREAKER_INDEX);
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of band) { const X = Math.log(p.depth), Y = Math.log(p.H); sx += X; sy += Y; sxx += X * X; sxy += X * Y; }
    const n = band.length;
    return { slope: (n * sxy - sx * sy) / (n * sxx - sx * sx), n, r, sm, prof };
  };
  const sweep = [];
  for (const H0 of [0.8, 0.2, 0.05, 0.012]) {
    const q = fitExp(H0, 0);
    sweep.push({ H0, slope: q.slope, n: q.n, q });
    console.log(`        H0 = ${String(H0).padEnd(6)} fitted d(logH)/d(logh) = ${q.slope.toFixed(3).padStart(7)}  (${q.n} gauges)`);
  }
  console.log(`        Green's law is -0.250. The departure at large H0 is the missing dispersion,`);
  console.log(`        not the bed friction: at H0 = 0.8 m, Manning 0.022 gives 0.154 and 0 gives 0.152.`);
  const lin = sweep[sweep.length - 1];
  check('Green exponent in the small-amplitude limit', lin.slope, -0.25, 0.15,
    `at H0 = ${lin.H0} m, where the model is valid`);
  assert('shoaling error falls monotonically with amplitude',
    sweep[0].slope > sweep[1].slope && sweep[1].slope > sweep[2].slope,
    'confirms the error is nonlinear steepening, which is real SWE behaviour, not a numerical fault');

  // The sqrt(2) that used to be invisible. Offshore, where the record is still a
  // clean sinusoid, Hm0 = 4*sigma must be sqrt(2) times the crest-to-trough
  // height. This is what makes the "1.40x" the reef case reported explicable.
  {
    const r = lin.q.r;
    const deep = lin.q.prof.filter(p => p.depth > 0.9 * r.h0 && p.x > 200);
    const ratio = deep.reduce((a, p) => a + p.H4sigma / p.H, 0) / deep.length;
    check('4*sigma / crest-to-trough offshore', ratio, Math.SQRT2, 0.03,
      `${deep.length} gauges in > ${(0.9 * r.h0).toFixed(1)} m; this is why every old absolute height read 41% high`);
  }

  // ---- the surf zone, and the breaking index this model cannot reach --------
  //
  // THE OLD CHECK HERE WAS AN ARTEFACT OF THE HEIGHT DEFINITION. It searched for
  // the first gauge with H/h > 0.78 using 4*sigma, which is sqrt(2) times the
  // real crest-to-trough height, so it "found" a breaker at H/h = 0.55 and then
  // compared that number to 0.78 with a 45% tolerance. With honest heights NO
  // CELL ON THIS BEACH REACHES 0.78 AT ANY OF THE FOUR AMPLITUDES BELOW.
  //
  // That is not a bug, it is the model. These equations have no dispersion, so a
  // finite-amplitude wave steepens into a bore and the Riemann solver dissipates
  // it on the way in -- the sweep above measures exactly that, the fitted
  // exponent going from -0.243 to +0.151 as the amplitude rises. By the time the
  // depth is small enough for H = 0.78h the height is gone. A depth-limited
  // breaker needs something to hold the crest together until h drops, and that
  // something is the dispersion a Boussinesq model has and this one does not.
  //
  // So the breaking index is PRINTED with the shortfall stated, and what gets
  // asserted is the thing the model does do and a single-slope beach must show:
  // a surf zone, i.e. a band near the shore where the wave loses height far
  // faster than it does offshore.
  const big = fitExp(0.8, 0.022);
  const ref = big.sm.find(p => p.depth > 0.9 * big.r.h0 && p.x > 250) || big.sm[0];
  const nStep = Math.round(50 / big.r.dx);
  const decay = (S) => (p) => {
    const n = S.indexOf(p), a = S[Math.max(0, n - nStep)], b = S[Math.min(S.length - 1, n + nStep)];
    return (a !== b && a.H > 0 && b.H > 0) ? 1e4 * Math.log(a.H / b.H) / (b.x - a.x) : NaN;
  };
  const dBig = decay(big.sm);
  console.log('');
  console.log(`        H0 = 0.8 m, offshore H = ${f(ref.H)} m at h = ${f(ref.depth)} m:`);
  console.log('           x [m]    h [m]    H [m]     H/h    -dlnH/dx [%/100m]');
  for (const p of big.sm.filter(q => q.depth > 0.45 && q.x > 900 && Math.round(q.x) % 100 < big.r.dx)) {
    console.log(`        ${p.x.toFixed(0).padStart(7)} ${p.depth.toFixed(2).padStart(8)} ${p.H.toFixed(3).padStart(8)} ` +
      `${(p.H / p.depth).toFixed(3).padStart(7)}       ${dBig(p).toFixed(1).padStart(6)}`);
  }
  // Where Green + McCowan say it should break: H0 (h0/h)^(1/4) = gamma h gives
  // h_b = (H0 h0^(1/4)/gamma)^(4/5). An external prediction, not one this code
  // can produce.
  const hb = Math.pow(ref.H * Math.pow(big.r.h0, 0.25) / BREAKER_INDEX, 0.8);
  const wet = big.sm.filter(p => p.depth > 0.45);
  const peak = wet.reduce((a, b) => (a.H / a.depth > b.H / b.depth ? a : b));
  console.log('');
  console.log(`        Green + McCowan predict breaking at h = ${f(hb)} m with H = ${f(BREAKER_INDEX * hb)} m.`);
  console.log(`        Measured peak H/h = ${f(peak.H / peak.depth)} at h = ${f(peak.depth)} m -- ` +
    `${(100 * peak.H / peak.depth / BREAKER_INDEX).toFixed(0)}% of the index, NOT ASSERTED.`);
  console.log(`        Green's shoaling from ${f(ref.depth)} to ${f(peak.depth)} m is ${f(greensLaw(ref.depth, peak.depth))}x; ` +
    `the model achieved ${f(peak.H / ref.H)}x.`);
  // Measured: 0.478, 0.428, 0.185, 0.050 as H0 goes 0.8, 0.2, 0.05, 0.012. The
  // peak tracks the AMPLITUDE THAT ARRIVES, not a depth limit -- if the surf
  // zone were depth-limited these four would cluster near 0.78 instead of
  // spanning a factor of ten. That is the same finding as the exponent sweep,
  // seen from the other end.
  console.log('        peak H/h across the amplitude sweep -- note it tracks H0, it does not saturate:');
  for (const s of sweep) {
    const w2 = s.q.sm.filter(p => p.depth > 0.45);
    const pk = w2.reduce((a, b) => (a.H / a.depth > b.H / b.depth ? a : b));
    console.log(`          H0 = ${String(s.H0).padEnd(6)} peak H/h = ${f(pk.H / pk.depth)} at h = ${f(pk.depth)} m`);
  }
  const shelf = wet.filter(p => p.depth > 6).map(dBig).filter(Number.isFinite).sort((a, b) => a - b);
  const shelfDecay = shelf[Math.floor(shelf.length / 2)];
  const surfDecay = Math.max(...wet.filter(p => p.depth < 3).map(dBig).filter(Number.isFinite));
  console.log('');
  console.log(`        height loss: ${shelfDecay.toFixed(1)} %/100 m (median) in more than 6 m of water, ` +
    `${surfDecay.toFixed(1)} %/100 m at its worst inside 3 m`);
  assert('there is a surf zone: dissipation concentrates near the shore', surfDecay > 3 * shelfDecay,
    `${surfDecay.toFixed(1)} against ${shelfDecay.toFixed(1)} %/100 m. A model that merely reflected the wave, ` +
    `or damped it uniformly, would not separate these two.`);
  assert('the surf zone is saturated, not growing without limit', peak.H / peak.depth < BREAKER_INDEX,
    `peak H/h ${f(peak.H / peak.depth)}. This is the wrong side of 0.78 and it is REPORTED as such: ` +
    `the wave arrives already dissipated, which is what a non-dispersive model does.`);
}

// ===========================================================================
if (want('snell')) {
  console.log('');
  console.log('=== oblique incidence: Snell\'s law from the measured phase field ====');
  console.log('');
  //
  // The refraction cases below compare HEIGHTS. This one measures the ANGLE, in
  // the only way that is not circular.
  //
  // The domain is y-periodic and the bed is y-invariant, so the alongshore
  // wavenumber ky is conserved exactly and reading it back off the gauges proves
  // nothing about the physics -- it is a wavemaker regression check and is
  // labelled as one. The content is in kx: the solver must satisfy its own
  // dispersion relation |k| = omega/sqrt(gh) locally as the depth falls, and it
  // is kx that has to move for that to happen. Given ky fixed, the statements
  //
  //     sin(theta)/sqrt(h) invariant        (Snell with c = sqrt(gh))
  //     |k| = omega/sqrt(gh)                (local dispersion)
  //
  // are the same statement, and BOTH are reported so that nobody mistakes the
  // first for an independent second confirmation of the second.
  //
  // The energy check is genuinely independent: with the angle measured rather
  // than assumed, the height must follow Green's shoaling TIMES the refraction
  // coefficient sqrt(cos(theta0)/cos(theta)), and that combination is smaller
  // than shoaling alone. A model that refracted the phase correctly but moved
  // the energy wrongly would fail it.
  const h0 = 8, dx = 2.5, dy = 5, ny = 40, nx = 280;
  const Ly = ny * dy;
  const sin0 = 0.5, theta0 = Math.asin(sin0);
  // Exactly one alongshore wavelength across the domain, so the y-periodic
  // boundary sees a continuous wave: ky = 2*pi/Ly and ky = k0*sin(theta0)
  // together force L0 = Ly*sin(theta0), which fixes the period.
  const L0 = Ly * sin0;
  const c0 = Math.sqrt(G * h0);
  const period = L0 / c0;
  const lag = sin0 / c0;                       // seconds of phase lag per metre alongshore

  /**
   * A wavemaker whose crests arrive at an angle.
   *
   * src/swe.mjs's flather() takes etaExt(t) and uExt(t) -- functions of TIME
   * ONLY -- so it cannot express a crest that is not parallel to the boundary.
   * Rather than reimplement the characteristic splitting (the one thing in that
   * file with a history of being subtly wrong), the real flather() is wrapped:
   * the boundary function is called once per ghost cell, so the cell's y is
   * stashed in a closure immediately before delegating. A y-dependent Flather
   * belongs in src/swe.mjs; this is a test harness, not a solver change.
   *
   * The normal velocity carries cos(theta0). The tangential component is left
   * to flather's zero-gradient copy, which is approximate for an oblique wave;
   * the measured reflection is reported below so the size of that is visible.
   */
  const obliqueWest = ({ wm, msl }) => {
    let yCell = 0;
    const shift = (t) => t + lag * (Ly - yCell);   // kept positive so the ramp stays monotone
    const inner = flather((t) => wm.etaExt(shift(t)), (t) => Math.cos(theta0) * wm.uExt(shift(t)));
    return (sim, i, j, side, g) => { yCell = (j + 0.5) * sim.dy; return inner(sim, i, j, side, g); };
  };

  const r = run('planeBeach', {
    build: { offshoreDepth: h0, slope: 1 / 40, shoreAt: 600 },
    domain: { nx, ny, dx, dy },
    height: 0.35, period, periods: 34, analyse: 12, manning: 0.022,
    rowsEvery: 1, west: obliqueWest,
  });
  console.log(`        theta0 = ${deg(theta0).toFixed(1)} deg, one alongshore wavelength across ${Ly} m,`);
  console.log(`        so ky = ${(2 * Math.PI / Ly).toFixed(5)} 1/m is fixed by the geometry and cannot drift.`);

  const w = 2 * Math.PI / period;
  const mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  const conj = (a) => [a[0], -a[1]];
  // ky from the mean alongshore phase increment (complex sum, so wrapping is
  // handled and low-amplitude gauges weight themselves down).
  let sy = [0, 0];
  for (let i = 40; i < nx - 40; i++) for (let j = 0; j < ny; j++) {
    sy = ((a, b) => [a[0] + b[0], a[1] + b[1]])(sy, mul(r.phasor(i, j), conj(r.phasor(i, (j + 1) % ny))));
  }
  // arg(Z) = -(kx*x + ky*y) with the e^(-i*omega*t) convention used in phasor(),
  // so arg(Z_j * conj(Z_j+1)) = +ky*dy. Getting this sign backwards reported
  // ky = -0.0314 for an imposed +0.0314 and emptied the kx > 0 filter.
  const kyMeas = Math.atan2(sy[1], sy[0]) / dy;
  const kyWant = 2 * Math.PI / Ly;
  check('ky recovered from the gauges (WAVEMAKER REGRESSION, not physics)', kyMeas, kyWant, 0.02,
    'the bed is y-invariant so ky is conserved by construction; this only shows the wavemaker did what it was told');

  const cols = [];
  for (let i = 1; i < nx - 1; i++) {
    let sx = [0, 0], amp = 0, dep = 0;
    for (let j = 0; j < ny; j++) {
      sx = ((a, b) => [a[0] + b[0], a[1] + b[1]])(sx, mul(r.phasor(i, j), conj(r.phasor(i + 1, j))));
      const p = r.phasor(i, j); amp += Math.hypot(p[0], p[1]); dep += r.sim.depth(i, j);
    }
    const kx = Math.atan2(sx[1], sx[0]) / dx;
    cols.push({ i, x: (i + 0.5) * dx, kx, h: dep / ny, a: amp / ny });
  }
  const usable = cols.filter(c => c.h > 1.2 && c.kx > 0 && 2 * c.a / c.h < 0.5 && Math.sqrt(G * c.h) * period / dx > 12);
  if (usable.length < 10) throw new Error(`only ${usable.length} usable columns out of ${cols.length}: the oblique wave did not establish`);
  const deepest = usable[0];
  console.log('');
  console.log('           h [m]   |k| meas   omega/sqrt(gh)   theta [deg]   Snell theta   sin(t)/sqrt(h)   H/H0 meas   Green*Kr');
  const rows = [];
  for (const c of usable) {
    const kAbs = Math.hypot(c.kx, kyWant);
    const kThy = w / Math.sqrt(G * c.h);
    const th = Math.atan2(kyWant, c.kx);
    const thSnell = snellAngle(theta0, c0, Math.sqrt(G * c.h));
    const inv = Math.sin(th) / Math.sqrt(c.h);
    rows.push({ ...c, kAbs, kThy, th, thSnell, inv });
  }
  const show = rows.filter((_, n) => n % Math.max(1, Math.round(rows.length / 10)) === 0);
  for (const q of show) {
    const HH = q.a / deepest.a;
    const pred = greensLaw(deepest.h, q.h) * refractionCoefficient(theta0, q.th);
    console.log(`        ${q.h.toFixed(2).padStart(7)}   ${q.kAbs.toFixed(5).padStart(8)}   ${q.kThy.toFixed(5).padStart(14)}   ` +
      `${deg(q.th).toFixed(2).padStart(11)}   ${deg(q.thSnell).toFixed(2).padStart(11)}   ${q.inv.toFixed(5).padStart(14)}   ` +
      `${HH.toFixed(3).padStart(9)}   ${pred.toFixed(3).padStart(8)}`);
  }
  const invs = rows.map(q => q.inv).sort((a, b) => a - b);
  const inv0 = Math.sin(theta0) / Math.sqrt(h0);
  const q1 = invs[Math.floor(invs.length * 0.25)], q3 = invs[Math.floor(invs.length * 0.75)];
  const med = invs[Math.floor(invs.length / 2)];
  const hMin = rows[rows.length - 1].h;
  // WHAT THE NULL LOOKS LIKE. A model that did not refract at all would leave
  // the crest at theta0 the whole way in, and sin(theta0)/sqrt(h) would then
  // rise by sqrt(h0/hMin) as the wave shoals. Printing that number is what makes
  // the tolerance below mean something instead of being a number chosen to pass.
  const nullSpread = Math.sqrt(h0 / hMin) - 1;
  console.log('');
  console.log(`        sin(theta)/sqrt(h): offshore prediction ${inv0.toFixed(5)}, median ${med.toFixed(5)},`);
  console.log(`        middle half ${q1.toFixed(5)} to ${q3.toFixed(5)}, full range ${invs[0].toFixed(5)} to ${invs[invs.length - 1].toFixed(5)},`);
  console.log(`        over ${rows.length} columns from h = ${rows[0].h.toFixed(2)} down to ${hMin.toFixed(2)} m.`);
  console.log(`        NO refraction at all would spread it by ${(100 * nullSpread).toFixed(0)}% over the same range.`);
  const iqr = (q3 - q1) / med;
  assert('sin(theta)/sqrt(h) is invariant as the wave shoals', iqr < 0.02,
    `middle-half spread ${(100 * iqr).toFixed(2)}% against a no-refraction null of ${(100 * nullSpread).toFixed(0)}%. ` +
    `The full range is wider because the extreme columns sit in the wavemaker near field and in the incipient surf zone.`);
  const kErr = rows.map(q => Math.abs(q.kAbs / q.kThy - 1));
  check('|k| against the local dispersion relation omega/sqrt(gh)',
    1 + kErr.reduce((a, b) => a + b, 0) / kErr.length, 1, 0.03,
    'THIS is the part with content: ky is fixed, so kx has to move as h falls');
  const thErr = rows.map(q => Math.abs(deg(q.th) - deg(q.thSnell)));
  assert('the crest angle follows snellAngle() from src/waves.mjs', Math.max(...thErr) < 1.5,
    `worst column is ${Math.max(...thErr).toFixed(2)} deg out over the whole shoaling zone; ` +
    `the crest turns ${deg(rows[0].th).toFixed(1)} -> ${deg(rows[rows.length - 1].th).toFixed(1)} deg`);

  // Energy. This one is MEASURED AND NOT ASSERTED, and the reason is worth
  // stating: the refraction coefficient sqrt(cos(theta0)/cos(theta)) is only a
  // 5% effect by the shallowest column, while the wave has lost 30-40% of its
  // height on the way in -- mostly to the bore dissipation the plane-beach
  // section measures, only ~7% of it to the grid. A 5% signal under a 35%
  // common-mode loss is not resolved by this run, and reporting the two columns
  // as if the difference between them were the finding would be exactly the sort
  // of claim this file is supposed to stop making.
  const dp = pathDamping((x) => Math.max(0.2, r.sim.depth(Math.min(nx - 1, Math.floor(x / dx)), 0)),
    0, rows[rows.length - 1].x, dx, period, dy / dx);
  const eMean = rows.map(q => q.a / deepest.a / (greensLaw(deepest.h, q.h) * refractionCoefficient(theta0, q.th)))
    .reduce((a, b) => a + b, 0) / rows.length;
  const gOnly = rows.map(q => q.a / deepest.a / greensLaw(deepest.h, q.h)).reduce((a, b) => a + b, 0) / rows.length;
  const KrEnd = refractionCoefficient(theta0, rows[rows.length - 1].th);
  console.log('');
  console.log(`        height / (Green * Kr) = ${eMean.toFixed(3)};  height / Green alone = ${gOnly.toFixed(3)};  ` +
    `Kr at the shallowest column = ${KrEnd.toFixed(3)}`);
  console.log(`        path to there: ${dp.nL.toFixed(1)} wavelengths, linear grid damping ${(100 * (1 - dp.kept)).toFixed(0)}%.`);
  const shallow = rows[rows.length - 1];
  const lossEnd = 1 - shallow.a / deepest.a / greensLaw(deepest.h, shallow.h);
  console.log(`        NOT ASSERTED: at the shallowest column the refraction coefficient is worth ` +
    `${(100 * (1 - KrEnd)).toFixed(0)}%, and the height there is ${(100 * lossEnd).toFixed(0)}% below Green's law. ` +
    `A 6% signal under a ${(100 * lossEnd).toFixed(0)}% common-mode loss is not resolved by this run.`);
}

// ===========================================================================
if (want('barredBeach')) {
  console.log('');
  console.log('=== barred beach: break, reform, break again ========================');
  console.log('');
  const r = run('barredBeach', { height: 1.1, period: 14, periods: 34, analyse: 14 });
  const P = r.params;
  const prof = profileAlongX(r).filter(p => p && p.depth > 0.4);
  const sm = smoothOverWavelength(prof, r.dx, r.period);

  // Find the bar as a GENUINE local minimum of depth, then check it against the
  // bar the bathymetry says it built. The old search took the shallowest cell in
  // a hard-coded window (1200, 1650) and, because the Dean profile is shallower
  // at the landward end of that window than the crest is, returned x = 1648.75 m
  // (h = 3.46 m) instead of the crest at x = 1476 m (h = 4.36 m) -- so the
  // "trough" behind it came out 0.05 m shallower than the "crest".
  const w = Math.max(2, Math.round(0.5 * P.barWidth / r.dx));
  // Local extrema come in CONTIGUOUS RUNS -- against +/- 45 m neighbours the flat
  // top of the bar qualifies over 18 cells (x = 1444 to 1486 m) -- so runs are
  // collapsed to one feature each and counted. One crest and one trough is
  // itself a claim about the bathymetry and can fail.
  const cluster = (pred) => {
    const runs = [];
    for (let n = w; n < sm.length - w; n++) {
      if (sm[n].bedDepth < 0.5 || !pred(n)) continue;
      if (runs.length && n === runs[runs.length - 1].last + 1) { runs[runs.length - 1].last = n; runs[runs.length - 1].cells.push(sm[n]); }
      else runs.push({ last: n, cells: [sm[n]] });
    }
    return runs;
  };
  const mins = cluster((n) => sm[n].bedDepth < sm[n - w].bedDepth && sm[n].bedDepth < sm[n + w].bedDepth);
  const maxs = cluster((n) => sm[n].bedDepth > sm[n - w].bedDepth && sm[n].bedDepth > sm[n + w].bedDepth);
  assert('the still-water profile has exactly one bar and one trough', mins.length === 1 && maxs.length === 1,
    `${mins.length} minima and ${maxs.length} maxima of still-water depth against neighbours +/- ${(w * r.dx).toFixed(0)} m`);
  const pick = (runs, cmp) => runs[0].cells.reduce((a, b) => (cmp(a.bedDepth, b.bedDepth) ? a : b));
  const bar = pick(mins, (a, b) => a < b);
  const trough = pick(maxs, (a, b) => a > b);
  const offshore = sm.find(p => p.depth > 0.95 * r.h0 && p.x > 100);

  // Rate of height loss, normalised: -d(ln H)/dx, per 100 m. Absolute dH/dx
  // cannot compare two surf zones because the wave in the second one is already
  // small; the relative rate can.
  const nStep = Math.round(50 / r.dx);
  const decay = (p) => {
    const n = sm.indexOf(p);
    const a = sm[Math.max(0, n - nStep)], b = sm[Math.min(sm.length - 1, n + nStep)];
    // Centred, so it still returns a number at the last usable gauge -- a
    // forward difference there ran off the end of the profile and reported NaN
    // for the inner surf zone, which is exactly where the second break is.
    return (a !== b && a.H > 0 && b.H > 0) ? 1e4 * Math.log(a.H / b.H) / (b.x - a.x) : NaN;
  };
  console.log('           x [m]    h [m]    H [m]     H/h    -dlnH/dx [%/100m]');
  for (const p of sm.filter(q => q.x > bar.x - 700 && q.x < P.shoreAt - 15 && Math.round(q.x) % 50 < r.dx)) {
    console.log(`        ${p.x.toFixed(0).padStart(7)} ${p.depth.toFixed(2).padStart(8)} ${p.H.toFixed(3).padStart(8)} ` +
      `${(p.H / p.depth).toFixed(3).padStart(7)}       ${decay(p).toFixed(1).padStart(6)}`);
  }
  const inner = sm.filter(p => p.x > trough.x + 40 && p.depth > 0.45)
    .reduce((a, b) => (a.H / a.depth > b.H / b.depth ? a : b));
  // The reference dissipation rate is the MEDIAN over the open shelf seaward of
  // the bar. The single cell nearest the wavemaker reads 0.5 %/100 m because the
  // wave has not steepened yet; using that as the reference would make the
  // comparison below trivially true.
  const shelf = sm.filter(p => p.x < bar.x - 150 && p.depth > 4).map(decay).filter(Number.isFinite).sort((a, b) => a - b);
  const shelfDecay = shelf[Math.floor(shelf.length / 2)];

  const dp = pathDamping(r.depthAlong(0), 0, bar.x, r.dx, r.period);
  console.log(`        offshore H = ${f(offshore.H)} m at h = ${f(offshore.depth)} m (requested ${r.height} m)`);
  console.log(`        path to the bar: ${dp.nL.toFixed(1)} wavelengths; linear numerical damping alone would leave ${(100 * dp.kept).toFixed(0)}%,`);
  console.log(`        and the measured height there is ${(100 * bar.H / offshore.H).toFixed(0)}% of offshore -- the rest is bore dissipation`);
  console.log(`        bar crest   x = ${f(bar.x)} m  h = ${f(bar.depth)} m  H = ${f(bar.H)} m  H/h = ${f(bar.H / bar.depth)}  decay ${decay(bar).toFixed(1)}%/100m`);
  console.log(`        trough      x = ${f(trough.x)} m  h = ${f(trough.depth)} m  H = ${f(trough.H)} m  H/h = ${f(trough.H / trough.depth)}  decay ${decay(trough).toFixed(1)}%/100m`);
  console.log(`        inner surf  x = ${f(inner.x)} m  h = ${f(inner.depth)} m  H = ${f(inner.H)} m  H/h = ${f(inner.H / inner.depth)}  decay ${decay(inner).toFixed(1)}%/100m`);
  console.log('');
  console.log(`        NOT ASSERTED, and it should be read: H/h peaks at ${f(bar.H / bar.depth)} on the bar, not at the`);
  console.log(`        McCowan index ${BREAKER_INDEX}. It cannot reach it. The plane-beach section measures why -- a`);
  console.log(`        finite-amplitude wave in these equations steepens into a bore and the Riemann solver`);
  console.log(`        dissipates it long before the depth limit, because nothing here is holding the crest`);
  console.log(`        together. Asserting 0.78 would be asserting a model failure. What the bar CAN show is`);
  console.log(`        two zones of rapid dissipation separated by one where the wave stops being`);
  console.log(`        depth-limited, and that is what is asserted below.`);
  console.log('');

  // Geometry cross-check: the search and the bathymetry are two independent
  // statements about where the bar is, so they can disagree.
  check('the measured crest sits on the bar the bathymetry built', bar.x, P.barAt, P.barWidth / P.barAt,
    `barAt = ${P.barAt} m, barWidth = ${P.barWidth} m`);
  assert('the trough really is deeper than the crest', trough.depth > bar.depth + 0.5,
    `h ${f(bar.depth)} -> ${f(trough.depth)} m; the old bathymetry managed 0.358 m of relief and could not break a wave`);
  assert('the bar dissipates far faster than the shelf it sits on', decay(bar) > 3 * shelfDecay,
    `${shelfDecay.toFixed(1)} %/100 m (median) on the open shelf against ${decay(bar).toFixed(1)} %/100 m at the crest`);
  assert('the wave stops being depth-limited in the trough', trough.H / trough.depth < bar.H / bar.depth,
    `H/h falls ${f(bar.H / bar.depth)} -> ${f(trough.H / trough.depth)} as depth rises ${f(bar.depth)} -> ${f(trough.depth)} m, ` +
    `back to its offshore value of ${f(offshore.H / offshore.depth)}`);
  assert('and dissipation relaxes there too', decay(trough) < decay(bar) / 2,
    `${decay(bar).toFixed(1)} -> ${decay(trough).toFixed(1)} %/100 m: this is the "reform" the case is named for`);
  assert('a SECOND surf zone at the shore', inner.H / inner.depth > trough.H / trough.depth,
    `H/h ${f(trough.H / trough.depth)} -> ${f(inner.H / inner.depth)} shoreward of the trough ` +
    `(decay ${decay(trough).toFixed(1)} -> ${decay(inner).toFixed(1)} %/100 m, printed not asserted: by the inner zone H is ` +
    `0.2 m and the rate is noisy)`);

  // MUTATION TEST. The claim above is that H/h is NON-MONOTONE -- an interior
  // maximum on the bar, a minimum in the trough. Take the bar away and it must
  // become monotone, because on an unbarred beach the depth only ever falls.
  // Without this the two asserts above are just a description of one run.
  const flat = run('barredBeach', {
    height: 1.1, period: 14, periods: 34, analyse: 14, build: { barHeight: 0 }, quiet: true,
  });
  const fsm = smoothOverWavelength(profileAlongX(flat).filter(p => p && p.depth > 0.4), flat.dx, flat.period);
  const bumpiness = (S) => {
    const win = S.filter(p => p.x > bar.x - 250 && p.x < trough.x + 5 && p.depth > 0.45);
    const end = win[win.length - 1];
    return Math.max(...win.map(p => p.H / p.depth)) / (end.H / end.depth);
  };
  const withBar = bumpiness(sm), without = bumpiness(fsm);
  console.log('');
  console.log(`        mutation test: peak H/h over the bar divided by H/h at the trough position,`);
  console.log(`        measured over the same window x = ${(bar.x - 250).toFixed(0)} to ${trough.x.toFixed(0)} m in both runs:`);
  console.log(`          with the bar    ${f(withBar)}`);
  console.log(`          barHeight = 0   ${f(without)}   (must be 1: an unbarred beach cannot have an interior maximum)`);
  check('the unbarred control is monotone', without, 1, 0.05,
    'H/h on a beach with no bar rises all the way in, so the window peak IS its landward end; 5% is gauge scatter');
  assert('the bar is what makes the profile non-monotone', withBar > 2 * without,
    `${f(withBar)} against ${f(without)} -- a factor 2 margin, chosen so a 5% wiggle of the kind the control shows cannot pass it`);
}

// ===========================================================================
if (want('headlandBay')) {
  console.log('');
  console.log('=== headland and bay: refraction focuses on the point ===============');
  console.log('');
  //
  // The period is 23 s, not the 11 s this case used to run at. In the
  // shallow-water limit the celerity is sqrt(gh) and does not depend on the
  // period at all, so the ray pattern -- the thing being tested -- is unchanged
  // by that, while cells-per-wavelength is proportional to the period. It is the
  // only lever here that buys resolution at linear rather than cubic cost:
  // halving dx instead would cost 8x the runtime for the same factor. Measured
  // at 320x320 and dx = 8 m: 19.3 cells/wavelength at T = 11 s and 5.7 minutes,
  // against 40.3 at T = 23 s and about 9 minutes. A 23 s swell in 20 m of water
  // is also a real thing, and it is further inside the model's own validity
  // (kh = 0.40 rather than 0.89).
  const period = 23, periods = 20, analyse = 8, D = [6, 8, 10];
  const r = run('headlandBay', { height: 1.2, period, periods, analyse });
  const P = r.params;
  // cos = +1 at y = 0 gives the SMALLEST shoreline x, and x = 0 is the sea, so
  // y = 0 is the headland and y = wavelength/2 is the bay. The code had these
  // the wrong way round and its comment identified the furthest-LANDWARD point.
  const jHead = r.rowAtY(0), jBay = r.rowAtY(P.wavelength / 2);
  const shoreX = (j) => { let i = 0; while (i < r.nx && r.sim.depth(i, j) > 0.01) i++; return (i + 0.5) * r.dx; };
  console.log(`        headland row j = ${jHead} (shoreline x = ${shoreX(jHead).toFixed(0)} m), bay row j = ${jBay} (x = ${shoreX(jBay).toFixed(0)} m)`);
  console.log(`        the bay gauge is the FURTHER one from the wavemaker, so damping flatters the headland:`);
  const dampOnly = [];
  for (const d of D) {
    const iH = r.contour(jHead, d), iB = r.contour(jBay, d);
    const dH = pathDamping(r.depthAlong(jHead), 0, (iH + 0.5) * r.dx, r.dx, period);
    const dB = pathDamping(r.depthAlong(jBay), 0, (iB + 0.5) * r.dx, r.dx, period);
    dampOnly.push(dH.kept / dB.kept);
    console.log(`          h = ${d} m: headland x = ${((iH + 0.5) * r.dx).toFixed(0)} m (${dH.nL.toFixed(1)} L, ${(100 * dH.kept).toFixed(0)}% kept), ` +
      `bay x = ${((iB + 0.5) * r.dx).toFixed(0)} m (${dB.nL.toFixed(1)} L, ${(100 * dB.kept).toFixed(0)}% kept) ` +
      `-> damping alone predicts ${(dH.kept / dB.kept).toFixed(3)}x`);
  }
  console.log(`        AT THE OLD RESOLUTION (T = 11 s, 19.3 cells/wavelength) that same path difference was worth`);
  console.log(`        about 1.6x, which is most of the 2.36x this case used to report. Raising the period to 23 s`);
  console.log(`        pulls the confound down to the numbers above; the 1D control removes what is left of it.`);

  // The null: the same transects in 1D, where there is no refraction at all.
  const ctl = controls(r, [jHead, jBay], { periods, analyse });
  console.log('');
  console.log('        contour     headland H   its 1D null   gain   |     bay H   its 1D null   gain   |  head/bay');
  const gains = [], focus = [], shelter = [];
  for (const d of D) {
    const gH = gainAt(r, ctl, jHead, d), gB = gainAt(r, ctl, jBay, d);
    gains.push(gH.gain / gB.gain); focus.push(gH.gain); shelter.push(gB.gain);
    console.log(`        h = ${String(d).padStart(2)} m    ${f(gH.twoD).padStart(9)}   ${f(gH.oneD).padStart(11)}  ${f(gH.gain).padStart(6)}   |  ` +
      `${f(gB.twoD).padStart(8)}   ${f(gB.oneD).padStart(11)}  ${f(gB.gain).padStart(6)}   |  ${f(gH.gain / gB.gain).padStart(8)}`);
  }
  console.log('');
  for (let n = 0; n < D.length; n++) {
    assert(`refraction focuses the headland at h = ${D[n]} m`, focus[n] > 1 && shelter[n] < 1,
      `headland ${f(focus[n])}x and bay ${f(shelter[n])}x against their own 1D no-refraction transects, ` +
      `so the point is ${f(gains[n])}x the bay at equal depth`);
  }
  const spread = (Math.max(...gains) - Math.min(...gains)) / (gains.reduce((a, b) => a + b, 0) / gains.length);
  console.log(`        head/bay across the three contours: ${gains.map(g => f(g)).join(', ')} (spread ${(100 * spread).toFixed(1)}%)`);
  // Anchored to a measured quantity rather than a chosen one: the only thing
  // that could produce a head/bay ratio without any refraction in it is the
  // difference in path length, and that has just been measured above.
  for (let n = 0; n < D.length; n++) {
    assert(`and by much more than the path-length difference alone at h = ${D[n]} m`, gains[n] > 2 * (dampOnly[n] - 1) + 1,
      `${f(gains[n])}x measured against ${f(dampOnly[n])}x from differential damping -- the margin is a factor two on the EXCESS over 1`);
  }
  // A physical prediction that a coincidence has no reason to satisfy: the rays
  // keep converging as they run up onto the point, so the focusing must be
  // strongest at the SHALLOWEST contour.
  assert('focusing strengthens as the wave shoals onto the point', gains[0] > gains[1] && gains[1] > gains[2],
    `${gains.map(g => f(g)).join(' > ')} at h = ${D.join(' < ')} m`);

  // MUTATION TEST OF THE INSTRUMENT. Straighten the shoreline (amp = 0) and the
  // whole apparatus must report a gain of 1: same measurement, same contours,
  // same control, no headland. Run at half resolution and half the duration
  // because it only has to show that the number MOVES.
  //
  // BE CLEAR ABOUT WHAT THIS DOES AND DOES NOT PROVE. With amp = 0 the two rows
  // have identical beds, so a correct apparatus returns exactly 1 by symmetry:
  // it proves the measurement chain invents no difference where there is none --
  // which is precisely the failure the old code had, comparing a gauge against
  // the east wall -- but it cannot catch an error that scales both rows alike.
  console.log('');
  console.log('        instrument control at half resolution -- straight shoreline (amp = 0) must give gain 1:');
  const cheap = { height: 1.2, period, periods: 14, analyse: 6, domain: { nx: 160, ny: 160, dx: 16, dy: 16 } };
  const nulls = [];
  for (const amp of [0, P.amp]) {
    const rr = run('headlandBay', { ...cheap, build: { amp }, quiet: true });
    const jH = rr.rowAtY(0), jB = rr.rowAtY(P.wavelength / 2);
    const cc = controls(rr, [jH, jB], { periods: cheap.periods, analyse: cheap.analyse });
    const a = gainAt(rr, cc, jH, 8), b = gainAt(rr, cc, jB, 8);
    nulls.push({ amp, ratio: a.gain / b.gain, a: a.gain, b: b.gain });
    console.log(`          amp = ${String(amp).padStart(4)} m: headland gain ${f(a.gain)}, bay gain ${f(b.gain)}, head/bay ${f(a.gain / b.gain)}`);
  }
  check('the instrument reads 1 on a straight shoreline', nulls[0].ratio, 1, 0.05,
    'if this cannot come out at 1 then the gain above is measuring the apparatus');
  assert('and moves when the headland is put back', nulls[1].ratio > nulls[0].ratio * 1.15,
    `${f(nulls[0].ratio)} -> ${f(nulls[1].ratio)} at 16 m resolution`);
}

// ===========================================================================
if (want('submarineCanyon')) {
  console.log('');
  console.log('=== submarine canyon: refraction defocuses ==========================');
  console.log('');
  //
  // The bathymetry was rebuilt (see src/shorelines.mjs): the canyon used to run
  // off the landward edge of the domain at 45 m depth, so the gauge that was
  // supposed to be on the sheltered beach was the last cell against the
  // reflecting east wall. It now tapers out at its head, which has the useful
  // side effect that the depth contours inshore of x = 1800 m are the same at
  // every y -- so the axis and flank gauges are at the SAME x, the same depth
  // and the same distance from the wavemaker, and the numerical damping is
  // common to both instead of being the thing under test.
  const period = 17, periods = 18, analyse = 7, D = [12, 8, 5];
  const r = run('submarineCanyon', { height: 1.5, period, periods, analyse });
  const P = r.params;
  const jAxis = r.rowAtY(P.canyonY);

  // WHERE THE FLANK IS, MEASURED. The old code compared the axis with a gauge
  // 340 m to the side and called that "the flank". At 16 m resolution the
  // shadow behind the head is about 700 m wide, so +340 m was still inside it
  // and read LOWER than the axis; the focused flank sits near +700 m. The row is
  // chosen here from the h = 12 m contour and then REUSED at the other two, so
  // the deeper contours are not selected on their own answer.
  console.log('        alongshore height at the h = 12 m contour (dy from the canyon axis):');
  let line = '';
  for (const j of r.rows) {
    const dyk = (j + 0.5) * r.dy - P.canyonY;
    line += `${dyk.toFixed(0).padStart(6)}:${f(r.at(r.contour(j, 12), j).H).slice(0, 6)} `;
    if (line.length > 90) { console.log('          ' + line); line = ''; }
  }
  if (line) console.log('          ' + line);
  const jFlank = r.rows.reduce((a, b) => (r.at(r.contour(a, 12), a).H > r.at(r.contour(b, 12), b).H ? a : b));
  console.log(`        axis row j = ${jAxis} (y = ${((jAxis + 0.5) * r.dy).toFixed(0)} m); brightest row j = ${jFlank}, ` +
    `${(((jFlank + 0.5) * r.dy) - P.canyonY).toFixed(0)} m from the axis`);
  for (const d of [12, 8]) {
    const iA = r.contour(jAxis, d), iF = r.contour(jFlank, d);
    console.log(`        h = ${d} m contour is at x = ${((iA + 0.5) * r.dx).toFixed(0)} m on the axis and ` +
      `${((iF + 0.5) * r.dx).toFixed(0)} m on the flank -- the canyon dies out at its head, so these are the ` +
      `same distance from the wavemaker and the damping is common to both`);
  }

  const ctl = controls(r, [jAxis, jFlank], { periods, analyse });
  console.log('');
  console.log('        contour      axis H   its 1D null   SHELTER   |   flank H   its 1D null   FOCUS');
  const rowsOut = [];
  for (const d of D) {
    const gA = gainAt(r, ctl, jAxis, d), gF = gainAt(r, ctl, jFlank, d);
    rowsOut.push({ d, gA, gF });
    console.log(`        h = ${String(d).padStart(2)} m    ${f(gA.twoD).padStart(8)}   ${f(gA.oneD).padStart(11)}   ${f(gA.gain).padStart(7)}   |  ` +
      `${f(gF.twoD).padStart(8)}   ${f(gF.oneD).padStart(11)}   ${f(gF.gain).padStart(6)}`);
  }
  console.log('');
  for (const q of rowsOut) {
    assert(`the coast behind the canyon head is sheltered at h = ${q.d} m`, q.gA.gain < 1,
      `${f(q.gA.gain)}x its own no-refraction transect -- rays bend AWAY from deep water`);
  }
  for (const q of rowsOut) {
    assert(`and the flank is focused at h = ${q.d} m`, q.gF.gain > 1,
      `${f(q.gF.gain)}x -- the energy taken off the axis has to arrive somewhere, and this is the Nazare shoulder`);
  }
  console.log(`        deepest shelter ${(100 * (1 - Math.min(...rowsOut.map(q => q.gA.gain)))).toFixed(0)}% ` +
    `below the no-refraction height; strongest flank focus ${f(Math.max(...rowsOut.map(q => q.gF.gain)))}x.`);
}

// ===========================================================================
if (want('shoal')) {
  console.log('');
  console.log('=== offshore shoal: a caustic in the lee ============================');
  console.log('');
  //
  // THIS CASE IS MEASURED AND NOT ASSERTED, and the reason is the point of it.
  //
  // The period is 15 s rather than 9 s, for the same reason as headlandBay:
  // cells/wavelength is proportional to the period and the ray pattern in the
  // SWE limit is not, so it is the cheap lever. That still leaves it at 24.8,
  // under the floor of 40, and it stays there because reaching 40 needs T = 24 s
  // -- at which the wavelength is 238 m and the bank is two wavelengths across,
  // so diffraction erases the caustic that is the whole point.
  //
  // But resolution is not what stops this case being a test. The lee field is
  // printed below and it is a fine-scale interference pattern: neighbouring
  // gauges 60 m apart in a 149 m wave differ by a factor of four, and the
  // pattern is MIRROR-SYMMETRIC about the bank, so it is deterministic
  // structure and not noise. The old code drew a single "on-axis" gauge and a
  // single "off to the side" gauge out of that field and divided them, and the
  // answer depended on which fringe each of them landed in -- with a solid east
  // wall its reference gauge sat on an antinode and read 0.4986 m where the
  // 400 m of open water either side of it swung between 0.264 and 0.499 m.
  //
  // HYPOTHESIS, NOT MEASUREMENT, for where the fringes come from: the north and
  // south boundaries are periodic, so this is not one bank but an infinite row
  // of them 1440 m apart, which is a diffraction grating for a 149 m wave. The
  // test that would settle it is to double ny and see whether the fringe spacing
  // follows; that has not been run. Until it has, the amplification below is a
  // number, not a result, and it is reported as one.
  const period = 15;
  const bc = { sponge: { width: 40, strength: 0.08 }, east: 'radiate' };
  const { meta: probe } = shoreline('shoal');
  // Gauge rows in exact mirror pairs about the bank centre, which lies on a cell
  // FACE (shoalY = 720 m, dy = 6 m), so that the symmetry check below is exact
  // rather than 3 m out.
  const jMid = Math.round(probe.params.shoalY / probe.domain.dy) - 1;
  const pairRows = [];
  for (let k = 0; k <= 11; k++) { pairRows.push(jMid - 10 * k, jMid + 1 + 10 * k); }
  const r = run('shoal', {
    height: 0.6, period, periods: 28, analyse: 11,
    rowList: pairRows.filter(j => j >= 0 && j < probe.domain.ny), ...bc,
  });
  const P = r.params;
  const iLee = Math.round(1500 / r.dx);
  const jAxis = r.rowAtY(P.shoalY);
  console.log(`        alongshore height at x = ${((iLee + 0.5) * r.dx).toFixed(0)} m (dy from the bank centre):`);
  let ln = '';
  for (const j of r.rows) {
    ln += `${((j + 0.5) * r.dy - P.shoalY).toFixed(0).padStart(6)}:${f(r.at(iLee, j).H).slice(0, 6)} `;
    if (ln.length > 90) { console.log('          ' + ln); ln = ''; }
  }
  if (ln) console.log('          ' + ln);

  // Mirror symmetry. The bed, the grid and the forcing are all symmetric about
  // y = 720 m, so the solution must be too; anything much above round-off is a
  // defect in the solver's y direction, not physics. It also settles whether the
  // fringe pattern above is structure or scatter.
  const pairs = [];
  for (let k = 1; k <= 11; k++) {
    const a = jMid - 10 * k, b = jMid + 1 + 10 * k;
    if (a < 0 || b >= r.ny) continue;
    const Ha = r.at(iLee, a).H, Hb = r.at(iLee, b).H;
    pairs.push(Math.abs(Ha - Hb) / (0.5 * (Ha + Hb)));
  }
  const worstSym = Math.max(...pairs);
  console.log(`        mirror asymmetry across the bank axis: worst pair ${(100 * worstSym).toFixed(2)}%, ` +
    `median ${(100 * pairs.slice().sort((a, b) => a - b)[Math.floor(pairs.length / 2)]).toFixed(2)}% over ${pairs.length} pairs`);
  assert('the lee field is mirror-symmetric about the bank', worstSym < 0.02,
    `worst ${(100 * worstSym).toFixed(2)}%. Everything about this problem is symmetric about y = ${P.shoalY} m, ` +
    `so this is a check on the SOLVER, and it also shows the fringes are deterministic structure rather than scatter.`);

  const jEdge = r.rows.reduce((a, b) =>
    (Math.abs(Math.abs((a + 0.5) * r.dy - P.shoalY) - 720) < Math.abs(Math.abs((b + 0.5) * r.dy - P.shoalY) - 720) ? a : b));
  const ctl = controls(r, [jAxis, jEdge], { periods: 28, analyse: 11, ...bc });
  const gA = gainAtColumn(r, ctl, jAxis, iLee), gE = gainAtColumn(r, ctl, jEdge, iLee);
  const band = (lo, hi) => {
    const v = r.rows.filter(j => { const d = Math.abs((j + 0.5) * r.dy - P.shoalY); return d >= lo && d <= hi; }).map(j => r.at(iLee, j).H);
    return v.reduce((a, b) => a + b, 0) / v.length;
  };
  console.log('');
  console.log(`        offshore H = ${f(r.at(20, jEdge).H)} m for a requested ${r.height} m`);
  console.log(`        on the bank axis: ${f(gA.twoD)} m against ${f(gA.oneD)} m from the same transect in 1D -> ${f(gA.gain)}x`);
  console.log(`        620 m to the side: ${f(gE.twoD)} m against ${f(gE.oneD)} m -> ${f(gE.gain)}x`);
  console.log(`        alongshore band means at the same x: |dy| < 260 m gives ${f(band(0, 260))} m, ` +
    `|dy| > 480 m gives ${f(band(480, 1e9))} m`);
  console.log('        NOT ASSERTED. Every one of those numbers depends on which fringe its gauge landed in.');
  console.log('        To turn this back into a test the lee field has to be smooth: either absorb the north');
  console.log('        and south boundaries so there is one bank instead of an infinite row of them, or widen');
  console.log('        the domain until the images are far enough away, and then re-measure. The Berkhoff');
  console.log('        experiment is an isolated shoal in a flume with absorbing walls, and that is the part');
  console.log('        of it this domain does not reproduce.');
  check('the incident wave arrives at the height it was asked for', r.at(20, jEdge).H, r.height, 0.15,
    'measured 20 cells in from the wavemaker, before the bank; this is the one thing here that is not in the fringe field');
}

// ===========================================================================
if (want('fringingReef')) {
  console.log('');
  console.log('=== fringing reef: breaking on the crest drives setup in the lagoon ==');
  console.log('');
  const r = run('fringingReef', { height: 1.6, period: 14, periods: 30, analyse: 12 });
  const P = r.params;
  const prof = profileAlongX(r).filter(p => p && p.depth > 0.3);
  const sm = smoothOverWavelength(prof, r.dx, r.period);
  const off = sm.find(p => p.x > 200 && p.depth > 18) || sm[0];
  let crest = sm[0];
  for (const p of sm) if (Math.abs(p.x - P.reefAt) < 400 && p.depth < crest.depth) crest = p;
  const lagoon = sm.filter(p => p.x > crest.x + 150 && p.x < P.shoreAt - 80);
  const meanLagoon = lagoon.reduce((a, p) => a + p.mean, 0) / lagoon.length;
  const setup = meanLagoon - off.mean;
  // THE BREAKER HEIGHT IS THE HEIGHT AT THE BREAK POINT, not the height left on
  // the reef flat afterwards. The old code used crest.H -- measured 0.287 m,
  // after the reef had already removed 93% of the wave -- and then called the
  // setup 87% of "the breaker height" while its own `expect` said 10-25%. Hb is
  // the maximum height on the fore-reef, which is where shoaling stops and
  // dissipation takes over; that is what the 10-25% is a fraction OF.
  const foreReef = sm.filter(p => p.x < crest.x - 20 && p.x > 200);
  const brk = foreReef.reduce((a, b) => (a.H > b.H ? a : b));
  const Hb = brk.H;
  console.log(`        offshore H = ${f(off.H)} m at h = ${f(off.depth)} m for a requested ${r.height} m`);
  console.log(`        (4*sigma at the same gauge = ${f(off.H4sigma)} m, ratio ${f(off.H4sigma / off.H)}; the old code`);
  console.log(`         printed that 4*sigma figure and its 1.40x over the request was unexplained -- it is sqrt(2))`);
  check('offshore height against the requested height', off.H, r.height, 0.12,
    'crest-to-trough at the first deep gauge; the wavemaker prescribes the INCOMING characteristic, so a few percent of standing wave is expected');
  console.log('           x [m]    h [m]    H [m]     H/h    mean [m]');
  for (const p of sm.filter(q => Math.round(q.x) % 50 < r.dx && q.x > 500))
    console.log(`        ${p.x.toFixed(0).padStart(7)} ${p.depth.toFixed(2).padStart(8)} ${p.H.toFixed(3).padStart(8)} ` +
      `${(p.H / p.depth).toFixed(3).padStart(7)} ${p.mean.toFixed(4).padStart(9)}`);
  console.log(`        breaker: x = ${f(brk.x)} m, h = ${f(brk.depth)} m, Hb = ${f(Hb)} m, H/h = ${f(Hb / brk.depth)}`);
  console.log(`        reef crest: h = ${f(crest.depth)} m, H = ${f(crest.H)} m, H/h = ${f(crest.H / crest.depth)}`);
  console.log(`        mean level: offshore ${f(off.mean)} m, lagoon ${f(meanLagoon)} m over ${lagoon.length} gauges`);
  const pct = 100 * setup / Math.max(Hb, 1e-9);
  console.log(`        setup ${f(setup)} m = ${pct.toFixed(1)}% of the breaker height`);
  // The band is the one the shoreline's own `expect` claims, and it is the
  // textbook number (setup at the shoreline is 15-20% of the breaker height for
  // a plane beach; Bowen, Inman & Simpson 1968). Asserting `setup > 0.02` as the
  // old code did could not fail: a millimetre of numerical drift passes it.
  assert('breaking raises the mean level in the lagoon (wave setup)', setup > 0,
    `setup ${f(setup)} m`);
  assert('and by the documented 10-25% of the breaker height', pct > 10 && pct < 25,
    `${pct.toFixed(1)}% -- if this fails the number is reported, not the band widened`);
  const dissip = 1 - lagoon[Math.min(3, lagoon.length - 1)].H / off.H;
  console.log(`        the reef removes ${(100 * dissip).toFixed(0)}% of the offshore wave height`);
}

console.log('');
console.log(`${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} -- ${checks - failures}/${checks} checks`);
console.log('');
process.exit(failures ? 1 : 0);
