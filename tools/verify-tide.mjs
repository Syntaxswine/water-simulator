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
// 64 checks. It was 29, and section 2's sweep went from seven forcing periods
// to eleven, so it costs more: 394 s and 434 s on two runs this session,
// against about 300 s for the 29-check version. Both are UPPER BOUNDS and not
// clean benchmarks -- other suites were running on the same machine, which is
// most of the 40 s between them -- and the four extra resonance runs account
// for about 55% more work in the section that dominates the total. Sections 1
// and 1b to 1e are free: all 34 of their checks run in 122 ms including node's
// own start-up.
//
// WHAT A MUTATION AUDIT OF THIS FILE FOUND, and what was done about it.
//
// The way to find out whether a suite checks anything is to break the code it
// grades and see whether it notices. Every mutation below was run against a
// COPY of src/ with one thing changed, and every "byte-identical" is a `cmp` of
// the whole 29-check output against the unmutated run. Measured this session:
//
//   MUTATION                                                RESULT BEFORE
//   Tide.resonantPeriod 4L/sqrt(gh) -> 2L/sqrt(gh)          byte-identical
//   Tide.rate() and .resonanceReport() throw on entry       byte-identical
//   swap the N2 and K2 periods in CONSTITUENTS              byte-identical
//   K1 period 23.93447213 h -> 25.0 h (+4.5%)               byte-identical
//   eta(): cos(wt - phase) -> cos(wt + phase)               ALL PASS 29/29
//   hydrostatic datum bStar = max(bL,bR) -> mean            ALL PASS 29/29
//
// The first four are the same defect wearing four hats: THE EXPORT WAS NEVER
// CALLED. This file recomputed 4L/sqrt(gh) inline while its own prose called
// that formula "the Bay of Fundy in one formula"; rate(), resonanceReport() and
// RESONANCE_GAIN_CAP had never executed at all, and resonanceReport carries
// forty lines of docstring arguing a sort-key redesign that nothing tested. The
// constituent table was pinned only by band membership -- "semidiurnal is
// between 11.5 and 13 hours" -- which N2, K2, K1, O1, P1, Q1 and Mf all satisfy
// while being wrong.
//
// The last two moved real physics and were still green. The phase flip took the
// mouth range from 6.53 m to 6.07 m and the flood/ebb asymmetry from 107.9% to
// 104.9%: it survived because every constituent set used in an ASSERTED
// quantity had phase 0 on its dominant term. The bStar mutation -- a broken
// hydrostatic reconstruction datum -- took the resonant peak from T/T_res =
// 1.0217 to 0.9840 and the headline gain from 2.784x to 3.180x, and survived
// because 0.9840 is CLOSER to 1.0 than the correct solver's 1.0217, so no
// symmetric tolerance about 1.0 could ever have caught it.
//
// What section 2 does about that last one is the interesting part and is
// written up there: the answer was not a tighter tolerance but a better
// instrument. The sweep now has eleven points instead of seven, four of them at
// 0.025 spacing across the peak, and the peak estimator uses the tightest
// stencil the grid allows. That barely moves the tolerance -- it moves how far
// the defect DRAGS the number, from 3.76 points of T/T_res to 6.83 -- and it is
// backed by a regression pin that is labelled as one.
//
// The other five holes were closed by making the exports run and by pinning the
// numbers to something outside src/tide.mjs: the nine constituent periods are
// now DERIVED from Doodson numbers and three orbital periods rather than
// transcribed, the phase convention is asserted at a phase that is not zero,
// rate() is graded against a central difference AND its d^2 convergence, and
// resonanceReport()'s docstring argument -- that the old sort key led with the
// smallest constituent -- is itself asserted, in both basins it quotes.
//
// WHAT WAS WRONG BEFORE THAT, all of it found by a reviewer running the file:
//
//   * THE RESONANCE SWEEP COULD NOT DISCRIMINATE. `check(peak.r, 1.0, 0.30)`
//     over the grid {0.55, 0.8, 1.0, 1.25, 1.7} compared a QUANTISED quantity
//     against a continuous target: peak.r could only be one of five numbers,
//     so the check passed for any resonant period within roughly +/-40% of the
//     prediction, consumed 0.0000 of its budget and printed "rel 0.000%". A
//     fitted parabola replaced it, which was right, and then the fitting
//     STENCIL turned out to be wider than the peak -- see section 2, which now
//     carries the sweep, the estimator and the measured blind band together.
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
//   * ...AND THE ABSORPTION CHECK STILL TESTED ONE CONDITION. It read the naive
//     metric at normal incidence and A/h = 0.0033 -- 0.119% against a 5%
//     threshold, 2.4% of budget -- while 3c measured the SAME metric at 4.577%
//     at A/h = 0.2. It is now a regression ceiling for the one condition it
//     runs at, the label says so, and 3c asserts the counterfactual column at
//     every amplitude it sweeps rather than only the steepest.
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
// EVERY NAME src/tide.mjs EXPORTS IS IMPORTED HERE, and every one of them is
// now executed below. Before this pass ATLANTIC_MESO was imported and never
// used, DIURNAL_COAST and RESONANCE_GAIN_CAP were referenced nowhere in the
// repository at all (`grep -rn` over *.mjs, *.html and *.md, this session), and
// Tide.rate() and Tide.resonanceReport() could be made to throw on entry
// without changing one byte of this suite's output.
import { Tide, CONSTITUENTS, ATLANTIC_MESO, DIURNAL_COAST, RESONANCE_GAIN_CAP } from '../src/tide.mjs';

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
  // table has been scrambled. THIS IS THE CHECK THAT WAS NOT ENOUGH: it is kept
  // because it is a cheap structural statement about the grouping, but on its
  // own it let N2 and K2 swap places, and K1 move 4.5%, without noticing. The
  // block below is what actually pins the numbers.
  assert('diurnal and semidiurnal families are correctly grouped',
    ['M2', 'S2', 'N2', 'K2'].every(k => CONSTITUENTS[k].period > 11.5 && CONSTITUENTS[k].period < 13) &&
    ['K1', 'O1', 'P1', 'Q1'].every(k => CONSTITUENTS[k].period > 23 && CONSTITUENTS[k].period < 27));
}

// ---------------------------------------------------------------------------
// 1b. EVERY CONSTITUENT PERIOD, DERIVED RATHER THAN RETYPED.
//
// Swapping the N2 and K2 periods in src/tide.mjs left this suite byte-identical
// (measured). So did moving K1 from 23.93447213 h to 25.0 h, a 4.5% error.
// Mf appeared in no assertion at all. Only M2 and S2 were pinned, and S2 only
// because the spring-neap beat above happens to contain it.
//
// Copying the nine numbers out of src/tide.mjs and asserting them here would
// catch a later edit and nothing else -- it grades a transcription against
// itself. So the periods are DERIVED, from a level of the theory the table does
// not contain: a tidal constituent's angular speed is an integer combination of
// the astronomical mean motions,
//
//     speed = i1*T + i2*s + i3*h + i4*p     [degrees per mean solar hour]
//
// with T = 15 deg/h exactly (the mean solar day, which is what "hour" means),
// and s, h, p the mean motions of the Moon's longitude, the Sun's longitude and
// the lunar perigee -- taken here as 360 degrees over the tropical month, the
// tropical year and the 8.847-year perigee cycle. The (i1..i4) are the first
// four Doodson numbers, which are integers and are the definition of which
// constituent one is talking about.
//
// The three orbital periods are literals in this file and could in principle be
// mistyped, but not undetectably: nine constituents are nine different integer
// combinations of the same three numbers, so a wrong month or year breaks most
// of the table at once, and the size of the break is the size of the error.
//
// AGREEMENT MEASURED THIS SESSION, derived against table, as a relative error:
// M2 6.7e-10, S2 0 (exact by definition), N2 4.7e-8, K2 1.1e-7, K1 1.1e-7,
// O1 1.2e-7, P1 1.1e-7, Q1 2.3e-7, Mf 2.9e-6. The tolerance is 1e-5, about 3.4x
// the worst of those (Mf, whose table value corresponds to a slightly different
// definition of the fortnightly speed than 2s). Measured against the mutants:
// a swapped N2/K2 reads 5.46% and 5.78% wrong, a 25 h K1 reads 4.45% wrong, and
// an Mf moved to the SYNODIC month 354.367 h reads 8.09% wrong -- all of them
// nearly four orders of magnitude outside the tolerance.
// ---------------------------------------------------------------------------
{
  const TROP_MONTH = 27.321582, TROP_YEAR = 365.242199, PERIGEE_YEARS = 8.847;
  const RATE = {
    T: 15.0,                                       // mean solar day, by definition
    s: 360 / (TROP_MONTH * 24),                    // 0.5490165 deg/h
    h: 360 / (TROP_YEAR * 24),                     // 0.0410686 deg/h
    p: 360 / (PERIGEE_YEARS * TROP_YEAR * 24),     // 0.0046421 deg/h
  };
  // Doodson numbers (i1..i4). The species digit i1 IS the family: 2 = semidiurnal,
  // 1 = diurnal, 0 = long-period.
  const DOODSON = {
    M2: [2, -2, 2, 0], S2: [2, 0, 0, 0], N2: [2, -3, 2, 1], K2: [2, 0, 2, 0],
    K1: [1, 0, 1, 0], O1: [1, -2, 1, 0], P1: [1, 0, -1, 0], Q1: [1, -3, 1, 1],
    Mf: [0, 2, 0, 0],
  };
  const derived = (k) => {
    const [i1, i2, i3, i4] = DOODSON[k];
    return 360 / (i1 * RATE.T + i2 * RATE.s + i3 * RATE.h + i4 * RATE.p);
  };
  console.log('        constituent periods against their Doodson numbers (hours):');
  for (const k of Object.keys(DOODSON)) {
    const ppm = 1e6 * Math.abs(CONSTITUENTS[k].period - derived(k)) / derived(k);
    check(`${k} = ${DOODSON[k].join(' ')} on (T,s,h,p)`, CONSTITUENTS[k].period, derived(k), 1e-5,
      `${ppm.toFixed(4).padStart(8)} ppm -- ${CONSTITUENTS[k].name}`);
  }
  // A table with an EXTRA scrambled entry would otherwise slip past, because the
  // loop above only visits the nine it knows about.
  assert('the table contains exactly the nine constituents pinned above',
    Object.keys(CONSTITUENTS).length === 9 && Object.keys(CONSTITUENTS).every(k => k in DOODSON),
    `${Object.keys(CONSTITUENTS).length} entries: ${Object.keys(CONSTITUENTS).join(', ')}`);
  // The species digit has to agree with the family, which is the structural
  // claim the old band check was making, now made against the Doodson number
  // instead of against a hand-drawn window.
  assert('the species digit agrees with the period in every row',
    Object.keys(DOODSON).every(k => {
      const P = CONSTITUENTS[k].period, i1 = DOODSON[k][0];
      return (i1 === 2 && P > 11 && P < 13) || (i1 === 1 && P > 22 && P < 28) || (i1 === 0 && P > 100);
    }));
}

// ---------------------------------------------------------------------------
// 1c. THE PHASE SIGN CONVENTION, which nothing checked.
//
// src/tide.mjs writes eta = sum A cos(w t - phi). Flipping that minus to a plus
// in a copy of src/ left all 29 checks green while the physics moved: the mouth
// range went 6.53 m -> 6.07 m and the flood/ebb asymmetry 107.9% -> 104.9%
// (measured). It survived because every constituent set used in an ASSERTED
// quantity -- {M2:[1,0], S2:[0.4,0]} in 1a, {M2:[1.6,0], S2:[0.5,30]} in
// section 4 -- has phase 0 on its dominant term, so the sign had nothing to act
// on.
//
// The convention is a LAG: a phase of phi degrees puts high water phi/360 of a
// cycle AFTER t = 0. That is what the check below asserts, with a phase chosen
// off the 45-degree grid so no trigonometric coincidence can rescue a flip.
// ---------------------------------------------------------------------------
{
  const A = 1.6, phiDeg = 63, T = CONSTITUENTS.M2.period * 3600;
  const one = new Tide({ M2: [A, phiDeg] });
  const tHW = (phiDeg / 360) * T;
  check(`phase +${phiDeg} deg puts high water ${phiDeg}/360 of a cycle later`, one.eta(tHW), A, 1e-12,
    `t = ${(tHW / 3600).toFixed(4)} h; with the sign flipped this reads A cos(2 phi) = ${(A * Math.cos(2 * phiDeg * Math.PI / 180)).toFixed(4)}`);
  // ...and not merely that eta is large there: that it is the LARGEST there. A
  // scan of the whole cycle catches a sign error that the single sample above
  // could in principle survive.
  let best = -Infinity, tBest = 0;
  const N = 200000;                                 // 0.22 s resolution on a 12.42 h cycle
  for (let n = 0; n < N; n++) { const t = n * T / N, e = one.eta(t); if (e > best) { best = e; tBest = t; } }
  check('...and a scan of the whole cycle finds the maximum there', tBest, tHW, 1e-4,
    `scan resolution ${(T / N).toFixed(3)} s; a flipped sign puts the maximum at ${((1 - phiDeg / 360) * T / 3600).toFixed(4)} h`);
  // The rate has to rise INTO high water, which is the same convention seen from
  // the derivative -- and it is the line that catches a sign error in rate()
  // alone, which the two checks above cannot see. Measured on mutants: a phase
  // convention reversed in BOTH eta() and rate() reads -2.2202e-4 here, and
  // rate() alone with its sign flipped reads -1.5898e-4. Either is negative.
  assert('the water is still rising an eighth of a cycle before high water',
    one.rate(tHW - T / 8) > 0,
    `rate = ${one.rate(tHW - T / 8).toExponential(4)} m/s, and it must be positive: high water is ahead`);
}

// ---------------------------------------------------------------------------
// 1d. rate() IS THE DERIVATIVE OF eta(), and until now it had never run.
//
// Making Tide.rate() throw on entry left this suite byte-identical. It is not
// dead weight in the library -- it is the rate of rise, which is what sets the
// current through a channel -- so it gets graded against a central difference
// of the function it claims to differentiate.
//
// A single tolerance would only say "close". SECOND-ORDER CONVERGENCE says it
// is the derivative: the central-difference truncation error is (d^2/6) eta''',
// so halving d must quarter the disagreement, and a rate() that is nearly right
// for some other reason will not do that. Measured this session on the seven
// ATLANTIC_MESO constituents, worst disagreement over one M2 cycle as a
// fraction of the largest rate in that cycle:
//
//     d = 0.5 s   8.18e-10        d = 2 s   1.30e-8
//     d = 1.0 s   3.26e-9         d = 5 s   8.15e-8
//
// which is d^2 to three figures across a factor of ten in d.
// ---------------------------------------------------------------------------
{
  const site = new Tide(ATLANTIC_MESO);
  const T = CONSTITUENTS.M2.period * 3600;
  const mismatch = (d) => {
    let worst = 0, scale = 0;
    for (let n = 0; n < 2000; n++) {
      const t = n * T / 2000;
      const fd = (site.eta(t + d) - site.eta(t - d)) / (2 * d);
      worst = Math.max(worst, Math.abs(site.rate(t) - fd));
      scale = Math.max(scale, Math.abs(site.rate(t)));
    }
    return worst / scale;
  };
  const e1 = mismatch(1), e2 = mismatch(2);
  check('rate() matches a central difference of eta()', e1, 0, 1e-8,
    `worst over one M2 cycle, as a fraction of the largest rate in it; measured 3.26e-9 at d = 1 s`);
  check('...and the disagreement scales as d^2, so it is truncation and not a wrong formula', e2 / e1, 4, 0.05,
    `${(e2 / e1).toFixed(4)}x when d doubles; a rate() that were merely close would not converge`);
}

// ---------------------------------------------------------------------------
// 1e. resonanceReport(), RESONANCE_GAIN_CAP, and the two named coasts.
//
// resonanceReport() carries about forty lines of docstring arguing for a
// redesign -- an amplitude-weighted sort key and a cap on the frictionless pole
// -- and making the whole method throw on entry left this suite byte-identical.
// RESONANCE_GAIN_CAP and DIURNAL_COAST were referenced nowhere in the
// repository, and ATLANTIC_MESO was imported by this file and never used.
//
// What is checked here is the docstring's own ARGUMENT, not just that the code
// runs: it claims the old sort key put N2 (0.28 m) ahead of M2 (1.35 m) in one
// basin and K2 (0.12 m) ahead of M2 in another, and that the new key does not.
// If the redesign were cosmetic -- if the two keys agreed -- that claim would be
// false and the docstring would be selling a fix for a bug it never had.
//
// This is ARITHMETIC, not physics. It grades the class against the formula in
// its own docstring, |sec(pi/2 * Tr/T)|, recomputed here from the published
// periods and an independent 4L/sqrt(G_REF h). It does not say the frictionless
// pole is the right model of a real bay -- the docstring says it is not, and
// section 2 is what measures the real amplification.
// ---------------------------------------------------------------------------
{
  const site = new Tide(ATLANTIC_MESO);
  const secGain = (Tr, name) => Math.abs(1 / Math.cos(Math.PI / 2 * (Tr / (CONSTITUENTS[name].period * 3600))));

  // The 230 km, 40 m basin the docstring works its example in.
  const L1 = 230000, h1 = 40, Tr1 = 4 * L1 / Math.sqrt(G_REF * h1);
  const rep = site.resonanceReport(L1, h1);
  const byIdeal = [...rep].sort((a, b) => b.idealGain - a.idealGain);
  console.log(`        resonanceReport in a ${L1 / 1000} km, ${h1} m basin (Tr = ${(Tr1 / 3600).toFixed(3)} h):`);
  for (const r of rep) {
    console.log(`          ${r.name.padEnd(3)} amp ${r.amp.toFixed(2)} m  Tr/T ${(Tr1 / 3600 / r.periodHours).toFixed(4)}`
      + `  idealGain ${r.idealGain.toFixed(3).padStart(7)}  gain ${r.gain.toFixed(3).padStart(6)}`
      + `  capped ${String(r.capped).padEnd(5)}  response ${r.response.toFixed(3)} m`);
  }
  check('idealGain is |sec(pi/2 Tr/T)|, recomputed here from the published period',
    rep.find(r => r.name === 'M2').idealGain, secGain(Tr1, 'M2'), 1e-12);
  assert('the OLD sort key really did lead with N2 at 0.28 m over M2 at 1.35 m',
    byIdeal[0].name === 'N2' && byIdeal[1].name === 'M2',
    `by idealGain: ${byIdeal.map(r => r.name).join(' > ')}`);
  assert('...and the amplitude-weighted key leads with M2, as the docstring claims',
    rep[0].name === 'M2',
    `by response: ${rep.map(r => `${r.name} ${r.response.toFixed(2)}m`).join(' > ')}`);
  assert('response is amplitude x CAPPED gain, in metres', rep.every(r => Math.abs(r.response - r.amp * r.gain) < 1e-12));

  // The second basin from the same docstring, where the old key was worse still.
  const L2 = 200000, h2 = 40;
  const rep2 = site.resonanceReport(L2, h2);
  const byIdeal2 = [...rep2].sort((a, b) => b.idealGain - a.idealGain);
  assert(`...and in a ${L2 / 1000} km basin the old key led with K2 at 0.12 m`,
    byIdeal2[0].name === 'K2' && rep2[0].name === 'M2',
    `old ${byIdeal2.map(r => r.name).join(' > ')} | new ${rep2.map(r => r.name).join(' > ')}`);

  // THE CAP. Applied where the pole is near, not applied where it is not, and
  // flagged either way -- which is the property that keeps it from hiding.
  const m2 = rep.find(r => r.name === 'M2'), s2 = rep.find(r => r.name === 'S2');
  assert('the cap bites on the near-resonant constituent, and says so',
    m2.idealGain > RESONANCE_GAIN_CAP && m2.gain === RESONANCE_GAIN_CAP && m2.capped === true,
    `M2 idealGain ${m2.idealGain.toFixed(3)} -> gain ${m2.gain.toFixed(3)}`);
  assert('...and does not bite on the detuned one', s2.idealGain <= RESONANCE_GAIN_CAP && s2.gain === s2.idealGain && s2.capped === false,
    `S2 idealGain ${s2.idealGain.toFixed(3)}, Tr/T ${(Tr1 / 3600 / s2.periodHours).toFixed(4)}`);
  assert('every row reports the cap it was judged against', rep.every(r => r.gainCap === RESONANCE_GAIN_CAP && r.capped === (r.idealGain > r.gainCap)));
  const rep3 = site.resonanceReport(L1, h1, 3);
  assert('an explicit gainCap argument is honoured', rep3.every(r => r.gain <= 3 && r.gainCap === 3) && rep3.some(r => r.capped),
    `at cap 3: ${rep3.map(r => `${r.name}${r.capped ? '*' : ''}`).join(' ')}`);
  // RESONANCE_GAIN_CAP's own docstring says 10 is where |sec(pi/2 x)| stops
  // discriminating, and quotes the roots x = 0.936231 and 1.063769. If the cap
  // is ever changed those roots become wrong, and this is what says so.
  check('RESONANCE_GAIN_CAP is |sec(pi/2 x)| at the roots its docstring quotes',
    Math.abs(1 / Math.cos(Math.PI / 2 * 1.0637685)), RESONANCE_GAIN_CAP, 1e-5,
    `the mirror root 0.9362315 gives ${Math.abs(1 / Math.cos(Math.PI / 2 * 0.9362315)).toFixed(6)}; the cap is a +/-6.4% band about resonance`);

  // THE TWO NAMED COASTS ARE WHAT THEY SAY THEY ARE. Courtier's form factor,
  // F = (K1 + O1)/(M2 + S2), is the standard classification: F < 0.25
  // semidiurnal, 0.25-1.5 mixed mainly semidiurnal, 1.5-3.0 mixed mainly
  // diurnal, F > 3 diurnal. These are published class boundaries, not a
  // plausibility guard. Measured here: 0.0889 and 4.4286.
  const F = (c) => (c.K1[0] + c.O1[0]) / (c.M2[0] + c.S2[0]);
  assert('ATLANTIC_MESO is semidiurnal on Courtier\'s form factor', F(ATLANTIC_MESO) < 0.25,
    `F = ${F(ATLANTIC_MESO).toFixed(4)}, and the semidiurnal class is F < 0.25`);
  assert('DIURNAL_COAST is diurnal on the same scale', F(DIURNAL_COAST) > 3.0,
    `F = ${F(DIURNAL_COAST).toFixed(4)}, and the diurnal class is F > 3`);
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

  // THE HEADLINE FORMULA IS NOW CALLED, NOT RETYPED.
  //
  // src/tide.mjs exports Tide.resonantPeriod() and its docstring calls it "the
  // Bay of Fundy in one line". This file used to write `4 * Lbay /
  // Math.sqrt(G * hBay)` inline instead, so that export had never executed:
  // changing its 4 to a 2 in a copy of src/ left the whole 29-check output
  // BYTE-IDENTICAL (`cmp`, measured this session). The prose was crediting a
  // formula the suite never ran.
  //
  // The literal below is still written out here, because a target that imports
  // its own answer grades nothing -- same reason G_REF exists. What changed is
  // that the export is checked against it and then DRIVES THE SWEEP, so a wrong
  // formula does not merely fail one line, it detunes the forcing and takes the
  // bracket, the fit and the peak check down with it. (Measured below: the 2L
  // mutation now produces four failures, not zero.)
  const TresRef = 4 * Lbay / Math.sqrt(G_REF * hBay);
  const Tres = Tide.resonantPeriod(Lbay, hBay, G_REF);
  check('Tide.resonantPeriod() is 4L/sqrt(g h)', Tres, TresRef, 1e-12,
    `${(Tres / 3600).toFixed(4)} h; 1e-12 rather than 0 so an equivalent reordering of the arithmetic is not a failure`);
  check('...and its default gravity is standard', Tide.resonantPeriod(Lbay, hBay), TresRef, 1e-12,
    'the three-argument form is what this file uses; the default is what every other caller gets');
  // The single value above can survive a transposed constant that the scaling
  // laws cannot: 4L/sqrt(gh) and, say, 2L/sqrt(g h/4) agree at one geometry.
  check('...T is linear in basin length', Tide.resonantPeriod(2 * Lbay, hBay, G_REF) / Tres, 2, 1e-12);
  check('...and goes as 1/sqrt(depth)', Tide.resonantPeriod(Lbay, 4 * hBay, G_REF) / Tres, 0.5, 1e-12);

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
      // N = 60 that is 0.137%, which is 0.0038 in a gain of 2.787 -- and the
      // sweep below measures the peak's ENTIRE variation between T/T_res =
      // 0.975 and 1.05 as 2.7866 - 2.7820 = 0.0046 (measured this session, four
      // adjacent rows of the printed table). The quantisation would be the same
      // size as the signal the fit reads. It costs nothing: dt is about 4 s, so
      // even 240 samples is one every 76 s. (A previous session measured the
      // 60 -> 240 change as moving the fitted peak 0.03% on the SEVEN-point
      // sweep; that number has not been re-taken on the eleven-point one, and
      // the argument above does not depend on it.)
      if (sim.t >= next) { if (sim.t >= T0) rec.push(sim.eta(nx - 2, 0)); next += period / 240; }
    }
    return amplitude(rec) / amp;
  };
  // ELEVEN POINTS, NOT SEVEN, AND FOUR OF THEM AT 0.025 SPACING OVER THE PEAK.
  //
  // This was seven, with the three nearest 1.0 spaced 0.10 apart, and that was
  // the reason a real defect walked past. A broken hydrostatic reconstruction
  // datum (bStar = mean of the two bed levels instead of max, run against a
  // copy of src/) moves the true peak to T/T_res = 0.954 -- but a parabola
  // fitted through 0.90/1.00/1.10 smooths a peak that has moved off centre and
  // reported 0.9840, which is CLOSER to 1.0 than the correct solver's 1.0217.
  // No symmetric tolerance about 1.0 could have caught that, and none was the
  // fix. The fix is resolving the peak: on this grid the maximum lands on a
  // sampled point (1.025 correct, 0.950 mutated) and the fitted vertices are
  // 1.0220 and 0.9537, so the same defect now moves the number 6.83% instead of
  // 3.77%.
  //
  // The cost is four extra runs, and section 2 is the expensive section, so it
  // is worth saying what they buy in one line: 1.8x the sensitivity to the one
  // mutation that is known to have got through.
  const ratios = [0.55, 0.80, 0.90, 0.95, 0.975, 1.00, 1.025, 1.05, 1.10, 1.25, 1.70];
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
    // THREE DECIMALS, because two rounds 0.975 to "0.97" and 1.025 to "1.02",
    // and the four points those two labels name are the reason this sweep got
    // denser. A table that mislabels its own new rows is worse than no table.
    console.log(`        T/T_res = ${r.toFixed(3)}   head amplitude / incident = ${gain.toFixed(3)}`
      + `   (lossless theory ${lossless(r).toFixed(3)}, ratio ${(gain / lossless(r)).toFixed(3)})`);
  }
  let peak = gains[0];
  for (const g of gains) if (g.gain > peak.gain) peak = g;

  // -------------------------------------------------------------------------
  // REFINING THE PEAK: what the instrument resolves, and what the check catches.
  //
  // TWO GENERATIONS OF THIS WERE WRONG IN DIFFERENT WAYS, and both are worth
  // keeping on the page because they are different mistakes.
  //
  // FIRST, `check(peak.r, 1.0, 0.30)` over the grid {0.55, 0.8, 1.0, 1.25,
  // 1.7}. peak.r can only ever BE one of those five numbers, so the check
  // passed for any true resonant period between about 0.7 and 1.4 of the
  // prediction, spent 0.0000 of its 0.30 budget, and printed "rel 0.000%" --
  // a precision it did not have and could not have. It was reporting the
  // spacing of the grid, not the position of the peak.
  //
  // SECOND, a parabola through the maximum and its two neighbours on a grid
  // spaced 0.10 apart. That is a continuous estimate and it was a real
  // improvement, but the stencil was wider than the feature: it SMOOTHED a peak
  // that had moved, and a broken hydrostatic datum whose true peak is at 0.954
  // was reported as 0.9840. Because the unmutated solver sits at +2.2%, the
  // mutant's 0.9840 was nearer 1.0 than the correct answer, and every symmetric
  // tolerance in the world would have passed it.
  //
  // WHAT THE INSTRUMENT ACTUALLY RESOLVES, measured this session by refitting
  // the same eleven-point sweep with three different stencils:
  //
  //     +/-1 point (0.025 wide)   1.02200      <- what is asserted
  //     +/-2 points (0.05)        1.01653
  //     +/-3 points (0.10)        1.02700      <- the old stencil
  //
  // a spread of 1.05 points about a mean of 1.0218. The peak is FLAT -- the
  // gain varies by 0.0045 in 2.787 across 0.975 to 1.05 -- so the vertex of a
  // three-point fit is genuinely ill-conditioned, and this is what that costs.
  // The tightest stencil is asserted because it is the one that tracks the peak
  // when the peak moves; the other two are printed at runtime so the number's
  // uncertainty is on the page and not only in this comment.
  //
  // WHERE THE +2.20% OFFSET COMES FROM, as far as it has been taken. Removing
  // bed friction entirely (manning 0, same eleven points, measured this
  // session) moves the fit to 1.01508 and lifts the peak gain from 2.7865 to
  // 2.8189. So friction accounts for 0.69 of the 2.20 points, about a third,
  // and the remaining 1.51 points is the solver's own dissipation and
  // dispersion -- most of it at the 360 m depth step, which the note at the end
  // of this block goes into.
  //
  // AND IT IS NOT MOSTLY GRID ERROR, which was the first guess and was wrong.
  // Halving dx (nx 200 -> 400, same eleven points, 19 minutes) moves the fit
  // from 1.02200 to 1.01741: refinement removes 0.46 of the 2.20 points, not
  // the 1.65 a second-order dispersion error would have given. So the offset is
  // a real property of this discrete basin at this resolution, the tolerance
  // below has to live with it, and doubling the grid would buy 0.46 points for
  // 4x the section's runtime. It is not bought.
  //
  // THE TWO CHECKS BELOW ARE DIFFERENT ANIMALS and the labels say which.
  //
  //   * TOLERANCE 0.04 against 1.0 is the PHYSICS. It is about twice the
  //     measured offset from the ideal quarter-wave formula and it is limited
  //     by that offset, not by the instrument. It says the emergent period is
  //     the quarter-wave period to within a few per cent, which is the claim
  //     this section exists to make.
  //
  //   * TOLERANCE 0.015 against 1.0220 is a REGRESSION PIN, and it is the
  //     solver being compared against its own output -- said out loud, because
  //     that is the only honest way to have one. It is 1.4x the measured 1.05
  //     point stencil spread, and 4.5x smaller than the 6.68% by which the
  //     bStar mutation misses it. What it is FOR is the case the physics check
  //     is structurally unable to see: a defect that drags the peak DOWN
  //     THROUGH 1.0 and parks it nearer the target than the correct solver
  //     manages. The table below has one -- gravity 5% high, fit 0.99738,
  //     physics PASS, pin FAIL at 2.41%. If a real improvement to src/swe.mjs
  //     moves the peak this line goes red and the pin is what gets re-measured:
  //     it is a tripwire, not a claim about nature.
  // -------------------------------------------------------------------------
  const iPk = gains.indexOf(peak);
  // AN INSTRUMENT THAT CANNOT BRACKET THE PEAK MUST REFUSE, not extrapolate. If
  // the maximum is at an end of the sweep the parabola is fitted outside the
  // data and returns a number shaped like an answer.
  assert('the sweep brackets the peak, so the fit interpolates rather than extrapolates',
    iPk > 0 && iPk < gains.length - 1,
    `maximum at T/T_res = ${peak.r}, ends of the sweep are ${ratios[0]} and ${ratios[ratios.length - 1]}`);
  // Lagrange vertex through the maximum and the points w places either side of
  // it. It does not assume the three abscissae are evenly spaced -- they are
  // not, wherever the maximum lands on the boundary of the dense region.
  const vertexAt = (w) => {
    if (iPk - w < 0 || iPk + w >= gains.length) return null;
    const [p, q, s] = [gains[iPk - w], gains[iPk], gains[iPk + w]];
    const d1 = (p.r - q.r) * (p.r - s.r), d2 = (q.r - p.r) * (q.r - s.r), d3 = (s.r - p.r) * (s.r - q.r);
    const A2 = p.gain / d1 + q.gain / d2 + s.gain / d3;
    const B2 = -(p.gain * (q.r + s.r) / d1 + q.gain * (p.r + s.r) / d2 + s.gain * (p.r + q.r) / d3);
    return { x: -B2 / (2 * A2), concave: A2 < 0, span: `${p.r}, ${q.r}, ${s.r}` };
  };
  const v1 = vertexAt(1), alt = [2, 3].map(vertexAt).filter(Boolean);
  const refined = v1 ? v1.x : NaN, concave = v1 ? v1.concave : false;
  if (v1) {
    console.log(`        parabolic fit through ${v1.span} puts the peak at T/T_res = ${refined.toFixed(5)}`);
    console.log(`        wider stencils give ${alt.map(a => `${a.x.toFixed(5)} (${a.span})`).join(', ')}`
      + `  -- spread ${(100 * (Math.max(refined, ...alt.map(a => a.x)) - Math.min(refined, ...alt.map(a => a.x)))).toFixed(2)} points,`
      + ` which is the resolution of this instrument`);
  }
  assert('the fitted parabola is actually a maximum', concave,
    'a non-concave fit means the three points are not a peak and the vertex is meaningless');
  check('resonant period, refined by fitting the peak', refined, 1.0, 0.04,
    `peak gain ${peak.gain.toFixed(2)}x; nothing in the solver knows 4L/sqrt(gh)`);
  check('...and has not moved from where this solver last put it', refined, 1.0220, 0.015,
    'A REGRESSION PIN, not physics: the solver against its own measurement. 1.4x the measured stencil'
    + ' spread, and it is what catches a defect that lands BETWEEN the true peak and 1.0');
  // WHAT THESE CHECKS CAN AND CANNOT CATCH. MEASURED, NOT ARGUED.
  //
  // All of these are the same eleven-point sweep run against a copy of src/
  // with exactly one thing changed, this session:
  //
  //   MUTATION                      fit       shift    physics 0.04   pin 0.015
  //   none                       1.02200        --         PASS         PASS
  //   g x 0.95 in swe.mjs        1.04922     +2.72 pts     FAIL         FAIL
  //   g x 1.05 in swe.mjs        0.99738     -2.46 pts     PASS         FAIL
  //   bStar = mean(bL,bR)        0.95371     -6.83 pts     FAIL         FAIL
  //
  // The gravity rows are the mutation a suite grading itself cannot survive,
  // and they show the shape of the blindness. A period is only square-root
  // sensitive to gravity: 5% of g is 2.47% of period, and the measured peak
  // already sits at +2.20%, so raising g slides the fit DOWN THROUGH the target
  // rather than away from it and out the other side to 0.997 -- closer to 1.0
  // than the correct solver manages. That row is the whole argument for having
  // a pin at all: the physics check is structurally unable to see it, and the
  // pin sees it at 2.41% against a 1.5% tolerance.
  //
  // THE ACHIEVED BAND, stated as a measured number. Against the unmutated
  // 1.02200 the physics check alone is blind to any shift in the fit between
  // -5.70 and +1.80 points of T/T_res. The pin narrows that to -1.53 to +1.53
  // points, and the denser sweep independently grows the bStar signal from
  // -3.77 points to -6.83, so the combination catches that defect with 4.5x to
  // spare. In gravity, interpolating linearly through the two 5% runs above,
  // section 2 now goes red for g wrong by more than about 2.8% low or 3.1%
  // high; before this pass +5% passed. What closes the gravity hole outright,
  // in both directions and at any size, is still the check at the top of
  // section 1, which compares G_SOLVER against G_REF at tolerance zero.

  // THE SIGNATURE OF A RESONANCE IS A SINGLE PEAK WITH MONOTONE FLANKS, and on
  // an eleven-point sweep that is worth asserting properly. The previous
  // version only looked at the two immediate neighbours, which on this grid
  // differ from the peak in the fourth decimal and is close to vacuous. An
  // earlier version asserted "the detuned case is below 0.85x the peak", which
  // is a threshold I invented, and it failed at 0.868 while the curve was a
  // textbook resonance -- the wrong reason to go red. Monotone arms invent
  // nothing and are a much stronger statement about the shape.
  const rising = gains.slice(0, iPk + 1).every((g, n, a) => n === 0 || g.gain > a[n - 1].gain);
  const falling = gains.slice(iPk).every((g, n, a) => n === 0 || g.gain < a[n - 1].gain);
  assert('gain rises to the peak and falls away from it, at every point of the sweep',
    iPk > 0 && iPk < gains.length - 1 && rising && falling,
    gains.map(g => `${g.r}:${g.gain.toFixed(3)}`).join('  '));
  assert('resonance amplifies beyond simple end-wall doubling', peak.gain > 2.3,
    `${peak.gain.toFixed(2)}x; the theta -> 0 limit of the closed form above is exactly 2, which is what a`
    + ` perfectly transparent mouth produced at EVERY period before the impedance step was added`);
  // ...and cannot beat the lossless resonator, which is an energy statement and
  // not a regression ceiling: the closed form above is the response with NO
  // dissipation anywhere, so a damped solver exceeding it is manufacturing
  // energy. Measured margin below: printed with the ratio at the end of the
  // block. This is the one bound on the gain that is safe to assert, and the
  // note that follows explains why no other one is.
  assert('...and does not beat the lossless closed form, which would be energy from nowhere',
    peak.gain < lossless(1.0),
    `${peak.gain.toFixed(3)}x against a lossless ceiling of ${lossless(1.0).toFixed(3)}x`);

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
  // ONE CONDITION, AND THE LABEL NOW SAYS SO.
  //
  // This asserted `rFlather < 0.05` and measured 0.121%: it used 2.4% of its
  // budget. The trouble is not the slack, it is that 3c below measures THE SAME
  // METRIC at 4.577% -- 92% of that 5% budget -- at A/h = 0.2, a condition this
  // check does not run. A reader seeing "Flather absorbs an outgoing long wave,
  // 5% budget, 2.4% used" would conclude the boundary has 40x of headroom, and
  // it does not; what it has is one amplitude and one angle where the
  // characteristic split is exact.
  //
  // So: the threshold is now a REGRESSION CEILING at 4.1x the measured value
  // for THIS condition, the label names the condition, and the claim that the
  // boundary behaves across a range of conditions is made in 3b and 3c where
  // the range is actually swept.
  assert('Flather absorbs an outgoing long wave (ONE condition: normal, A/h = 0.0033)',
    rFlather < 0.005,
    `${(100 * rFlather).toFixed(3)}% -- a REGRESSION CEILING at ~4.1x the 0.121% this block measures, for this condition only.`
    + ` The same metric reads 4.577% at A/h = 0.2 (see 3c), so do not read this as headroom`);
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
// metric reads 4.577% while the boundary is responsible for 1.162% of it. When
// that check carried a 5% threshold it was 92% of the way to red -- one small
// step in amplitude from failing for a reason that is not reflection, and it
// would have been read as the open boundary breaking. It now carries a 0.5%
// ceiling and a label naming the single condition it runs at, which is the
// honest version of the same information; the cross-amplitude claim is the one
// made below, on the counterfactual column, where it belongs.
//
// A MEASURED SIDE-EFFECT, so nobody has to rediscover it at 2 a.m. Running the
// whole file against a copy of src/ with gravity scaled by 0.95 and by 1.05
// turns these checks red as well -- at 0.95 the naive metric at A/h = 0.0033
// goes from 0.119% to 1.16% and stops being monotonic; at 1.05 the ratio at
// A/h = 0.2 falls from 3.9 to 1.7. The cause is not the boundary. The pulse is
// SEEDED with hu = sqrt(g_ref*h)*eta, so a solver whose celerity disagrees with
// G_REF is handed a pulse that is not purely right-going, and the left-going
// part bounces off the west wall and lands in the window. That is a real
// sensitivity and worth having, but it means these labels are about the METRIC
// and not about the boundary: if they go red, read section 1 first.
//
// The two checks that used to go red for the WRONG reason are the ratio and the
// monotonicity, and both are rewritten below with the confound written into the
// label rather than left for the next reader to rediscover.
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
  const worstErr = Math.max(...rows.map(r => r.err));
  // EVERY AMPLITUDE, not just the steepest. This asserted only the last row,
  // which meant the claim "the open boundary stays quiet" rested on one
  // condition in a block whose entire subject is condition-dependence. The
  // amplitudes are already run; asserting all five is free.
  assert('the open boundary stays quiet at EVERY amplitude swept, not just the steepest',
    rows.every(r => r.err < 0.02),
    `worst ${(100 * worstErr).toFixed(3)}% at A/h = ${rows.find(r => r.err === worstErr).ratio};`
    + ` a REGRESSION CEILING at ~1.7x the 1.162% measured on the correct solver`);

  // A BRITTLE CHECK, MADE ROBUST, AND THE CONFOUND NAMED. This was
  // `steep.old / steep.err > 2.5` and it went red during the mutation audit
  // because the NUMERATOR fell -- the suite metric got smaller, which is not a
  // defect in anything, and certainly not evidence that the boundary had taken
  // over. A ratio going the wrong way for the right reason is the worst kind of
  // red line.
  //
  // The thing actually worth asserting is a disjunction: EITHER the suite
  // metric at this amplitude is small enough that section 3's headline check
  // has room, OR it is large and most of it is not the boundary. Both branches
  // are good news and the negation -- a large metric that IS mostly boundary --
  // is the only outcome worth a red line.
  assert('at A/h = 0.2 the suite metric is either small, or large and mostly not the boundary',
    steep.old < 0.02 || steep.old / steep.err > 2.5,
    `metric ${(100 * steep.old).toFixed(2)}%, boundary ${(100 * steep.err).toFixed(2)}%,`
    + ` ratio ${(steep.old / steep.err).toFixed(1)} -- the rest is the pulse steepening into a bore.`
    + ` The disjunction exists because a FALLING numerator used to turn this red`);

  // THE SAME TREATMENT FOR THE MONOTONICITY CLAIM. It asserted growth across
  // all five rows and went red during the audit on the first PAIR -- 0.37/0.04
  // then 0.24/0.24 under a perturbed solver -- which is not a statement about
  // steepening at all. At A/h = 0.0033 the metric is 0.119% of a 10 cm pulse,
  // i.e. about 4 mm of eta: at that amplitude there IS no steepening to speak
  // of and the column is measuring the grid. So the monotone claim is made
  // where the mechanism it names is operating, from A/h = 0.02 up, and the
  // full range is covered by the end-to-end growth instead.
  const bulk = rows.slice(1);
  assert('from A/h = 0.02 up, both the suite metric and the boundary error grow with amplitude',
    bulk.every((r, i) => i === 0 || (r.old > bulk[i - 1].old && r.err > bulk[i - 1].err)),
    bulk.map(r => `${r.ratio}:${(100 * r.old).toFixed(2)}/${(100 * r.err).toFixed(2)}`).join('  '));
  // ...and end to end, on the COUNTERFACTUAL column only. The naive column is
  // deliberately not in this one: measured under a g x 0.95 solver, its
  // smallest-amplitude value goes from 0.119% to 1.156% -- the seeded pulse is
  // no longer purely right-going and the west wall returns the rest -- so its
  // apparent growth collapses from 38.3x to 4.1x for a reason that has nothing
  // to do with amplitude. The boundary column grew 29.0x in that same run
  // against 29.4x clean, because the counterfactual subtracts the confound.
  // That is the whole argument for the counterfactual, so it is the column the
  // end-to-end claim is made on.
  assert('...and end to end the boundary error grows by more than 10x with the wave',
    steep.err > 10 * rows[0].err,
    `boundary x${(steep.err / rows[0].err).toFixed(1)} for a 60x wave (naive column x${(steep.old / rows[0].old).toFixed(1)},`
    + ` not asserted here -- see the comment); the smallest row is excluded from the monotone claim above, not from this one`);
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
