// ---------------------------------------------------------------------------
// Verification, part two: the subsystems nothing else in the tree touches.
//
// tools/verify.mjs checks the things a shallow-water solver is famous for --
// lake at rest, Ritter, Thacker, Merian, convergence. This file checks the
// machinery those tests happen to leave alone, and "leave alone" is meant
// literally: before this file existed, `coriolis` was never set to anything but
// its constructor default of zero anywhere in the repo, so that entire branch
// of residual() ran zero times in the whole test suite. Manning friction was
// switched on in places but never measured against a friction law. The
// positivity limiter never fired, because verify.mjs section 2's basin never
// dries. vel()'s desingularisation could be deleted outright. So could the
// component swap in the y-sweep's call to hllc(), and so could the contact
// wave that is HLLC's entire reason for existing over HLL.
//
// Every target below is an analytic solution or an exact algebraic identity.
// Where a number came from deliberately breaking the solver in a scratch copy
// -- to prove a check can go red, and to place a threshold between working and
// broken -- it says so at the point of use.
//
//   node tools/verify-physics.mjs        (~8 s)
//
// G IS A LITERAL HERE, AND THAT IS THE POINT. tools/verify.mjs imports G from
// the module it is testing, so its analytic targets are written in terms of
// whatever gravity the solver happens to be holding: change G and the target
// moves with it, and the check cannot see the change. Measured on a scratch
// copy with G scaled by 1.1, this file goes red in five places -- the three
// Manning normal-depth checks by 4.53%, 4.60% and 4.53%, and the two spin-down
// identities by exactly 10%, which is the scaling itself, because the friction
// coefficient is linear in g. Section 1's inertial period stays green, which is
// also right: an inertial oscillation does not involve gravity at all.
// ---------------------------------------------------------------------------

import { ShallowWater, reflect, periodic } from '../src/swe.mjs';

const G = 9.80665;                 // standard gravity [m/s^2] -- NOT imported.

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
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  return (a < 1e-3 || a >= 1e5) ? v.toExponential(4) : v.toFixed(6);
}

/** Set a uniform state over the interior. */
function uniform(sim, h0, u0, v0) {
  for (let j = 0; j < sim.ny; j++) {
    for (let i = 0; i < sim.nx; i++) {
      const k = sim.idx(i, j);
      sim.h[k] = h0; sim.hu[k] = h0 * u0; sim.hv[k] = h0 * v0;
    }
  }
}

/**
 * How many cells the positivity limiter clipped in the last residual. theta is
 * refilled every residual() call, so after step() this is stage 2's tally --
 * an undercount of the step, which is the safe direction for a number that is
 * only ever reported as "this never happens".
 */
function countClips(sim) {
  let n = 0;
  for (let k = 0; k < sim.theta.length; k++) if (sim.theta[k] < 1) n++;
  return n;
}

/** Largest departure from a uniform state over the interior. */
function nonUniformity(sim) {
  const k0 = sim.idx(0, 0);
  let m = 0;
  for (let j = 0; j < sim.ny; j++) {
    for (let i = 0; i < sim.nx; i++) {
      const k = sim.idx(i, j);
      m = Math.max(m, Math.abs(sim.h[k] - sim.h[k0]),
        Math.abs(sim.hu[k] - sim.hu[k0]), Math.abs(sim.hv[k] - sim.hv[k0]));
    }
  }
  return m;
}

// ===========================================================================
console.log('\n=== 1. Coriolis: the inertial oscillation ===========================\n');
// ===========================================================================
//
// Water on an f-plane with no pressure gradient feels only the Coriolis force:
//
//     du/dt = +f v,    dv/dt = -f u
//
// so the velocity vector rotates at constant speed with period 2*pi/f, and the
// water parcel traces a circle of radius |U|/f -- the inertial circle. For
// f > 0 (northern hemisphere) the rotation is CLOCKWISE, which a period check
// on its own cannot see: swap the two signs and the period is unchanged.
//
// The set-up is a uniform-depth periodic box with a uniform initial velocity.
// Uniform means every interface sees identical left and right states, so the
// flux divergence is not merely small but IDENTICALLY zero -- measured, the
// departure from uniformity after 2000 steps is 0, bit for bit. Whatever this
// section measures is therefore the Coriolis term and nothing else.
//
// TOLERANCES. Both come from the time integrator, not from taste. SSP-RK2
// applied to a pure rotation has amplification 1 + z + z^2/2 at z = +-i*f*dt,
// which gives per step a phase error of exactly (f dt)^2/6 and an amplitude
// growth of exactly (f dt)^4/8. At f dt = 3.1416e-3 that predicts a period
// 1.645e-6 short and a speed 2.436e-8 high after one revolution; measured,
// 1.645e-6 and 2.435e-8. The tolerances are ~5x those predictions, which is
// still four orders tighter than any coefficient error worth the name.
{
  const f = 1e-4;                       // 2*Omega*sin(43.4 deg): the Bay of Biscay
  const T = 2 * Math.PI / f;            // 62832 s = 17.45 h
  const h0 = 10, U = 0.5;
  const N = 2000, dt = T / N;
  const theta = f * dt;

  const sim = new ShallowWater({
    nx: 8, ny: 8, dx: 5000, bed: () => -h0, eta0: 0, manning: 0, coriolis: f,
  });
  sim.boundaries = { west: periodic, east: periodic, south: periodic, north: periodic };
  uniform(sim, h0, U, 0);
  assert('inertial: the fixed step is inside the CFL limit', dt < sim.maxDt(),
    `dt = ${fmt(dt)} s, CFL limit ${fmt(sim.maxDt())} s`);

  const k0 = sim.idx(4, 4);
  const uu = () => sim.vel(sim.hu[k0], sim.h[k0]);
  const vv = () => sim.vel(sim.hv[k0], sim.h[k0]);

  // Trajectory by the trapezoid rule, so "traces a circle of radius U/f" is
  // tested as written rather than inferred from the velocity.
  let px = 0, py = 0, pu = uu(), pv = vv();
  const traj = [[0, 0]];
  const spd0 = Math.hypot(pu, pv);
  let ang = 0, prev = Math.atan2(pv, pu), quarterV = null;
  for (let n = 0; n < N; n++) {
    sim.step(dt);
    const u = uu(), v = vv();
    px += 0.5 * (pu + u) * dt; py += 0.5 * (pv + v) * dt;
    traj.push([px, py]);
    pu = u; pv = v;
    let d = Math.atan2(v, u) - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    ang += d; prev = Math.atan2(v, u);
    if (n === N / 4 - 1) quarterV = v;
  }
  const spd1 = Math.hypot(uu(), vv());

  assert('inertial: the state stays exactly uniform', nonUniformity(sim) === 0,
    `max departure ${nonUniformity(sim)} -- no pressure gradient exists, so this is pure Coriolis`);

  // (a) PERIOD. Measured from the total rotation angle, which needs no
  // interpolation and no threshold: after time T the vector must have turned
  // through exactly one full turn.
  const period = T * (2 * Math.PI) / Math.abs(ang);
  check('inertial period = 2*pi/f', period, T, 1e-5,
    `${fmt(period)} vs ${fmt(T)} s; SSP-RK2 phase error (f dt)^2/6 = ${fmt(theta * theta / 6)}`);

  // (b) SENSE. f > 0 turns the velocity vector CLOCKWISE: starting due east it
  // must be pointing due south a quarter period later. A sign error in either
  // Coriolis line reverses this and changes nothing else.
  assert('inertial rotation is clockwise for f > 0', ang < 0,
    `total turn ${(ang / (2 * Math.PI)).toFixed(6)} revolutions (negative = clockwise, northern hemisphere)`);
  check('inertial: v after a quarter period', quarterV, -U, 2e-3,
    `starts due east at ${U} m/s, must point due south`);

  // (c) SPEED. The Coriolis force is perpendicular to the velocity and so does
  // no work at all.
  check('inertial: speed after one revolution', spd1, spd0, 1e-7,
    `drift ${fmt(100 * (spd1 - spd0) / spd0)}%; SSP-RK2 predicts +${fmt(100 * N * theta ** 4 / 8)}%`);

  // (d) The circle itself.
  const cx = traj.reduce((a, p) => a + p[0], 0) / traj.length;
  const cy = traj.reduce((a, p) => a + p[1], 0) / traj.length;
  let rMin = Infinity, rMax = 0;
  for (const [x, y] of traj) {
    const r = Math.hypot(x - cx, y - cy);
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
  }
  check('inertial circle radius = U/f', 0.5 * (rMin + rMax), U / f, 1e-4,
    `${fmt(0.5 * (rMin + rMax))} vs ${fmt(U / f)} m, out-of-round ${fmt(rMax - rMin)} m`);
}

// ===========================================================================
console.log('\n=== 2. Manning friction ============================================\n');
// ===========================================================================
//
// Two checks that fail for different reasons. The first pins the friction LAW
// -- the exponents on depth and velocity, and the coefficient. The second pins
// its DISCRETISATION, which the first cannot see.
{
  // -----------------------------------------------------------------------
  // (a) NORMAL DEPTH. Steady uniform flow down a slope S balances gravity
  // against bed friction:
  //         g h S = g n^2 u^2 / h^(1/3)      =>      u = h^(2/3) sqrt(S) / n
  // which is Manning's formula, and it is the number every hydraulics table in
  // the world is built on.
  //
  // The solver has no body-force hook, so the slope is applied through
  // sim.forcing, which step() calls as (sim, dt) once per step after friction.
  // That ordering is a Lie splitting and it BIASES the answer, upward, by a
  // computable amount: the discrete fixed point of
  //     u -> u/(1 + dt*K)  then  u -> u + g S dt,        K = g n^2 u / h^(4/3)
  // is u* = u_normal * sqrt(1 + dt*K), not u_normal. That is a property of the
  // splitting, derived here, not of the friction law -- so it is printed beside
  // each result and the steps are sized to keep it under 0.13%. Measured, the
  // deviation from Manning agrees with the predicted splitting bias to four
  // significant figures in all three cases. The tolerance is 0.5%.
  //
  // The transient is analytic too: du/dt = gS(1 - (u/u_N)^2) gives
  // u = u_N tanh(g S t / u_N), so each run is long enough that the remaining
  // approach deficit is under 2e-6 -- reported, not assumed.
  console.log('  (a) normal depth: u = h^(2/3) sqrt(S) / n\n');
  for (const [h0, S, n, dt, T] of [
    [2.0, 1e-3, 0.030, 0.20, 1200],
    [0.5, 5e-3, 0.045, 0.05, 250],
    [6.0, 1e-3, 0.035, 0.30, 3000],
  ]) {
    const uN = Math.pow(h0, 2 / 3) * Math.sqrt(S) / n;
    const sim = new ShallowWater({ nx: 8, ny: 4, dx: 20, bed: () => 0, eta0: h0, manning: n });
    sim.boundaries = { west: periodic, east: periodic, south: periodic, north: periodic };
    // Body force g*h*S per unit mass: the along-bed component of gravity for a
    // small slope. G is the literal above, so a solver whose gravity has been
    // changed no longer balances this and the check goes red.
    sim.forcing = (s, step) => {
      for (let j = 0; j < s.ny; j++) {
        for (let i = 0; i < s.nx; i++) { const k = s.idx(i, j); s.hu[k] += G * s.h[k] * S * step; }
      }
    };
    while (sim.t < T) sim.step(Math.min(dt, T - sim.t));
    const k = sim.idx(3, 2);
    const u = sim.vel(sim.hu[k], sim.h[k]);
    const bias = Math.sqrt(1 + dt * G * n * n * u / Math.pow(h0, 4 / 3)) - 1;
    const deficit = 1 - Math.tanh(G * S * T / uN);
    check(`normal depth h=${h0} m S=${S} n=${n}`, u, uN, 5e-3,
      `err ${(100 * (u / uN - 1)).toFixed(4)}%, splitting bias ${(100 * bias).toFixed(4)}%, approach deficit ${deficit.toExponential(1)}`);
    assert(`  ...and the depth never moved (h - h0 = ${sim.h[k] - h0})`, sim.h[k] === h0);
  }

  // -----------------------------------------------------------------------
  // (b) EXACT SPIN-DOWN. With no forcing, the semi-implicit update
  //         hu <- hu / (1 + dt g n^2 |u| / h^(4/3))
  // telescopes EXACTLY, for any dt:
  //         1/u_{k+1} = (1 + dt A u_k)/u_k = 1/u_k + dt A,     A = g n^2/h^(4/3)
  //     =>  1/u - 1/u0 = A t                                   (exactly, not to O(dt))
  //
  // This is the check that pins the discretisation rather than the coefficient.
  // Both of the mutations that matter here are invisible to every other test in
  // the tree AND to check (a) above:
  //   - an explicit update, hu -= dt*A*|u|*hu, satisfies the identity only to
  //     O(dt): measured on a scratch copy, it misses by 22% in the first case
  //     below, where dt*A*u0 = 0.50.
  //   - the wrong depth exponent (h^(1/3) for h^(4/3)) still gives a perfectly
  //     plausible-looking decay, and still passes (a) if the coefficient is
  //     re-tuned. Here it is off by a factor of h.
  //
  // TOLERANCE. In exact arithmetic the identity holds to the last bit. The only
  // error is the ~1 ulp per step in vel()'s square root, amplified by the
  // cancellation in 1/u - 1/u0; measured over 200 steps that is 1.7e-15 and
  // 1.2e-13 for the two cases. 1e-10 leaves three orders of headroom over the
  // worse of them and eight orders under the smallest mutation above.
  console.log('\n  (b) spin-down: 1/u - 1/u0 = g n^2 t / h^(4/3), exactly\n');
  for (const [h0, n, u0] of [[0.2, 0.05, 3.0], [1.5, 0.03, 2.0]]) {
    const A = G * n * n / Math.pow(h0, 4 / 3);
    const sim = new ShallowWater({ nx: 8, ny: 4, dx: 5, bed: () => 0, eta0: h0, manning: n });
    sim.boundaries = { west: periodic, east: periodic, south: periodic, north: periodic };
    uniform(sim, h0, u0, 0);
    const k = sim.idx(3, 2);
    let worst = 0, dt = 0;
    for (let s = 0; s < 200; s++) {
      dt = sim.step();
      const u = sim.vel(sim.hu[k], sim.h[k]);
      const rel = Math.abs((1 / u - 1 / u0) - A * sim.t) / (A * sim.t);
      if (rel > worst) worst = rel;
    }
    const uf = sim.vel(sim.hu[k], sim.h[k]);
    check(`spin-down identity, h=${h0} m n=${n}`, worst, 0, 1e-10,
      `worst of 200 steps; u ${u0} -> ${fmt(uf)} m/s, stiffness dt*A*u0 = ${fmt(dt * A * u0)}`);
  }
}

// ===========================================================================
console.log('\n=== 3. wetting and drying: mass ====================================\n');
// ===========================================================================
//
// The positivity limiter and dryClean() are the two places in this solver that
// are allowed to touch water without a flux to account for it, and nothing else
// in the tree exercises either: verify.mjs section 2's basin never dries, so no
// cell is ever floored and theta is 1 everywhere for the whole run.
//
// Two claims about the runs, and the second is the one that matters:
//   - the volume in a closed box is constant to roundoff, AND
//   - sim.massFloored is zero. The solver accumulates, per step, the water it
//     had to INVENT by flooring a negative depth back to zero. If that is ever
//     non-zero then the volume is only conserved because the flooring topped it
//     back up, and the first claim is being satisfied by an accident. Checking
//     the drift alone would not notice. Confirmed red: with friction integrated
//     explicitly instead of semi-implicitly, both runs below floor mass (1.7e-15
//     and 2.2e-19 kg/rho) while the drift check is still reading NaN.
//     Its blind spot, stated so nobody trusts it further than it goes: it reads
//     what dryClean() reports. A dryClean() that floored silently -- dropping
//     the `added -=` and keeping the `h = 0` -- passes this file untouched,
//     because in a healthy run there is nothing to report in the first place.
//
// Each run also reports how many cells were dry and how many changed state, so
// that a future edit which quietly stops the beach from drying turns these into
// vacuous checks LOUDLY rather than silently.
//
// AND A NEGATIVE RESULT, recorded so that nobody has to find it twice: THE
// POSITIVITY LIMITER NEVER FIRES IN A STABLE RUN. Both runs below report the
// number of cells it clipped and both report zero. So does a 1200-cell dry-bed
// dam break at dx = 0.5 m; so does a dam break onto a 2 mm film; so does a 2D
// circular column collapse; so does a bore climbing a 1:8 slope; so do all of
// those at first order; and so do the 1D cases at cfl = 0.7, 0.9 and 1.1. The
// first configuration that clips anything is cfl = 1.4, which has already blown
// up (max speed 8e47 m/s at step 70). The slope-zeroing at wet/dry fronts drops
// the front to first order, and a first-order upwind flux inside the CFL
// condition simply cannot over-draw a cell.
//
// That makes the limiter unreachable from any run-based test, so part (c) tests
// it directly instead, with a step the solver would never take.
//
// STEP BUDGETS. Every loop here is capped at a step count derived from the
// analytic maximum speed, and the cap is asserted. This is a hang guard, not a
// physics check: a solver whose shoreline velocities blow up gets a vanishing
// CFL step, and would otherwise spin for hours instead of failing. Measured
// with vel() replaced by a raw hu/h, the 2D case below stops advancing and the
// cap is what turns that into a FAIL.
{
  // (a) dam break onto a dry bed, closed box.
  {
    const nx = 400, dx = 2.5, h0 = 3, T = 60;
    const c0 = Math.sqrt(G * h0);
    // Ritter: the dry-bed release keeps u + 2c = 2 c0, so |u| <= 2 c0 and
    // c <= c0 -- until the front reflects off the east wall and piles up, for
    // which this allows a factor of 2. Measured, the run takes 580 steps.
    const dtMin = 0.45 / (2 * ((2 * c0 + c0) / dx + c0 / dx));
    const BUDGET = Math.ceil(T / dtMin);

    const sim = new ShallowWater({
      nx, ny: 1, dx, bed: () => 0, eta0: (x) => (x < 400 ? h0 : 0), manning: 0.02,
    });
    sim.boundaries = { west: reflect, east: reflect, south: reflect, north: reflect };
    const v0 = sim.volume();
    let floored = 0, steps = 0, maxDry = 0, finite = true, clips = 0;
    const wasDry = new Set();
    for (let i = 0; i < nx; i++) if (sim.h[sim.idx(i, 0)] <= sim.minDepth) wasDry.add(i);
    const dry0 = wasDry.size;
    let rewet = 0;
    while (sim.t < T && steps < BUDGET) {
      sim.step(Math.min(sim.maxDt(), T - sim.t));
      steps++;
      floored += sim.massFloored;
      clips += countClips(sim);
      if (!sim.finite()) { finite = false; break; }
      if (steps % 5 === 0) {
        let d = 0;
        for (let i = 0; i < nx; i++) {
          if (sim.h[sim.idx(i, 0)] <= sim.minDepth) d++;
          else if (wasDry.delete(i)) rewet++;
        }
        if (d > maxDry) maxDry = d;
      }
    }
    assert('dam break: run completed inside the analytic step budget', steps < BUDGET && sim.t >= T,
      `${steps} steps of ${BUDGET} allowed, reached t = ${fmt(sim.t)} of ${T} s`);
    assert('dam break stays finite', finite);
    check('dam break: volume drift, closed box', (sim.volume() - v0) / v0, 0, 1e-12,
      `${maxDry} of ${nx} cells dry at once, ${rewet} of ${dry0} initially-dry cells re-wetted`);
    assert('dam break: no mass invented by flooring', floored === 0,
      `total floored mass ${floored}`);
    assert('dam break: the dry bed was actually exercised', dry0 > 50 && rewet > 50,
      `${dry0} dry at t=0, ${rewet} re-wetted -- if either is 0 the check above is vacuous`);
    console.log(`        positivity limiter clipped ${clips} cell-steps of ${steps * nx} (measured, not asserted -- see (c))`);
  }

  // (b) 2D run-up on a sloping beach with an alongshore-varying bed, closed box.
  {
    const nx = 120, ny = 60, dx = 5, dy = 5, T = 90;
    const ETA0 = 2.5, BMIN = -8.6;
    const bed = (x, y) => -8.6 + 12 * Math.max(0, x - 250) / 400 + 0.6 * Math.sin(y * 0.02);
    const Hmax = ETA0 - BMIN;                       // deepest water column at t = 0
    const uB = 2 * Math.sqrt(G * Hmax), cB = Math.sqrt(G * Hmax);
    const dtMin = 0.45 / ((uB + cB) / dx + cB / dy);
    const BUDGET = Math.ceil(T / dtMin);            // measured: the run takes 819

    const sim = new ShallowWater({
      nx, ny, dx, dy, bed, eta0: (x) => (x < 180 ? ETA0 : 0), manning: 0.025,
    });
    sim.boundaries = { west: reflect, east: reflect, south: reflect, north: reflect };
    const v0 = sim.volume();
    const wasDry = new Set();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (sim.h[sim.idx(i, j)] <= sim.minDepth) wasDry.add(j * nx + i);
    const dry0 = wasDry.size;
    let floored = 0, steps = 0, maxDry = 0, rewet = 0, finite = true, maxSpd = 0, clips = 0;
    while (sim.t < T && steps < BUDGET) {
      sim.step(Math.min(sim.maxDt(), T - sim.t));
      steps++;
      floored += sim.massFloored;
      clips += countClips(sim);
      if (!sim.finite()) { finite = false; break; }
      if (steps % 10 === 0) {
        let d = 0;
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const c = j * nx + i;
            if (sim.h[sim.idx(i, j)] <= sim.minDepth) d++;
            else if (wasDry.delete(c)) rewet++;
          }
        }
        if (d > maxDry) maxDry = d;
        maxSpd = Math.max(maxSpd, sim.maxSpeed());
      }
    }
    assert('run-up 2D: run completed inside the analytic step budget', steps < BUDGET && sim.t >= T,
      `${steps} steps of ${BUDGET} allowed, reached t = ${fmt(sim.t)} of ${T} s`);
    assert('run-up 2D stays finite', finite);
    check('run-up 2D: volume drift, closed box', (sim.volume() - v0) / v0, 0, 1e-12,
      `${maxDry} of ${nx * ny} cells dry at once, ${rewet} of ${dry0} re-wetted, max speed ${fmt(maxSpd)} m/s`);
    assert('run-up 2D: no mass invented by flooring', floored === 0,
      `total floored mass ${floored}`);
    assert('run-up 2D: the shoreline actually moved', dry0 > 500 && rewet > 500,
      `${dry0} dry at t=0, ${rewet} re-wetted`);
    console.log(`        positivity limiter clipped ${clips} cell-steps of ${steps * nx * ny} (measured, not asserted -- see (c))`);
  }

  // -----------------------------------------------------------------------
  // (c) THE POSITIVITY LIMITER, TESTED DIRECTLY.
  //
  // Since no stable run reaches it (see the note above), reach it on purpose:
  // take one residual with a step five times the CFL limit, over a state built
  // to over-draw -- shallow water diverging at 9 m/s, so the cells in the middle
  // are draining out of BOTH faces at once.
  //
  // residual(dt) uses dt for exactly one thing, sizing theta, so h + dt*rh is
  // precisely the forward-Euler stage the solver would take. The property being
  // tested is the one the limiter exists to guarantee and is exact: NO CELL MAY
  // END A STAGE WITH NEGATIVE DEPTH. Measured, the limiter empties the worst
  // cells to exactly 0.0 -- it scales the outflow by the factor that just empties
  // them, so zero is the designed answer, and the tolerance below is roundoff in
  // the flux sum (at 30x the CFL step the worst cell reaches -1.1e-16).
  //
  // This is a deliberately over-large step and NOT a claim about a real run.
  {
    const nx = 40, dx = 2, h0 = 0.5, USPLIT = 9;
    const sim = new ShallowWater({ nx, ny: 1, dx, bed: () => 0, eta0: h0, manning: 0 });
    sim.boundaries = { west: reflect, east: reflect, south: reflect, north: reflect };
    for (let i = 0; i < nx; i++) {
      const k = sim.idx(i, 0);
      sim.h[k] = h0; sim.hu[k] = h0 * (i < nx / 2 ? -USPLIT : USPLIT);
    }
    const dt = 5 * sim.maxDt();
    sim.applyBC();
    sim.residual(dt);
    let clipped = 0, minTheta = 1, minH = Infinity;
    for (let i = 0; i < nx; i++) {
      const k = sim.idx(i, 0);
      if (sim.theta[k] < 1) { clipped++; minTheta = Math.min(minTheta, sim.theta[k]); }
      minH = Math.min(minH, sim.h[k] + dt * sim.rh[k]);
    }
    assert('positivity: the limiter was actually needed here', clipped > 0,
      `${clipped} of ${nx} cells clipped, worst theta ${fmt(minTheta)} at dt = ${fmt(dt)} s (5x the CFL step)`);
    assert('positivity: no cell ends the stage with negative depth', minH >= -1e-15,
      `min(h + dt*rh) = ${minH === 0 ? '0' : minH.toExponential(3)} m`);
  }
}

// ===========================================================================
console.log('\n=== 4. the desingularised velocity vel() ===========================\n');
// ===========================================================================
//
// vel() has to do two incompatible-sounding things: be EXACTLY hu/h wherever
// the water is deep enough to mean anything, and stay finite where it is not.
// Dividing by max(h, eps) would satisfy the second and quietly fail the first,
// biasing every shallow cell's velocity low.
{
  // (a) EXACTNESS. For h above minDepth the Kurganov-Petrova formula reduces
  // algebraically to hu/h; all that is left is the rounding of one sqrt.
  {
    const sim = new ShallowWater({ nx: 4, ny: 4, dx: 1, bed: () => -1, eta0: 0 });
    let worst = 0, at = null;
    for (const h of [1.01e-3, 1e-2, 0.1, 0.5, 1, 3.7, 12, 100, 1e3]) {
      for (const u of [-9.3, -0.4, 1e-6, 0.7, 5, 40]) {
        const got = sim.vel(h * u, h);
        const rel = Math.abs(got - u) / Math.abs(u);
        if (rel > worst) { worst = rel; at = [h, u]; }
      }
    }
    // 1 ulp is 2.2e-16; two roundings in the sqrt and the divide is 4 ulp.
    check('vel() equals hu/h for h > minDepth', worst, 0, 1e-15,
      `worst over 54 (h,u) pairs, at h = ${at[0]} m, u = ${at[1]} m/s -- 4 ulp is ${fmt(4 * Number.EPSILON)}`);
  }

  // (b) BOUNDEDNESS. With hu held FIXED while h -> 0, raw hu/h diverges. The
  // regularisation has an analytic ceiling: sqrt(2) h hq / sqrt(h^4 + max(h^4,
  // eps^4)) is largest at h = eps, where it equals hq/eps, and falls linearly
  // to zero below that. So |vel| <= |hq|/minDepth, everywhere, always.
  {
    const sim = new ShallowWater({ nx: 4, ny: 4, dx: 1, bed: () => -1, eta0: 0, minDepth: 1e-3 });
    const hq = 2e-3;
    let peak = 0, raw = 0;
    for (let e = 0; e <= 60; e++) {
      const h = Math.pow(10, -e / 2);
      peak = Math.max(peak, Math.abs(sim.vel(hq, h)));
      raw = Math.max(raw, Math.abs(hq / h));
    }
    assert('vel() stays bounded as h -> 0', peak <= hq / sim.minDepth + 1e-15,
      `peak ${fmt(peak)} m/s against the analytic ceiling hq/minDepth = ${fmt(hq / sim.minDepth)}; raw hu/h reaches ${fmt(raw)} m/s over the same sweep`);
    // The h = 0 case is the whole ballgame -- see (c). It is also the ONLY
    // thing separating this formula from the max(h, eps) shortcut its docstring
    // warns against: measured on a scratch copy, `hq / Math.max(h, minDepth)`
    // fails this one assertion and nothing else in the file, because dryClean()
    // has already zeroed the momentum of every cell where the two differ. The
    // documented bias on shallow cells is real arithmetic but unreachable here.
    assert('vel() -> 0 rather than diverging at h = 0', sim.vel(hq, 0) === 0,
      `vel(${hq}, 0) = ${sim.vel(hq, 0)}, where hu/h is 0/0 = NaN`);
  }

  // (c) A RUN-UP THAT NEEDS IT.
  //
  // Measured on a scratch copy with vel() replaced by `return hq / h`: this case
  // goes non-finite in ONE step. The mechanism is exact, and worth writing down
  // because it is much narrower than the docstring suggests. dryClean() has
  // already zeroed the momentum of every cell at or below minDepth, so hu/h and
  // vel() return the same double everywhere EXCEPT at h == 0 exactly, where
  // hu/h is 0/0. The single unguarded call is the interface reconstruction in
  // residual(), which reads vel() from a dry neighbour across every wet/dry
  // face. So the desingularisation is load-bearing at exactly one value of h.
  //
  // WHICH DRY CELLS, THOUGH -- this cost the first version of this check. A dry
  // BEACH, where the bed stands above the water line, does not do it: the
  // hydrostatic reconstruction measures both sides against the higher bed, gets
  // zero on both, and hllc() returns before the NaN is used. It takes a dry BED
  // at or below the water surface, which is what the dam break below runs out
  // over before it ever reaches the slope. A run-up test built on a beach alone
  // passes with vel() deleted.
  //
  // The asserted physics is Ritter's Riemann invariant: a dry-bed release from
  // a still column of depth H keeps u + 2c = 2 sqrt(gH), so no water anywhere
  // can exceed 2 sqrt(gH). Friction and the climb only lower it.
  {
    const nx = 300, dx = 4, T = 70;
    const H = 4;                                   // depth behind the dam
    const bed = (x) => (x < 500 ? 0 : (x - 500) / 25);   // dry flat, then 1:25 beach
    const sim = new ShallowWater({
      nx, ny: 1, dx, bed, eta0: (x) => (x < 300 ? H : 0), manning: 0.02,
    });
    sim.boundaries = { west: reflect, east: reflect, south: reflect, north: reflect };
    const uB = 2 * Math.sqrt(G * H), cB = Math.sqrt(G * H);
    const BUDGET = Math.ceil(T / (0.45 / ((uB + cB) / dx + cB / dx)));
    let steps = 0, finite = true, maxSpd = 0, runup = -Infinity, dryFlat = 0;
    for (let i = 0; i < nx; i++) {
      if (sim.h[sim.idx(i, 0)] === 0 && bed((i + 0.5) * dx) <= 0) dryFlat++;
    }
    while (sim.t < T && steps < BUDGET) {
      sim.step(Math.min(sim.maxDt(), T - sim.t));
      steps++;
      if (!sim.finite()) { finite = false; break; }
      maxSpd = Math.max(maxSpd, sim.maxSpeed());
      for (let i = nx - 1; i >= 0; i--) {
        if (sim.depth(i, 0) > sim.minDepth) { runup = Math.max(runup, bed((i + 0.5) * dx)); break; }
      }
    }
    assert('run-up 1D: the dry BED the mutation needs is present', dryFlat >= 40,
      `${dryFlat} cells start at h = 0 with the bed at or below the water surface (the 200 m flat between the dam and the beach)`);
    assert('run-up 1D: completed inside the analytic step budget', steps < BUDGET && sim.t >= T,
      `${steps} steps of ${BUDGET} allowed, reached t = ${fmt(sim.t)} of ${T} s`);
    assert('run-up 1D stays finite', finite);
    assert('run-up 1D: no water exceeds the Riemann bound 2 sqrt(g H)', maxSpd <= uB,
      `max speed ${fmt(maxSpd)} m/s against 2 sqrt(g*${H}) = ${fmt(uB)} m/s`);
    console.log(`        highest bed elevation reached by the tongue: ${fmt(runup)} m (measured, no analytic target)`);
  }
}

// ===========================================================================
console.log('\n=== 5. 2D isotropy: the transpose test =============================\n');
// ===========================================================================
//
// The x-sweep and the y-sweep share one Riemann solver, called with the
// components swapped and swapped back. That swap is the only thing making the
// two directions equivalent, and no single-axis test can see it.
//
// So: run a problem, run its exact mirror image about the line y = x, and
// require the two solutions to be transposes of each other. Nothing about the
// answer needs to be known in advance -- the target is the symmetry of the
// equations themselves, which is exact.
//
// The two runs are driven with the SAME step sequence, taken from run A, so
// that any difference is in the residual and not in the CFL controller.
//
// The bed and the initial state are deliberately NOT symmetric about y = x --
// the control below measures how different the two runs actually are, because a
// transpose test on a symmetric problem passes no matter what is broken.
{
  const n = 64, d = 6, STEPS = 200;
  const bedA = (x, y) => -6 + 1.8 * Math.sin(x * 0.011) + 1.1 * Math.cos(y * 0.019)
    + 2.2 * Math.exp(-(((x - 150) / 70) ** 2) - (((y - 260) / 50) ** 2));
  const etaA = (x, y) => 0.4 * Math.exp(-(((x - 90) / 60) ** 2) - (((y - 300) / 90) ** 2))
    - 0.25 * Math.exp(-(((x - 320) / 80) ** 2) - (((y - 120) / 70) ** 2));
  const build = (T) => {
    const sim = new ShallowWater({
      nx: n, ny: n, dx: d, dy: d,
      bed: T ? (x, y) => bedA(y, x) : bedA,
      eta0: T ? (x, y) => etaA(y, x) : etaA,
      manning: 0.02,
    });
    sim.boundaries = { west: reflect, east: reflect, south: reflect, north: reflect };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = sim.idx(i, j);
        // The mirrored run's velocity has to be mirrored TWICE: the components
        // swap AND the point they are evaluated at reflects about y = x. Getting
        // only the first half right cost the first version of this check a
        // 0.53 m disagreement that looked exactly like a solver bug.
        const x = T ? (j + 0.5) * d : (i + 0.5) * d;
        const y = T ? (i + 0.5) * d : (j + 0.5) * d;
        const u = 0.6 * Math.sin(x * 0.008), v = -0.35 * Math.cos(y * 0.013);
        sim.hu[k] = sim.h[k] * (T ? v : u);
        sim.hv[k] = sim.h[k] * (T ? u : v);
      }
    }
    return sim;
  };
  const A = build(false), B = build(true);
  const dts = [];
  for (let s = 0; s < STEPS; s++) dts.push(A.step());
  for (const dt of dts) B.step(dt);

  let dh = 0, dm = 0, plain = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = A.idx(i, j), b = B.idx(j, i), bSame = B.idx(i, j);
      dh = Math.max(dh, Math.abs(A.h[a] - B.h[b]));
      dm = Math.max(dm, Math.abs(A.hu[a] - B.hv[b]), Math.abs(A.hv[a] - B.hu[b]));
      plain = Math.max(plain, Math.abs(A.h[a] - B.h[bSame]));
    }
  }
  assert('transpose: the two runs are genuinely different problems', plain > 0.01,
    `max |h_A - h_B| WITHOUT transposing = ${fmt(plain)} m -- this is the control that stops the test below being vacuous`);
  // TOLERANCES. The x and y accumulations reach each cell in a different order,
  // so the two runs differ by floating-point summation order and by nothing
  // else. Measured after 200 steps on water ~6 m deep: 8.9e-15 in the depth and
  // 1.5e-13 in the momentum, which is a factor of h larger and passes through
  // two flux sums rather than one. The tolerances are ~100x and ~65x those.
  // A real y-sweep bug -- dropping the component swap in the call to hllc() --
  // moves both to O(1); nothing produces an answer in between.
  check('transpose: max |h_A - transpose(h_B)|', dh, 0, 1e-12,
    `after ${STEPS} steps on a ${n}x${n} grid`);
  check('transpose: max |hu_A - transpose(hv_B)|', dm, 0, 1e-11);
}

// ===========================================================================
console.log('\n=== 6. the HLLC contact wave ========================================\n');
// ===========================================================================
//
// HLLC's whole advantage over HLL is the middle wave: the contact
// discontinuity, which in the shallow-water equations carries the TRANSVERSE
// momentum. Delete it and refraction comes out weak, an oblique wave train
// bleeds its along-crest velocity, and every existing check stays green --
// replacing
//     out[2] = out[0] * (sM >= 0 ? vL : vR)      with      out[0] * vL
// produces zero failures anywhere else in the tree.
//
// Both cases below set up a uniform depth and a uniform NORMAL velocity, with
// the transverse velocity varying along the flow. The transverse component is
// then exactly passive: h and the normal velocity stay uniform (measured, bit
// for bit, to the end of the run), and the exact solution is the initial
// transverse profile translated at the normal velocity. Anything that happens
// to the profile is the contact wave being resolved or not.
//
// THE FLOW RUNS BACKWARDS, deliberately: u0 < 0, so the correct upwind side is
// the RIGHT one and `out[0] * vL` is the downwind state. With u0 > 0 that
// mutation is exactly equivalent to the real thing and invisible. The flow is
// also strongly subcritical, |u0|/c = 0.19, which is what separates HLLC from
// HLL: HLLC's transverse diffusion goes with the contact speed |u0|, HLL's with
// the gravity-wave speed c.
{
  const h0 = 4, U0 = -1.2, V = 0.4, L = 240, N = 120, LAPS = 1;
  const T = LAPS * L / Math.abs(U0);

  // A fixed step, sized once from the initial CFL number. Fixed because an
  // unstable transverse flux otherwise drives dt to zero and the test hangs
  // instead of failing; measured, `out[0] * vL` never finishes at all with an
  // adaptive step.
  const stepper = (sim) => {
    const dtc = sim.maxDt();
    const ns = Math.ceil(T / (0.95 * dtc));
    return { dt: T / ns, ns, dtc };
  };

  // (a) x-sweep, a top-hat of transverse velocity: does the contact stay SHARP?
  {
    const dx = L / N, ny = 4;
    const sim = new ShallowWater({ nx: N, ny, dx, bed: () => -h0, eta0: 0, manning: 0 });
    sim.boundaries = { west: periodic, east: periodic, south: periodic, north: periodic };
    const vf = (x) => (((x % L) + L) % L > L / 4 && ((x % L) + L) % L < 3 * L / 4) ? V : -V;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < N; i++) {
        const k = sim.idx(i, j);
        sim.h[k] = h0; sim.hu[k] = h0 * U0; sim.hv[k] = h0 * vf((i + 0.5) * dx);
      }
    }
    const { dt, ns, dtc } = stepper(sim);
    for (let s = 0; s < ns; s++) sim.step(dt);

    let smeared = 0, over = 0, l1 = 0, drift = 0;
    for (let i = 0; i < N; i++) {
      const k = sim.idx(i, 2), x = (i + 0.5) * dx;
      const v = sim.vel(sim.hv[k], sim.h[k]);
      if (Math.abs(v) < 0.8 * V) smeared++;
      over = Math.max(over, Math.abs(v) - V);
      l1 += Math.abs(v - vf(x - U0 * sim.t)) / V;
      drift = Math.max(drift, Math.abs(sim.h[k] - h0), Math.abs(sim.vel(sim.hu[k], sim.h[k]) - U0));
    }
    assert('contact: h and u stayed uniform, so v really is passive', drift === 0,
      `max departure ${drift} after ${ns} steps of dt = ${fmt(dt)} s (CFL limit ${fmt(dtc)} s)`);
    // A passively advected scalar cannot exceed its own initial range. This is
    // a maximum principle, not a tolerance: measured overshoot is exactly 0.
    assert('contact: no overshoot of the transverse profile', over <= 1e-12,
      `max |v| - ${V} = ${fmt(over)} m/s`);
    // THRESHOLD. Cells with |v| below 80% of the plateau, i.e. the width of the
    // two transitions in cells. Measured after one traversal of the domain:
    // 12 with the HLLC contact, 20 with an HLL transverse flux
    // (out[2] = (sR*FLs[2] - sL*FRs[2] + sL*sR*(hvR - hvL))/(sR - sL)) pasted
    // into hllc() on a scratch copy. 16 sits between them.
    assert('contact stays sharp: transition width', smeared < 16,
      `${smeared} of ${N} cells inside the transitions; HLL-like smearing measures 20`);
    check('contact: L1 against the exact translated profile', l1 / N, 0, 0.08,
      `HLL measures 0.095 on the same run`);
  }

  // (b) y-sweep, a sine: does the AMPLITUDE survive? This is the half of the
  // Riemann solver that is reached only through the component swap.
  {
    const dy = L / N, nx = 4;
    const sim = new ShallowWater({ nx, ny: N, dx: dy, bed: () => -h0, eta0: 0, manning: 0 });
    sim.boundaries = { west: periodic, east: periodic, south: periodic, north: periodic };
    // Two cycles across the domain, i.e. 60 cells per wavelength. ONE cycle
    // damps too little to tell a good transverse flux from a bad one: measured,
    // HLLC kept 0.99986 of the amplitude and HLL 0.99936, and no tolerance
    // worth defending fits between them. Halving the wavelength multiplied the
    // loss by 18.7 for HLLC and 16.9 for HLL -- a scheme this far above first
    // order damps far faster than the k^2 of plain diffusion -- which leaves
    // the ratio between them intact at 4.1x while opening the absolute gap.
    const kw = 4 * Math.PI / L;
    const uf = (y) => V * Math.sin(kw * y);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < nx; i++) {
        const k = sim.idx(i, j);
        sim.h[k] = h0; sim.hv[k] = h0 * U0; sim.hu[k] = h0 * uf((j + 0.5) * dy);
      }
    }
    const { dt, ns } = stepper(sim);
    for (let s = 0; s < ns; s++) sim.step(dt);

    let a = 0, b = 0;
    for (let j = 0; j < N; j++) {
      const k = sim.idx(2, j), y = (j + 0.5) * dy;
      const u = sim.vel(sim.hu[k], sim.h[k]);
      const ph = kw * (y - U0 * sim.t);
      a += u * Math.sin(ph); b += u * Math.cos(ph);
    }
    a *= 2 / N; b *= 2 / N;
    const amp = Math.hypot(a, b) / V, phase = Math.atan2(b, a);
    // The exact answer is amplitude 1 and phase 0: pure translation, no
    // distortion of any kind. TOLERANCE: measured, the amplitude loss is
    // 2.64e-3 with the HLLC contact and 1.08e-2 with an HLL transverse flux, so
    // 6e-3 sits between them -- 2.3x above what the scheme costs, 1.8x below
    // what losing the contact costs. out[0]*vL does not survive the run at all.
    check('contact: transverse amplitude after one traversal', amp, 1, 6e-3,
      `exact answer is 1 -- pure translation; HLL measures 0.98919 here`);
    // The phase is an exactness check on the translation speed, not a
    // discriminator between flux functions: HLL gets the phase right too.
    check('contact: transverse phase error', phase, 0, 0.02,
      `${fmt(phase)} rad after one traversal`);
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} -- ${checks - failures}/${checks} checks\n`);
process.exit(failures ? 1 : 0);
