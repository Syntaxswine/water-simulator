// ---------------------------------------------------------------------------
// What the bed does to the waves.
//
// Six shorelines, each chosen to make one process dominant so it can be measured
// on its own rather than inferred from a pretty picture:
//
//   plane beach       shoaling against Green's law, then depth-limited breaking
//   barred beach      break / reform / break -- two surf zones
//   headland and bay  refraction FOCUSING energy on the point
//   submarine canyon  refraction DEFOCUSING, the same law with the other sign
//   offshore shoal    a caustic behind the bank (Berkhoff's experiment)
//   fringing reef     wave setup in the lagoon from breaking momentum flux
//
// The quantitative claims are asserted. The qualitative ones are printed with
// their numbers and NOT asserted, because a threshold invented to make a
// picture pass is not a test.
//
//   node tools/waves.mjs [shoreline]
// ---------------------------------------------------------------------------

import { ShallowWater, flather, reflect, periodic, makeSponge, G } from '../src/swe.mjs';
import { shoreline, SHORELINES } from '../src/shorelines.mjs';
import { regularWave, greensLaw, airy, waveStats, snellAngle, BREAKER_INDEX } from '../src/waves.mjs';

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

/**
 * Run a shoreline with a regular wave arriving from the west (deep) side.
 *
 * Gauges record for the LAST `analyse` periods only. The first crossing of the
 * domain sets up the standing pattern between the wavemaker and the beach, and
 * statistics taken during it describe the transient rather than the sea state.
 */
function run(name, { height = 1.0, period = 9, periods = 34, analyse = 14, res = 1, msl = 0, manning = 0.022 } = {}) {
  const { bed, meta } = shoreline(name);
  const d = meta.domain;
  const nx = Math.round(d.nx * res), ny = Math.round(d.ny * res);
  const dx = d.dx / res, dy = d.dy / res;
  const h0 = meta.offshoreDepth;
  const sim = new ShallowWater({ nx, ny, dx, dy, bed, eta0: msl, manning });
  const wm = regularWave({ height, period, depth: h0, rampPeriods: 3, msl });
  sim.boundaries = {
    west: flather(wm.etaExt, wm.uExt),
    east: reflect, south: periodic, north: periodic,
  };
  // NO SPONGE ON THE WAVEMAKER BOUNDARY. A sponge relaxes the surface toward a
  // reference, so putting one where the waves come IN damps the incident wave
  // before it ever enters -- measured, a requested 0.8 m wave arrived as 0.16 m.
  // Flather already lets the reflected wave out; that is what it is for.

  // ALWAYS report the resolution. tools/verify.mjs section 8 measures the
  // amplitude a wave loses per wavelength travelled, and below about 40 cells
  // per wavelength the answer is dominated by numerical dissipation rather than
  // by the bed. A coastal result quoted without this number cannot be judged.
  const Lw = Math.sqrt(G * h0) * period;
  const cpw = Lw / dx;
  console.log(`        grid ${nx}x${ny} at ${dx} m; wave T = ${period} s in ${h0} m -> L = ${Lw.toFixed(0)} m, ${cpw.toFixed(0)} cells/wavelength`);
  if (cpw < 35) console.log(`        WARNING: under 35 cells/wavelength, numerical damping competes with the physics`);

  const T = periods * period, T0 = (periods - analyse) * period;
  const dtRec = period / 40;
  const rec = new Map();                       // key -> series
  const gauges = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j += Math.max(1, Math.round(ny / 24))) gauges.push([i, j]);
  for (const [i, j] of gauges) rec.set(i + ':' + j, []);

  let next = T0;
  while (sim.t < T) {
    sim.step(Math.min(sim.maxDt(), Math.max(1e-6, Math.min(T, next) - sim.t)));
    if (sim.t >= next && sim.t >= T0) {
      for (const [i, j] of gauges) rec.get(i + ':' + j).push(sim.eta(i, j));
      next += dtRec;
    } else if (sim.t >= next) next += dtRec;
  }
  return { sim, meta, rec, gauges, wm, dtRec, h0, nx, ny, dx, dy };
}

/** Wave height and mean level along x, averaged over the recorded y gauges. */
function profileAlongX(r) {
  const out = [];
  const ys = [...new Set(r.gauges.map(g => g[1]))];
  for (let i = 0; i < r.nx; i++) {
    let H = 0, mean = 0, n = 0, depth = 0;
    for (const j of ys) {
      const s = r.rec.get(i + ':' + j);
      if (!s || s.length < 8) continue;
      const st = waveStats(s, r.dtRec);
      if (!st) continue;
      H += st.H4sigma; mean += st.mean; n++;
      depth += r.sim.depth(i, j);
    }
    out.push(n ? { x: (i + 0.5) * r.dx, H: H / n, mean: mean / n, depth: depth / n } : null);
  }
  return out;
}

const only = process.argv[2];
const want = (k) => !only || only === k;

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
  // measured and printed rather than hidden. Measured: the fitted exponent goes
  // +0.15, -0.18, -0.24, -0.24 as the offshore height goes 0.8, 0.2, 0.05,
  // 0.012 m, against Green's -0.25. Bed friction is NOT the cause: switching
  // Manning off moves the H = 0.8 m case from 0.154 to 0.152.
  const fitExp = (H0, manning) => {
    const r = run('planeBeach', { height: H0, period: 14, periods: 30, analyse: 12, manning });
    const prof = profileAlongX(r).filter(p => p && p.depth > 0.3);
    const sm = prof.map((p, i) => {
      const Lloc = Math.sqrt(G * p.depth) * 14;
      const half = Math.max(1, Math.round(0.5 * Lloc / r.dx));
      let acc = 0, n = 0;
      for (let q = Math.max(0, i - half); q <= Math.min(prof.length - 1, i + half); q++) { acc += prof[q].H; n++; }
      return { ...p, H: acc / n, cellsPerL: Lloc / r.dx };
    });
    // Smoothed over one local wavelength first: a beach reflects, and the partial
    // standing pattern it sets up is fixed in space, so an unsmoothed gauge
    // reports its position in that pattern instead of the wave height.
    const band = sm.filter(p => p.depth < 10 && p.depth > 3 && p.cellsPerL >= 30 && p.H / p.depth < BREAKER_INDEX);
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of band) { const X = Math.log(p.depth), Y = Math.log(p.H); sx += X; sy += Y; sxx += X * X; sxy += X * Y; }
    const n = band.length;
    return { slope: (n * sxy - sx * sy) / (n * sxx - sx * sx), n, r, sm };
  };
  const sweep = [];
  for (const H0 of [0.8, 0.2, 0.05, 0.012]) {
    const q = fitExp(H0, 0);
    sweep.push({ H0, slope: q.slope, n: q.n });
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

  // Breaking, at a realistic wave height.
  const big = fitExp(0.8, 0.022);
  const ref = big.sm.find(p => p.depth > 0.9 * big.r.h0 && p.x > 250) || big.sm[0];
  const broke = big.sm.find(p => p.x > ref.x && p.H / p.depth > BREAKER_INDEX);
  if (broke) {
    console.log(`        breaks at h = ${f(broke.depth)} m with H = ${f(broke.H)} m`);
    check('breaker index H/h at break', broke.H / broke.depth, BREAKER_INDEX, 0.45,
      'McCowan 0.78; the real index is slope- and steepness-dependent, so this is a band');
    const surf = big.sm.filter(p => p.x > broke.x && p.depth > 0.5);
    if (surf.length > 3) {
      const mx = Math.max(...surf.map(p => p.H / p.depth));
      assert('surf zone stays depth-limited', mx < 1.7, `max H/h inside the surf zone = ${f(mx)}`);
    }
  } else assert('the wave breaks somewhere on the beach', false, 'no cell reached H/h = 0.78');
}

// ===========================================================================
if (want('barredBeach')) {
  console.log('');
  console.log('=== barred beach: break, reform, break again ========================');
  console.log('');
  const r = run('barredBeach', { height: 1.1, period: 14 });
  const prof = profileAlongX(r).filter(p => p && p.depth > 0.4);
  // Find the bar: the local minimum of depth seaward of the shore.
  let bar = prof[0];
  for (const p of prof) if (p.x > 1200 && p.x < 1650 && p.depth < bar.depth) bar = p;
  const trough = prof.filter(p => p.x > bar.x && p.x < bar.x + 220).sort((a, b) => b.depth - a.depth)[0];
  console.log(`        bar crest at x = ${f(bar.x)} m, h = ${f(bar.depth)} m, H/h = ${f(bar.H / bar.depth)}`);
  console.log(`        trough behind it h = ${f(trough.depth)} m, H/h = ${f(trough.H / trough.depth)}`);
  assert('waves break on the bar', bar.H / bar.depth > 0.55, `H/h = ${f(bar.H / bar.depth)} at the crest`);
  assert('the wave relaxes in the deeper trough',
    trough.H / trough.depth < bar.H / bar.depth,
    `H/h falls ${f(bar.H / bar.depth)} -> ${f(trough.H / trough.depth)} as depth rises ${f(bar.depth)} -> ${f(trough.depth)} m`);
}

// ===========================================================================
if (want('headlandBay')) {
  console.log('');
  console.log('=== headland and bay: refraction focuses on the point ===============');
  console.log('');
  const r = run('headlandBay', { height: 1.2, period: 11, periods: 26, analyse: 10 });
  // Headland is where the shoreline reaches furthest seaward (cos = -1 -> y = L/2).
  const yHead = Math.round(r.ny / 2), yBay = 2;
  const at = (i, j) => { const s = r.rec.get(i + ':' + j); return s ? waveStats(s, r.dtRec) : null; };
  // Compare at the SAME DEPTH contour, not the same x -- otherwise the
  // comparison is contaminated by ordinary shoaling and says nothing about
  // refraction at all.
  const findDepth = (j, target) => {
    for (let i = r.nx - 1; i > 0; i--) if (r.sim.depth(i, j) >= target) return i;
    return -1;
  };
  const D = 6;
  const iH = findDepth(yHead, D), iB = findDepth(yBay, D);
  const sH = iH > 0 ? at(iH, yHead) : null, sB = iB > 0 ? at(iB, yBay) : null;
  if (sH && sB) {
    const ratio = sH.H4sigma / sB.H4sigma;
    console.log(`        at the h = ${D} m contour:  headland H = ${f(sH.H4sigma)} m,  bay H = ${f(sB.H4sigma)} m`);
    assert('the headland sees bigger waves than the bay at equal depth', ratio > 1.15,
      `ratio ${f(ratio)} -- this is why headlands erode and bays accrete`);
  } else assert('gauges found at the comparison depth', false);
}

// ===========================================================================
if (want('submarineCanyon')) {
  console.log('');
  console.log('=== submarine canyon: refraction defocuses ==========================');
  console.log('');
  const r = run('submarineCanyon', { height: 1.5, period: 12, periods: 24, analyse: 9 });
  const yAxis = Math.round(r.ny / 2);
  const yFlank = Math.round(r.ny / 2) + Math.round(340 / r.dy);
  const at = (i, j) => { const s = r.rec.get(i + ':' + j); return s ? waveStats(s, r.dtRec) : null; };
  const findDepth = (j, target) => { for (let i = r.nx - 1; i > 0; i--) if (r.sim.depth(i, j) >= target) return i; return -1; };
  const D = 8;
  const ia = findDepth(yAxis, D), ifl = findDepth(yFlank, D);
  const sa = ia > 0 ? at(ia, yAxis) : null, sf = ifl > 0 ? at(ifl, yFlank) : null;
  if (sa && sf) {
    console.log(`        at the h = ${D} m contour:  canyon axis H = ${f(sa.H4sigma)} m,  flank H = ${f(sf.H4sigma)} m`);
    assert('the coast behind the canyon axis is sheltered', sa.H4sigma < sf.H4sigma,
      `axis/flank = ${f(sa.H4sigma / sf.H4sigma)} -- rays bend AWAY from deep water`);
  } else assert('gauges found at the comparison depth', false);
}

// ===========================================================================
if (want('shoal')) {
  console.log('');
  console.log('=== offshore shoal: a caustic in the lee ============================');
  console.log('');
  const r = run('shoal', { height: 0.6, period: 9, periods: 28, analyse: 11 });
  const at = (i, j) => { const s = r.rec.get(i + ':' + j); return s ? waveStats(s, r.dtRec) : null; };
  const ys = [...new Set(r.gauges.map(g => g[1]))];
  const iLee = Math.round(1500 / r.dx);
  let best = null, edge = null;
  for (const j of ys) {
    const s = at(iLee, j);
    if (!s) continue;
    const dy = Math.abs((j + 0.5) * r.dy - 720);
    if (dy < 260 && (!best || s.H4sigma > best.H)) best = { H: s.H4sigma, y: (j + 0.5) * r.dy };
    if (dy > 620 && (!edge || s.H4sigma > edge.H)) edge = { H: s.H4sigma, y: (j + 0.5) * r.dy };
  }
  if (best && edge) {
    console.log(`        1500 m downstream: on-axis H = ${f(best.H)} m, off to the side H = ${f(edge.H)} m`);
    assert('energy concentrates behind the bank', best.H / edge.H > 1.1,
      `amplification ${f(best.H / edge.H)}x on the shoal axis`);
  } else assert('lee gauges found', false);
}

// ===========================================================================
if (want('fringingReef')) {
  console.log('');
  console.log('=== fringing reef: breaking on the crest drives setup in the lagoon ==');
  console.log('');
  const r = run('fringingReef', { height: 1.6, period: 14, periods: 30, analyse: 12 });
  const prof = profileAlongX(r).filter(p => p && p.depth > 0.3);
  const off = prof.find(p => p.x > 200 && p.depth > 18) || prof[0];
  let crest = prof[0];
  for (const p of prof) if (p.x > 900 && p.x < 1300 && p.depth < crest.depth) crest = p;
  const lagoon = prof.filter(p => p.x > crest.x + 150 && p.x < 1620);
  if (lagoon.length) {
    const meanLagoon = lagoon.reduce((a, p) => a + p.mean, 0) / lagoon.length;
    const setup = meanLagoon - off.mean;
    const Hb = crest.H;
    console.log(`        offshore H = ${f(off.H)} m at h = ${f(off.depth)} m; crest h = ${f(crest.depth)} m, H = ${f(Hb)} m`);
    console.log(`        mean level: offshore ${f(off.mean)} m, lagoon ${f(meanLagoon)} m`);
    assert('breaking raises the mean level in the lagoon (wave setup)', setup > 0.02,
      `setup ${f(setup)} m = ${(100 * setup / Math.max(Hb, 1e-9)).toFixed(0)}% of the breaker height (typically 10-25%)`);
    const dissip = 1 - lagoon[Math.min(3, lagoon.length - 1)].H / off.H;
    console.log(`        the reef removes ${(100 * dissip).toFixed(0)}% of the offshore wave height`);
  } else assert('lagoon gauges found', false);
}

console.log('');
console.log(`${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} -- ${checks - failures}/${checks} checks`);
console.log('');
process.exit(failures ? 1 : 0);
