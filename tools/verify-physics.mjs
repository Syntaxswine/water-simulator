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
//   node tools/verify-physics.mjs        (9-12 s; see below)
//
// RUNTIME, measured 2026-08-14 as four interleaved pairs against the 43-check
// version this grew out of: 8144, 8599, 11322, 8317 ms then, 10964, 11770,
// 11129, 10574 ms now. The spread on this machine is wider than the difference
// is interesting, so the honest figure is the minimum of the pairs, 8.1 s
// against 10.6 s -- sections 7 and 10 cost about two and a half seconds
// between them, nearly all of it the two seiche and channel runs.
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
//
// All five of those are FRICTION checks, though, and that is a hole rather than
// a result: gravity also sets the pressure flux, the wave speeds and the CFL
// step, and a scratch copy with 1.23*G in all of those and the honest constant
// in applyFriction() passes this file 43/43. Section 7 was added for that, and
// measures g from the period of a standing wave instead of reading it.
//
// SECTIONS 7-10 WERE ADDED 2026-08-14 after a mutation audit found five holes:
// a one-sided positivity check (3c), gravity read rather than measured (7), an
// unpinned CFL step (8), an unpinned HLL wave-speed estimate (9), and no
// coverage at all of outflow() or makeSponge() (10). They are appended rather
// than slotted in among 1-6 so that the older sections keep their numbers.
// ---------------------------------------------------------------------------

import { ShallowWater, hllc, reflect, periodic, outflow, makeSponge } from '../src/swe.mjs';

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
// That makes the limiter unreachable from any run-based test, so parts (c) and
// (d) test it directly instead, with a step the solver would never take.
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

  // -----------------------------------------------------------------------
  // (d) AND TIGHT, NOT MERELY SAFE.
  //
  // Everything in (c) is ONE-SIDED. It asserts that no cell ends the stage
  // below zero, which catches a limiter that lets too much water out and
  // cannot, even in principle, catch one that lets too little. Measured
  // 2026-08-14 on a scratch copy with theta halved -- `0.5 * avail / (out*dt)`,
  // so a cell that should drain to exactly zero keeps a quarter metre of water:
  //
  //   PASS  positivity: the limiter was actually needed here
  //         38 of 40 cells clipped, worst theta 0.331573 ...
  //   PASS  positivity: no cell ends the stage with negative depth
  //         min(h + dt*rh) = 2.500e-1 m
  //   ALL PASS -- 43/43 checks
  //
  // Both guards stay green and so does the whole file. On a beach that mutation
  // is a limiter silently damping drainage and run-up, which is the failure
  // this solver can least afford.
  //
  // This part also catches `theta-left-only`, which tools/mutants.mjs lists as
  // a known survivor: measured against that file's own patch, the draining cell
  // ends the stage at -1.250e-1 m and its neighbours hold 0.625 m of the 0.5 m
  // it released, 2 FAILURES and 73/75. That table needs editing too, and again
  // not from here.
  //
  // (c)'s rig cannot be made two-sided as it stands. 38 of its 40 cells are
  // draining and being refilled at the same time, so their stage-end depth is
  // whatever flowed IN, not zero, and nothing outside the solver can separate
  // the two. So build a cell with no inflow at all: ONE wet cell in a dry row.
  // The neighbours are dry and have nothing to give it, it drains out of both
  // faces, and the answer is then exact -- at a step big enough to over-draw
  // it, it must end the stage at EXACTLY zero, and its two neighbours must hold
  // exactly what it started with.
  //
  // The scale factor is exact too, and this is the part that pins tightness
  // rather than inferring it. Against a dry neighbour hllc() takes its dry
  // branch, sL = uL - cL and sR = uL + 2cL; with uL = 0 and F(W_dry) = 0 the
  // HLL mass flux collapses to
  //     F = sL sR (hR - hL)/(sR - sL) = 2 c h0 / 3
  // so the cell's outgoing budget is out = 2F/dx, and the factor that just
  // empties it is theta = h0/(out dt) = 3 dx/(4 c dt) -- at dt = 5 dtCFL with
  // dy = dx that is 3/(10 cfl) = 2/3, and the solver returns 0.66666666666666674
  // against 0.66666666666666663 predicted, one ulp. THAT IS THE SCHEME'S FLUX AT
  // A WET/DRY FACE, derived here from the published HLL formula and the exact
  // Ritter speeds; it is not a claim about a real dam break, and the difference
  // matters: the exact Ritter flux at the same face is 8 c h0/27, measured here
  // as 0.328051152 against the scheme's 0.738115092, 2.25 times smaller. HLL is
  // that diffusive at a dry front, which is why the limiter exists at all.
  //
  // MASS CONSERVATION CANNOT STAND IN FOR ANY OF THIS. Under the halving
  // mutation the whole row still sums to 0.50000000000000000 m, bit for bit,
  // because both sides of a face are scaled by the same factor whatever that
  // factor is -- which is why the third check below is written against what the
  // two neighbours HOLD (0.25 each, and 0.125 each under the mutation) and not
  // against the total.
  {
    const nx = 9, dx = 2, h0 = 0.5, MULT = 5, ic = 4;
    const sim = new ShallowWater({ nx, ny: 1, dx, bed: () => 0, eta0: 0, manning: 0 });
    sim.boundaries = { west: reflect, east: reflect, south: reflect, north: reflect };
    const kc = sim.idx(ic, 0);
    sim.h[kc] = h0;                                 // one wet cell, dry row
    const dt = MULT * sim.maxDt();
    const c = Math.sqrt(G * h0);
    const thetaWant = 3 * dx / (4 * c * dt);
    sim.applyBC();
    sim.residual(dt);
    const end = (i) => { const k = sim.idx(i, 0); return sim.h[k] + dt * sim.rh[k]; };
    let untouched = 0;
    for (let i = 0; i < nx; i++) {
      if (i !== ic && sim.theta[sim.idx(i, 0)] === 1) untouched++;
    }
    // 1 ulp is 2.2e-16 and that is what this measures; 1e-12 is four orders of
    // room, and still twelve orders under the smallest scaling error worth the
    // name (the halving above reads -50.000%).
    check('positivity: theta is the factor that JUST empties the cell',
      sim.theta[kc], thetaWant, 1e-12,
      `dt = ${fmt(dt)} s (${MULT}x CFL); analytic 3dx/(4 c dt) from the HLL dry-face flux 2 c h0/3 = ${fmt(2 * c * h0 / 3)} m^2/s`);
    check('positivity: the over-drawing cell ends the stage at 0', end(ic), 0, 1e-15,
      `measured exactly ${end(ic) === 0 ? '0' : end(ic).toExponential(3)} m; the same rig with theta halved leaves 2.500e-1 m`);
    check('positivity: its neighbours hold everything it lost', end(ic - 1) + end(ic + 1), h0, 1e-15,
      `${fmt(end(ic - 1))} + ${fmt(end(ic + 1))} m against ${h0} m released`);
    assert('positivity: a cell that gives nothing away is not limited',
      untouched === nx - 1,
      `${untouched} of ${nx - 1} untouched cells still have theta = 1 exactly -- a limiter that scales everything a little is caught here`);
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
    //
    // BOTH OF THESE THRESHOLDS SIT MID-BAND AND THE BAND IS NARROW, so it is
    // worth saying whether that is defensible. Re-measured 2026-08-14, both
    // fluxes, same rig, varying only the number of traversals:
    //
    //   laps   steps    HLLC L1   HLL L1   ratio    HLLC cells   HLL cells
    //     1     3305   0.066138  0.095050  1.437        12          20
    //     2     6609   0.081890  0.113552  1.387        16          22
    //     3     9914   0.093124  0.126082  1.354        18          24
    //     4    13218   0.102163  0.135852  1.330        18          26
    //     6    19827   0.116614  0.151015  1.295        22          30
    //
    // So the margin cannot be bought with a longer run: running further makes
    // the separation WORSE, because HLLC's transverse diffusion is going with
    // the contact speed the whole way while HLL's head start is fixed. One lap
    // is the best-separated member of the family, and inside it the thresholds
    // are already about as well placed as they can be -- 0.08 against a band of
    // 0.066138 to 0.095050 (the geometric middle is 0.0793), and 16 against 12
    // and 20. The margins are 21% and 25% of the band, they are DETERMINISTIC
    // (no RNG anywhere in this case, and both numbers reproduce bit for bit
    // between runs), so this is a hard margin and not a flaky one. What it does
    // mean is that a future change to the reconstruction which costs the
    // shipped scheme a fifth of its remaining sharpness will turn these red
    // without HLLC having been touched; the fix then is to re-measure the band
    // and re-place the threshold, not to widen it.
    assert('contact stays sharp: transition width', smeared < 16,
      `${smeared} of ${N} cells inside the transitions; HLL-like smearing measures 20`);
    check('contact: L1 against the exact translated profile', l1 / N, 0, 0.08,
      `HLL measures 0.095050 on the same run, so the discriminating band is 0.066 to 0.095`);
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

// ===========================================================================
console.log('\n=== 7. gravity, measured from the water rather than read off it ====\n');
// ===========================================================================
//
// Comparing the solver's EXPORTED gravity against a reference constant closes
// exactly one hole -- somebody typing 9.81 -- and cannot see a solver that
// exports 9.80665 and integrates with something else.
//
// Gravity enters this solver in four places: the hydrostatic pressure flux
// 0.5 g h^2, the HLL wave-speed estimates, maxDt()'s celerity, and the Manning
// coefficient. Only the LAST of those is pinned by anything above, and it is
// pinned hard -- section 2(b) is linear in g and holds to 1e-10, so a wrong
// gravity in applyFriction() is caught by ten orders of magnitude.
//
// Measured 2026-08-14 on a scratch copy, `export const G` left at 9.80665 and
// every INTERNAL use of the identifier replaced by 1.23*G:
//
//   internal gravity 23% high, everywhere       38/43   (the three Manning
//                                                        normal depths and both
//                                                        spin-down identities)
//   ...with applyFriction() alone reverted      43/43
//
// The second line is the hole: 23% wrong in the pressure flux, the wave speeds
// and the CFL step, and not one check in this file noticed.
//
// So measure gravity from what the water does with it. A closed flat basin
// rings in its fundamental mode at the Merian period T = 2L/sqrt(g h), which
// inverts to g = (2L/T)^2/h. The period is read off the zero crossings of the
// elevation at the west wall: no amplitude calibration, no fit, and unaffected
// by the slow numerical decay of the mode.
//
// TOLERANCE, AND IT IS A DISCRETISATION-LIMITED PLAUSIBILITY BOUND, not a
// figure from a book. Measured on this rig (L = 2000 m, h = 10 m, A = 1 mm,
// 3 periods) at three resolutions:
//
//   dx = 20 m    g = 9.808461367    +0.018471%
//   dx = 10 m    g = 9.807149595    +0.005094%   <- shipped
//   dx =  5 m    g = 9.806821757    +0.001751%
//
// The error falls by 3.6x and then 2.9x as dx halves, i.e. roughly second
// order and short of it in the way a limited scheme usually is, which is what
// says the residue is the mesh and not the solver. Amplitude matters too, and
// less: A = 1e-2 m reads +0.010915% (finite-amplitude steepening) and
// A = 1e-4 m reads +0.004514%, so of the shipped 0.005094% about 0.00058
// percentage points -- a ninth of it -- is nonlinearity and the rest is dx.
// The tolerance is 5e-4, ten times the shipped error and 460 times under the
// mutation above.
//
// Against that mutation the instrument does not merely go red, it reads the
// injected error back: g = 12.062715, +23.005% against an injected 23%.
{
  const L = 2000, h0 = 10, nx = 200, A = 1e-3, PERIODS = 3;
  const T1 = 2 * L / Math.sqrt(G * h0);            // Merian, fundamental mode
  const sim = new ShallowWater({
    nx, ny: 1, dx: L / nx, bed: () => -h0, manning: 0,
    eta0: (x) => A * Math.cos(Math.PI * x / L),    // the exact mode shape
  });
  sim.boundaries = { west: reflect, east: reflect, south: reflect, north: reflect };
  const dt = 0.9 * sim.maxDt();
  const k0 = sim.idx(0, 0);
  const eta = () => sim.b[k0] + sim.h[k0];

  let prev = eta(), prevT = sim.t, steps = 0;
  const cross = [];
  while (sim.t < PERIODS * T1) {
    sim.step(dt);
    steps++;
    const e = eta();
    // Linear interpolation between the two samples that straddle zero. The
    // elevation is smooth on the scale of dt (one period is ~1975 steps).
    if ((prev > 0 && e <= 0) || (prev < 0 && e >= 0)) cross.push(prevT + dt * prev / (prev - e));
    prev = e; prevT = sim.t;
  }
  assert('gravity: the basin rang at all', cross.length >= 4,
    `${cross.length} zero crossings at the west wall in ${steps} steps (measured 6: two per period, ${PERIODS} periods)`);

  const T = 2 * (cross[cross.length - 1] - cross[0]) / (cross.length - 1);
  const gMeas = (2 * L / T) ** 2 / h0;
  check('gravity recovered from the long-wave period', gMeas, G, 5e-4,
    `T = ${fmt(T)} s against 2L/sqrt(gh) = ${fmt(T1)} s, so g = ${fmt(gMeas)} m/s^2 against the literal ${G}`);
}

// ===========================================================================
console.log('\n=== 8. the CFL step ================================================\n');
// ===========================================================================
//
// Section 1 asserts `dt < sim.maxDt()`, which is one-sided: it can catch a
// limit that has grown too SMALL and can never catch one that has grown too
// large. Changing the 2D wave-speed combination from a sum to a max -- the
// classic way to get this wrong, and worth roughly a factor of two in the step
// -- passes everything. Measured 2026-08-14 on a scratch copy: 43/43, with the
// section 3 dam break finishing in 389 steps instead of 580 and the section 6
// contact run in 1746 instead of 3305. Both still look like healthy runs.
//
// So pin the limit itself against the analytic Courant condition, on a state
// built here with BOTH velocity components non-zero and dx != dy, which is what
// makes the sum and the max distinguishable at all.
//
// THE COURANT NUMBER IS READ OFF THE OBJECT rather than written as a literal,
// deliberately. This check is about the FORMULA. Whether 0.45 is the right
// number is a stability-margin question, it is answered by running the solver
// rather than by reading it, and tools/mutants.mjs carries `cfl-0.9` as a known
// survivor for exactly that reason; this section does not change that.
{
  for (const [dx, dy] of [[7, 11], [11, 7]]) {
    const h0 = 3, u0 = 1.7, v0 = -0.9;
    const sim = new ShallowWater({ nx: 6, ny: 5, dx, dy, bed: () => -h0, eta0: 0, manning: 0 });
    uniform(sim, h0, u0, v0);
    const c = Math.sqrt(G * h0);
    const sum = (Math.abs(u0) + c) / dx + (Math.abs(v0) + c) / dy;
    const mx = Math.max((Math.abs(u0) + c) / dx, (Math.abs(v0) + c) / dy);
    // Measured: bit for bit, rel 0.00e+0, in both orientations. The tolerance
    // is 1e-14 rather than 0 because vel() reaches u0 through a square root
    // (section 4a measures that at 2.8e-16 worst case), so exactness here is
    // measured and not guaranteed. The mutation it is placed against is 56.5%
    // (dx=7) and 71.7% (dx=11) away.
    check(`maxDt = cfl/((|u|+c)/dx + (|v|+c)/dy), dx=${dx} dy=${dy}`,
      sim.maxDt(), sim.cfl / sum, 1e-14,
      `cfl ${sim.cfl}; the same state with the two directions MAXed instead of summed gives ${fmt(sim.cfl / mx)} s, ${fmt(sum / mx)}x larger`);
  }

  // Dry cells do not set the step -- "over wet cells only", as the method says.
  // A puddle below minDepth carrying momentum would otherwise seize the whole
  // grid's timestep. It cannot arise in a real run, because dryClean() zeroes
  // the momentum of every such cell before the next step reads it; this asserts
  // the contract rather than a run, and it is measured against what maxDt()
  // WOULD return if the cell counted, printed beside it.
  {
    const h0 = 3, u0 = 1.7, v0 = -0.9, dx = 7, dy = 11;
    const sim = new ShallowWater({ nx: 6, ny: 5, dx, dy, bed: () => -h0, eta0: 0, manning: 0 });
    uniform(sim, h0, u0, v0);
    const dt0 = sim.maxDt();
    const k = sim.idx(2, 2), hd = 0.9 * sim.minDepth;
    sim.h[k] = hd; sim.hu[k] = hd * 100; sim.hv[k] = 0;
    const ud = sim.vel(sim.hu[k], hd), cd = Math.sqrt(G * hd);
    assert('maxDt: a cell at or below minDepth does not set the step',
      sim.maxDt() === dt0,
      `one cell at h = ${fmt(hd)} m moving ${fmt(ud)} m/s; the step stays ${fmt(dt0)} s, where counting it would give ${fmt(sim.cfl / ((ud + cd) / dx + cd / dy))} s`);
  }
}

// ===========================================================================
console.log('\n=== 9. the HLL wave-speed estimate =================================\n');
// ===========================================================================
//
// sL and sR decide how much diffusion the Riemann solver adds and whether it
// can go negative at a strong shock, and NOTHING measured them. Measured
// 2026-08-14 on scratch copies: multiplying the two-rarefaction h* estimate by
// 1.2 passes 43/43, and so does replacing the whole estimate with plain Davis
// speeds (min/max of u -+ c), which is tools/mutants.mjs's declared known
// survivor `einfeldt-davis`.
//
// HOW THE SPEEDS ARE READ OUT. hllc() does not return them, but it branches on
// them: `if (sL >= 0) return F(W_L)`. The estimate is Galilean-invariant, so
// shifting both states by a uniform velocity s shifts sL and sR by exactly s,
// and the shift at which the function switches to its early return is -sL. The
// switch is detected by out[0] === hu_L, which is a BIT comparison against the
// argument flux1D copies verbatim, not a tolerance on two computed numbers, and
// bisection then locates the edge to ~1e-16. Recovered this way the left speed
// comes back as uL - cL to 2.2e-16 relative, which is the right answer for
// these cases and a good check on the method itself.
//
// WHAT IT IS COMPARED AGAINST is the exact Riemann solution of the same two
// states, iterated below and self-checked against the Rankine-Hugoniot
// conditions and the u + 2c invariant before anything is compared to it.
//
// A NEGATIVE RESULT, recorded so nobody spends the afternoon twice: DO NOT
// COMPARE THE FLUX. The obvious test -- HLLC's flux at x/t = 0 against the
// exact flux -- ranks the mutants BACKWARDS. Measured on the 100:1 dam break
// below, mass-flux error against the exact solution: shipped +128.9%, Davis
// +67.1%, h* 20% high +141.4%. Davis scores BEST, because a fan that is too
// narrow is less diffusive -- and it is also the one that fails to enclose the
// true fan in (c) below, which is the condition the positivity guarantee rests
// on. A flux comparison measures diffusion; the question here is about
// bounding; so the check has to be on the speeds.
//
// THIS SECTION CATCHES `einfeldt-davis`, which tools/mutants.mjs lists as a
// known survivor. Measured 2026-08-14 against that file's own patch: 5
// FAILURES, 70/75. Its known-survivor table has to be edited before it
// misleads the next reader -- that is a change to tools/mutants.mjs and it is
// not made here.
{
  const vL = 0.3, vR = -0.7;         // transverse; the wave speeds ignore them

  // The exact solution. h* solves f(h,hL) + f(h,hR) + (uR - uL) = 0 with
  //   f(h,hK) = 2(sqrt(g h) - sqrt(g hK))              h <= hK   rarefaction
  //           = (h - hK) sqrt(g (h + hK)/(2 h hK))     h >  hK   shock
  // which is monotone increasing in h, so bisection cannot miss the root.
  const exact = (hL, uL, hR, uR) => {
    const cL = Math.sqrt(G * hL), cR = Math.sqrt(G * hR);
    const f = (h, hK) => (h <= hK
      ? 2 * (Math.sqrt(G * h) - Math.sqrt(G * hK))
      : (h - hK) * Math.sqrt(0.5 * G * (h + hK) / (h * hK)));
    const F = (h) => f(h, hL) + f(h, hR) + (uR - uL);
    let lo = 1e-12, hi = Math.max(hL, hR);
    while (F(hi) < 0) hi *= 2;
    for (let n = 0; n < 200; n++) { const m = 0.5 * (lo + hi); if (F(m) > 0) hi = m; else lo = m; }
    const hs = 0.5 * (lo + hi);
    const us = 0.5 * (uL + uR) + 0.5 * (f(hs, hR) - f(hs, hL));
    return {
      hs, us, cs: Math.sqrt(G * hs),
      SL: hs > hL ? uL - cL * Math.sqrt(0.5 * (hs + hL) * hs / (hL * hL)) : uL - cL,
      SR: hs > hR ? uR + cR * Math.sqrt(0.5 * (hs + hR) * hs / (hR * hR)) : uR + cR,
    };
  };

  // The shipped estimate, transcribed from the source with the LITERAL G.
  const estimate = (hL, uL, hR, uR) => {
    const cL = Math.sqrt(G * hL), cR = Math.sqrt(G * hR);
    const hStar = ((cL + cR) / 2 + (uL - uR) / 4) ** 2 / G;
    const qL = hStar > hL ? Math.sqrt(0.5 * (hStar + hL) * hStar / (hL * hL)) : 1;
    const qR = hStar > hR ? Math.sqrt(0.5 * (hStar + hR) * hStar / (hR * hR)) : 1;
    return { hStar, sL: uL - cL * qL, sR: uR + cR * qR };
  };

  const out = [0, 0, 0];
  const recover = (hL, uL, hR, uR) => {
    const leftOnly = (s) => {
      hllc(out, hL, hL * (uL + s), hL * vL, hR, hR * (uR + s), hR * vR, 1e-4);
      return out[0] === hL * (uL + s);
    };
    const rightOnly = (s) => {
      hllc(out, hL, hL * (uL - s), hL * vL, hR, hR * (uR - s), hR * vR, 1e-4);
      return out[0] === hR * (uR - s);
    };
    const edge = (pred) => {
      let lo = 0, hi = 1;
      while (!pred(hi)) { hi *= 2; if (hi > 1e9) return NaN; }
      for (let n = 0; n < 100; n++) { const m = 0.5 * (lo + hi); if (pred(m)) hi = m; else lo = m; }
      return 0.5 * (lo + hi);
    };
    return { sL: -edge(leftOnly), sR: edge(rightOnly) };
  };

  // Three Riemann problems, all of them a left rarefaction and a right shock,
  // which is asserted below rather than assumed because the self-checks that
  // follow are written for that structure.
  const CASES = [[10, 0, 0.1, 0], [10, 0, 1, 0], [1, 0, 0.9, 0]];

  // (a) THE EXACT SOLVER, SELF-CHECKED. The Rankine-Hugoniot conditions and the
  // Riemann invariant are not what the f-function above solves, so an error in
  // it -- a factor of two in the shock branch, say -- shows up here rather than
  // silently moving the target. Measured, all six residuals are at roundoff:
  // worst 3.87e-16 relative. Measured with the 0.5 dropped from the shock branch
  // of f, the three Rankine-Hugoniot residuals read 3.917%, 17.298% and 8.416%.
  for (const [hL, uL, hR, uR] of CASES) {
    const e = exact(hL, uL, hR, uR);
    const cL = Math.sqrt(G * hL);
    const tag = `hL=${hL} hR=${hR}`;
    assert(`exact solver: ${tag} is a left rarefaction over a right shock`,
      e.hs < hL && e.hs > hR, `h* = ${fmt(e.hs)} m between hR = ${hR} and hL = ${hL}`);
    // Shock speed from the MASS jump, then the momentum jump as the residual.
    const S = (e.hs * e.us - hR * uR) / (e.hs - hR);
    const mom = (e.hs * e.us * e.us + 0.5 * G * e.hs ** 2) - (hR * uR * uR + 0.5 * G * hR ** 2)
      - S * (e.hs * e.us - hR * uR);
    check(`exact solver: Rankine-Hugoniot residual, ${tag}`,
      mom / (e.hs * e.us * e.us + 0.5 * G * e.hs ** 2), 0, 1e-13,
      `shock speed ${fmt(S)} m/s from the mass jump, momentum jump as the residual`);
    check(`exact solver: u + 2c across the rarefaction, ${tag}`,
      ((uL + 2 * cL) - (e.us + 2 * e.cs)) / (uL + 2 * cL), 0, 1e-13,
      `${fmt(uL + 2 * cL)} against ${fmt(e.us + 2 * e.cs)} m/s`);
  }

  // (b) A WEAK JUMP. Every consistent estimate has to converge to the exact
  // characteristics as the jump vanishes; the question is how fast. At 10% in
  // depth the shipped estimate is already at the exact speeds to 0.001%, while
  // Davis is 1.256% out on the right-going wave (measured, same rig) because it
  // takes uL + cL and never sees the shock at all. TOLERANCE 5e-4: fifty times
  // the shipped error, twenty-five times under Davis, and it also catches an
  // h* estimate 1% high, which reads 0.757% -- measured, as is the 3.777% an h*
  // 5% high reads here, which (d) below lets through at 13.290%.
  {
    const [hL, uL, hR, uR] = CASES[2];
    const e = exact(hL, uL, hR, uR), r = recover(hL, uL, hR, uR);
    check(`weak Riemann problem hL=${hL} hR=${hR}: left speed vs exact`, r.sL, e.SL, 5e-4,
      `${fmt(r.sL)} against the exact rarefaction head ${fmt(e.SL)} m/s`);
    check(`weak Riemann problem hL=${hL} hR=${hR}: right speed vs exact`, r.sR, e.SR, 5e-4,
      `${fmt(r.sR)} against the exact shock speed ${fmt(e.SR)} m/s`);
  }

  // (c) A STRONG SHOCK, 100:1. Here the estimates genuinely differ, and the
  // property that matters is not accuracy but BOUNDING: the fan handed to the
  // HLL average must contain the true one, or the scheme can hand a cell a
  // negative depth. Measured: the exact right-going shock runs at 12.331739
  // m/s, the shipped estimate says 21.529455 (bounds it, 74.6% over), and Davis
  // says 9.902853 -- 19.7% SHORT of a wave it is supposed to enclose.
  //
  // The slack is 1e-9 of the wave speed and is the recovery's own resolution:
  // the left speed is EQUAL to the exact rarefaction head here (both are
  // uL - cL, since h* < hL leaves qL = 1) and the Galilean shift costs a ulp.
  {
    const [hL, uL, hR, uR] = CASES[0];
    const e = exact(hL, uL, hR, uR), r = recover(hL, uL, hR, uR);
    const slack = 1e-9 * Math.max(Math.abs(e.SL), Math.abs(e.SR));
    assert(`strong shock hL=${hL} hR=${hR}: sL bounds the exact left wave`,
      r.sL <= e.SL + slack,
      `sL = ${fmt(r.sL)} must not exceed the exact ${fmt(e.SL)} m/s`);
    assert(`strong shock hL=${hL} hR=${hR}: sR bounds the exact right wave`,
      r.sR >= e.SR - slack,
      `sR = ${fmt(r.sR)} against the exact shock ${fmt(e.SR)} m/s, ${(100 * (r.sR / e.SR - 1)).toFixed(1)}% over`);
  }

  // (d) AND NOT BY TOO MUCH. A fan that bounds the true one by a mile is safe
  // and diffusive, so the bound above needs a companion. At 10:1 the shipped
  // estimate is 8.380% over the exact shock speed and an h* 20% high is 28.007%
  // over (both measured). 15% is a PLAUSIBILITY BAND placed between them -- the
  // geometric middle of 8.4 and 28 is 15.3 -- and not a number from anywhere
  // else. It is deliberately not applied to (c), where the shipped estimate is
  // itself 74.6% over: that is what the two-rarefaction estimate costs at a
  // 100:1 ratio, and it is the price of the guarantee in (c).
  {
    const [hL, uL, hR, uR] = CASES[1];
    const e = exact(hL, uL, hR, uR), r = recover(hL, uL, hR, uR);
    const over = r.sR / e.SR - 1;
    assert(`shock hL=${hL} hR=${hR}: sR is tight as well as safe`, over <= 0.15,
      `${(100 * over).toFixed(3)}% over the exact ${fmt(e.SR)} m/s; h* 20% high measures 28.007%`);
  }

  // (e) AND THE PIN. (b) to (d) say the estimate is good; this one says WHICH
  // estimate it is, to the last bit, and it is the check that will go red if
  // somebody deliberately swaps in a better one. That is its job: the three
  // physical checks above decide whether the replacement is acceptable, this
  // one makes sure the swap cannot happen silently. It is a transcription of
  // the two-rarefaction formula, not an independent target, and it is labelled
  // that way so nobody reads it as verification.
  for (const [hL, uL, hR, uR] of CASES) {
    const est = estimate(hL, uL, hR, uR), r = recover(hL, uL, hR, uR);
    check(`hllc uses the declared two-rarefaction speeds, hL=${hL} hR=${hR}`,
      r.sR, est.sR, 1e-12,
      `recovered ${fmt(r.sR)} against the transcribed estimate ${fmt(est.sR)} m/s (h* = ${fmt(est.hStar)} m)`);
  }
}

// ===========================================================================
console.log('\n=== 10. the open boundaries: outflow() and makeSponge() ============\n');
// ===========================================================================
//
// Until 2026-08-14 this file imported { ShallowWater, reflect, periodic } and
// nothing else, so neither outflow() nor makeSponge() was exercised by it at
// all. makeSponge() was exercised by NOTHING: tools/waves.mjs calls it for the
// `shoal` case, but no verification suite did, and the audit's advice was
// "cover it or delete it". It stays, because deleting it would silently change
// the offshore-shoal result, and it is covered here.
//
// THE HONEST SCOPE OF THIS SECTION. verify-tide.mjs is where an open boundary
// is really put on trial -- it is the suite that caught the historical Flather
// bug, a boundary that reflected 98.19% of an outgoing pulse. This section is
// not a replacement for that. It is the minimum that makes these two functions
// impossible to break unnoticed: what outflow() writes into the ghost cells,
// that a steady stream can leave through it, and that both of them absorb an
// outgoing pulse where a wall returns it.
{
  // (a) ZERO-GRADIENT, GHOST BY GHOST. The contract is that every ghost cell
  // holds a bit-exact copy of the nearest interior cell -- b, h, hu AND hv,
  // with no sign change anywhere, which is the whole difference between this
  // and reflect(). Measured: 64 ghost cells, 0 mismatches. Measured on a
  // scratch copy with the two momenta negated (i.e. outflow() turned into a
  // mirror): 128 mismatches, worst 11.887.
  {
    const nx = 7, ny = 5;
    const sim = new ShallowWater({
      nx, ny, dx: 3, dy: 4,
      bed: (x, y) => -5 + 0.3 * Math.sin(x * 0.2) + 0.2 * Math.cos(y * 0.3),
      eta0: (x, y) => 0.1 * Math.sin(x * 0.15) - 0.05 * Math.cos(y * 0.11),
      manning: 0,
    });
    sim.boundaries = { west: outflow, east: outflow, south: outflow, north: outflow };
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = sim.idx(i, j);
        // Signed and monotone, so a flip or a wrong source cell cannot cancel.
        sim.hu[k] = sim.h[k] * (0.5 + 0.1 * i);
        sim.hv[k] = sim.h[k] * (-0.3 - 0.05 * j);
      }
    }
    sim.applyBC();
    const ng = sim.ng;
    let ghosts = 0, bad = 0, worst = 0;
    for (let j = -ng; j < ny + ng; j++) {
      for (let i = -ng; i < nx + ng; i++) {
        if (i >= 0 && i < nx && j >= 0 && j < ny) continue;
        ghosts++;
        const g = sim.idx(i, j);
        const s = sim.idx(Math.max(0, Math.min(nx - 1, i)), Math.max(0, Math.min(ny - 1, j)));
        for (const f of ['b', 'h', 'hu', 'hv']) {
          const d = Math.abs(sim[f][g] - sim[f][s]);
          if (d !== 0) { bad++; worst = Math.max(worst, d); }
        }
      }
    }
    assert('outflow: every ghost is a bit-exact copy of the nearest interior cell',
      bad === 0 && ghosts === (nx + 2 * ng) * (ny + 2 * ng) - nx * ny,
      `${ghosts} ghosts, ${bad} mismatched fields, worst ${worst}`);
  }

  // (b) A STEADY STREAM LEAVES. A uniform current over a flat bed is an exact
  // steady solution, and with zero-gradient at both ends every interface sees
  // identical left and right states, so the flux divergence is identically zero
  // and the state must stay uniform TO THE BIT. Measured: 0 departure and 0
  // volume drift after 200 steps and 24.1 m of travel. Measured with the ghost
  // momenta negated: 6.087488070075575 and 7.329e-4.
  {
    const h0 = 4, u0 = 1.5, STEPS = 200;
    const sim = new ShallowWater({ nx: 30, ny: 4, dx: 5, bed: () => -h0, eta0: 0, manning: 0 });
    sim.boundaries = { west: outflow, east: outflow, south: periodic, north: periodic };
    uniform(sim, h0, u0, 0);
    const v0 = sim.volume();
    const dt = 0.5 * sim.maxDt();
    for (let s = 0; s < STEPS; s++) sim.step(dt);
    assert('outflow: a uniform stream crosses it without noticing',
      nonUniformity(sim) === 0,
      `max departure ${nonUniformity(sim)} after ${STEPS} steps, ${fmt(u0 * sim.t)} m of travel; volume drift ${((sim.volume() - v0) / v0).toExponential(3)}`);
  }

  // (c) AND THEY ABSORB. A right-going Gaussian (u = eta sqrt(g/h), so the
  // leftward characteristic is zero everywhere at t = 0) down a flat channel,
  // with a gauge at x = 700 m; the incident pass is over by t = 75 s and
  // anything the boundary sends back reaches the gauge at about t = 106 s.
  // Measured 2026-08-14, all three on the same ruler:
  //
  //   solid wall (the control)          99.559%
  //   outflow                            0.126%
  //   wall + sponge, width 40, str 0.08  0.123%
  //
  // The control is what makes this a measurement rather than an assertion: it
  // says the rig can tell a mirror from an absorber. Measured with outflow()
  // turned into a mirror, it reads 99.472% -- i.e. the wall.
  //
  // WHAT THIS DOES NOT SHOW. It does not show outflow() is as good as
  // flather(). Zero-gradient is EXACTLY transparent to a purely outgoing wave,
  // because copying the interior state also copies its zero incoming
  // characteristic; it is the case where the two boundaries agree by
  // construction. Where zero-gradient fails is where an incoming signal has to
  // be prescribed, or where the outgoing wave is oblique or is riding on a mean
  // level -- none of which this rig contains, and all of which are
  // verify-tide.mjs's territory. The thresholds below are therefore placed
  // between a mirror and an absorber (a factor of 790 apart on this rig), not
  // between two absorbers.
  {
    const nx = 200, dx = 5, h0 = 10, A = 0.1, SIG = 80, X0 = 250, XG = 700;
    const T = 150, TSPLIT = 75;
    const channel = (east, sponge) => {
      const sim = new ShallowWater({
        nx, ny: 1, dx, bed: () => -h0, manning: 0,
        eta0: (x) => A * Math.exp(-(((x - X0) / SIG) ** 2)),
      });
      sim.boundaries = { west: reflect, east, south: reflect, north: reflect };
      for (let i = 0; i < nx; i++) {
        const k = sim.idx(i, 0);
        sim.hu[k] = sim.h[k] * (sim.b[k] + sim.h[k]) * Math.sqrt(G / h0);   // right-going
      }
      if (sponge) sim.forcing = makeSponge(sim, { side: 'east', etaRef: 0, ...sponge });
      const kg = sim.idx(Math.round(XG / dx), 0);
      const dt = 0.9 * sim.maxDt();
      let incident = 0, back = 0;
      while (sim.t < T) {
        sim.step(dt);
        const e = Math.abs(sim.b[kg] + sim.h[kg]);
        if (sim.t < TSPLIT) incident = Math.max(incident, e); else back = Math.max(back, e);
      }
      return { incident, back, R: back / incident };
    };
    const wall = channel(reflect, null);
    const open = channel(outflow, null);
    const spng = channel(reflect, { width: 40, strength: 0.08 });
    assert('open boundary: the rig can see a reflection at all (control)',
      wall.R > 0.9,
      `a solid wall returns ${(100 * wall.R).toFixed(3)}% of a ${fmt(wall.incident)} m pulse`);
    assert('outflow: an outgoing pulse leaves', open.R < wall.R / 100,
      `${(100 * open.R).toFixed(3)}% returned against the wall's ${(100 * wall.R).toFixed(3)}%`);
    assert('makeSponge: an outgoing pulse is absorbed before the wall',
      spng.R < wall.R / 100,
      `${(100 * spng.R).toFixed(3)}% returned through a width-40 sponge in front of the same wall`);
  }

  // (d) AND THE SPONGE LEAVES A LAKE AT REST ALONE. It relaxes toward
  // max(0, etaRef - b), which on a still lake at etaRef IS the depth, so the
  // relaxation term must be identically zero however strong it is. Measured
  // with the DEFAULT width and strength: 8.882e-16 m after 40 steps, which is 4
  // ulp of the 8 m depth and is the solver's own well-balancing roundoff, not
  // the sponge. A sponge that relaxed toward max(0, etaRef) instead -- dropping
  // the bed -- would drain this lake by 8 m.
  {
    const sim = new ShallowWater({
      nx: 40, ny: 8, dx: 10,
      bed: (x, y) => -8 + 3 * Math.sin(x * 0.01) * Math.cos(y * 0.02), eta0: 0, manning: 0,
    });
    sim.boundaries = { west: reflect, east: reflect, south: reflect, north: reflect };
    sim.forcing = makeSponge(sim, { side: 'east', etaRef: 0 });
    const h0 = Float64Array.from(sim.h);
    const dt = 0.5 * sim.maxDt();
    let d = 0;
    for (let s = 0; s < 40; s++) sim.step(dt);
    for (let j = 0; j < sim.ny; j++) {
      for (let i = 0; i < sim.nx; i++) {
        const k = sim.idx(i, j);
        d = Math.max(d, Math.abs(sim.h[k] - h0[k]));
      }
    }
    check('makeSponge: a lake at rest is left alone', d, 0, 1e-14,
      `max |dh| = ${d.toExponential(3)} m over ${sim.nx * sim.ny} cells after 40 steps, max speed ${fmt(sim.maxSpeed())} m/s`);
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} -- ${checks - failures}/${checks} checks\n`);
process.exit(failures ? 1 : 0);
