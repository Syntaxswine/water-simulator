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
//   - MUSCL reconstruction of (eta, u, v), minmod limited -> 2nd order in space.
//     Reconstructing ETA and not h is what keeps lake-at-rest exact at 2nd order.
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
// truth is omega^2 = g*k*tanh(k*h). src/boussinesq.mjs adds the dispersion
// correction and tools/dispersion.mjs measures what it buys. Do not quote this
// solver for deep-water wind sea.
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
    const eps4 = Math.max(this.minDepth, 1e-12) ** 4;
    const h4 = h * h * h * h;
    return (Math.SQRT2 * h * hq) / Math.sqrt(h4 + Math.max(h4, eps4));
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
    const { W, H, ng, nx, ny, dx, dy } = this;
    const h = this.h, hu = this.hu, hv = this.hv, b = this.b;
    const rh = this.rh, rhu = this.rhu, rhv = this.rhv;
    rh.fill(0); rhu.fill(0); rhv.fill(0);
    this.fxM.fill(0); this.fyM.fill(0);

    // ---- slopes ----------------------------------------------------------
    const sE = this.sE, sU = this.sU, sV = this.sV, sB = this.sB;
    const lim = this.limit;
    if (this.order >= 2) {
      for (let j = 1; j < H - 1; j++) {
        for (let i = 1; i < W - 1; i++) {
          const k = j * W + i;
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
            if (h[k] <= this.minDepth || h[kp] <= this.minDepth || h[km] <= this.minDepth) {
              sE[2 * k + d] = 0; sB[2 * k + d] = 0; sU[2 * k + d] = 0; sV[2 * k + d] = 0;
              continue;
            }
            const eC = b[k] + h[k], eP = b[kp] + h[kp], eM = b[km] + h[km];
            sE[2 * k + d] = lim(eC - eM, eP - eC);
            sB[2 * k + d] = lim(b[k] - b[km], b[kp] - b[k]);
            const uC = this.vel(hu[k], h[k]), uP = this.vel(hu[kp], h[kp]), uM = this.vel(hu[km], h[km]);
            sU[2 * k + d] = lim(uC - uM, uP - uC);
            const vC = this.vel(hv[k], h[k]), vP = this.vel(hv[kp], h[kp]), vM = this.vel(hv[km], h[km]);
            sV[2 * k + d] = lim(vC - vM, vP - vC);
          }
        }
      }
    } else { sE.fill(0); sU.fill(0); sV.fill(0); sB.fill(0); }

    // ---- x interfaces ----------------------------------------------------
    const FL = [0, 0, 0], FR = [0, 0, 0], flux = [0, 0, 0];
    for (let j = ng; j < H - ng; j++) {
      for (let i = ng - 1; i < W - ng; i++) {
        const kL = j * W + i, kR = kL + 1;
        // reconstructed states at the shared face
        const etaL = b[kL] + h[kL] + 0.5 * sE[2 * kL];
        const etaR = b[kR] + h[kR] - 0.5 * sE[2 * kR];
        const bL = b[kL] + 0.5 * sB[2 * kL];
        const bR = b[kR] - 0.5 * sB[2 * kR];
        const hLf = Math.max(0, etaL - bL);
        const hRf = Math.max(0, etaR - bR);
        const uL = this.vel(hu[kL], h[kL]) + 0.5 * sU[2 * kL];
        const uR = this.vel(hu[kR], h[kR]) - 0.5 * sU[2 * kR];
        const vL = this.vel(hv[kL], h[kL]) + 0.5 * sV[2 * kL];
        const vR = this.vel(hv[kR], h[kR]) - 0.5 * sV[2 * kR];

        // hydrostatic reconstruction against the higher bed
        const bStar = Math.max(bL, bR);
        const hsL = Math.max(0, etaL - bStar);
        const hsR = Math.max(0, etaR - bStar);
        hllc(flux, hsL, hsL * uL, hsL * vL, hsR, hsR * uR, hsR * vR, this.minDepth);

        // Interface-local pressure corrections. This is the well-balancing: the
        // flux each cell sees is the Riemann flux plus the difference between
        // its OWN hydrostatic pressure and the reconstructed one, so a flat
        // surface produces g/2*h^2 on both sides and nothing moves.
        const pL = 0.5 * G * (hLf * hLf - hsL * hsL);
        const pR = 0.5 * G * (hRf * hRf - hsR * hsR);
        this.fxM[kL] = flux[0]; this.fxN[kL] = flux[1]; this.fxT[kL] = flux[2];
        this.pxL[kL] = pL; this.pxR[kL] = pR;
      }
    }

    // ---- y interfaces ----------------------------------------------------
    for (let j = ng - 1; j < H - ng; j++) {
      for (let i = ng; i < W - ng; i++) {
        const kL = j * W + i, kR = kL + W;
        const etaL = b[kL] + h[kL] + 0.5 * sE[2 * kL + 1];
        const etaR = b[kR] + h[kR] - 0.5 * sE[2 * kR + 1];
        const bL = b[kL] + 0.5 * sB[2 * kL + 1];
        const bR = b[kR] - 0.5 * sB[2 * kR + 1];
        const hLf = Math.max(0, etaL - bL);
        const hRf = Math.max(0, etaR - bR);
        const uL = this.vel(hu[kL], h[kL]) + 0.5 * sU[2 * kL + 1];
        const uR = this.vel(hu[kR], h[kR]) - 0.5 * sU[2 * kR + 1];
        const vL = this.vel(hv[kL], h[kL]) + 0.5 * sV[2 * kL + 1];
        const vR = this.vel(hv[kR], h[kR]) - 0.5 * sV[2 * kR + 1];

        const bStar = Math.max(bL, bR);
        const hsL = Math.max(0, etaL - bStar);
        const hsR = Math.max(0, etaR - bStar);
        // Same solver, axes swapped: pass v as the normal component and u as the
        // tangential one, then swap back. One Riemann solver, no second copy to
        // drift out of step with the first.
        hllc(flux, hsL, hsL * vL, hsL * uL, hsR, hsR * vR, hsR * uR, this.minDepth);

        const pL = 0.5 * G * (hLf * hLf - hsL * hsL);
        const pR = 0.5 * G * (hRf * hRf - hsR * hsR);
        this.fyM[kL] = flux[0]; this.fyN[kL] = flux[1]; this.fyT[kL] = flux[2];
        this.pyL[kL] = pL; this.pyR[kL] = pR;
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
          if (this.fxM[k] > 0) out += this.fxM[k] / dx;
          if (this.fxM[k - 1] < 0) out -= this.fxM[k - 1] / dx;
          if (this.fyM[k] > 0) out += this.fyM[k] / dy;
          if (this.fyM[k - W] < 0) out -= this.fyM[k - W] / dy;
          const avail = h[k];
          if (out * dt > avail) theta[k] = avail > 0 ? avail / (out * dt) : 0;
        }
      }
    }
    for (let j = ng; j < H - ng; j++) {
      for (let i = ng - 1; i < W - ng; i++) {
        const kL = j * W + i, kR = kL + 1;
        const th = this.fxM[kL] >= 0 ? theta[kL] : theta[kR];
        const inv = th / dx;
        rh[kL] -= this.fxM[kL] * inv; rhu[kL] -= (this.fxN[kL] + this.pxL[kL]) * inv; rhv[kL] -= this.fxT[kL] * inv;
        rh[kR] += this.fxM[kL] * inv; rhu[kR] += (this.fxN[kL] + this.pxR[kL]) * inv; rhv[kR] += this.fxT[kL] * inv;
      }
    }
    for (let j = ng - 1; j < H - ng; j++) {
      for (let i = ng; i < W - ng; i++) {
        const kL = j * W + i, kR = kL + W;
        const th = this.fyM[kL] >= 0 ? theta[kL] : theta[kR];
        const inv = th / dy;
        rh[kL] -= this.fyM[kL] * inv; rhv[kL] -= (this.fyN[kL] + this.pyL[kL]) * inv; rhu[kL] -= this.fyT[kL] * inv;
        rh[kR] += this.fyM[kL] * inv; rhv[kR] += (this.fyN[kL] + this.pyR[kL]) * inv; rhu[kR] += this.fyT[kL] * inv;
      }
    }

    // ---- centred bed term, needed for 2nd-order well-balancing ------------
    if (this.order >= 2) {
      for (let j = ng; j < H - ng; j++) {
        for (let i = ng; i < W - ng; i++) {
          const k = j * W + i;
          const eC = b[k] + h[k];
          for (let d = 0; d < 2; d++) {
            const hP = Math.max(0, eC + 0.5 * sE[2 * k + d] - (b[k] + 0.5 * sB[2 * k + d]));
            const hM = Math.max(0, eC - 0.5 * sE[2 * k + d] - (b[k] - 0.5 * sB[2 * k + d]));
            const db = sB[2 * k + d];
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
    const dtMax = this.maxDt();
    const h = dt == null ? Math.min(dtMax, this.dxLimit ?? Infinity) : dt;
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

  /** Total energy: kinetic + potential relative to the datum [J/rho]. */
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

  const FL = [0, 0, 0], FR = [0, 0, 0];
  flux1D(FL, hL, huL, hvL, uL);
  flux1D(FR, hR, huR, hvR, uR);
  // HLL for mass and normal momentum...
  const inv = 1 / (sR - sL);
  out[0] = (sR * FL[0] - sL * FR[0] + sL * sR * (hR - hL)) * inv;
  out[1] = (sR * FL[1] - sL * FR[1] + sL * sR * (huR - huL)) * inv;
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
 *     u = u_ext +/- sqrt(g/h) * (eta - eta_ext)
 *
 * This is the boundary a tide needs. A prescribed-elevation boundary is a
 * perfect mirror to anything travelling outward, so a domain driven by a
 * clamped tide slowly fills with its own reflections and the range at the head
 * of the bay comes out too large -- which reads exactly like the resonance you
 * were hoping to see. Flather lets the reflected wave out and keeps the forcing.
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
    const e0 = etaExt(sim.t), u0 = uExt(sim.t);
    const hInt = sim.h[s];
    if (hInt <= sim.minDepth) { sim.h[g] = Math.max(0, e0 - bed); sim.hu[g] = 0; sim.hv[g] = 0; return; }
    const etaInt = bed + hInt;
    const c = Math.sqrt(G / hInt);
    // Sign: the outgoing characteristic leaves through this face.
    const sgn = (side === 0 || side === 2) ? 1 : -1;
    const un = u0 + sgn * c * (etaInt - e0);
    sim.h[g] = Math.max(0, e0 - bed);
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
 * Flather is exact only for a linear normal-incidence long wave. A steep or
 * oblique wave still returns a few percent of its amplitude, and a few percent
 * arriving back at a wavemaker for a hundred periods is not a few percent. The
 * sponge is the belt to Flather's braces; tools/verify.mjs measures what the
 * pair actually absorb rather than assuming it is enough.
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
