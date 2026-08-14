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
//
// About 5 minutes, up from about 2. The extra time buys three things that were
// not measured before: a peak fitted rather than picked off a grid, an oblique
// angle sweep for the open boundary, and an amplitude sweep that separates the
// boundary's error from the pulse's own.
//
// WHAT WAS WRONG BEFORE, all of it found by a reviewer running the file:
//
//   * THE RESONANCE SWEEP COULD NOT DISCRIMINATE. `check(peak.r, 1.0, 0.30)`
//     over the grid {0.55, 0.8, 1.0, 1.25, 1.7} compared a QUANTISED quantity
//     against a continuous target: peak.r could only be one of five numbers,
//     so the check passed for any resonant period within roughly +/-40% of the
//     prediction, consumed 0.0000 of its budget and printed "rel 0.000%". It
//     now fits a parabola through the peak, reads 1.0217, reproduces that to
//     0.25% when the fitting stencil is changed, and asserts at 0.04. See
//     section 2, including what a tolerance of 0.04 still cannot catch.
//
//   * THE ASYMMETRY CHECK HAD A 54x MARGIN AND NO CEILING. `asym > 0.02`
//     against a measured 1.079. It is now a band, and the top of the band is
//     argued from a real estuary. See section 4.
//
//   * NOTHING MEASURED THE OPEN BOUNDARY OBLIQUELY, while flather()'s own
//     docstring in src/swe.mjs claimed "a steep or oblique wave still returns a
//     little". Both words are now measured, both against long-domain
//     counterfactuals rather than against a threshold on the leftover field.
//     Measured, as a fraction of the launched wave: 0.076% at normal
//     incidence, 5.66% at 30 degrees, 7.32% at 45, 9.26% at 60 -- and 0.089%
//     to 13.2% against the wave that actually arrived. At A/h = 0.2 the old
//     metric reads 4.58%, of which the boundary is 1.16%. See 3b and 3c.
//
// One thing this file now says out loud that it did not before: the resonant
// GAIN at a 10:1 depth step is 45% of the closed-form lossless prediction, and
// that is a finding about src/swe.mjs rather than a check. It is printed, not
// asserted, and the note in section 2 says why.
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
// Friction is kept small but non-zero, and the reason written here used to be
// wrong. It said "a frictionless resonator has infinite gain at the peak", which
// is true of a resonator with no way to lose energy and false of this one: the
// mouth is only 52% reflecting, so most of the damping is RADIATION out through
// it and the lossless gain is finite and known in closed form (see below).
// Measured, at manning = 0, the peak gain is 2.818 against 2.784 with friction
// on -- a 1.2% difference. Friction is kept because it is physical, not because
// the experiment falls over without it.
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
  //
  // THE GEOMETRY IS CHOSEN SO THE DEPTH STEP LANDS ON A CELL FACE. With
  // Lapp = 40 km and dx = 650 m the step fell inside cell 61, so the discrete
  // bay was 89.70 km while the analytic target was computed from 90 km -- a
  // 0.33% error built into the prediction, which is a third of the effect this
  // section now resolves. 39 km and 91 km are exactly 60 and 140 cells, so the
  // bay the solver has and the bay the formula describes are the same bay.
  const Lbay = 91000, hBay = 40, Lapp = 39000, hApp = 400;
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
      // 240 SAMPLES PER PERIOD, NOT 60. amplitude() takes half the peak-to-peak
      // of the record, so it under-reads the true crest by 1 - cos(pi/N). At
      // N = 60 that is 0.14%, which is 0.004 in a gain of 2.78 -- and a one-off
      // 29-point sweep of this basin at 0.025 spacing put the peak's ENTIRE
      // variation between T/T_res = 0.975 and 1.05 at 0.004 as well. The
      // quantisation was the same size as the signal the fit below reads. It
      // costs nothing (dt is ~4 s and even 240 samples is one every 76 s) and
      // it moved the fitted peak by 0.03%, so it was not in fact load-bearing
      // here -- but it is now measured rather than hoped.
      if (sim.t >= next) { if (sim.t >= T0) rec.push(sim.eta(nx - 2, 0)); next += period / 240; }
    }
    return amplitude(rec) / amp;
  };
  // Seven points, not five, and the three around 1.0 are there to be fitted.
  const ratios = [0.55, 0.80, 0.90, 1.00, 1.10, 1.25, 1.70];
  // THE LOSSLESS CLOSED FORM for this exact geometry, which is printed beside
  // each measurement and is NOT the solver measuring itself.
  //
  // Match eta and hu at the step, put a wall at the head and a transparent
  // termination at the far end of the approach channel, and the head amplitude
  // relative to the prescribed incoming wave comes out as
  //
  //     gain(theta) = 2 / sqrt(cos^2 theta + rho^2 sin^2 theta),
  //     theta = k_bay * L_bay = (pi/2) / (T/T_res),   rho = c_bay/c_app = sqrt(h_bay/h_app)
  //
  // which has two useful limits. At theta -> 0 it is exactly 2: that is the
  // "end-wall doubling" the comment above quotes, now derived rather than
  // recalled, and it is what the uniform-depth experiment measured at 1.98. At
  // theta = pi/2 it is 2/rho, and the peak sits there for ANY rho -- so the
  // quarter-wave period is a property of the bay alone, independent of how long
  // the approach channel is. That is worth knowing before blaming the appendix
  // for the offset measured below.
  const rho = Math.sqrt(hBay / hApp);
  const lossless = (r) => {
    const th = (Math.PI / 2) / r;
    return 2 / Math.sqrt(Math.cos(th) ** 2 + rho * rho * Math.sin(th) ** 2);
  };
  const gains = [];
  for (const r of ratios) {
    const gain = runPeriod(Tres * r);
    gains.push({ r, gain });
    console.log(`        T/T_res = ${r.toFixed(2)}   head amplitude / incident = ${gain.toFixed(3)}`
      + `   (lossless theory ${lossless(r).toFixed(3)}, ratio ${(gain / lossless(r)).toFixed(3)})`);
  }
  let peak = gains[0];
  for (const g of gains) if (g.gain > peak.gain) peak = g;

  // -------------------------------------------------------------------------
  // REFINING THE PEAK, and why the old check could not fail.
  //
  // This was `check(peak.r, 1.0, 0.30)` over the grid {0.55, 0.8, 1.0, 1.25,
  // 1.7}. peak.r can only ever BE one of those five numbers, so the check
  // passed for any true resonant period between about 0.7 and 1.4 of the
  // prediction, spent 0.0000 of its 0.30 budget, and printed "rel 0.000%" --
  // a precision it did not have and could not have. It was reporting the
  // spacing of the grid, not the position of the peak.
  //
  // A parabola through the grid maximum and its two neighbours gives a
  // continuous estimate. Measured, this basin peaks at T/T_res = 1.0217, and
  // the estimate is stable under a change of stencil: fitting the +/-0.05
  // points instead of the +/-0.10 ones gives 1.0192. The two differ by 0.25%,
  // which is the resolution of the instrument -- against a grid spacing of 10%,
  // which is what the old check was reporting.
  //
  // Removing bed friction entirely (manning 0) moves the fit to 1.0134 and
  // lifts the gain from 2.784 to 2.818, so friction accounts for about 0.8% of
  // the 2.2% offset and the rest is the solver's own dissipation at the step
  // (which the note at the end of this block goes into).
  //
  // TOLERANCE 0.04: about twice the measured offset from the ideal quarter-wave
  // formula. It is 7.5x tighter than the 0.30 it replaces and, more to the
  // point, it is compared against a continuous number instead of one of five
  // grid values. It is set by the OFFSET and not by the instrument -- the
  // instrument is 16x better than this -- and that is the honest limit of the
  // check. See the note below for exactly what it can and cannot catch.
  // -------------------------------------------------------------------------
  const iPk = gains.indexOf(peak);
  // AN INSTRUMENT THAT CANNOT BRACKET THE PEAK MUST REFUSE, not extrapolate. If
  // the maximum is at an end of the sweep the parabola is fitted outside the
  // data and returns a number shaped like an answer.
  assert('the sweep brackets the peak, so the fit interpolates rather than extrapolates',
    iPk > 0 && iPk < gains.length - 1,
    `maximum at T/T_res = ${peak.r}, ends of the sweep are ${ratios[0]} and ${ratios[ratios.length - 1]}`);
  let refined = NaN, concave = false;
  if (iPk > 0 && iPk < gains.length - 1) {
    const [p, q, s] = [gains[iPk - 1], gains[iPk], gains[iPk + 1]];
    // Lagrange vertex, which does not assume the three abscissae are evenly
    // spaced -- they are not, if the maximum lands at 0.80 or 1.25.
    const d1 = (p.r - q.r) * (p.r - s.r), d2 = (q.r - p.r) * (q.r - s.r), d3 = (s.r - p.r) * (s.r - q.r);
    const A2 = p.gain / d1 + q.gain / d2 + s.gain / d3;
    const B2 = -(p.gain * (q.r + s.r) / d1 + q.gain * (p.r + s.r) / d2 + s.gain * (p.r + q.r) / d3);
    concave = A2 < 0;
    refined = -B2 / (2 * A2);
    console.log(`        parabolic fit through ${p.r}, ${q.r}, ${s.r} puts the peak at T/T_res = ${refined.toFixed(4)}`);
  }
  assert('the fitted parabola is actually a maximum', concave,
    'a non-concave fit means the three points are not a peak and the vertex is meaningless');
  check('resonant period, refined by fitting the peak', refined, 1.0, 0.04,
    `peak gain ${peak.gain.toFixed(2)}x; nothing in the solver knows 4L/sqrt(gh)`);
  // WHAT THIS CHECK CAN AND CANNOT CATCH. MEASURED, NOT ARGUED.
  //
  // Both of these are whole runs of this file against a copy of src/ with
  // nothing changed but `export const G` in swe.mjs, which is the mutation a
  // suite grading itself cannot survive:
  //
  //   g x 0.95  ->  fit 1.04332, rel 4.332%  ->  FAIL   (red, as it must be)
  //   g x 1.05  ->  fit 0.99705, rel 0.295%  ->  PASS   (green -- see below)
  //
  // The old check reported "rel 0.000%" for BOTH of those and for the correct
  // solver, because peak.r was one of five grid values in all three cases.
  //
  // The green one is not a bug, it is the geometry of the problem, and it is
  // written down here rather than hidden. A period is only square-root
  // sensitive to gravity: 5% of g is 2.47% of period. The measured peak sits at
  // +2.167%, so raising g by 5% slides it DOWN THROUGH the target and out the
  // other side to 0.997 -- closer to 1.0 than the correct solver manages.
  //
  // Interpolating the two runs above against the unperturbed 1.02167, this
  // check goes red for gravity low by about 4.2% and for gravity high by about
  // 12.5%. No symmetric tolerance about 1.0 fixes the asymmetry while the
  // offset is 2.167%: catching +5% would need a tolerance below 2.47%, which
  // the correct solver already exceeds. What closes the hole is the check at
  // the top of section 1, which compares G_SOLVER against G_REF at tolerance
  // zero and cannot be fooled in either direction. This check measures a
  // PERIOD, and now states how wrong one has to be before it notices.

  // The signature of a resonance is that the gain falls away on BOTH sides of the
  // peak. Asserting "the detuned case is below 0.85x the peak" instead tests a
  // threshold I invented -- and it failed at 0.868 while the curve was a textbook
  // resonance, which is the wrong reason to go red.
  const fallsBelow = iPk > 0 && gains[iPk - 1].gain < peak.gain;
  const fallsAbove = iPk < gains.length - 1 && gains[iPk + 1].gain < peak.gain;
  assert('gain falls away on both sides of the peak', fallsBelow && fallsAbove,
    gains.map(g => `${g.r}:${g.gain.toFixed(2)}`).join('  '));
  assert('resonance amplifies beyond simple end-wall doubling', peak.gain > 2.3,
    `${peak.gain.toFixed(2)}x; the theta -> 0 limit of the closed form above is exactly 2, which is what a`
    + ` perfectly transparent mouth produced at EVERY period before the impedance step was added`);

  // -------------------------------------------------------------------------
  // NOT ASSERTED, and it should be read before anyone quotes a resonant gain
  // out of this simulator.
  //
  // The lossless closed form printed beside each row above is an INDEPENDENT
  // prediction -- it is matched at the step by hand, not taken from the solver
  // -- and the solver reproduces it beautifully for a gentle step and then
  // loses it. Measured at T = T_res, frictionless, same grid, varying only the
  // depth of the approach channel:
  //
  //     h_app    rho    2/rho (theory)   measured   measured/theory
  //        41   0.988          2.0248      2.0239            0.9995
  //        50   0.894          2.2361      2.2063            0.9867
  //        90   0.667          3.0000      2.5442            0.8481
  //       160   0.500          4.0000      2.6649            0.6662
  //       400   0.316          6.3246      2.8183            0.4456
  //
  // At the 10:1 step this section actually uses, the resonant gain is 45% of
  // the lossless prediction. It is not bed friction: those are the manning = 0
  // numbers, and switching friction on changes the last row only from 2.8183
  // to 2.7844. Something is dissipating energy at a bed discontinuity of 360 m
  // in one cell -- the hydrostatic reconstruction re-measures both sides
  // against the higher bed, which at a 10:1 step is a violent modification of
  // the state the Riemann solver then sees -- and the resonance is the thing
  // that makes it visible, because a resonator integrates its losses.
  //
  // This is NOT asserted, for the same reason `shoal` in tools/waves.mjs is
  // not: it is a finding about src/swe.mjs, it has one measurement behind it
  // and no convergence study, and a red line here would be a red line about a
  // file this one does not own. What it does mean is concrete: the PERIOD of
  // the quarter-wave mode is trustworthy to the 2% measured above, and the
  // GAIN at a steep step is not a number to quote. The check below asserts
  // only that the resonance beats end-wall doubling, which is the part that
  // survives.
  // -------------------------------------------------------------------------
  console.log(`        measured peak gain ${peak.gain.toFixed(3)}x against a lossless prediction of `
    + `${lossless(1).toFixed(3)}x = 2/sqrt(h_bay/h_app): a ratio of ${(peak.gain / lossless(1)).toFixed(3)}.`);
  console.log('        NOT ASSERTED -- see the note above. The step dissipates, the period does not care.');
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
//
// READ 3b AND 3c BEFORE QUOTING THE NUMBER THIS BLOCK PRINTS. It is measured at
// NORMAL incidence and at A/h = 0.0033, which are the two conditions under
// which the Flather split is closest to exact, and the metric it uses --
// max|eta| left in the domain -- silently includes whatever the pulse itself
// left behind. 3b measures the angle dependence against a counterfactual and 3c
// measures the amplitude dependence; both of them are larger than this.
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
    `reflection coefficient ${(100 * rFlather).toFixed(2)}% at NORMAL incidence and A/h = 0.0033;`
    + ` 3b and 3c below measure what happens away from both of those`);
  assert('...and the measurement can tell a mirror from an absorber', rWall > 0.5,
    `a solid wall returns ${(100 * rWall).toFixed(0)}%, so the check is sensitive`);
}

// ---------------------------------------------------------------------------
// 3b. OBLIQUE INCIDENCE, which nothing measured until now.
//
// flather()'s own docstring has always said "a steep or oblique wave still
// returns a little", and until this block nothing anywhere in the repository
// measured either word of that. The check above is at NORMAL incidence, where
// the characteristic split is exact, so it was measuring the one case the
// method is guaranteed to get right and calling the answer "the reflection
// coefficient".
//
// WHY A COUNTERFACTUAL AND NOT A THRESHOLD ON max|eta|.
//
// The obvious metric -- run the pulse out, then take max|eta| left in the
// domain -- cannot separate what the BOUNDARY returned from what the PACKET
// left behind. Measured, at 30 degrees, that metric reads 12.98% while the
// boundary is responsible for well under half of it: an oblique packet in a
// transversely-periodic channel is DISPERSIVE in x (with ky fixed,
// omega = c*sqrt(kx^2 + ky^2) is not linear in kx), so it smears and leaves a
// long tail sitting in the window with no boundary involved at all.
//
// So each case is run twice on an identical fixed dt sequence: once in the
// 20 km domain whose east boundary is under test, and once in a 48 km domain
// the packet never reaches within the run. Everything about the two runs is
// identical except the presence of that boundary, so the POINTWISE difference
// field is the boundary's entire contribution and nothing else. The metric is
// the largest that difference ever gets, anywhere in the window, at any step.
//
// That the long domain really is long enough is not assumed: at the worst
// angle it is re-run at 64 km and the two must agree.
// ---------------------------------------------------------------------------
{
  const h = 30, c0 = Math.sqrt(G * h);
  const dx = 200, dy = 200, Ly = 12000, ny = Ly / dy;
  const nxShort = 100, nxCtl = 240, nxCtl2 = 320;
  const x0 = 4000, sig = 2500, A = 0.1;
  const iW0 = 30, iW1 = 95;                      // window 6 km .. 19 km

  // A right-going wave packet whose crests are tilted by +/- theta: two
  // symmetric oblique plane waves superposed, which makes the y-structure
  // cos(ky*y) and therefore EXACTLY periodic in y, which is what the north and
  // south boundaries are. Both halves strike the east boundary at |theta|.
  const build = (nx, theta, bc) => {
    const ky = theta === 0 ? 0 : 2 * Math.PI / Ly;          // one transverse period
    const kx = theta === 0 ? 2 * Math.PI / 6000 : ky / Math.tan(theta);
    const k = Math.hypot(kx, ky);
    const sim = new ShallowWater({ nx, ny, dx, dy, bed: () => -h, eta0: 0, manning: 0, cfl: 0.4 });
    for (let j = 0; j < ny; j++) {
      const y = (j + 0.5) * dy;
      for (let i = 0; i < nx; i++) {
        const x = (i + 0.5) * dx;
        const E = Math.exp(-(((x - x0) / sig) ** 2));
        const e = A * E * Math.cos(kx * x) * Math.cos(ky * y);
        const g = sim.idx(i, j);
        sim.h[g] = h + e;
        sim.hu[g] = c0 * (kx / k) * e;
        sim.hv[g] = -c0 * (ky / k) * A * E * Math.sin(kx * x) * Math.sin(ky * y);
      }
    }
    sim.boundaries = { west: reflect, east: bc, south: periodic, north: periodic };
    return { sim, lam: 2 * Math.PI / k };
  };
  const worst = (a, b) => {
    let m = 0;
    for (let j = 0; j < ny; j++) for (let i = iW0; i < iW1; i++) m = Math.max(m, Math.abs(a.eta(i, j) - b.eta(i, j)));
    return m;
  };
  const loudest = (a) => {
    let m = 0;
    for (let j = 0; j < ny; j++) for (let i = iW0; i < iW1; i++) m = Math.max(m, Math.abs(a.eta(i, j)));
    return m;
  };

  console.log('');
  console.log('        oblique incidence, measured against a long-domain counterfactual:');
  console.log('        columns 4-6 are fractions of the LAUNCHED amplitude. Column 7 is the largest the');
  console.log('        control ever gets in the window -- the wave that actually arrived, after the grid');
  console.log('        has eaten some of it -- and column 8 is column 5 against that instead. The');
  console.log('        assertions below are on column 5, the conservative one; 8 is the closer estimate');
  console.log('        of a reflection coefficient and runs 1.1 to 1.4x it.');
  console.log('        angle  wavelength  cells/L   naive max|eta|   boundary returns   solid wall   arrived   returned');
  const sweep = [];
  let ctlCheck = null;
  for (const degIn of [0, 30, 45, 60]) {
    const th = degIn * Math.PI / 180;
    const S = build(nxShort, th, flather(() => 0, () => 0));
    const C = build(nxCtl, th, flather(() => 0, () => 0));
    const W = build(nxShort, th, reflect);
    const C2 = degIn === 60 ? build(nxCtl2, th, flather(() => 0, () => 0)) : null;
    // ONE dt for every run at this angle. If the short and the control chose
    // their own steps the difference field would contain the timestep history
    // as well as the boundary, and the whole measurement would be noise.
    const dt = Math.min(S.sim.maxDt(), C.sim.maxDt()) * 0.98;
    const T = ((nxShort * dx - x0) + (nxShort - iW0) * dx) / (c0 * Math.cos(th));
    const steps = Math.ceil(T / dt);
    let mB = 0, mW = 0, mB2 = 0, mInc = 0;
    for (let n = 0; n < steps; n++) {
      S.sim.step(dt); C.sim.step(dt); W.sim.step(dt); if (C2) C2.sim.step(dt);
      mB = Math.max(mB, worst(S.sim, C.sim));
      mW = Math.max(mW, worst(W.sim, C.sim));
      // The incident wave AS IT ARRIVES, taken from the control so no boundary
      // has touched it. Dividing by the LAUNCHED A instead -- which is what the
      // columns below do -- reads low, because the grid eats about 2% of the
      // wave per wavelength at 30 cells/L and the packet crosses two or three
      // wavelengths to get here. The ratio is printed so the size of that
      // under-read is on the page rather than in a footnote.
      mInc = Math.max(mInc, loudest(C.sim));
      if (C2) mB2 = Math.max(mB2, worst(S.sim, C2.sim));
    }
    // The naive metric -- max|eta| left in the window at the end, which is what
    // the check at the top of this section reads -- is printed beside the
    // counterfactual one so the difference between them is on the page and not
    // just in a comment. At normal incidence both are hundredths of a percent.
    // At 30 and 60 degrees the naive one reads 13.0% and 24.5% while the
    // boundary's own contribution is 5.7% and 9.3%, and the gap is the packet.
    // (The two are not the same KIND of number even where they are close: the
    // naive one is a snapshot, the counterfactual one a running maximum over
    // the whole run, which is why at 0 degrees the running maximum is the
    // larger of the two.)
    const rec = { deg: degIn, err: mB / A, wall: mW / A, lam: S.lam, naive: loudest(S.sim) / A, arrived: mInc / A };
    sweep.push(rec);
    if (C2) ctlCheck = { err: mB / A, err2: mB2 / A };
    console.log(`        ${String(degIn).padStart(5)}  ${S.lam.toFixed(0).padStart(9)} m ${(S.lam / dx).toFixed(0).padStart(8)}   `
      + `${(100 * rec.naive).toFixed(3).padStart(13)}%   ${(100 * rec.err).toFixed(3).padStart(15)}%   ${(100 * rec.wall).toFixed(1).padStart(9)}%`
      + `   ${(100 * rec.arrived).toFixed(1).padStart(7)}%  ${(100 * rec.err / rec.arrived).toFixed(3).padStart(8)}%`);
  }
  const at = (d) => sweep.find(s => s.deg === d).err;

  // The control has to be shown to be a control. If the 48 km and 64 km domains
  // disagree, something IS coming back off the control's own far boundary and
  // every number in the table is contaminated.
  assert('the long-domain control is long enough to be a control',
    Math.abs(ctlCheck.err - ctlCheck.err2) / Math.max(ctlCheck.err, 1e-12) < 0.02,
    `at 60 deg: 48 km control gives ${(100 * ctlCheck.err).toFixed(3)}%, 64 km gives ${(100 * ctlCheck.err2).toFixed(3)}%`);

  // The physical claim. The characteristic split is one-dimensional in x, so it
  // is exact only for a wave whose crests are parallel to the boundary; the
  // further from that, the more it gets wrong. This is a statement about the
  // METHOD and it has to hold monotonically.
  assert('absorption degrades monotonically with angle of incidence',
    at(0) < at(30) && at(30) < at(45) && at(45) < at(60),
    sweep.map(s => `${s.deg}deg:${(100 * s.err).toFixed(2)}%`).join('  '));

  // REGRESSION CEILINGS, and labelled as such: there is no theory here saying
  // the return at 45 degrees must be under 10%, only a measurement saying it is
  // currently 7.3%. Each ceiling is about 1.4x what was measured, so a real
  // degradation of the boundary shows up and ordinary drift does not.
  for (const [deg, ceil] of [[0, 0.002], [30, 0.080], [45, 0.100], [60, 0.130]]) {
    assert(`what the open boundary returns at ${String(deg).padStart(2)} deg stays under ${(100 * ceil).toFixed(1)}%`,
      at(deg) < ceil,
      `${(100 * at(deg)).toFixed(3)}% -- a REGRESSION CEILING at ~1.4x the measured value, not a physical requirement`);
  }
  // ...and the same measurement pointed at a mirror, at every angle, so that a
  // ceiling passing because the instrument went deaf is not a way to pass.
  assert('the same measurement sees a solid wall at every angle',
    sweep.every(s => s.wall > 0.30),
    sweep.map(s => `${s.deg}deg:${(100 * s.wall).toFixed(0)}%`).join('  '));
}

// ---------------------------------------------------------------------------
// 3c. FINITE AMPLITUDE, and what the metric above is actually made of.
//
// The check at the top of this section reads max|eta| left in the domain and
// calls it reflection. At A/h = 0.0033 that is nearly true. It stops being
// true as the wave gets steeper, and the failure is quiet: a shallow-water
// pulse with no dispersion to hold it together steepens into a bore and leaves
// a residue behind that has nothing to do with the boundary.
//
// Measured here, and the point of the block: at A/h = 0.2 the suite's own
// metric reads 4.58% against its own 5% threshold -- 92% of the way to red --
// while the boundary is responsible for 1.16% of that. The check was one small
// step in amplitude away from going red for a reason that is not reflection,
// and it would have been read as the open boundary breaking.
//
// A MEASURED SIDE-EFFECT, so nobody has to rediscover it at 2 a.m. Running the
// whole file against a copy of src/ with gravity scaled by 0.95 and by 1.05
// turns these two checks red as well -- at 0.95 the naive metric at
// A/h = 0.0033 goes from 0.119% to 1.16% and stops being monotonic; at 1.05 the
// ratio at A/h = 0.2 falls from 3.9 to 1.7. The cause is not the boundary. The
// pulse is SEEDED with hu = sqrt(g_ref*h)*eta, so a solver whose celerity
// disagrees with G_REF is handed a pulse that is not purely right-going, and
// the left-going part bounces off the west wall and lands in the window. That
// is a real sensitivity and worth having, but it means these labels are about
// the METRIC and not about the boundary: if they go red, read section 1 first.
// ---------------------------------------------------------------------------
{
  const h = 30, c0 = Math.sqrt(G * h), L = 60000, nx = 600, dx = L / nx, x0 = 20000, sig = 2500;
  const build = (n, amp, bc) => {
    const sim = new ShallowWater({ nx: n, ny: 1, dx, bed: () => -h, eta0: 0, manning: 0, cfl: 0.4 });
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * dx, e = amp * Math.exp(-(((x - x0) / sig) ** 2));
      const k = sim.idx(i, 0); sim.h[k] = h + e; sim.hu[k] = c0 * e;
    }
    sim.boundaries = { west: reflect, east: bc, south: periodic, north: periodic };
    return sim;
  };
  console.log('');
  console.log('        finite amplitude at normal incidence (same 140 km counterfactual method):');
  console.log('          A/h     suite metric max|eta|/A   of which the boundary   solid wall');
  const rows = [];
  for (const ratio of [0.0033, 0.02, 0.05, 0.10, 0.20]) {
    const amp = ratio * h;
    const S = build(nx, amp, flather(() => 0, () => 0));
    const C = build(1400, amp, flather(() => 0, () => 0));
    const W = build(nx, amp, reflect);
    const dt = Math.min(S.maxDt(), C.maxDt()) * 0.98;
    const T = 1.9 * (L - x0) / c0;
    const steps = Math.ceil(T / dt);
    for (let n = 0; n < steps; n++) { S.step(dt); C.step(dt); W.step(dt); }
    let mOld = 0, mB = 0, mW = 0;
    for (let i = 10; i < nx - 40; i++) {
      mOld = Math.max(mOld, Math.abs(S.eta(i, 0)));
      mB = Math.max(mB, Math.abs(S.eta(i, 0) - C.eta(i, 0)));
      mW = Math.max(mW, Math.abs(W.eta(i, 0) - C.eta(i, 0)));
    }
    rows.push({ ratio, old: mOld / amp, err: mB / amp, wall: mW / amp });
    console.log(`          ${ratio.toFixed(4)}   ${(100 * mOld / amp).toFixed(3).padStart(20)}%   ${(100 * mB / amp).toFixed(3).padStart(20)}%   ${(100 * mW / amp).toFixed(1).padStart(9)}%`);
  }
  const steep = rows[rows.length - 1];
  assert('the open boundary stays quiet as the wave steepens', steep.err < 0.02,
    `at A/h = ${steep.ratio}, the boundary contributes ${(100 * steep.err).toFixed(2)}%`);
  assert('...and most of the suite metric at that amplitude is NOT the boundary',
    steep.old / steep.err > 2.5,
    `metric ${(100 * steep.old).toFixed(2)}% against a boundary contribution of ${(100 * steep.err).toFixed(2)}%,`
    + ` a factor of ${(steep.old / steep.err).toFixed(1)} -- the rest is the pulse steepening into a bore`);
  assert('the suite metric grows with amplitude and the boundary error does too',
    rows.every((r, i) => i === 0 || (r.old > rows[i - 1].old && r.err > rows[i - 1].err)),
    rows.map(r => `${r.ratio}:${(100 * r.old).toFixed(2)}/${(100 * r.err).toFixed(2)}`).join('  '));
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
    const asym = Math.abs(fm - em) / ((fm + em) / 2);
    console.log(`        inner basin: mean flood ${(fm / 3600).toFixed(2)} h, mean ebb ${(em / 3600).toFixed(2)} h`
      + `  (ratio ${(em / fm).toFixed(2)}:1, asymmetry ${(100 * asym).toFixed(1)}%)`);

    // ---------------------------------------------------------------------
    // THIS USED TO BE A ONE-SIDED THRESHOLD WITH A 54x MARGIN.
    //
    // It asserted `asym > 0.02` and measured 1.079. A check that passes at 54x
    // its own threshold is not measuring the thing it names: it cannot tell a
    // tide that is slightly distorted from one that is distorted beyond what
    // any estuary on Earth does, and the second of those is a defect that would
    // have sailed straight through.
    //
    // So the claim is now a BAND, and both ends have to be argued for.
    //
    // LOWER END, 0.10. A linear tide is exactly symmetric, so anything above
    // measurement noise is a real signal. The noise floor here is the 120 s
    // sampling of the extrema finder: pushing each turning point one sample the
    // wrong way turns the measured 1.079 into 1.069, so the instrument's own
    // uncertainty on this quantity is about 0.01. 0.10 is ten times that, and
    // still far below anything a distorted estuary shows. The measured value
    // clears it by 10.8x, which is honest -- this basin is strongly distorted
    // and the interesting question is the other end.
    //
    // UPPER END, 1.52, and this is the number the check exists for.
    //
    // The National Oceanography Centre's tidal-bore page for the Severn says
    // the water level goes on rising for about one and a half hours after the
    // bore passes -- a LEVEL duration, which is what is measured here, not a
    // current duration. https://ntslf.org/tides/about-tides/tidal-river-bores
    // On an M2 cycle of 12.4206 h that is a rise of 1.5 h against a fall of
    // 10.92 h: a ratio of 7.3:1 and an asymmetry of 1.517. The Severn bore
    // reach is about as far as a real tide is documented to go, so 1.52 is the
    // ceiling: above it the model is claiming a distortion no estuary does.
    //
    // WHAT THE MODEL ACTUALLY DOES, and it is not what I expected going in. The
    // measured 1.079 (2.83 h flood against 9.47 h ebb, 3.35:1) is not "beyond
    // what real estuaries show". It is between the main body of the Qiantang
    // and the Severn's bore reach, and this basin -- 30 km long, 4.2 m of range
    // over 6 m of water at the mouth, drying flats at the head -- is exactly
    // the bore-forming configuration. So the band is set where the evidence
    // puts it, not widened to fit: the model passes at 1.41x margin on the
    // ceiling, which is tight, and it should be.
    //
    // The Qiantang figures I found are CURRENT durations, not level durations,
    // and I could not open either primary source (SAGE 403, Springer paywalled)
    // -- two independent search summaries reported flood current 3.5-4.5 h
    // against ebb current 7.5-8.5 h in the estuary, and 1 h 11 min to 4 h 10 min
    // against 7 h 42 min to 12 h 15 min near the Babao lock. They are recorded
    // here as context for the regime, and they are NOT what the ceiling is
    // derived from, because I have not read them.
    // ---------------------------------------------------------------------
    assert('the tide is distorted by the shallow basin', asym > 0.10,
      `asymmetry ${(100 * asym).toFixed(1)}%; a linear tide would be exactly symmetric`);
    assert('...and not by more than a real estuary manages', asym < 1.52,
      `asymmetry ${(100 * asym).toFixed(1)}% against a ceiling of 152%, which is the Severn bore reach`
      + ` (1.5 h rise, NOC/NTSLF) on a 12.42 h cycle. If this goes red the number is reported, not the band widened.`);
    // A GUARD ON THE INSTRUMENT, not on the physics. The durations above come
    // from a three-point extrema search on a 120 s record; if it invents or
    // misses an extremum the two durations stop tiling the cycle and every
    // number above is wrong while still looking plausible. A flood and an ebb
    // must add up to one M2 period.
    check('flood + ebb tile one M2 period', (fm + em) / M2, 1, 0.05,
      `${((fm + em) / 3600).toFixed(2)} h against M2 = ${(M2 / 3600).toFixed(4)} h;`
      + ` this fails if the extrema finder drops or invents a turning point`);
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
