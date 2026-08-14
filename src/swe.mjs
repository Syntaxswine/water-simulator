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
// wave travels at sqrt(g*h) regardless of wavelength. That is correct to within
// a few percent for kh < 0.5 -- tides, surges, tsunamis, and swell once it is
// well inside the surf zone -- and increasingly wrong in deeper water, where the
// truth is omega^2 = g*k*tanh(k*h). There is no dispersive term here and no
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
// sweep) and p comes out +0.152, -0.179, -0.236, -0.238 for offshore heights of
// 0.8, 0.2, 0.05 and 0.012 m, against Green's law p = -0.25. So the small-
// amplitude limit is recovered, and at 0.8 m the exponent has the WRONG SIGN:
// that wave loses height as it shoals. Bed friction is not the cause -- with
// Manning switched off the 0.8 m case moves only from 0.154 to 0.152. Do not
// quote this solver for deep-water wind sea, and do not quote its shoaling for
// waves steep enough to break before they arrive.
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
 * over a flat bed with no physics to take it. Measured on a 10 s wave in 12 m of
 * water at 22 cells per wavelength: minmod lost a factor of 5.9 in amplitude over
 * 1100 m, which is eleven wavelengths of travel and about a tenth of the way
 * across any real bay. A wave model that cannot carry a wave to the beach is not
 * a wave model.
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
   *   all exceed the film -- and a solver that takes such a cell seriously will
   *   happily report it moving at 40 m/s, which is measured, not hypothetical.
   * @param cfl        Courant number; 0.45 is safe for 2D SSP-RK2 + MUSCL
   * @param coriolis   f [1/s]; 2*Omega*sin(lat). Zero for a beach, not for a shelf.
   */
  constructor({
    nx, ny, dx, dy = dx, bed, eta0 = 0, manning = 0.025,
    minDepth = 1e-3, cfl = 0.45, coriolis = 0, order = 2, limiter = 'mc',
  }) {
    this.nx = nx; this.ny = ny; this.dx = dx; this.dy = dy;
    this.manning = manning; this.minDepth = minDepth; this.cfl = cfl;
    // vel()'s desingularisation constant, which depends only on minDepth. Cached
    // because vel() is the most-called function in the solver; nothing in this
    // repository assigns sim.minDepth after construction, and anything that did
    // would have to recompute this alongside it.
    this.eps4 = Math.max(minDepth, 1e-12) ** 4;
    this.coriolis = coriolis; this.order = order;
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
        const [x, y] = this.cellCentre(i - this.ng, j - this.ng);
        this.b[k] = bed(x, y);
        const e = typeof eta0 === 'function' ? eta0(x, y) : eta0;
        this.h[k] = Math.max(0, e - this.b[k]);
      }
    }

    this.t = 0;
    this.steps = 0;
    this.boundaries = { west: reflect, east: reflect, south: reflect, north: reflect };
    this.forcing = null;              // optional (sim, dt) => void, e.g. a tidal potential
    this.stats = {};
  }

  cellCentre(i, j) { return [(i + 0.5) * this.dx, (j + 0.5) * this.dy]; }
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
    const { W, H, ng, dx, dy, minDepth } = this;
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
    // cells, and they used to ask for it separately: counted 4,066,992 vel()
    // calls per step on a 320x320 grid, i.e. 39 per cell per step for 104,976
    // cells. This one change is essentially the whole speedup of this file --
    // 0.1230 -> 0.0503 s/step, minimum of 4 interleaved 100-step runs each --
    // and end to end the same benchmark went 0.1181 -> 0.0485 s/step (200 steps,
    // 4 runs each, minimum), a factor of 2.43.
    //
    // It is a pure caching change and has to be provable as one: vel() is a pure
    // function of (hu, h), and nothing writes hu or h during a residual, so the
    // cached value is the SAME double rather than an approximation of it. The
    // 200-step state fingerprint is bit-identical before and after (FNV-1a over
    // the raw bytes of h, hu, hv: 751585954432b699 either way), as are five other
    // scenarios chosen to hit the dry front, first order, minmod, Coriolis and
    // both dt branches.
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
            // still lake with an island in it develops a permanent 0.34 m/s
            // current radiating outward. Measured, before this guard.
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
    // A cell cannot give away more water than it has. The leading film of a dam
    // break is thinner than one step's worth of outflow -- measured, h = 3e-4 m
    // draining at 12 m/s -- so a cell empties past zero, gets floored back to
    // zero, and leaves a HOLE in the middle of the sheet. Its neighbour then
    // accelerates into that hole: 166 m/s, then 1e40 m/s, and the run stops
    // advancing while remaining perfectly finite the whole way.
    //
    // So scale the outgoing fluxes of any cell that would over-draw, by the one
    // factor that just empties it. Because the SAME scaled flux is handed to
    // both neighbours, mass is still conserved exactly; and because a still lake
    // has zero flux everywhere, theta is 1 and well-balancing is untouched.
    const theta = this.theta;
    theta.fill(1);
    if (dt > 0) {
      for (let j = ng - 1; j < H - ng + 1; j++) {
        for (let i = ng - 1; i < W - ng + 1; i++) {
          const k = j * W + i;
          let out = 0;
          if (fxM[k] > 0) out += fxM[k] / dx;
          if (fxM[k - 1] < 0) out -= fxM[k - 1] / dx;
          if (fyM[k] > 0) out += fyM[k] / dy;
          if (fyM[k - W] < 0) out -= fyM[k - W] / dy;
          const avail = h[k];
          if (out * dt > avail) theta[k] = avail > 0 ? avail / (out * dt) : 0;
        }
      }
    }
    for (let j = ng; j < H - ng; j++) {
      for (let i = ng - 1; i < W - ng; i++) {
        const kL = j * W + i, kR = kL + 1;
        const th = fxM[kL] >= 0 ? theta[kL] : theta[kR];
        const inv = th / dx;
        rh[kL] -= fxM[kL] * inv; rhu[kL] -= (fxN[kL] + pxL[kL]) * inv; rhv[kL] -= fxT[kL] * inv;
        rh[kR] += fxM[kL] * inv; rhu[kR] += (fxN[kL] + pxR[kL]) * inv; rhv[kR] += fxT[kL] * inv;
      }
    }
    for (let j = ng - 1; j < H - ng; j++) {
      for (let i = ng; i < W - ng; i++) {
        const kL = j * W + i, kR = kL + W;
        const th = fyM[kL] >= 0 ? theta[kL] : theta[kR];
        const inv = th / dy;
        rh[kL] -= fyM[kL] * inv; rhv[kL] -= (fyN[kL] + pyL[kL]) * inv; rhu[kL] -= fyT[kL] * inv;
        rh[kR] += fyM[kL] * inv; rhv[kR] += (fyN[kL] + pyR[kL]) * inv; rhu[kR] += fyT[kL] * inv;
      }
    }

    // ---- centred bed term, needed for 2nd-order well-balancing ------------
    if (this.order >= 2) {
      for (let j = ng; j < H - ng; j++) {
        for (let i = ng; i < W - ng; i++) {
          const k = j * W + i, k2 = 2 * k, bk = b[k];
          const eC = bk + h[k];
          for (let d = 0; d < 2; d++) {
            const hP = Math.max(0, eC + 0.5 * sE[k2 + d] - (bk + 0.5 * sB[k2 + d]));
            const hM = Math.max(0, eC - 0.5 * sE[k2 + d] - (bk - 0.5 * sB[k2 + d]));
            const db = sB[k2 + d];
            const term = -G * 0.5 * (hP + hM) * db / (d === 0 ? dx : dy);
            if (d === 0) rhu[k] += term; else rhv[k] += term;
          }
        }
      }
    }

    // ---- Coriolis ---------------------------------------------------------
    if (this.coriolis) {
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
    const { W, H, ng, dx, dy } = this;
    let inv = 0;
    for (let j = ng; j < H - ng; j++) {
      for (let i = ng; i < W - ng; i++) {
        const k = j * W + i, hk = this.h[k];
        if (hk <= this.minDepth) continue;
        const c = Math.sqrt(G * hk);
        const u = Math.abs(this.vel(this.hu[k], hk)), v = Math.abs(this.vel(this.hv[k], hk));
        const s = (u + c) / dx + (v + c) / dy;
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
    // SMALL: maxDt() costs 0.75 ms per call timed where it actually runs, i.e.
    // straight after a residual has evicted the grid from cache, against a step
    // that cost 119.34 ms before this work and 48.89 ms after. So this removes
    // 0.6% of the old step and it is invisible in an A/B against machine noise.
    // It is still the right change -- a full-grid scan whose answer is discarded
    // is not something to leave in the hot path -- but it is not the speedup.
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
    const { W, ng, nx, ny, dx, dy } = this;
    let v = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v += this.h[(j + ng) * W + (i + ng)];
    return v * dx * dy;
  }

  /**
   * Total energy: kinetic + potential relative to the datum [J/rho].
   *
   * NO CALLER. Nothing in src/ or tools/ uses this, so no check exercises it and
   * it cannot be called verified. It is kept because it is the one diagnostic
   * that tells energy the scheme DISSIPATED apart from energy that left through
   * a boundary, which is what every argument about a radiation condition turns
   * into, and because writing it later against a running solver is how people
   * end up calibrating a diagnostic to the answer it is supposed to judge.
   *
   * Checked once by hand (2026-08-14) against closed forms rather than against
   * this solver's own output, on a 40x40 lake at dx = 25 m:
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
    const { W, ng, nx, ny, dx, dy } = this;
    let e = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = (j + ng) * W + (i + ng), hk = this.h[k];
        if (hk <= 0) continue;
        const u = this.vel(this.hu[k], hk), v = this.vel(this.hv[k], hk);
        e += 0.5 * hk * (u * u + v * v) + 0.5 * G * hk * (hk + 2 * this.b[k]);
      }
    }
    return e * dx * dy;
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
// branch: counted on a 320x320 grid, 410,880 hllc() calls per step of which
// 321,428 reach that branch, i.e. 642,856 short-lived arrays per step.
//
// THAT COUNT IS NOT WHERE THE TIME WENT, and the honest thing is to say so.
// Hoisting them changed the step time by nothing measurable: 0.1230 s/step with
// the allocations against 0.1231 without (minimum of 4 interleaved 100-step runs
// each, 320x320, on a machine with other work on it). V8 allocates a small array
// by bumping a pointer, and these die before the next scavenge, so the collector
// never copies them. The change is kept because it is free and bit-identical, and
// because 642,856 allocations per step is a genuine cost under a different engine
// or a larger surviving set -- but the profile said the arithmetic in residual()
// was the hot loop, not this, and the profile was right.
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
 * THE FIRST VERSION OF THIS REFLECTED 98.19% OF AN OUTGOING PULSE -- measured
 * against a solid wall at 98.2%, i.e. it was a mirror wearing a radiation
 * condition's name. It clamped the ghost ELEVATION to the external value and
 * applied the radiation formula only to the velocity, and a clamped elevation is
 * a Dirichlet boundary, which reflects with coefficient -1. Nothing looked
 * wrong: the tide went in, the basin responded, and every resonance number was
 * quietly the domain talking to itself.
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
 * UNUSED AND UNVERIFIED, and this docstring used to claim otherwise. It said
 * "tools/verify.mjs measures what the pair actually absorb". There is no such
 * check. Nothing in this repository calls makeSponge: tools/waves.mjs imports
 * the name and then deliberately does not use it, because a sponge on the
 * WAVEMAKER boundary damps the incident wave -- its comment records a requested
 * 0.8 m wave arriving as 0.16 m. So the absorption of this function has never
 * been measured, by anything, and the reasoning above about Flather's residual
 * reflection is an argument for why a sponge might help, not evidence that this
 * one does.
 *
 * It is kept rather than deleted only because the export is imported by
 * tools/waves.mjs, and a named import of a missing export is a link-time
 * SyntaxError -- the tool would not start, and tools/ is not mine to edit in the
 * same change. Delete the function and that import together, or write a check
 * that sends a pulse into it and measures what comes back. An absorber nobody
 * has measured is exactly the thing that quietly eats the signal you came to
 * measure.
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
