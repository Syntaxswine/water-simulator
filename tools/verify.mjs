// ---------------------------------------------------------------------------
// Verification: the solver against closed-form water.
//
// Sections 0-6 are verification: the target is a published analytic solution or
// an exact algebraic identity, evaluated from constants this file owns.
// Sections 7 and 8 are NOT, and now say so on the lines they print -- section 7
// is a self-convergence study (its reference is the same solver on a finer
// grid) and three of section 8's thresholds are regression guards read off
// measured values. Both are standard and worth keeping; neither is a test
// against theory.
//
// WHAT WAS WRONG BEFORE. The paragraph above used to read "Nothing here checks
// that the simulator agrees with itself", and it was false twice over. Every
// analytic target imported G from the solver under test, so a hostile review
// could mutate src/swe.mjs's `export const G` to 9.80665 * 1.1 and this suite
// still printed ALL PASS 32/32: Ritter, c = sqrt(gh), Thacker's period and
// Merian's period all rescale with the bug, so the prediction moved as far as
// the measurement and the ratio never budged.
//
// Reproduced here against a frozen copy of src/, and the reproduction is worth
// stating precisely because it does not match the review word for word. ALL
// PASS 32/32 both ways: exact. "BYTE-IDENTICAL relative errors": true of the
// checks that scale purely -- celerity printed rel 0.307% / 0.060% / 0.011% at
// h = 2 / 10 / 50 m with and without the bug, and Merian 0.000% both ways,
// while `got` and `want` both moved by sqrt(1.1) -- but NOT true of the whole
// file. 23 of the 67 printed lines differ somewhere: Ritter's contour positions
// snap to cell centres (dx = 1.25 m) while their targets slide continuously, so
// those rel errors moved (0.670% -> 0.228% at the h = 0.5 m contour), and the
// lake-at-rest lines wobble at 1e-16. The suite still passed everything.
//
// The test now owns G_REF, imports the solver's G only to compare against it,
// and there is no bare `G` in this file's scope at all.
//
//   node tools/verify.mjs
// ---------------------------------------------------------------------------

// Aliased on purpose. These two are SUBJECTS of section 0, not inputs to any
// target below; keeping the name `G` out of scope means an analytic target that
// reaches for the solver's constant is a ReferenceError rather than a pass.
import { ShallowWater, G as G_SWE, reflect, periodic, outflow } from '../src/swe.mjs';
import { G as G_WAVES } from '../src/waves.mjs';

let checks = 0, failures = 0;
function check(label, got, want, tol, note = '') {
  checks++;
  const rel = Math.abs(want) > 1e-12 ? Math.abs(got - want) / Math.abs(want) : Math.abs(got - want);
  const ok = rel <= tol;
  if (!ok) failures++;
  const pct = (100 * rel).toFixed(3);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(48)} got ${fmt(got)}  want ${fmt(want)}  rel ${pct}%${note ? '   ' + note : ''}`);
}
function assert(label, ok, note = '') {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${note ? '   ' + note : ''}`);
}
function fmt(v) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  return (a < 1e-3 || a >= 1e5) ? v.toExponential(4) : v.toFixed(6);
}
const EPS = Number.EPSILON;

// Standard gravity: 9.80665 m/s^2, exact by definition (CGPM 1901). EVERY
// analytic target in this file is evaluated with this and nothing else, so the
// predictions below stay put when the solver's own constant moves.
const G_REF = 9.80665;

// ===========================================================================
console.log('\n=== 0. the test\'s gravity is not the solver\'s ======================\n');
// ===========================================================================
//
// src/ declares gravity TWICE -- `export const G` in swe.mjs (the solver) and
// again in waves.mjs (the theory, used by tools/waves.mjs). Nothing but this
// check couples them, and a suite that imports either one cannot notice when
// they drift apart, because it would be measuring one against itself.
//
// Exact equality is the right comparison and a tolerance would be wrong here:
// all three are meant to be the same decimal literal, so any difference at all,
// down to one ulp, is an edit and not accumulated arithmetic.
//
// This check is also the one that sees a SMALL error in g, because the celerity
// and period targets below cannot. A relative error d in g is only d/2 in a
// celerity or a period, and those checks carry 1% tolerances, so they have no
// resolution until d is a few percent. Measured, by running this exact file
// against copies of src/ with swe.mjs's G multiplied and nothing else changed:
//
//   g x 1.01 -> 3 of 35 checks fail, and NOT the ones you would expect.
//     celerity read 0.889% / 0.642% / 0.592% at h = 2 / 10 / 50 m, Thacker's
//     period 0.500%, Merian's 0.497% -- every one inside its 1% tolerance,
//     every one still PASS. What failed was this check, plus Ritter's
//     convergence assert (L1 stops falling under refinement: 2.07e-3 -> 1.59e-3
//     -> 1.40e-3, order 0.29 against the > 0.4 requirement) and Thacker's mean
//     depth error (22.263% against 2%). Those two see it because a wrong g
//     displaces the whole exact solution instead of adding a small offset --
//     Thacker's surface tilt is (U w / g) x over a 3 km arm.
//
//   g x 1.10 -> 12 of 35 fail: this check, the three Ritter contours (4.6-5.0%),
//     Ritter's L1 and its convergence assert, all three celerities (5.7-6.0%),
//     Thacker's L1 and period (4.659%), and Merian's period (4.654%).
//
// So a gravity wrong by 10% is now caught eleven different ways, one wrong by 1%
// is caught three, and one wrong in the last decimal place is caught only here.
{
  assert('gravity: src/swe.mjs G equals the reference constant', G_SWE === G_REF,
    `solver ${G_SWE} vs reference ${G_REF} m/s^2, difference ${fmt(G_SWE - G_REF)}`);
  assert('gravity: src/waves.mjs G equals the reference constant', G_WAVES === G_REF,
    `theory ${G_WAVES} vs reference ${G_REF} m/s^2, difference ${fmt(G_WAVES - G_REF)}`);
}

// ===========================================================================
console.log('\n=== 1. still water: the state the model lives in =====================\n');
// ===========================================================================
//
// A flat surface over an uneven bed must stay EXACTLY flat. This is the check
// the whole scheme is built around: the pressure flux and the bed-slope source
// are individually large and must cancel algebraically, not to truncation error.
// A scheme that is merely consistent produces cm/s currents in a still lake and
// every wave you launch afterwards rides on them.
//
// The tolerance below is machine epsilon scaled by the size of the terms being
// cancelled -- not a "small number" chosen to make it pass.
{
  const beds = {
    'smooth bump': (x) => 0.8 * Math.exp(-(((x - 500) / 120) ** 2)),
    'sharp step': (x) => (x > 480 && x < 620 ? 1.2 : 0.1),
    'random rough': (x) => 0.6 * (Math.sin(x * 0.031) + Math.sin(x * 0.0173) * Math.cos(x * 0.0077)),
    'island (pierces surface)': (x) => 2.6 * Math.exp(-(((x - 500) / 90) ** 2)),
  };
  for (const [name, bfn] of Object.entries(beds)) {
    const ETA = 2.0;
    const sim = new ShallowWater({
      nx: 200, ny: 4, dx: 5, bed: (x, y) => bfn(x) + 0.15 * Math.sin(y * 0.05), eta0: ETA, manning: 0,
    });
    sim.boundaries = { west: reflect, east: reflect, south: periodic, north: periodic };
    const v0 = sim.volume();
    for (let n = 0; n < 400; n++) sim.step();
    const dev = sim.maxSurfaceDeviation(ETA);
    const spd = sim.maxSpeed();
    const dV = Math.abs(sim.volume() - v0) / v0;
    // The cancelled quantity is g*h^2/2 ~ 20 m^3/s^2; eta is O(1). 400 steps of
    // accumulation gives a few thousand roundings.
    assert(`lake at rest, ${name}: surface`, dev < 1e-12, `max |eta - ${ETA}| = ${fmt(dev)} m over 400 steps`);
    assert(`lake at rest, ${name}: velocity`, spd < 1e-12, `max speed = ${fmt(spd)} m/s`);
    assert(`lake at rest, ${name}: volume`, dV < 1e-13, `relative drift ${fmt(dV)}`);
  }
}

// ===========================================================================
console.log('\n=== 2. mass conservation ============================================\n');
// ===========================================================================
//
// With solid walls all round, the total volume is exact to roundoff no matter
// how violent the interior. A finite-volume scheme gets this for free IF the
// interface fluxes are shared exactly between neighbours -- which is worth
// checking, because the well-balancing corrections are applied per side and a
// sign error there leaks mass slowly enough to look like physics.
{
  const sim = new ShallowWater({
    nx: 120, ny: 80, dx: 4,
    bed: (x, y) => -8 + 3 * Math.sin(x * 0.02) * Math.cos(y * 0.03),
    eta0: (x, y) => (x < 240 ? 1.5 : 0.0),
    manning: 0.02,
  });
  const v0 = sim.volume();
  let minV = v0, maxV = v0;
  for (let n = 0; n < 600; n++) {
    sim.step();
    const v = sim.volume();
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const drift = Math.abs(sim.volume() - v0) / v0;
  check('closed basin, volume drift over 600 steps', drift, 0, 1e-12,
    `swing ${fmt((maxV - minV) / v0)}, max speed ${fmt(sim.maxSpeed())} m/s`);
  assert('closed basin stays finite', sim.finite());
}

// ===========================================================================
console.log(''); console.log('=== 3. dam break on a dry bed: Ritter 1892 =========================='); console.log('');
// ===========================================================================
//
// The canonical nonlinear test, and the one that catches a scheme that cannot
// handle a dry front. Exact solution:
//     x < -c0 t          h = h0
//     between            h = (2c0 - x/t)^2 / (9g),  u = 2(x/t + c0)/3
//     x > 2 c0 t         h = 0
//
// Measured at DEPTH CONTOURS, and the tip is reported rather than tested. The
// leading edge of Ritter's solution tapers to zero thickness, and no scheme with
// a dry threshold can resolve the last millimetre of it: measured, the h = 1 cm
// contour lags 9-13% and does NOT converge under refinement, while every contour
// at 10 cm and above tracks to about 1% and does. Testing the tip would be
// testing the threshold; hiding it would be worse. So the check is on the part
// the model can represent, and the part it cannot is printed with its number.
{
  const h0 = 4, L = 2000, x0 = 1000, T = 20;
  const c0 = Math.sqrt(G_REF * h0);
  const errs = [];
  for (const nx of [800, 1600, 3200]) {
    const dx = L / nx;
    const sim = new ShallowWater({
      nx, ny: 1, dx, bed: () => 0, eta0: (x) => (x < x0 ? h0 : 0), manning: 0,
    });
    sim.boundaries = { west: reflect, east: outflow, south: periodic, north: periodic };
    while (sim.t < T) sim.step(Math.min(sim.maxDt(), T - sim.t));
    let l1 = 0;
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * dx - x0;
      let ex;
      if (x <= -c0 * T) ex = h0;
      else if (x >= 2 * c0 * T) ex = 0;
      else ex = (2 * c0 - x / T) ** 2 / (9 * G_REF);
      l1 += Math.abs(sim.depth(i, 0) - ex);
    }
    errs.push(l1 / nx);
    const contour = (lvl) => { let p = 0; for (let i = 0; i < nx; i++) if (sim.depth(i, 0) > lvl) p = (i + 0.5) * dx; return p; };
    const exact = (lvl) => x0 + T * (2 * c0 - Math.sqrt(9 * G_REF * lvl));
    if (nx === 1600) {
      for (const lvl of [0.5, 0.2, 0.1]) {
        check(`Ritter: h = ${lvl} m contour position`, contour(lvl) - x0, exact(lvl) - x0, 0.02,
          `${fmt(contour(lvl) - x0)} vs ${fmt(exact(lvl) - x0)} m from the dam`);
      }
      const tip = 100 * (contour(0.01) - exact(0.01)) / (exact(0.01) - x0);
      console.log(`        KNOWN LIMIT: the h = 1 cm tip lags ${tip.toFixed(1)}% and does not converge --`);
      console.log(`        it is 10x the ${1e-3} m dry threshold, so this is the model's floor, not a bug.`);
    }
  }
  check('Ritter: mean |h - exact| at nx=1600', errs[1], 0, 0.004, `h0 = ${h0} m, so ${fmt(100 * errs[1] / h0)}% of depth`);
  const p = Math.log2(errs[0] / errs[2]) / 2;
  assert('Ritter: error converges under refinement', p > 0.4 && errs[2] < errs[1] && errs[1] < errs[0],
    `L1 ${errs.map(e => e.toExponential(2)).join(' -> ')}, order ${p.toFixed(2)} (1st order is correct at a shock)`);
}

// ===========================================================================
console.log(''); console.log('=== 4. long-wave celerity: c = sqrt(g h) ============================'); console.log('');
// ===========================================================================
//
// The dispersion relation the shallow-water equations exist to represent.
//
// Two design choices, both of which cost a wrong answer first.
//
// The pulse is launched as a PURE right-going simple wave, hu = c0 * eta, which
// is the Riemann invariant for rightward propagation. Seeding elevation alone
// splits it into two counter-moving halves, and any window that then tries to
// isolate one of them clips the other -- measured, a clean 6.2% low at every
// depth, which is the signature of a measurement bias rather than physics
// because it does not vary with h at all.
//
// Position is the CENTROID, not a threshold crossing. A threshold sees the
// smooth pulse's numerical precursor, which runs ahead of the wave and reports a
// celerity far too high; the centroid of a non-dispersive pulse translates at
// exactly c.
{
  const measured = {};
  for (const h0 of [2, 10, 50]) {
    const c0 = Math.sqrt(G_REF * h0);
    const L = 20000, nx = 1000, dx = L / nx;
    const amp = 0.01, x0 = 5000, sig = 700;
    const shape = (x) => amp * Math.exp(-(((x - x0) / sig) ** 2));
    const sim = new ShallowWater({
      nx, ny: 1, dx, bed: () => -h0, eta0: (x) => shape(x), manning: 0, order: 2,
    });
    for (let i = 0; i < nx; i++) {
      const k = sim.idx(i, 0);
      sim.hu[k] = c0 * shape((i + 0.5) * dx);
    }
    sim.boundaries = { west: outflow, east: outflow, south: periodic, north: periodic };
    const centroid = () => {
      let m = 0, mx = 0;
      for (let i = 0; i < nx; i++) {
        const w = Math.max(0, sim.eta(i, 0));
        m += w; mx += w * (i + 0.5) * dx;
      }
      return mx / m;
    };
    const t1 = 1500 / c0, t2 = t1 + 9000 / c0;      // both well inside the domain
    while (sim.t < t1) sim.step(Math.min(sim.maxDt(), t1 - sim.t));
    const x1 = centroid(), tA = sim.t;
    while (sim.t < t2) sim.step(Math.min(sim.maxDt(), t2 - sim.t));
    const x2 = centroid(), tB = sim.t;
    const c = (x2 - x1) / (tB - tA);
    measured[h0] = c;
    check(`celerity at h = ${h0} m`, c, c0, 0.01, `${fmt(c)} vs sqrt(g*h) = ${fmt(c0)} m/s`);
  }
  // A control: the same measurement must DISAGREE when the depth is wrong, or it
  // is not measuring depth at all.
  //
  // This line used to be a console.log that asserted NOTHING -- it printed the
  // word "control" and checked no quantity, which is worse than having no
  // control at all, because it reads like coverage. It is now the arithmetic it
  // was pretending to be: the h = 10 m run is compared against the h = 50 m
  // target. Those depths differ by a factor of 5, so the celerities differ by
  // sqrt(5) and the h = 10 m measurement must land 1 - 1/sqrt(5) = 55.28% below
  // the h = 50 m target. The threshold is 50%, which is that algebraic figure
  // with a little room, and the pairing is what matters: a routine that ignored
  // depth and returned one constant would satisfy at most one of the three
  // celerity checks above and would read 0% here, failing both ways.
  const wrong = Math.sqrt(G_REF * 50);
  const apart = Math.abs(measured[10] - wrong) / wrong;
  assert('celerity: the measurement discriminates depth', apart > 0.5,
    `the h = 10 m run reads ${fmt(measured[10])} m/s, ${(100 * apart).toFixed(1)}% away from the h = 50 m target ${fmt(wrong)} m/s (exact answer 55.28%, threshold 50%)`);
}

// ===========================================================================
console.log('\n=== 5. Thacker: oscillation in a parabolic bowl =====================\n');
// ===========================================================================
//
// An EXACT time-dependent solution of the nonlinear equations WITH moving wet/dry
// shorelines -- the only test here that exercises run-up against something known.
//
// Ansatz: a planar free surface eta = eta0(t) + s(t)x over a bed b = h0 x^2/a^2,
// with u spatially uniform. Substituting into the shallow-water equations gives
//     du/dt = -g s,      ds/dt = 2 h0 u / a^2,      d eta0/dt = -u s
// so (u, s) is a harmonic oscillator with omega = sqrt(2 g h0)/a, and
//     u = U cos(wt),  s = (U w/g) sin(wt),  eta0 = C + (U^2/4g) cos(2wt).
// That is Thacker's 1981 planar solution, re-derived here so the reference is a
// formula rather than a remembered constant.
{
  const h0 = 10, a = 3000, U = 5;
  const w = Math.sqrt(2 * G_REF * h0) / a;
  const period = 2 * Math.PI / w;
  const C = h0 - U * U / (4 * G_REF);
  const bed = (x) => h0 * ((x - 6000) / a) ** 2;
  const etaEx = (x, t) => C + (U * U / (4 * G_REF)) * Math.cos(2 * w * t) + (U * w / G_REF) * Math.sin(w * t) * (x - 6000);
  const uEx = (t) => U * Math.cos(w * t);

  const nx = 1200, dx = 12000 / nx;
  const sim = new ShallowWater({
    nx, ny: 1, dx, bed: (x) => bed(x), eta0: (x) => etaEx(x, 0), manning: 0,
  });
  // Uniform initial velocity everywhere wet.
  for (let i = 0; i < nx; i++) {
    const k = sim.idx(i, 0);
    if (sim.h[k] > sim.minDepth) sim.hu[k] = sim.h[k] * uEx(0);
  }
  sim.boundaries = { west: reflect, east: reflect, south: periodic, north: periodic };

  const T = 2 * period;
  while (sim.t < T) sim.step(Math.min(sim.maxDt(), T - sim.t));

  // Compare over cells that are wet in BOTH the exact and numerical solutions.
  let l1 = 0, cnt = 0, worst = 0;
  for (let i = 0; i < nx; i++) {
    const x = (i + 0.5) * dx;
    const hx = etaEx(x, sim.t) - bed(x);
    if (hx < 0.15) continue;                       // skip the shoreline cells
    const got = sim.depth(i, 0);
    const e = Math.abs(got - hx);
    l1 += e; cnt++;
    if (e > worst) worst = e;
  }
  check('Thacker: mean |h - exact| after 2 periods', l1 / cnt, 0, 0.02,
    `over ${cnt} wet cells, worst ${fmt(worst)} m, depth scale ${h0} m`);

  // The period is the sharpest test: it depends only on g, h0 and a, and a
  // scheme with the wrong effective gravity or a leaky bowl drifts in phase.
  const centre = Math.round(6000 / dx);
  const hist = [];
  const sim2 = new ShallowWater({
    nx, ny: 1, dx, bed: (x) => bed(x), eta0: (x) => etaEx(x, 0), manning: 0,
  });
  for (let i = 0; i < nx; i++) {
    const k = sim2.idx(i, 0);
    if (sim2.h[k] > sim2.minDepth) sim2.hu[k] = sim2.h[k] * uEx(0);
  }
  sim2.boundaries = { west: reflect, east: reflect, south: periodic, north: periodic };
  const samp = 0.5;
  // Six periods, not the four this used to run. u = U cos(wt) crosses downward
  // once per period, so four periods yielded exactly 4 crossings against a
  // `>= 3` requirement -- one crossing of margin, and the requirement would
  // have started failing for a reason as dull as the sampler landing a hair
  // early. Six gives 6 crossings against a requirement of 4 (measured, below),
  // and the extra length also sharpens the period: measured 0.008% error over
  // four periods, 0.004% over six, because a fixed timing error at the first
  // and last crossing is divided by more intervals. Costs ~32 s.
  while (sim2.t < 6 * period) {
    let acc = 0;
    while (acc < samp - 1e-12) acc += sim2.step(Math.min(sim2.maxDt(), samp - acc));
    hist.push([sim2.t, sim2.vel(sim2.hu[sim2.idx(centre, 0)], sim2.h[sim2.idx(centre, 0)])]);
  }
  // zero crossings of u at the bowl centre, downward
  const zc = [];
  for (let n = 1; n < hist.length; n++) {
    if (hist[n - 1][1] > 0 && hist[n][1] <= 0) {
      const f = hist[n - 1][1] / (hist[n - 1][1] - hist[n][1]);
      zc.push(hist[n - 1][0] + f * (hist[n][0] - hist[n - 1][0]));
    }
  }
  assert('Thacker: at least four oscillations observed', zc.length >= 4,
    `${zc.length} crossings in 6 periods, need 4, margin ${zc.length - 4}`);
  // Deliberately NOT wrapped in `if (zc.length >= 3)` as it used to be. A check
  // that disappears when the run goes wrong is the worst kind: the suite would
  // have printed a smaller total and still said ALL PASS. With too few
  // crossings the period comes out NaN, and NaN <= tol is false, so it FAILS
  // and says so.
  const measured = (zc[zc.length - 1] - zc[0]) / (zc.length - 1);
  check('Thacker: oscillation period', measured, period, 0.01,
    `${fmt(measured)} vs 2*pi*a/sqrt(2 g h0) = ${fmt(period)} s`);
}

// ===========================================================================
console.log('\n=== 6. seiche in a closed basin: Merian =============================\n');
// ===========================================================================
//
// The fundamental standing mode of a rectangular basin of length L and depth h
// has period T = 2L/sqrt(g h). Independent of amplitude, and a direct check that
// reflective walls really are reflective.
{
  const L = 5000, h = 20;
  const nx = 500, dx = L / nx;
  const sim = new ShallowWater({
    nx, ny: 1, dx, bed: () => -h,
    eta0: (x) => 0.05 * Math.cos(Math.PI * x / L), manning: 0,
  });
  sim.boundaries = { west: reflect, east: reflect, south: periodic, north: periodic };
  const want = 2 * L / Math.sqrt(G_REF * h);
  const hist = [];
  const samp = 1.0;
  // 8.4 periods, not the 3.2 this used to run. eta at the west end crosses
  // downward at t = (n + 1/4) T, so 3.2 periods produced EXACTLY 3 crossings
  // against a `>= 3` requirement: the assert below could not have failed for
  // any reason short of the basin losing an entire oscillation, and one step of
  // extra numerical damping would have taken it out for a bookkeeping reason
  // rather than a physical one. 8.4 periods gives 9 crossings against a
  // requirement of 6.
  //
  // Length is free accuracy here and it was worth measuring how free: the
  // period reads 714.0409 s at 3.2 periods and 714.0411 s at 8.4 against
  // Merian's 714.0435 s -- 3.4e-6 relative either way, so the basin is not
  // drifting in phase and the longer run buys margin rather than error. Costs
  // ~25 s.
  while (sim.t < 8.4 * want) {
    let acc = 0;
    while (acc < samp - 1e-12) acc += sim.step(Math.min(sim.maxDt(), samp - acc));
    hist.push([sim.t, sim.eta(2, 0)]);
  }
  const zc = [];
  for (let n = 1; n < hist.length; n++) {
    if (hist[n - 1][1] > 0 && hist[n][1] <= 0) {
      const f = hist[n - 1][1] / (hist[n - 1][1] - hist[n][1]);
      zc.push(hist[n - 1][0] + f * (hist[n][0] - hist[n - 1][0]));
    }
  }
  assert('seiche: at least six periods observed', zc.length >= 6,
    `${zc.length} crossings in 8.4 periods, need 6, margin ${zc.length - 6}`);
  // Unconditional, for the reason given in section 5: too few crossings must
  // make this line FAIL, not make it vanish from the tally.
  const measured = (zc[zc.length - 1] - zc[0]) / (zc.length - 1);
  check('seiche period (Merian)', measured, want, 0.01, `${fmt(measured)} vs 2L/sqrt(gh) = ${fmt(want)} s`);
}

// ===========================================================================
console.log('\n=== 7. SELF-CONVERGENCE (not verification) ==========================\n');
// ===========================================================================
//
// READ THE LABEL. Everything above compares the solver to an answer that exists
// without it. This does NOT: the reference is build(1600) -- the same class,
// the same flux, the same limiter, the same time integrator, on a finer grid.
// The file used to head this section "convergence order" and claim in its
// opening paragraph that nothing here checks the simulator against itself. This
// section is exactly that, so it now says so in the heading, in the printed
// line, and in the check's own label.
//
// It is still worth running, and it is standard practice (Roache's grid
// convergence study), but be exact about what it can and cannot see:
//   CAN see  -- the limiter clipping a smooth extremum, a well-balancing
//               correction that is only 1st order, an RK stage weighted wrong:
//               anything that costs formal order shows up as p falling to 1.
//   CANNOT see -- a solver that converges beautifully to the WRONG equation. A
//               consistent discretisation of the wrong PDE self-converges at
//               2nd order all day. Sections 3-6 are what stand between this
//               suite and that failure; this section cannot help there.
//
// The window 1.5-2.6 is a REGRESSION GUARD, not a theoretical prediction.
// Theory says 2 for a smooth problem; the bracket was drawn around what this
// code already produced, wide enough not to flap. Measured on the current
// solver: 1.73 and 1.79. Note those are BELOW the design order of 2 and the
// guard passes anyway -- which is the honest situation, but it means this
// section is not evidence that the scheme achieves 2nd order.
{
  const L = 1000, h0 = 5, T = 30;
  const exactish = [];
  const errs = [];
  const res = [50, 100, 200];
  let ref = null;
  // Reference: THE SAME SOLVER at 8x the finest grid. Not an exact solution --
  // this is what makes the section a self-convergence study and not a check.
  const build = (n) => {
    const s = new ShallowWater({
      nx: n, ny: 1, dx: L / n, bed: () => -h0,
      eta0: (x) => 0.05 * Math.exp(-(((x - 300) / 60) ** 2)), manning: 0,
    });
    s.boundaries = { west: periodic, east: periodic, south: periodic, north: periodic };
    while (s.t < T) s.step(Math.min(s.maxDt(), T - s.t));
    return s;
  };
  const fine = build(1600);
  const sampleFine = (x) => fine.eta(Math.min(1599, Math.floor(x / (L / 1600))), 0);
  for (const n of res) {
    const s = build(n);
    let e = 0;
    for (let i = 0; i < n; i++) e += Math.abs(s.eta(i, 0) - sampleFine((i + 0.5) * (L / n)));
    errs.push(e / n);
  }
  const p1 = Math.log2(errs[0] / errs[1]);
  const p2 = Math.log2(errs[1] / errs[2]);
  console.log(`        L1 errors vs build(1600): ${errs.map(e => e.toExponential(3)).join('  ')}`);
  console.log('        REFERENCE IS THE SOLVER ITSELF at nx=1600 -- self-convergence, NOT theory.');
  assert('self-convergence order in 1.5-2.6 (regression guard, not theory)',
    p1 > 1.5 && p1 < 2.6 && p2 > 1.5 && p2 < 2.6,
    `observed orders ${p1.toFixed(2)} and ${p2.toFixed(2)}; window drawn round measured values, not derived`);
}

// ===========================================================================
console.log(''); console.log('=== 8. numerical dissipation: can it carry a wave at all? ==========='); console.log('');
// ===========================================================================
//
// A wave model that damps its own waves is not a wave model, and NOTHING else in
// this suite would catch it: lake-at-rest is stationary, Ritter is a single
// front, Thacker and the seiche are standing modes. A progressive wave crossing
// many wavelengths is a separate question needing its own check.
//
// Measured on a PERIODIC domain holding a whole number of wavelengths, seeded
// with an analytic right-going wave, with no boundaries at all. An earlier
// version used two gauges in a bounded domain and read 35% where the truth is
// 86%: a few percent of reflection off the outflow boundary sets up a standing
// pattern, and a fixed gauge then reports its position in that pattern rather
// than the wave. If a propagation measurement has a boundary in it, it is
// measuring the boundary.
//
// These numbers are a RESOLUTION REQUIREMENT and the model should be quoted with
// them. At 20 cells per wavelength half the height is gone after fifteen
// wavelengths, and no coastal result at that resolution means anything.
//
// WHAT THE THRESHOLDS IN THIS SECTION ARE. The percentages printed below are
// measurements and stand on their own. The three PASS/FAIL lines are REGRESSION
// GUARDS, not physics: there is no closed-form prediction for how much
// amplitude a MUSCL/HLLC/SSP-RK2 scheme keeps over fifteen wavelengths at 40
// cells each, so "within 20% of unity", "above 92%" and "order above 1.4" were
// all drawn around numbers this code already produced. They will catch a change
// that makes the scheme more diffusive, which is what they are for; they cannot
// tell you the scheme is right. The only line here with a theoretical value
// behind it is the convergence rate, and even that is checked against 1.4 rather
// than the design order of 2 because the measurement is a ratio of logs of
// three points. Labelled on the printed lines so nobody reads them as theory.
{
  const h0 = 12, A = 0.02, T = 10, c0 = Math.sqrt(G_REF * h0), Lw = c0 * T;
  const seed = (sim, nx, dx) => {
    const k = 2 * Math.PI / Lw;
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * dx, e = A * Math.cos(k * x), kk = sim.idx(i, 0);
      sim.h[kk] = h0 + e; sim.hu[kk] = c0 * e;
    }
    sim.boundaries = { west: periodic, east: periodic, south: periodic, north: periodic };
  };
  const amp = (sim, nx) => { let m = 0; for (let i = 0; i < nx; i++) m = Math.max(m, Math.abs(sim.eta(i, 0))); return m; };
  const results = [];
  for (const cpw of [20, 40, 80]) {
    const nx = cpw * 4, dx = Lw / cpw;
    const sim = new ShallowWater({ nx, ny: 1, dx, bed: () => -h0, eta0: 0, manning: 0, cfl: 0.4 });
    seed(sim, nx, dx);
    while (sim.t < 15 * T) sim.step(Math.min(sim.maxDt(), 15 * T - sim.t));
    const kept = amp(sim, nx) / A;
    results.push({ cpw, kept });
    console.log(`        ${String(cpw).padStart(3)} cells/wavelength: ${(100 * kept).toFixed(1)}% of amplitude after 15 wavelengths`);
  }
  check('REGRESSION GUARD: amplitude kept at 40 cells/wavelength', results[1].kept, 1, 0.20,
    'the documented minimum resolution for a wave result; 20% is a guard band, not a prediction');
  assert('REGRESSION GUARD: amplitude kept at 80 cells/wavelength above 92%', results[2].kept > 0.92,
    `${(100 * results[2].kept).toFixed(1)}% -- 92% was read off this code, not derived`);
  const a1 = -Math.log(results[0].kept), a2 = -Math.log(results[1].kept), a3 = -Math.log(results[2].kept);
  const p1 = Math.log2(a1 / a2), p2 = Math.log2(a2 / a3);
  assert('REGRESSION GUARD: dissipation converges above 1.4 order', p1 > 1.4 && p2 > 1.4,
    `observed orders ${p1.toFixed(2)} and ${p2.toFixed(2)}; 2 is the scheme design order, 1.4 is a guard band`);
  // Control: the most diffusive limiter must be measurably worse, or this
  // measurement is not sensitive to what it claims to measure.
  const nx = 80, dx = Lw / 20;
  const bad = new ShallowWater({ nx, ny: 1, dx, bed: () => -h0, eta0: 0, manning: 0, cfl: 0.4, limiter: 'minmod' });
  seed(bad, nx, dx);
  while (bad.t < 15 * T) bad.step(Math.min(bad.maxDt(), 15 * T - bad.t));
  assert('the check can tell limiters apart', amp(bad, nx) / A < 0.5 * results[0].kept,
    `minmod keeps ${(100 * amp(bad, nx) / A).toFixed(1)}% where the default MC keeps ${(100 * results[0].kept).toFixed(1)}%`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} -- ${checks - failures}/${checks} checks\n`);
process.exit(failures ? 1 : 0);
