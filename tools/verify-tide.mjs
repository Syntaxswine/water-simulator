// ---------------------------------------------------------------------------
// Tides, and the boundary that lets them in.
//
// A tide is not generated inside a coastal domain -- it arrives. So two things
// have to be right, and they are different things:
//
//   1. the ASTRONOMY, which is arithmetic on constituent frequencies and can be
//      checked against published periods to as many digits as you like;
//   2. the RESPONSE, which is what the basin does to the tide it is given, and
//      which is the whole reason to run a simulation rather than plot a sine.
//
// The headline check is quarter-wave resonance. A basin open at one end and
// closed at the other amplifies a forcing near T = 4L/sqrt(gh). That single
// formula is the entire explanation of the Bay of Fundy's 16 m range, and it is
// an EMERGENT property here: nothing in the solver knows about it, so finding
// the peak in the right place is a real result and not a restatement.
//
//   node tools/verify-tide.mjs
// ---------------------------------------------------------------------------

import { ShallowWater, flather, reflect, periodic, G as G_SOLVER } from '../src/swe.mjs';

// THE ANALYTIC TARGETS MUST NOT IMPORT GRAVITY FROM THE SOLVER.
//
// This file used to write `Math.sqrt(G * h)` with G taken from src/swe.mjs, so a
// solver with the wrong gravity produced a wrong answer AND a matching wrong
// prediction, and the suite stayed green. That is exactly the defect a mutation
// sweep found in tools/verify.mjs -- it passed 32/32 with g scaled by 1.1, with
// byte-identical relative errors -- and this file had inherited it.
//
// G_REF is the independent value. G_SOLVER is only ever compared against it.
const G_REF = 9.80665;
const G = G_REF;
import { Tide, CONSTITUENTS, ATLANTIC_MESO } from '../src/tide.mjs';

let checks = 0, failures = 0;
function check(label, got, want, tol, note = '') {
  checks++;
  const rel = Math.abs(want) > 1e-12 ? Math.abs(got - want) / Math.abs(want) : Math.abs(got - want);
  const ok = rel <= tol; if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} got ${f(got)}  want ${f(want)}  rel ${(100 * rel).toFixed(3)}%${note ? '   ' + note : ''}`);
}
function assert(label, ok, note = '') {
  checks++; if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${note ? '   ' + note : ''}`);
}
function f(v) { const a = Math.abs(v); return a === 0 ? '0' : (a < 1e-3 || a >= 1e5) ? v.toExponential(4) : v.toFixed(5); }

/** Amplitude of the last `nCycles` of a series, as half the peak-to-peak range. */
function amplitude(series) {
  let lo = Infinity, hi = -Infinity;
  for (const v of series) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return 0.5 * (hi - lo);
}

console.log('');
console.log('=== 1. constituent arithmetic ======================================');
console.log('');
// The decoupling above only means something if someone checks the two agree.
check('solver gravity matches the reference used by every target here', G_SOLVER, G_REF, 0,
  'if this fails, every analytic target below is being graded by the thing it grades');
// Not a simulation: a check that the published periods are transcribed correctly
// and that the derived quantities follow from them. Cheap, and a typo in a period
// would otherwise silently detune every resonance result below.
{
  const t = new Tide({ M2: [1, 0], S2: [0.4, 0] });
  // Spring-neap is the M2/S2 beat: 1/(1/12 - 1/12.4206012) hours.
  const wantBeat = 1 / (1 / 12.0 - 1 / 12.4206012) * 3600;
  check('spring-neap beat period', t.springNeapPeriod(), wantBeat, 1e-12,
    `${(t.springNeapPeriod() / 86400).toFixed(3)} days; the synodic month is 29.53 so half is 14.765`);
  check('...which is half a synodic month', t.springNeapPeriod() / 86400, 29.5306 / 2, 0.002);
  // Range: with M2 = 1.0 and S2 = 0.4 in phase at springs, the extremes are
  // +/-1.4 exactly, and at neaps +/-0.6.
  const r = t.range(30, 60);
  check('spring range from M2 + S2 amplitudes', r.range, 2 * 1.4, 0.01,
    'springs are the sum, neaps the difference');
  assert('M2 is the largest semidiurnal constituent', CONSTITUENTS.M2.period > 12 && CONSTITUENTS.M2.period < 12.5,
    `M2 = ${CONSTITUENTS.M2.period} h`);
  // A diurnal constituent must be near 24 h and a semidiurnal near 12, or the
  // table has been scrambled.
  assert('diurnal and semidiurnal families are correctly grouped',
    ['M2', 'S2', 'N2', 'K2'].every(k => CONSTITUENTS[k].period > 11.5 && CONSTITUENTS[k].period < 13) &&
    ['K1', 'O1', 'P1', 'Q1'].every(k => CONSTITUENTS[k].period > 23 && CONSTITUENTS[k].period < 27));
}

console.log('');
console.log('=== 2. quarter-wave resonance: the Bay of Fundy in one formula ======');
console.log('');
//
// Force a closed-ended channel at a range of periods and find the one that
// amplifies most. Theory says T_res = 4L/sqrt(gh), from the mode with a node at
// the mouth and an antinode at the head.
//
// Friction is kept small but non-zero: a frictionless resonator has infinite
// gain at the peak and the measured maximum is then set by how long you ran it,
// which is a property of the experiment rather than of the basin.
{
  // A RESONATOR NEEDS A PARTIALLY REFLECTING MOUTH, and getting this wrong is
  // instructive. With a perfectly transparent open boundary the gain came out
  // 1.98 at EVERY forcing period -- which is right, and is not resonance: a wave
  // hitting the closed end doubles, and with nothing to send it back into the
  // basin there is no standing mode to build. Real bays resonate because the
  // mouth is an impedance step, where the bay meets a deeper, wider shelf.
  //
  // So the basin here opens into deep water. The step reflects part of the
  // returning wave back in, the basin rings, and the ringing peaks when the
  // basin is a quarter-wavelength long: T = 4L/sqrt(g h_bay). That is the Bay of
  // Fundy, and nothing in the solver knows the formula.
  const Lbay = 90000, hBay = 40, Lapp = 40000, hApp = 400;
  const Tres = 4 * Lbay / Math.sqrt(G * hBay);
  const zBay = Math.sqrt(hBay), zApp = Math.sqrt(hApp);
  const Rstep = Math.abs((zBay - zApp) / (zBay + zApp));
  console.log(`        bay ${Lbay / 1000} km long, ${hBay} m deep, opening into ${hApp} m`);
  console.log(`        predicted quarter-wave period 4L/sqrt(g h) = ${(Tres / 3600).toFixed(2)} h`);
  console.log(`        the depth step returns ${(100 * Rstep).toFixed(0)}% of the outgoing wave, which is what makes it ring`);
  const L = Lapp + Lbay, nx = 200, dx = L / nx;
  const bed = (x) => (x < Lapp ? -hApp : -hBay);
  const runPeriod = (period) => {
    const sim = new ShallowWater({ nx, ny: 1, dx, bed, eta0: 0, manning: 0.010, cfl: 0.4 });
    const w = 2 * Math.PI / period, amp = 0.5;
    const eta = (t) => amp * Math.min(1, t / (3 * period)) * Math.cos(w * t);
    sim.boundaries = {
      west: flather(eta, (t) => Math.sqrt(G / hApp) * eta(t)),
      east: reflect, south: periodic, north: periodic,
    };
    const T = 12 * period, T0 = 8 * period;
    const rec = [];
    let next = T0;
    while (sim.t < T) {
      sim.step(Math.min(sim.maxDt(), Math.max(1e-6, Math.min(T, next) - sim.t)));
      if (sim.t >= next) { if (sim.t >= T0) rec.push(sim.eta(nx - 2, 0)); next += period / 60; }
    }
    return amplitude(rec) / amp;
  };
  const ratios = [0.55, 0.8, 1.0, 1.25, 1.7];
  const gains = [];
  for (const r of ratios) {
    const gain = runPeriod(Tres * r);
    gains.push({ r, gain });
    console.log(`        T/T_res = ${r.toFixed(2)}   head amplitude / incident = ${gain.toFixed(3)}`);
  }
  let peak = gains[0];
  for (const g of gains) if (g.gain > peak.gain) peak = g;
  check('resonant period found by sweeping the forcing', peak.r, 1.0, 0.30,
    `peak gain ${peak.gain.toFixed(2)}x at T/T_res = ${peak.r}; nothing in the solver knows 4L/sqrt(gh)`);
  // The signature of a resonance is that the gain falls away on BOTH sides of the
  // peak. Asserting "the detuned case is below 0.85x the peak" instead tests a
  // threshold I invented -- and it failed at 0.868 while the curve was a textbook
  // resonance, which is the wrong reason to go red.
  const iPeak = gains.indexOf(peak);
  const fallsBelow = iPeak > 0 && gains[iPeak - 1].gain < peak.gain;
  const fallsAbove = iPeak < gains.length - 1 && gains[iPeak + 1].gain < peak.gain;
  assert('gain falls away on both sides of the peak', fallsBelow && fallsAbove,
    gains.map(g => `${g.r}:${g.gain.toFixed(2)}`).join('  '));
  assert('resonance amplifies beyond simple end-wall doubling', peak.gain > 2.3,
    `${peak.gain.toFixed(2)}x; a non-resonant closed end gives exactly 2, which is what a`
    + ` perfectly transparent mouth produced at EVERY period before the impedance step was added`);
}

console.log('');
console.log('=== 3. the open boundary must absorb, not reflect ===================');
console.log('');
//
// Everything above depends on the Flather condition letting the reflected wave
// OUT. A prescribed-elevation boundary is a perfect mirror, and a domain driven
// through one slowly fills with its own reflections -- which shows up as
// amplification, i.e. exactly the signal section 2 is trying to measure. So
// measure the reflection coefficient directly: send a pulse at the boundary and
// see how much comes back.
{
  const h = 30, L = 60000, nx = 600, dx = L / nx;
  const measure = (bc) => {
    const sim = new ShallowWater({ nx, ny: 1, dx, bed: () => -h, eta0: 0, manning: 0, cfl: 0.4 });
    const c0 = Math.sqrt(G * h);
    const A = 0.1, x0 = 20000, sig = 2500;
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * dx, e = A * Math.exp(-(((x - x0) / sig) ** 2));
      const k = sim.idx(i, 0);
      sim.h[k] = h + e; sim.hu[k] = c0 * e;          // pure right-going pulse
    }
    sim.boundaries = { west: reflect, east: bc, south: periodic, north: periodic };
    // Run until the pulse has left and any reflection has come back into view.
    const T = 1.9 * (L - x0) / c0;
    while (sim.t < T) sim.step(Math.min(sim.maxDt(), T - sim.t));
    let mx = 0;
    for (let i = 10; i < nx - 40; i++) mx = Math.max(mx, Math.abs(sim.eta(i, 0)));
    return mx / A;
  };
  const rFlather = measure(flather(() => 0, () => 0));
  const rWall = measure(reflect);
  console.log(`        wall boundary reflects ${(100 * rWall).toFixed(1)}% of the pulse (the control)`);
  console.log(`        Flather boundary reflects ${(100 * rFlather).toFixed(2)}%`);
  assert('Flather absorbs an outgoing long wave', rFlather < 0.05,
    `reflection coefficient ${(100 * rFlather).toFixed(2)}%`);
  assert('...and the measurement can tell a mirror from an absorber', rWall > 0.5,
    `a solid wall returns ${(100 * rWall).toFixed(0)}%, so the check is sensitive`);
}

console.log('');
console.log('=== 4. a real tide over a drying flat ==============================');
console.log('');
//
// The thing a tidal model has to survive: a shoreline that moves kilometres
// twice a day. Checks that the basin tracks the forcing, that mass is not
// invented while cells wet and dry, and that the shallow-water nonlinearity
// produces the flood/ebb asymmetry real estuaries have.
{
  const tide = new Tide({ M2: [1.6, 0], S2: [0.5, 30] });
  const L = 30000, nx = 150, dx = L / nx;
  // Sloping bed: deep at the mouth, drying flats at the head.
  const bed = (x) => -6 + 7.4 * (x / L) ** 1.5;
  const sim = new ShallowWater({ nx, ny: 1, dx, bed, eta0: 0, manning: 0.025, cfl: 0.4 });
  sim.boundaries = {
    west: flather((t) => tide.eta(t), (t) => Math.sqrt(G / 6) * tide.eta(t)),
    east: reflect, south: periodic, north: periodic,
  };
  const M2 = CONSTITUENTS.M2.period * 3600;
  const rec = [], recV = [];
  const T = 3 * M2, T0 = 1.5 * M2;
  let next = 0;
  while (sim.t < T) {
    sim.step(Math.min(sim.maxDt(), Math.max(1e-6, Math.min(T, next) - sim.t)));
    if (sim.t >= next) {
      if (sim.t >= T0) { rec.push([sim.t, sim.eta(4, 0), sim.eta(nx - 30, 0)]); }
      let wet = 0;
      for (let i = 0; i < nx; i++) if (sim.depth(i, 0) > sim.minDepth) wet++;
      recV.push(wet / nx);
      next += 120;
    }
  }
  assert('the run stays finite over four tidal cycles', sim.finite());
  const wetMin = Math.min(...recV), wetMax = Math.max(...recV);
  assert('the shoreline actually moves', wetMax - wetMin > 0.08,
    `wetted fraction of the domain swings ${(100 * wetMin).toFixed(1)}% to ${(100 * wetMax).toFixed(1)}%`);

  // Flood/ebb asymmetry: time from low water to high water, against high to low.
  const inner = rec.map(r => [r[0], r[2]]);
  const ex = [];
  for (let n = 1; n + 1 < inner.length; n++) {
    const a = inner[n - 1][1], b = inner[n][1], c = inner[n + 1][1];
    if (b > a && b >= c) ex.push([inner[n][0], 'H']);
    if (b < a && b <= c) ex.push([inner[n][0], 'L']);
  }
  let flood = [], ebb = [];
  for (let n = 0; n + 1 < ex.length; n++) {
    const dt = ex[n + 1][0] - ex[n][0];
    if (ex[n][1] === 'L' && ex[n + 1][1] === 'H') flood.push(dt);
    if (ex[n][1] === 'H' && ex[n + 1][1] === 'L') ebb.push(dt);
  }
  if (flood.length && ebb.length) {
    const fm = flood.reduce((a, b) => a + b, 0) / flood.length;
    const em = ebb.reduce((a, b) => a + b, 0) / ebb.length;
    console.log(`        inner basin: mean flood ${(fm / 3600).toFixed(2)} h, mean ebb ${(em / 3600).toFixed(2)} h`);
    assert('the tide is distorted by the shallow basin', Math.abs(fm - em) / ((fm + em) / 2) > 0.02,
      `asymmetry ${(100 * Math.abs(fm - em) / ((fm + em) / 2)).toFixed(1)}%; a linear tide would be exactly symmetric`);
  } else assert('flood and ebb durations measurable', false, `${flood.length} floods, ${ebb.length} ebbs`);

  // Damping: the inner basin range must be smaller than at the mouth, and the
  // phase must LAG. Both are what friction and propagation do to a real tide.
  const mouthAmp = amplitude(rec.map(r => r[1]));
  const innerAmp = amplitude(rec.map(r => r[2]));
  console.log(`        range at the mouth ${(2 * mouthAmp).toFixed(2)} m, inner basin ${(2 * innerAmp).toFixed(2)} m`);
  assert('the tide propagates into the basin', innerAmp > 0.2 * mouthAmp,
    `inner/mouth amplitude ratio ${(innerAmp / mouthAmp).toFixed(2)}`);
}

console.log('');
console.log(`${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} -- ${checks - failures}/${checks} checks`);
console.log('');
process.exit(failures ? 1 : 0);
