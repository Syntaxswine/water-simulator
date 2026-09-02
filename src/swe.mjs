// ---------------------------------------------------------------------------
// Two-dimensional nonlinear shallow-water equations, finite volume, WELL-BALANCED.
//
//   d/dt [ h  ]   d/dx [ hu           ]   d/dy [ hv           ]   [ 0                    ]
//        [ hu ] +      [ hu^2 + gh^2/2] +      [ huv          ] = [ -gh db/dx - friction ]
//        [ hv ]        [ huv          ]        [ hv^2 + gh^2/2]   [ -gh db/dy - friction ]
//
// h is water depth, b the bed elevation, and eta = h + b the free surface.
//
// WHY "WELL-BALANCED" IS THE WHOLE DESIGN, and not a detail.
//
// Still water over an uneven bed is the state this simulator spends most of its
// time in: a harbour between waves, a lagoon behind a reef, a bay at slack tide.
// In that state the pressure-gradient flux and the bed-slope source term are
// individually enormous and must cancel EXACTLY. Discretise them independently
// -- the obvious thing -- and they cancel only to truncation error, which means
// a flat lake over a sloping bed spontaneously develops currents of a few cm/s
// and never stops. Those currents look like physics. They are the scheme talking
// to itself, and every wave you then launch rides on top of them.
//
// So the bed is not handled as a source term added to a flux. The flux itself is
// evaluated on hydrostatically RECONSTRUCTED depths (Audusse et al. 2004): at
// each interface both sides are re-measured against the higher of the two bed
// levels, and a matching pressure correction is folded into the same interface.
// Lake-at-rest then cancels algebraically rather than numerically, and
// tools/verify.mjs checks that it does -- to machine epsilon, not to a tolerance.
//
// SCHEME
//   - cell-centred finite volume, uniform grid
//   - MUSCL reconstruction of (eta, u, v) -> 2nd order in space. The DEFAULT
//     limiter is MC (monotonized central), not minmod; minmod and an unlimited
//     central slope are selectable with `limiter`, and what the choice costs is
//     measured in the comment on mc() below. Reconstructing ETA and not h is what
//     keeps lake-at-rest exact at 2nd order.
//   - HLLC approximate Riemann solver with Einfeldt wave speeds and explicit
//     dry-state handling
//   - SSP-RK2 (Heun) in time, which is TVD and will not manufacture the
//     oscillations a plain RK2 puts on a breaking front
//   - wetting and drying with a desingularised velocity, so a shoreline can move
//   - Manning bed friction, solved semi-implicitly so a thin film cannot blow up
//
// WHAT THIS MODEL IS NOT. The shallow-water equations are non-dispersive: every
// wave travels at sqrt(g*h) regardless of wavelength. "Correct to within a few
// percent for kh < 0.5" was written here without a number behind it; measured
// 2026-08-14 against src/waves.mjs's exact Airy relation, the celerity this
// solver uses runs FAST by
//
//   kh    0.1    0.2    0.3    0.4    0.5    0.6    0.8    1.0    1.5    pi
//   err  0.17%  0.66%  1.48%  2.60%  4.02%  5.70%  9.76%  14.6%  28.7%  77.6%
//
// so "a few percent below kh = 0.5" holds, and 4% AT 0.5 is the edge of it. Below
// that -- tides, surges, tsunamis, and swell once it is well inside the surf zone
// -- this is a good model, and it degrades fast above.
//
// There is no dispersive term here and no
// Boussinesq mode anywhere in this repository: if you need one it has to be
// written. (An earlier version of this comment pointed at src/boussinesq.mjs and
// tools/dispersion.mjs. Neither file has ever existed. src/waves.mjs holds the
// exact Airy relation, so the ERROR at a given kh can be computed, but nothing
// here corrects it.)
//
// The price is measured, not asserted. Without dispersion nothing balances the
// nonlinear steepening that makes a crest outrun its trough, so a finite-
// amplitude wave sharpens into a bore and the Riemann solver dissipates it
// before it reaches the depth-limited breaking point. Fit p in H ~ h^p over a
// plane beach (tools/waves.mjs planeBeach does exactly this, as an amplitude
// sweep, with Manning at 0 so the figure is the dispersion error on its own) and
// p comes out +0.151, -0.210, -0.243, -0.243 for offshore heights of 0.8, 0.2,
// 0.05 and 0.012 m, against Green's law p = -0.25. So the small-amplitude limit
// is recovered, and at 0.8 m the exponent has the WRONG SIGN: that wave loses
// height as it shoals. Bed friction is not the cause -- putting Manning back at
// 0.022 moves the 0.8 m case only from 0.1509 to 0.1534. Do not quote this
// solver for deep-water wind sea, and do not quote its shoaling for waves steep
// enough to break before they arrive.
//
// Re-measured 2026-08-14 by running that case. The five numbers printed here
// before were +0.152, -0.179, -0.236, -0.238 and "0.154 to 0.152": the H0 = 0.2 m
// exponent had drifted by 0.031, the rest by 0.007 or less. The published figures
// had fallen behind the solver, which is exactly the failure this comment style
// exists to prevent, so: every number in this file is dated by the run that
// produced it, and anything that could not be reproduced has been deleted rather
// than rounded into agreement.
// ---------------------------------------------------------------------------

export const G = 9.80665;          // standard gravity [m/s^2]

/** Minmod: the least-steep of two slopes, zero if they disagree. Most diffusive. */
function minmod(a, b) {
  if (a > 0 && b > 0) return a < b ? a : b;
  if (a < 0 && b < 0) return a > b ? a : b;
  return 0;
}

/**
 * Monotonized-central limiter (van Leer). THE DEFAULT, and the difference is not
 * cosmetic.
 *
 * minmod always picks the smaller one-sided slope, so at a smooth crest -- where
 * the two one-sided slopes have opposite signs -- it returns ZERO and flattens
 * the extremum. Do that every step and a propagating wave bleeds amplitude even
 * over a flat bed with no physics to take it.
 *
 * Measured 2026-08-14: a 0.1 m, 10 s wave on a FLAT bed in 12 m of water,
 * Manning 0, dx = 4.931 m so that L = 108.5 m is exactly 22 cells; wavemaker at
 * the west, Flather radiation at the east. At a gauge 1100 m downwave -- 10.1
 * wavelengths, about a tenth of the way across any real bay -- minmod retains
 * 0.169 of its amplitude at the wavemaker and MC retains 0.686. The wave arrives
 * 4.14x smaller under minmod. A wave model that cannot carry a wave to the beach
 * is not a wave model.
 *
 * The note here previously said "a factor of 5.9 over 1100 m, which is eleven
 * wavelengths". 1100 m is 10.1 wavelengths at this period and depth, not eleven,
 * and 5.9 did not reproduce. Nor did the first re-measurement, which got 5.23 --
 * with a REFLECTING east wall, so a partial standing wave sat over the gauge and
 * MC came out "retaining" 1.33, i.e. more amplitude than the wavemaker made. That
 * is how the setup gave itself away; 4.14 is from the radiating version, where
 * the gauge sees a travelling wave and nothing else.
 *
 * tools/verify.mjs measures the same effect independently and reports a bigger
 * gap -- "minmod keeps 3.9% where the default MC keeps 50.7%", i.e. 13x -- on its
 * own resolution and path length. Both are real; the ratio is not a constant of
 * the scheme, it grows with how far the wave has to travel and how coarse the
 * grid is, which is precisely why a number like this is worthless without the
 * configuration attached. That suite is the gate. This paragraph is an
 * explanation, and it does not get to overrule it.
 *
 * MC allows up to twice the minmod slope, bounded by the central difference. It
 * is still TVD -- it will not manufacture oscillations at a bore -- but it holds
 * smooth extrema far better.
 */
function mc(a, b) {
  if (a * b <= 0) return 0;
  const c = 0.5 * (a + b);
  const m = Math.min(Math.abs(c), 2 * Math.abs(a), 2 * Math.abs(b));
  return a > 0 ? m : -m;
}

/** Unlimited central slope. Not TVD -- diagnostic only, it will ring at a bore. */
function central(a, b) { return 0.5 * (a + b); }

const LIMITERS = { minmod, mc, central };

import { cartesianGeometry, sphericalGeometry } from './geometry.mjs';

export class ShallowWater {
  /**
   * @param nx,ny      interior cells
   * @param dx,dy      cell size [m]
   * @param bed        function (x,y) -> bed elevation [m], positive up
   * @param eta0       initial free-surface elevation [m] (number or fn(x,y))
   * @param manning    Manning's n [s/m^(1/3)]; 0.025 is sand, 0.04 a rocky bed
   * @param minDepth   below this a cell is dry [m]. A MODELLING choice, not a
   *   numerical fudge: below about a millimetre the shallow-water equations
   *   describe nothing real -- surface tension, bed roughness and the grain size
   *   all exceed the film. Measured 2026-08-14 on a dam break onto a dry bed
   *   (400x4 at dx = 2.5 m, 10 m behind the dam, 300 steps at cfl 0.45), varying
   *   nothing but this number:
   *     1e-3 (default)   fastest wet cell 17.40 m/s in h = 1.6e-1 m    finite
   *     1e-4             fastest wet cell 18.26 m/s in h = 1.1e-2 m    finite
   *     1e-6             fastest wet cell 1.244e+65 m/s               NOT FINITE
   *     1e-9             fastest wet cell 9.693e+67 m/s               NOT FINITE
   *   So this is not a knob that trades a little accuracy for a little
   *   robustness: three decades below the default the run destroys itself. The
   *   doc here used to say such a cell would "happily report it moving at 40 m/s,
   *   which is measured, not hypothetical". 40 m/s did not reproduce at any
   *   setting tried, and it badly understates what happens.
   * @param cfl        Courant number; 0.45 is safe for 2D SSP-RK2 + MUSCL
   * @param coriolis   f [1/s]; 2*Omega*sin(lat). Zero for a beach, not for a shelf.
   */
  constructor({
    nx, ny, dx, dy = dx, bed, eta0 = 0, manning = 0.025,
    minDepth = 1e-3, cfl = 0.45, coriolis = 0, order = 2, limiter = 'mc',
    sphere = null,
  }) {
    this.nx = nx; this.ny = ny; this.dx = dx; this.dy = dy;
    // THE METRIC. Cartesian unless `sphere` is supplied, in which case dx is
    // meaningless -- a cell width depends on its latitude -- and is left undefined
    // so that anything still reading it produces a loud NaN rather than a quiet
    // mid-domain approximation. See src/geometry.mjs for why the spherical
    // divisors are stored as divisors.
    this.geom = sphere
      ? sphericalGeometry({ nx, ny, ng: 2, ...sphere })
      : cartesianGeometry({ nx, ny, dx, dy, ng: 2, coriolis });
    if (sphere) { this.dx = undefined; this.dy = this.geom.dy; }
    this.manning = manning; this.minDepth = minDepth; this.cfl = cfl;
    // vel()'s desingularisation constant, which depends only on minDepth. Cached
    // because vel() is the most-called function in the solver; nothing in this
    // repository assigns sim.minDepth after construction, and anything that did
    // would have to recompute this alongside it.
    this.eps4 = Math.max(minDepth, 1e-12) ** 4;
    this.coriolis = coriolis; this.order = order;
    this.manningField = null;   // set via setManningField(); see applyFriction()
    this.limiterName = limiter;
    this.limit = LIMITERS[limiter];
    if (!this.limit) throw new Error(`unknown limiter ${limiter}; have ${Object.keys(LIMITERS)}`);
    this.ng = 2;                                   // ghost cells per side
    this.W = nx + 2 * this.ng;
    this.H = ny + 2 * this.ng;
    const N = this.W * this.H;

    this.b = new Float64Array(N);
    this.h = new Float64Array(N);
    this.hu = new Float64Array(N);
    this.hv = new Float64Array(N);
    // RK stage storage
    this.h0 = new Float64Array(N); this.hu0 = new Float64Array(N); this.hv0 = new Float64Array(N);
    this.rh = new Float64Array(N); this.rhu = new Float64Array(N); this.rhv = new Float64Array(N);
    // MUSCL slopes of eta, u, v
    this.sE = new Float64Array(2 * N); this.sU = new Float64Array(2 * N); this.sV = new Float64Array(2 * N);
    this.sB = new Float64Array(2 * N);
    // Interface fluxes, stored rather than accumulated on the fly, so the
    // positivity limiter below can see a cell's whole budget before any of it
    // is spent. Indexed by the LEFT/LOWER cell of each face.
    this.fxM = new Float64Array(N); this.fxN = new Float64Array(N); this.fxT = new Float64Array(N);
    this.fyM = new Float64Array(N); this.fyN = new Float64Array(N); this.fyT = new Float64Array(N);
    this.pxL = new Float64Array(N); this.pxR = new Float64Array(N);
    this.pyL = new Float64Array(N); this.pyR = new Float64Array(N);
    this.theta = new Float64Array(N);
    // Cell velocities, refilled once per residual (see the note there).
    this.uu = new Float64Array(N); this.vv = new Float64Array(N);

    for (let j = 0; j < this.H; j++) {
      for (let i = 0; i < this.W; i++) {
        const k = j * this.W + i;
        const [x, y] = this.geom.kind === 'sphere'
          ? this.cellLonLat(i - this.ng, j - this.ng)
          : this.cellCentre(i - this.ng, j - this.ng);
        this.b[k] = bed(x, y);
        const e = typeof eta0 === 'function' ? eta0(x, y) : eta0;
        this.h[k] = Math.max(0, e - this.b[k]);
      }
    }

    this.t = 0;
    this.steps = 0;
    // On a sphere longitude WRAPS -- it is not a boundary, it is the same water --
    // and the caps are walls (or, at +-90, zero-length faces that close
    // themselves; see src/geometry.mjs).
    this.boundaries = this.geom.kind === 'sphere'
      ? { west: periodic, east: periodic, south: reflect, north: reflect }
      : { west: reflect, east: reflect, south: reflect, north: reflect };
    this.forcing = null;              // optional (sim, dt) => void, e.g. a tidal potential
    this.stats = {};
  }

  cellCentre(i, j) {
    if (this.geom.kind === 'sphere') {
      throw new Error('cellCentre is Cartesian-only; a spherical cell has no single '
        + 'x in metres. Use cellLonLat(i, j).');
    }
    return [(i + 0.5) * this.dx, (j + 0.5) * this.dy];
  }

  /**
   * Longitude and latitude of a cell centre, in DEGREES, longitude in [-180, 180).
   *
   * Accepts ghost indices, and longitude WRAPS rather than running off the end,
   * because it must: the ghost column at i = -1 is physically the column at
   * i = nx - 1, so a bed function sampled there has to see the same place, or every
   * MUSCL slope across the seam is taken over a discontinuity that is not there.
   */
  cellLonLat(i, j) {
    const g = this.geom;
    if (g.kind !== 'sphere') throw new Error('cellLonLat is spherical-only');
    const lon = (i + 0.5) * g.dlam * 180 / Math.PI;
    return [((lon % 360) + 360) % 360 - 180, g.phiC[j + this.ng] * 180 / Math.PI];
  }
  idx(i, j) { return (j + this.ng) * this.W + (i + this.ng); }

  /** Free-surface elevation of an interior cell. */
  eta(i, j) { const k = this.idx(i, j); return this.b[k] + this.h[k]; }
  depth(i, j) { return this.h[this.idx(i, j)]; }

  /**
   * Velocity from momentum, desingularised.
   *
   * u = hu/h is unbounded as h -> 0, and a shoreline cell spends its life near
   * zero. Kurganov & Petrova's regularisation keeps u finite and, crucially,
   * still exact when h is not small: dividing by max(h, eps) instead would bias
   * every shallow cell's velocity low and quietly damp run-up.
   */
  vel(hq, h) {
    const h4 = h * h * h * h;
    return (Math.SQRT2 * h * hq) / Math.sqrt(h4 + Math.max(h4, this.eps4));
  }

  // -- boundaries -----------------------------------------------------------

  applyBC() {
    const { W, H, ng, nx, ny } = this;
    for (let j = 0; j < H; j++) {
      for (let g = 0; g < ng; g++) {
        this.boundaries.west(this, -1 - g, j - ng, 0, g);
        this.boundaries.east(this, nx + g, j - ng, 1, g);
      }
    }
    for (let i = -ng; i < nx + ng; i++) {
      for (let g = 0; g < ng; g++) {
        this.boundaries.south(this, i, -1 - g, 2, g);
        this.boundaries.north(this, i, ny + g, 3, g);
      }
    }
  }

  // -- one Runge-Kutta stage ------------------------------------------------

  /** Fill this.rh/rhu/rhv with the spatial residual (dU/dt). */
  residual(dt) {
    const { W, H, ng, minDepth } = this;
    const gm = this.geom, sph = gm.kind === 'sphere';
    const dxRow = gm.dxRow, dyRowN = gm.dyRowN, dyRowS = gm.dyRowS, bedPhi = gm.bedPhi;
    const h = this.h, hu = this.hu, hv = this.hv, b = this.b;
    const rh = this.rh, rhu = this.rhu, rhv = this.rhv;
    const fxM = this.fxM, fxN = this.fxN, fxT = this.fxT;
    const fyM = this.fyM, fyN = this.fyN, fyT = this.fyT;
    const pxL = this.pxL, pxR = this.pxR, pyL = this.pyL, pyR = this.pyR;
    rh.fill(0); rhu.fill(0); rhv.fill(0);
    fxM.fill(0); fyM.fill(0);

    // ---- cell velocities, computed ONCE ----------------------------------
    //
    // The slope pass and the two interface passes all want u = hu/h at the same
    // cells, and they used to ask for it separately.
    //
    // Counted 2026-08-14 by reverting this loop in a scratch copy and
    // instrumenting vel(), on a 320x320 grid (324x324 with ghosts = 104,976
    // cells):
    //
    //                        vel() calls per step    per cell
    //     before, step()          4,126,800            39.3
    //     before, step(dt)        3,922,000            37.4
    //     after,  step()            829,504             7.9
    //     after,  step(dt)          624,704             6.0
    //
    // step() self-times and therefore also runs maxDt(), which scans the grid
    // again; every caller in tools/ supplies dt. This one change is essentially
    // the whole speedup of this file: 0.1055 -> 0.0570 s/step, a factor of 1.85,
    // minimum of 5 interleaved 100-step runs each.
    //
    // THE ABSOLUTE TIMES DO NOT TRAVEL and should not be read to two digits. The
    // same shipped 100-step benchmark on this machine gave 0.0570, 0.0684, 0.0915
    // and 0.1019 s/step in four sessions, depending on what else was running. The
    // RATIO is the measurement, and it is taken interleaved so both variants meet
    // the same machine in the same minute. The numbers previously written here --
    // 4,066,992 calls, 0.1230 -> 0.0503 s/step, 2.43x -- came from a faster
    // machine: the call count reproduces to 1.5%, the times do not reproduce at
    // all, and they have been replaced rather than kept.
    //
    // It is a pure caching change and has to be provable as one: vel() is a pure
    // function of (hu, h), and nothing writes hu or h during a residual, so the
    // cached value is the SAME double rather than an approximation of it. Checked
    // by fingerprinting 200 steps (FNV-1a over the raw bytes of h, hu, hv) of the
    // shipped code against the reverted copy, over six scenarios chosen to reach
    // the dry front, first order, minmod, Coriolis, a moving shoreline and both
    // dt branches. All six bit-identical -- see the note at hllc(), which was
    // checked in the same pass and includes what it took to make that check
    // capable of failing.
    const U = this.uu, V = this.vv, NC = U.length;
    for (let k = 0; k < NC; k++) { const hk = h[k]; U[k] = this.vel(hu[k], hk); V[k] = this.vel(hv[k], hk); }

    // ---- slopes ----------------------------------------------------------
    const sE = this.sE, sU = this.sU, sV = this.sV, sB = this.sB;
    const lim = this.limit;
    if (this.order >= 2) {
      for (let j = 1; j < H - 1; j++) {
        for (let i = 1; i < W - 1; i++) {
          const k = j * W + i, k2 = 2 * k;
          const hk = h[k], bk = b[k], eC = bk + hk, uk = U[k], vk = V[k];
          for (let d = 0; d < 2; d++) {
            const kp = d === 0 ? k + 1 : k + W;
            const km = d === 0 ? k - 1 : k - W;
            // FIRST ORDER AT A WET/DRY FRONT, and this is not a robustness hack.
            //
            // A dry cell has h = 0, so its eta equals its BED, which beside an
            // island stands above the water. Feeding that into the slope of eta
            // makes the wet neighbour reconstruct a surface tilted up onto the
            // shore, the hydrostatic reconstruction no longer cancels, and a
            // still lake with an island in it starts to move.
            //
            // Measured 2026-08-14 by deleting these four lines and running a
            // 200x200 lake at dx = 10 m: bed -10 m with a Gaussian island
            // (sigma 220 m, crest +4 m), eta0 = 0, Manning 0, all four walls
            // reflecting, 400 steps to t = 91 s.
            //
            //   guard present   max speed 1.055e-13 m/s   max |eta| 7.105e-15 m
            //   guard deleted   max speed 1.490e+00 m/s   max |eta| 4.784e-02 m
            //                   and 4.474 m/s at its peak during the run
            //
            // Machine epsilon against 1.5 m/s of permanent outward current and
            // 5 cm of standing set-up, on a lake that is supposed to be flat.
            // The note here previously said 0.34 m/s without recording the
            // geometry that produced it; the number depends on the island, so
            // this one states the island.
            //
            // Zeroing eta, bed and velocity slopes TOGETHER drops the cell to
            // the first-order scheme, which Audusse's hydrostatic reconstruction
            // balances exactly on its own. Zeroing only some of them would not:
            // the eta and bed reconstructions have to describe the same surface.
            if (hk <= minDepth || h[kp] <= minDepth || h[km] <= minDepth) {
              sE[k2 + d] = 0; sB[k2 + d] = 0; sU[k2 + d] = 0; sV[k2 + d] = 0;
              continue;
            }
            const eP = b[kp] + h[kp], eM = b[km] + h[km];
            sE[k2 + d] = lim(eC - eM, eP - eC);
            sB[k2 + d] = lim(bk - b[km], b[kp] - bk);
            sU[k2 + d] = lim(uk - U[km], U[kp] - uk);
            sV[k2 + d] = lim(vk - V[km], V[kp] - vk);
          }
        }
      }
    } else { sE.fill(0); sU.fill(0); sV.fill(0); sB.fill(0); }

    // ---- x interfaces ----------------------------------------------------
    const flux = [0, 0, 0];              // hllc() writes here; FL/FR live in hllc
    for (let j = ng; j < H - ng; j++) {
      for (let i = ng - 1; i < W - ng; i++) {
        const kL = j * W + i, kR = kL + 1, kL2 = 2 * kL, kR2 = 2 * kR;
        // reconstructed states at the shared face
        const etaL = b[kL] + h[kL] + 0.5 * sE[kL2];
        const etaR = b[kR] + h[kR] - 0.5 * sE[kR2];
        const bL = b[kL] + 0.5 * sB[kL2];
        const bR = b[kR] - 0.5 * sB[kR2];
        const hLf = Math.max(0, etaL - bL);
        const hRf = Math.max(0, etaR - bR);
        const uL = U[kL] + 0.5 * sU[kL2];
        const uR = U[kR] - 0.5 * sU[kR2];
        const vL = V[kL] + 0.5 * sV[kL2];
        const vR = V[kR] - 0.5 * sV[kR2];

        // hydrostatic reconstruction against the higher bed
        const bStar = Math.max(bL, bR);
        const hsL = Math.max(0, etaL - bStar);
        const hsR = Math.max(0, etaR - bStar);
        hllc(flux, hsL, hsL * uL, hsL * vL, hsR, hsR * uR, hsR * vR, minDepth);

        // Interface-local pressure corrections. This is the well-balancing: the
        // flux each cell sees is the Riemann flux plus the difference between
        // its OWN hydrostatic pressure and the reconstructed one, so a flat
        // surface produces g/2*h^2 on both sides and nothing moves.
        const pL = 0.5 * G * (hLf * hLf - hsL * hsL);
        const pR = 0.5 * G * (hRf * hRf - hsR * hsR);
        fxM[kL] = flux[0]; fxN[kL] = flux[1]; fxT[kL] = flux[2];
        pxL[kL] = pL; pxR[kL] = pR;
      }
    }

    // ---- y interfaces ----------------------------------------------------
    for (let j = ng - 1; j < H - ng; j++) {
      for (let i = ng; i < W - ng; i++) {
        const kL = j * W + i, kR = kL + W, kL2 = 2 * kL + 1, kR2 = 2 * kR + 1;
        const etaL = b[kL] + h[kL] + 0.5 * sE[kL2];
        const etaR = b[kR] + h[kR] - 0.5 * sE[kR2];
        const bL = b[kL] + 0.5 * sB[kL2];
        const bR = b[kR] - 0.5 * sB[kR2];
        const hLf = Math.max(0, etaL - bL);
        const hRf = Math.max(0, etaR - bR);
        const uL = U[kL] + 0.5 * sU[kL2];
        const uR = U[kR] - 0.5 * sU[kR2];
        const vL = V[kL] + 0.5 * sV[kL2];
        const vR = V[kR] - 0.5 * sV[kR2];

        const bStar = Math.max(bL, bR);
        const hsL = Math.max(0, etaL - bStar);
        const hsR = Math.max(0, etaR - bStar);
        // Same solver, axes swapped: pass v as the normal component and u as the
        // tangential one, then swap back. One Riemann solver, no second copy to
        // drift out of step with the first.
        hllc(flux, hsL, hsL * vL, hsL * uL, hsR, hsR * vR, hsR * uR, minDepth);

        const pL = 0.5 * G * (hLf * hLf - hsL * hsL);
        const pR = 0.5 * G * (hRf * hRf - hsR * hsR);
        fyM[kL] = flux[0]; fyN[kL] = flux[1]; fyT[kL] = flux[2];
        pyL[kL] = pL; pyR[kL] = pR;
      }
    }

    // ---- positivity limiter, then accumulate ------------------------------
    //
    // A cell cannot give away more water than it has. Let it, and it empties past
    // zero, gets floored back to zero by dryClean(), and leaves a HOLE in the
    // middle of the sheet; the neighbour then accelerates into that hole and the
    // run stops meaning anything while staying perfectly FINITE the whole way,
    // which is the part that makes it dangerous rather than merely wrong.
    //
    // So scale the outgoing fluxes of any cell that would over-draw, by the one
    // factor that just empties it. Because the SAME scaled flux is handed to
    // both neighbours, mass is still conserved exactly; and because a still lake
    // has zero flux everywhere, theta is 1 and well-balancing is untouched.
    //
    // Measured 2026-08-14 on a dam break onto a DRY bed (400x4 at dx = 2.5 m,
    // 10 m behind the dam, Manning 0, 300 steps at the CFL limit) by counting
    // the cell-steps where theta < 1, and separately by deleting this block:
    //
    //   cfl          theta < 1   smallest theta    fastest wet cell, block DELETED
    //   0.45 shipped        0        1             1.740e+01 m/s   (finite)
    //   0.80               36        0             1.136e+04 m/s   (finite)
    //   0.95               28        9.08e-21      2.262e+40 m/s   (finite)
    //
    // Two things worth saying plainly. AT THE SHIPPED CFL OF 0.45 THIS LIMITER
    // NEVER FIRES: theta < 1 on zero cell-steps in that dam break, and on zero
    // cell-steps in a planeBeach run-up at H0 = 0.8 m over 3888 steps. It is
    // insurance against a Courant number this solver does not use by default, and
    // calling it load-bearing for the shipped configuration would be a lie. But
    // when it does fire, the thing it prevents is exactly as advertised: 2.3e40
    // m/s, with every field still finite and the run still "advancing".
    //
    // The note here previously read "h = 3e-4 m draining at 12 m/s ... 166 m/s,
    // then 1e40 m/s", with no Courant number attached. The 1e40 reproduces
    // (2.262e40 at cfl 0.95). The 3e-4 m / 12 m/s / 166 m/s trio did not, in any
    // configuration tried, so it is gone rather than carried on trust.
    const theta = this.theta;
    theta.fill(1);
    if (dt > 0) {
      for (let j = ng - 1; j < H - ng + 1; j++) {
        for (let i = ng - 1; i < W - ng + 1; i++) {
          const k = j * W + i;
          let out = 0;
          // Per-row divisors. fyM[k] is the NORTH face of cell k and fyM[k-W] its
          // SOUTH one, and on a sphere those two faces have different lengths, so
          // they cannot share a divisor.
          if (fxM[k] > 0) out += fxM[k] / dxRow[j];
          if (fxM[k - 1] < 0) out -= fxM[k - 1] / dxRow[j];
          if (fyM[k] > 0) out += fyM[k] / dyRowN[j];
          if (fyM[k - W] < 0) out -= fyM[k - W] / dyRowS[j];
          const avail = h[k];
          if (out * dt > avail) theta[k] = avail > 0 ? avail / (out * dt) : 0;
        }
      }
    }
    for (let j = ng; j < H - ng; j++) {
      for (let i = ng - 1; i < W - ng; i++) {
        const kL = j * W + i, kR = kL + 1;
        const th = fxM[kL] >= 0 ? theta[kL] : theta[kR];
        // Both cells across a zonal face lie in the SAME row, so one divisor still
        // serves both -- on a sphere exactly as in Cartesian.
        const inv = th / dxRow[j];
        rh[kL] -= fxM[kL] * inv; rhu[kL] -= (fxN[kL] + pxL[kL]) * inv; rhv[kL] -= fxT[kL] * inv;
        rh[kR] += fxM[kL] * inv; rhu[kR] += (fxN[kL] + pxR[kL]) * inv; rhv[kR] += fxT[kL] * inv;
      }
    }
    for (let j = ng - 1; j < H - ng; j++) {
      for (let i = ng; i < W - ng; i++) {
        const kL = j * W + i, kR = kL + W;
        const th = fyM[kL] >= 0 ? theta[kL] : theta[kR];
        // TWO divisors, because the two cells sharing this face lie in different
        // ROWS and on a sphere different rows have different areas. The face is one
        // length shared by both (dyRowN[j] and dyRowS[j+1] are built from the same
        // ly), so each cell receives the same flux*length divided by its OWN area,
        // which is what keeps mass conservation exact instead of nearly exact.
        const invL = th / dyRowN[j];
        const invR = th / dyRowS[j + 1];
        rh[kL] -= fyM[kL] * invL; rhv[kL] -= (fyN[kL] + pyL[kL]) * invL; rhu[kL] -= fyT[kL] * invL;
        rh[kR] += fyM[kL] * invR; rhv[kR] += (fyN[kL] + pyR[kL]) * invR; rhu[kR] += fyT[kL] * invR;
      }
    }

    // ---- centred bed term, needed for 2nd-order well-balancing ------------
    // On a sphere this block runs at EVERY order. In Cartesian the bed term is a
    // second-order-ONLY correction, because the hydrostatic reconstruction handles
    // the bed exactly at first order -- which is why the guard is right there, and
    // why leaving it alone is the loudest way to get a spherical port wrong. The
    // geometric source below exists at every order: at first order all slopes are
    // zero, hP = hM = h[k], and -(tan phi/4R)*G*2h^2 is not zero. Magnitude at
    // h = 4000 m and 45 degrees: 3.1e-3 m/s^2, i.e. 268 m/s per day, with the whole
    // ocean draining to the equator inside a few minutes.
    //
    // Running it at first order costs Cartesian nothing: sE and sB are written only
    // by the slope block, so at order 1 they stay zero for the life of the object,
    // db = 0, and every term here is identically zero.
    if (this.order >= 2 || sph) {
      const geoCoef = gm.geoCoef;
      for (let j = ng; j < H - ng; j++) {
        const bedDiv1 = bedPhi[j], bedDiv0 = dxRow[j], gc = geoCoef[j];
        for (let i = ng; i < W - ng; i++) {
          const k = j * W + i, k2 = 2 * k, bk = b[k];
          const eC = bk + h[k];
          for (let d = 0; d < 2; d++) {
            const hP = Math.max(0, eC + 0.5 * sE[k2 + d] - (bk + 0.5 * sB[k2 + d]));
            const hM = Math.max(0, eC - 0.5 * sE[k2 + d] - (bk - 0.5 * sB[k2 + d]));
            const db = sB[k2 + d];
            const term = -G * 0.5 * (hP + hM) * db / (d === 0 ? bedDiv0 : bedDiv1);
            if (d === 0) rhu[k] += term;
            else {
              rhv[k] += term;
              // THE SPHERICAL GEOMETRIC SOURCE, on the SUM OF SQUARES of this cell
              // own reconstructed face depths and not on h_cell^2. The two agree
              // exactly on a flat bed, which is why no flat-bed test can tell them
              // apart; over a slope the h_cell^2 form leaves about 0.17 m/s per day
              // per 200 m of relief, arriving as a persistent rim current on every
              // shelf break and seamount flank and nowhere else. That is the
              // hardest artefact here to disbelieve, because a slope current at the
              // shelf break is what the real ocean has.
              if (sph) rhv[k] += gc * G * (hP * hP + hM * hM);
            }
          }
        }
      }
    }

    // ---- Coriolis ---------------------------------------------------------
    if (sph) {
      // f = 2 omega sin(phi), PLUS the metric curvature term u tan(phi)/R. That
      // second piece is easy to omit and nearly impossible to catch afterwards: it
      // is exactly zero at rest, it is 1.5e-3 of f at 45 degrees so an
      // inertial-oscillation check cannot see it, and it is absent from any
      // zonal-strip test. Only advection over a pole, or a long high-latitude jet,
      // notices. Folding it into an effective f is not an approximation; the two
      // enter the momentum equations in identical positions.
      const fRow = gm.fRow, tanPhi = gm.tanPhi, R = gm.R, U = this.uu;
      for (let j = ng; j < H - ng; j++) {
        const f0 = fRow[j], tR = tanPhi[j] / R;
        for (let i = ng; i < W - ng; i++) {
          const k = j * W + i;
          const fe = f0 + U[k] * tR;
          rhu[k] += fe * hv[k];
          rhv[k] -= fe * hu[k];
        }
      }
    } else if (this.coriolis) {
      const f = this.coriolis;
      for (let j = ng; j < H - ng; j++) {
        for (let i = ng; i < W - ng; i++) {
          const k = j * W + i;
          rhu[k] += f * hv[k];
          rhv[k] -= f * hu[k];
        }
      }
    }
  }

  /** Largest stable step from the CFL condition, over wet cells only. */
  maxDt() {
    const { W, H, ng } = this;
    const dxRow = this.geom.dxRow, dyCFL = this.geom.dyCFL;
    let inv = 0;
    for (let j = ng; j < H - ng; j++) {
      for (let i = ng; i < W - ng; i++) {
        const k = j * W + i, hk = this.h[k];
        if (hk <= this.minDepth) continue;
        const c = Math.sqrt(G * hk);
        const u = Math.abs(this.vel(this.hu[k], hk)), v = Math.abs(this.vel(this.hv[k], hk));
        const s = (u + c) / dxRow[j] + (v + c) / dyCFL[j];
        if (s > inv) inv = s;
      }
    }
    return inv > 0 ? this.cfl / inv : Infinity;
  }

  /**
   * Manning friction, semi-implicit.
   *
   * tau/rho = g n^2 |u| u / h^(1/3), so d(hu)/dt = -g n^2 |u| (hu) / h^(4/3).
   * Explicit integration of that is unstable exactly where it matters -- a
   * millimetre of water on a beach face has a friction timescale far shorter
   * than the wave -- and the usual symptom is a run-up tongue that flickers.
   * Treating the linear factor implicitly is unconditionally stable and cannot
   * reverse the flow, which explicit friction happily does.
   */
  applyFriction(dt) {
    const n = this.manning;
    // PER-CELL Manning, when a field is supplied. Roughness is a property of the
    // ground, not of the run: gridlands exports forest at 0.100 against playa at
    // 0.020, a factor of FIVE, and overland routing is where that shows -- a flood
    // crossing woodland and a flood crossing a salt pan are not the same flood.
    //
    // The scalar path below is untouched and stays BYTE-IDENTICAL: same `if (!n)
    // return`, same expression, same operand order, same divisions. The array path
    // is a separate loop rather than an `nArr ? nArr[k] : n` inside the hot one,
    // because a ternary in there would change nothing numerically and would still
    // have to be argued about every time someone reads it.
    if (this.manningField) {
      const nf = this.manningField;
      const { W, H, ng } = this;
      for (let j = ng; j < H - ng; j++) {
        for (let i = ng; i < W - ng; i++) {
          const k = j * W + i, hk = this.h[k];
          if (hk <= this.minDepth) { this.hu[k] = 0; this.hv[k] = 0; continue; }
          const nk = nf[k];
          if (!nk) continue;
          const u = this.vel(this.hu[k], hk), v = this.vel(this.hv[k], hk);
          const speed = Math.hypot(u, v);
          if (speed < 1e-14) continue;
          const denom = 1 + dt * G * nk * nk * speed / Math.pow(hk, 4 / 3);
          this.hu[k] /= denom;
          this.hv[k] /= denom;
        }
      }
      return;
    }
    if (!n) return;
    const { W, H, ng } = this;
    for (let j = ng; j < H - ng; j++) {
      for (let i = ng; i < W - ng; i++) {
        const k = j * W + i, hk = this.h[k];
        if (hk <= this.minDepth) { this.hu[k] = 0; this.hv[k] = 0; continue; }
        const u = this.vel(this.hu[k], hk), v = this.vel(this.hv[k], hk);
        const speed = Math.hypot(u, v);
        if (speed < 1e-14) continue;
        const denom = 1 + dt * G * n * n * speed / Math.pow(hk, 4 / 3);
        this.hu[k] /= denom;
        this.hv[k] /= denom;
      }
    }
  }

  /**
   * Supply a per-cell Manning field, sampled the way bed() is.
   *
   * @param fn  (x, y) -> Manning n, or (lon, lat) on a sphere. Sampled at every cell
   *   centre INCLUDING the ghost rings, so the array indexes exactly like h and b.
   *   Pass null to go back to the scalar.
   */
  setManningField(fn) {
    if (!fn) { this.manningField = null; return this; }
    const N = this.W * this.H, out = new Float64Array(N);
    const sph = this.geom.kind === 'sphere';
    for (let j = 0; j < this.H; j++) {
      for (let i = 0; i < this.W; i++) {
        const [x, y] = sph
          ? this.cellLonLat(i - this.ng, j - this.ng)
          : this.cellCentre(i - this.ng, j - this.ng);
        const v = fn(x, y);
        if (!(v >= 0) || !isFinite(v)) {
          throw new Error(`setManningField: n = ${v} at (${x}, ${y}); Manning n must be finite and >= 0`);
        }
        out[j * this.W + i] = v;
      }
    }
    this.manningField = out;
    return this;
  }

  /** Clean up dry and near-dry cells; returns the mass added by flooring h. */
  dryClean() {
    const { W, H, ng } = this;
    let added = 0;
    for (let j = ng; j < H - ng; j++) {
      for (let i = ng; i < W - ng; i++) {
        const k = j * W + i;
        if (this.h[k] < 0) { added -= this.h[k]; this.h[k] = 0; }
        if (this.h[k] <= this.minDepth) { this.hu[k] = 0; this.hv[k] = 0; }
      }
    }
    return added;
  }

  /**
   * Advance by dt (or by the CFL step if dt is omitted). SSP-RK2.
   *
   * The two stages are a convex combination of forward-Euler steps, which is
   * what makes the scheme total-variation-diminishing: it cannot invent an
   * overshoot at a discontinuity. A plain midpoint RK2 costs the same and does.
   */
  step(dt = null) {
    this.applyBC();
    // maxDt() scans every cell. It used to run on EVERY step, including the ones
    // where the caller had already supplied dt -- and every caller in tools/ does,
    // as sim.step(Math.min(sim.maxDt(), ...)) -- so the grid was scanned twice per
    // step to produce one usable number. The old code then took
    // Math.min(dtMax, this.dxLimit ?? Infinity), and dxLimit was never assigned
    // anywhere in this repository, so the min() was always with Infinity.
    //
    // SMALL, AND THE INSTRUMENT REFUSES TO SAY HOW SMALL. Timing maxDt() where
    // it actually runs -- straight after a residual, with the grid evicted from
    // cache -- means taking the difference of two nearly equal ~70 ms numbers.
    // Five attempts at that on a 320x320 grid, 2026-08-14, each the minimum of
    // four interleaved 80-step runs:
    //
    //   0.468 ms (0.65%)   2.884 ms (3.80%)   2.115 ms (3.27%)
    //   0.669 ms (0.66%)   2.198 ms (3.85%)
    //
    // A sixfold spread. So the honest statement is a bound, not a figure: maxDt()
    // costs somewhere between 0.5 and 3 ms against a step of 60-76 ms, i.e. under
    // 4% and probably nearer 1%, and this method cannot do better. The note here
    // previously read "0.75 ms per call ... against a step that cost 119.34 ms
    // before this work and 48.89 ms after ... 0.6% of the old step"; those came
    // from a machine this one is not, none of them reproduced, and quoting a
    // difference of two large numbers to three significant figures was the error.
    //
    // The conclusion is unchanged and was never the point of contention: removing
    // it is right because a full-grid scan whose answer is discarded does not
    // belong in the hot path, NOT because it was the speedup. It was not.
    const h = dt == null ? this.maxDt() : dt;
    if (!(h > 0) || !isFinite(h)) return 0;

    const N = this.h.length;
    this.h0.set(this.h); this.hu0.set(this.hu); this.hv0.set(this.hv);

    // stage 1
    this.residual(h);
    for (let k = 0; k < N; k++) {
      this.h[k] += h * this.rh[k];
      this.hu[k] += h * this.rhu[k];
      this.hv[k] += h * this.rhv[k];
    }
    this.massFloored = this.dryClean();

    // stage 2
    this.applyBC();
    this.residual(h);
    for (let k = 0; k < N; k++) {
      this.h[k] = 0.5 * (this.h0[k] + this.h[k] + h * this.rh[k]);
      this.hu[k] = 0.5 * (this.hu0[k] + this.hu[k] + h * this.rhu[k]);
      this.hv[k] = 0.5 * (this.hv0[k] + this.hv[k] + h * this.rhv[k]);
    }
    this.massFloored += this.dryClean();

    this.applyFriction(h);
    if (this.forcing) this.forcing(this, h);

    this.t += h;
    this.steps++;
    return h;
  }

  // -- diagnostics ----------------------------------------------------------

  /** Total water volume over the interior [m^3]. */
  volume() {
    const { W, ng, nx, ny } = this;
    // The Cartesian branch sums every cell and multiplies ONCE, which is the
    // summation order the pinned 2.0662e-16 drift figure was measured with;
    // multiplying per row rounds differently and would move it.
    if (this.geom.kind !== 'sphere') {
      let v = 0;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v += this.h[(j + ng) * W + (i + ng)];
      return v * this.dx * this.dy;
    }
    const area = this.geom.area;
    let v = 0;
    for (let j = 0; j < ny; j++) {
      let row = 0;
      for (let i = 0; i < nx; i++) row += this.h[(j + ng) * W + (i + ng)];
      v += row * area[j + ng];
    }
    return v;
  }

  /**
   * Total energy: kinetic + potential relative to the datum [J/rho].
   *
   * NO CALLER. Nothing in src/ or tools/ uses this -- re-checked 2026-08-14 by
   * grepping the tree for `.energy()`, and the only hit is this definition -- so
   * no check exercises it and it cannot be called verified. It is kept because it
   * is the one diagnostic that tells energy the scheme DISSIPATED apart from
   * energy that left through a boundary, which is what every argument about a
   * radiation condition turns into, and because writing it later against a
   * running solver is how people end up calibrating a diagnostic to the answer it
   * is supposed to judge.
   *
   * Checked by hand against closed forms rather than against this solver's own
   * output, on a 40x40 lake at dx = 25 m. Re-run 2026-08-14 during an audit of
   * every number in this file: all three lines below came back digit for digit,
   * which is the only claim in here that needed no correction.
   *   still, bed at datum, h = 10 m   4.90332500000010788e+8  vs g/2 h^2 A
   *                                   4.90332500000000000e+8  rel 2.2e-14
   *   same lake at u = 2 m/s          5.10332500000011206e+8  vs (h u^2/2 + g h^2/2) A
   *                                   5.10332500000000000e+8  rel 2.2e-14
   *   bed 10 m BELOW the datum       -4.90332500000010788e+8  vs g/2 h(h+2b) A
   *                                  -4.90332500000000000e+8  rel 2.2e-14
   * The 1e-14 is the summation order over 1600 cells, not a modelling error.
   * That is a one-off measurement, not a regression guard: nothing re-runs it.
   */
  energy() {
    const { W, ng, nx, ny } = this;
    const sph = this.geom.kind === 'sphere', area = this.geom.area;
    let e = 0;
    for (let j = 0; j < ny; j++) {
      let row = 0;
      for (let i = 0; i < nx; i++) {
        const k = (j + ng) * W + (i + ng), hk = this.h[k];
        if (hk <= 0) continue;
        const u = this.vel(this.hu[k], hk), v = this.vel(this.hv[k], hk);
        row += 0.5 * hk * (u * u + v * v) + 0.5 * G * hk * (hk + 2 * this.b[k]);
      }
      if (sph) e += row * area[j + ng]; else e += row;
    }
    return sph ? e : e * this.dx * this.dy;
  }

  /** Largest |eta - reference| anywhere wet, for the still-water check. */
  maxSurfaceDeviation(ref) {
    const { W, ng, nx, ny } = this;
    let m = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = (j + ng) * W + (i + ng);
        if (this.h[k] <= this.minDepth) continue;
        const d = Math.abs(this.b[k] + this.h[k] - ref);
        if (d > m) m = d;
      }
    }
    return m;
  }

  /** Largest speed anywhere wet [m/s]. */
  maxSpeed() {
    const { W, ng, nx, ny } = this;
    let m = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = (j + ng) * W + (i + ng), hk = this.h[k];
        if (hk <= this.minDepth) continue;
        const s = Math.hypot(this.vel(this.hu[k], hk), this.vel(this.hv[k], hk));
        if (s > m) m = s;
      }
    }
    return m;
  }

  /** Is every field finite? A blow-up must be reported, never inferred. */
  finite() {
    for (let k = 0; k < this.h.length; k++) {
      if (!Number.isFinite(this.h[k]) || !Number.isFinite(this.hu[k]) || !Number.isFinite(this.hv[k])) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// HLLC Riemann solver for the shallow-water equations.
//
// HLL alone smears the contact discontinuity that carries TRANSVERSE momentum,
// so an oblique wave train slowly loses its along-crest velocity and refraction
// comes out weak. HLLC restores that middle wave, and for SWE it costs almost
// nothing: the transverse component is simply advected at the contact speed.
//
// The dry-state wave speeds are Toro's, not an afterthought. If h_L = 0 the left
// wave is not u_L - sqrt(g h_L) -- there is no left state -- it is the head of
// the rarefaction running into the dry bed at u_R - 2 sqrt(g h_R). Using the
// wet-wet formula across a dry front is how a shoreline ends up either frozen or
// launching a spurious jet.
// ---------------------------------------------------------------------------
// SHARED SCRATCH -- safe, and worth less than it looks. The two physical fluxes
// below used to be a fresh pair of arrays on every call that reached the contact
// branch.
//
// Counted 2026-08-14 on a 320x320 grid: 410,880 hllc() calls per step. That one
// is pure geometry -- 2 RK stages x (320x321 x-faces + 321x320 y-faces) -- so it
// does not depend on the flow, and it reproduces the figure written here before
// exactly. How many reach the contact branch DOES depend on the flow, and the
// old note gave one number for it without saying which flow: 100% on an all-wet
// field, but 78.2% (48,525,733 of 62,051,400) over a whole planeBeach run, where
// a dry beach sends the rest out through the dry-state or supercritical exits.
// So between 642,000 and 822,000 short-lived arrays per step.
//
// THAT COUNT IS NOT WHERE THE TIME WENT, and the honest thing is to say so.
// Hoisting them changed the step time by nothing measurable: 0.0570 s/step shared
// against 0.0564 s/step allocating -- the SHARED version came out 0.9% slower,
// which is how you know you are reading noise (5 interleaved 100-step runs each,
// minimum, 320x320). V8 allocates a small array by bumping a pointer, and these
// die before the next scavenge, so the collector never copies them. The change is
// kept because it is free and bit-identical, and because 800,000 allocations per
// step is a genuine cost under a different engine or a larger surviving set --
// but the profile said the arithmetic in residual() was the hot loop, not this,
// and the profile was right.
//
// Bit-identical, checked: 200-step FNV-1a fingerprints of h, hu and hv agree
// between the shipped code, this allocation reverted, and the velocity cache
// reverted, across six scenarios (wavy lake; dam break on a dry bed; order = 1;
// minmod; Coriolis; an island with a wavemaker and a self-timed dt). The
// fingerprint was then MUTATION-TESTED, because a check that cannot fail proves
// nothing: nudging one cell by 1e-12 m or 1e-9 m is detected, and the first
// attempt at that control used 1e-15 m on h = 18.87 m, where the double spacing
// is 4.4e-15 -- the nudge was a no-op and the "control" was passing by doing
// nothing.
//
// Safety: the solver is single-threaded and hllc() is not re-entrant -- no await,
// no callback, and nothing else in this file reads these two arrays -- so one
// shared pair cannot be observed by anyone. A worker-per-tile parallelisation
// would still be safe, since each worker gets its own module instance; two
// INTERLEAVED hllc() calls in one realm would not be, and that needs an async
// boundary this function does not have.
const FLs = [0, 0, 0], FRs = [0, 0, 0];
export function hllc(out, hL, huL, hvL, hR, huR, hvR, dry = 1e-4) {
  const wetL = hL > dry, wetR = hR > dry;
  if (!wetL && !wetR) { out[0] = out[1] = out[2] = 0; return out; }

  const uL = wetL ? huL / hL : 0, vL = wetL ? hvL / hL : 0;
  const uR = wetR ? huR / hR : 0, vR = wetR ? hvR / hR : 0;
  const cL = Math.sqrt(G * Math.max(hL, 0)), cR = Math.sqrt(G * Math.max(hR, 0));

  let sL, sR;
  if (!wetL) { sL = uR - 2 * cR; sR = uR + cR; }
  else if (!wetR) { sL = uL - cL; sR = uL + 2 * cL; }
  else {
    // Einfeldt / two-rarefaction estimates, which bound the true speeds for SWE.
    const hStar = ((cL + cR) / 2 + (uL - uR) / 4) ** 2 / G;
    const qL = hStar > hL ? Math.sqrt(0.5 * (hStar + hL) * hStar / (hL * hL)) : 1;
    const qR = hStar > hR ? Math.sqrt(0.5 * (hStar + hR) * hStar / (hR * hR)) : 1;
    sL = uL - cL * qL;
    sR = uR + cR * qR;
  }
  if (sL >= 0) { flux1D(out, hL, huL, hvL, uL); return out; }
  if (sR <= 0) { flux1D(out, hR, huR, hvR, uR); return out; }

  // contact speed
  const num = sL * hR * (uR - sR) - sR * hL * (uL - sL);
  const den = hR * (uR - sR) - hL * (uL - sL);
  const sM = Math.abs(den) > 1e-30 ? num / den : 0.5 * (sL + sR);

  flux1D(FLs, hL, huL, hvL, uL);
  flux1D(FRs, hR, huR, hvR, uR);
  // HLL for mass and normal momentum...
  const inv = 1 / (sR - sL);
  out[0] = (sR * FLs[0] - sL * FRs[0] + sL * sR * (hR - hL)) * inv;
  out[1] = (sR * FLs[1] - sL * FRs[1] + sL * sR * (huR - huL)) * inv;
  // ...and the contact wave decides which side's transverse momentum is carried.
  out[2] = out[0] * (sM >= 0 ? vL : vR);
  return out;
}

function flux1D(out, h, hu, hv, u) {
  out[0] = hu;
  out[1] = hu * u + 0.5 * G * h * h;
  out[2] = hv * u;
  return out;
}

// ---------------------------------------------------------------------------
// Boundary conditions. Each is (sim, i, j, side, ghostIndex) and writes the
// ghost cell (i,j). side: 0 west, 1 east, 2 south, 3 north.
// ---------------------------------------------------------------------------

/** Solid wall: mirror the state, reverse the normal momentum. */
export function reflect(sim, i, j, side) {
  const { nx, ny } = sim;
  let si = i, sj = j;
  if (side === 0) si = -1 - i; else if (side === 1) si = 2 * nx - 1 - i;
  else if (side === 2) sj = -1 - j; else sj = 2 * ny - 1 - j;
  si = Math.max(0, Math.min(nx - 1, si));
  sj = Math.max(0, Math.min(ny - 1, sj));
  const g = sim.idx(i, j), s = sim.idx(si, sj);
  sim.b[g] = sim.b[s];
  sim.h[g] = sim.h[s];
  const flipX = side === 0 || side === 1;
  sim.hu[g] = flipX ? -sim.hu[s] : sim.hu[s];
  sim.hv[g] = flipX ? sim.hv[s] : -sim.hv[s];
}

/** Zero-gradient. Cheap, and it reflects long waves; prefer flather(). */
export function outflow(sim, i, j, side) {
  const { nx, ny } = sim;
  const si = Math.max(0, Math.min(nx - 1, i));
  const sj = Math.max(0, Math.min(ny - 1, j));
  const g = sim.idx(i, j), s = sim.idx(si, sj);
  sim.b[g] = sim.b[s]; sim.h[g] = sim.h[s]; sim.hu[g] = sim.hu[s]; sim.hv[g] = sim.hv[s];
}

/**
 * Flather radiation condition: prescribe the INCOMING signal and let everything
 * else leave.
 *
 * THE FIRST VERSION OF THIS REFLECTED 98.19% OF AN OUTGOING PULSE. It clamped the
 * ghost ELEVATION to the external value and applied the radiation formula only to
 * the velocity, and a clamped elevation is a Dirichlet boundary, which reflects
 * with coefficient -1. Nothing looked wrong: the tide went in, the basin
 * responded, and every resonance number was quietly the domain talking to itself.
 *
 * Re-measured 2026-08-14, and this is the one historical claim in this file that
 * could be checked against the real thing rather than a reconstruction: the
 * pre-fix function was recovered with `git show 0bb0817^:src/swe.mjs` and run
 * through the section-3 rig of tools/verify-tide.mjs alongside today's, so all
 * three numbers come off the same ruler.
 *
 *   solid wall (the control)                98.19%
 *   Flather at 0bb0817^, the version above  98.19%
 *   Flather as shipped                       0.12%
 *
 * The old boundary returned 100.0% of what a solid wall returns, to four figures.
 * "A mirror wearing a radiation condition's name" was not a figure of speech.
 *
 * The fix is to split the state into characteristics and replace ONLY the one
 * that enters the domain. The outgoing invariant is taken from the interior and
 * passed through untouched, which is what makes the boundary transparent.
 *
 * This is exact for a linear long wave at normal incidence. A steep or oblique
 * wave still returns a little; tools/verify-tide.mjs measures the coefficient
 * rather than assuming it, and reports a solid wall alongside as the control.
 *
 * @param etaExt (t) => elevation of the external tide/wave [m]
 * @param uExt   (t) => external normal velocity [m/s], usually 0
 */
export function flather(etaExt, uExt = () => 0) {
  return (sim, i, j, side) => {
    const { nx, ny } = sim;
    const si = Math.max(0, Math.min(nx - 1, i));
    const sj = Math.max(0, Math.min(ny - 1, j));
    const g = sim.idx(i, j), s = sim.idx(si, sj);
    sim.b[g] = sim.b[s];
    const bed = sim.b[g];
    const hInt = sim.h[s];
    const e0 = etaExt(sim.t), u0 = uExt(sim.t);
    if (hInt <= sim.minDepth) { sim.h[g] = Math.max(0, e0 - bed); sim.hu[g] = 0; sim.hv[g] = 0; return; }
    const etaInt = bed + hInt;
    const r = Math.sqrt(G / hInt);
    // Sign of the OUTWARD normal: +1 where the domain lies to the right of the
    // face (west, south), -1 where it lies to the left (east, north).
    const sgn = (side === 0 || side === 2) ? 1 : -1;
    // Split into characteristics and replace only the one that enters.
    //
    //   incoming (prescribed):  Rin  = u_ext + sgn * eta_ext * sqrt(g/h)
    //   outgoing (from inside): Rout = u_int - sgn * eta_int * sqrt(g/h)
    //
    // then u = (Rin + Rout)/2 and eta = sgn*(Rin - Rout)/(2 sqrt(g/h)).
    const uInt = (side === 0 || side === 1)
      ? sim.vel(sim.hu[s], hInt) : sim.vel(sim.hv[s], hInt);
    const Rin = u0 + sgn * e0 * r;
    const Rout = uInt - sgn * etaInt * r;
    const un = 0.5 * (Rin + Rout);
    const en = sgn * (Rin - Rout) / (2 * r);
    sim.h[g] = Math.max(0, en - bed);
    if (side === 0 || side === 1) { sim.hu[g] = sim.h[g] * un; sim.hv[g] = sim.hv[s]; }
    else { sim.hv[g] = sim.h[g] * un; sim.hu[g] = sim.hu[s]; }
  };
}

/** Periodic in x (side 0/1) or y (side 2/3). */
export function periodic(sim, i, j, side) {
  const { nx, ny } = sim;
  let si = i, sj = j;
  if (side === 0) si = i + nx; else if (side === 1) si = i - nx;
  else if (side === 2) sj = j + ny; else sj = j - ny;
  const g = sim.idx(i, j), s = sim.idx(si, sj);
  sim.b[g] = sim.b[s]; sim.h[g] = sim.h[s]; sim.hu[g] = sim.hu[s]; sim.hv[g] = sim.hv[s];
}

/**
 * A sponge layer: relax the solution toward a reference over the last `width`
 * cells, so an outgoing wave is absorbed rather than reflected.
 *
 * TWO CORRECTIONS TO WHAT THIS DOCSTRING USED TO SAY.
 *
 * It said UNUSED -- "Nothing in this repository calls makeSponge: tools/waves.mjs
 * imports the name and then deliberately does not use it." That is false.
 * tools/waves.mjs calls it inside simulate(), as
 * `if (sponge) sim.forcing = makeSponge(sim, { side: 'east', etaRef: msl,
 * ...sponge })`, and the `shoal` case switches it on with `{ width: 40, strength:
 * 0.08 }` because that case ends in open water with no beach to absorb anything.
 * What tools/waves.mjs declines to do is put one on the WAVEMAKER boundary, which
 * is a different statement entirely. The offshore-shoal result depends on this
 * function, so "delete it" was bad advice.
 *
 * It said UNVERIFIED, and that WAS true: nothing had ever measured what it
 * absorbs. Measured 2026-08-14 -- a right-going Gaussian pulse (A = 0.1 m, sigma
 * 150 m) down a flat 10 m channel, dx = 5 m, Manning 0, gauge at x = 1503 m,
 * taking the largest return at that gauge after the pulse has reached the far
 * end:
 *
 *   solid wall (the control)           98.74%
 *   Flather radiation                   0.12%
 *   sponge width 20, strength 0.06      0.13%
 *   sponge width 40, strength 0.08      0.12%
 *
 * So it works, and on this problem it is indistinguishable from Flather. The
 * control returns 98.74%, so the measurement can tell a mirror from an absorber.
 * This is one long wave at normal incidence and claims nothing beyond that.
 *
 * NOT ON THE INCOMING BOUNDARY, and the size of that mistake is worth recording.
 * Same measurement rig on planeBeach, a 0.8 m 14 s wave, gauge at x = 400 m:
 *
 *   no sponge                       0.7799 m arrives
 *   west sponge w20, strength 0.06  3.150e-05 m
 *   west sponge w40, strength 0.08  3.711e-12 m
 *
 * That is annihilation, not attenuation. The figure carried here before -- "a
 * requested 0.8 m wave arrived as 0.16 m", quoted from a comment in
 * tools/waves.mjs -- does not reproduce at either setting, and understates what
 * happens by four to eleven orders of magnitude.
 *
 * Note also that the relaxation rate is `strength * dt * 60`: `strength` is a
 * fraction per 1/60 s frame, not a rate per second.
 */
export function makeSponge(sim, { side = 'east', width = 20, strength = 0.06, etaRef = 0 }) {
  const { nx, ny, W, ng } = sim;
  const cells = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let d;
      if (side === 'east') d = nx - 1 - i; else if (side === 'west') d = i;
      else if (side === 'north') d = ny - 1 - j; else d = j;
      if (d >= width) continue;
      // cos^2 taper: a sponge with a hard edge reflects off its own front face.
      const s = strength * Math.cos(0.5 * Math.PI * d / width) ** 2;
      cells.push([(j + ng) * W + (i + ng), s]);
    }
  }
  return (s2, dt) => {
    const ref = typeof etaRef === 'function' ? etaRef(s2.t) : etaRef;
    for (const [k, str] of cells) {
      const f = Math.min(1, str * dt * 60);
      const target = Math.max(0, ref - s2.b[k]);
      s2.h[k] += (target - s2.h[k]) * f;
      s2.hu[k] -= s2.hu[k] * f;
      s2.hv[k] -= s2.hv[k] * f;
    }
  };
}
