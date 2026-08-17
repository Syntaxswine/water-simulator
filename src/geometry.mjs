// ---------------------------------------------------------------------------
// The METRIC: how big a cell is, how long its faces are, and where it sits.
//
// A finite-volume update is two separable things -- a Riemann problem at a face,
// and the bookkeeping of areas and face lengths that turns face fluxes into cell
// averages -- and only the second one knows what shape the world is. src/swe.mjs
// does the first. Everything geometric is here, so a spherical run and a
// Cartesian run share one solver instead of two that drift apart.
//
// WHY THE DIVISORS ARE STORED AS DIVISORS and not as premultiplied reciprocals.
// The Cartesian path must stay BIT-IDENTICAL: five suites pin numbers like a
// resting lake at 4.4409e-16 m and volume drift at 2.0662e-16, which is exactly
// the resolution at which `x * (1/dx)` stops equalling `x / dx`. So
// cartesianGeometry() ASSIGNS the scalar dx into every row rather than deriving
// it from an area and a face length, and swe.mjs keeps dividing. Same double,
// same division, same bits.
//
// THE THREE SPHERICAL CHOICES THAT ARE NOT NEGOTIABLE. A lake at rest is a
// HARDER test on a sphere than in Cartesian, because a cell's north and south
// faces have different lengths (R dlam cos(phi), at two different phi), so the
// hydrostatic pressure g h^2/2 -- identical on both faces -- does not cancel.
// The leftover is not small: at h = 4000 m and 45 degrees it is 12.3 m/s^2,
// larger than g. The momentum equation's curvature term absorbs it, and absorbs
// it EXACTLY only if all three of these are written the way the flux is written:
//
//   area     R^2 dlam (sin phi_N - sin phi_S)   NOT R^2 cos(phi) dlam dphi
//   geoCoef  -(tan phi / 4R), applied to G*(h_N^2 + h_S^2)
//                                            NOT -(G/2) h_cell^2 tan(phi)/R
//   bedPhi   2 area / (ly_N + ly_S)             NOT R dphi
//
// The cancellation is an identity, not an approximation, and it hangs on phi_C
// being the ARITHMETIC mean of the two face latitudes. Writing
// sin phi_N - sin phi_S = 2 cos(phi_C) sin(dphi/2) = 2P and
// cos phi_S - cos phi_N = 2 sin(phi_C) sin(dphi/2) = 2S gives S/P = tan(phi_C)
// exactly, which is what lets the h_N^2 + h_S^2 term kill the geometric part and
// the (ly_N + ly_S)/2A coefficient kill the bed part. The area-bisecting latitude
// asin((sin phi_N + sin phi_S)/2) looks more principled and breaks it.
//
// AND A FLAT-BED RESTING LAKE CANNOT SEE TWO OF THE THREE. That is the whole
// reason this note is long. Each choice above was broken on purpose in a copy of
// the tree and a resting ocean re-run for 400 steps at 2 degrees; max speed:
//
//   mutation                      flat bed     UNEVEN bed    piercing island
//   (none)                        7.7e-14      6.7e-13       5.3e-13
//   bedPhi := R dphi              7.7e-14      5.9e-03  <-    1.3e-02  <-
//   geo on h_cell^2 not h_N,h_S   7.7e-14      7.5e-02  <-    7.5e-02  <-
//   geo source deleted            3.1e+02 <-   3.1e+02       3.1e+02
//   area := R^2 cos(phi) dlam dphi 1.3e-13     7.4e-13       5.2e-13   ALL SURVIVE
//
// So a flat bed catches ONE of four, and the two subtle ones need relief to show
// at all. The bed relief used here is 1800-2500 m; 200 m is enough to see them.
//
// THE NAIVE AREA SURVIVES THE RESTING LAKE AT EVERY RESOLUTION, and the reason is
// worth understanding rather than patching around: R^2 cos(phi) dlam dphi is the
// exact area times 1/sinc(dphi/2), a factor INDEPENDENT OF LATITUDE. It therefore
// scales dxRow, dyRow and bedPhi up by that factor and geoCoef down by it, so the
// flux divergence and the geometric source move together and the balance holds
// identically. This is the g x 1.1 disease in new clothes -- a wrong constant that
// every relative check divides out -- and no still-water test of any bed can ever
// catch it. What catches it is the AREA IDENTITY against an independently declared
// radius: sum of cell areas vs 4 pi R_REF^2 reads -1.2e-16 correct against
// 1 - sinc(dphi/2) = 1.27e-5 at 1 degree, a margin of eleven orders of magnitude.
// A per-band sum (30..60 deg vs 2 pi R^2 (sin 60 - sin 30), measured 5.0e-16) is
// there for the same reason one level down: it catches a metric right in TOTAL and
// mis-distributed by row.
//
// What the naive area WOULD do if it ever escaped that check: the error is
// dphi^2/24 relative and refinement does not rescue it, since it is a bias and not
// a truncation. And the cell-centred tan form is the nastier of the two
// correctness bugs, because it is exactly zero on a flat bed and wakes up only
// over SLOPES -- a persistent rim current on every shelf break and seamount flank
// and nowhere else, which is the one artefact an oceanographer would nod at.
//
// THE POLE NEEDS NO SPECIAL CASE. The face at phi = 90 deg has length
// R dlam cos(90 deg) = 0, so no flux can cross it: the pole is a zero-length
// boundary that closes itself, and the last interior row's face latitudes are
// still symmetric about its centre, so the identity above still holds there.
// Only rows lying ENTIRELY beyond a pole need care, and they are pure ghosts:
// they take mirrored latitudes, because the cell beyond the north pole is a real
// cell on the far side. Without that, cos(90 + dphi/2) < 0 hands the positivity
// limiter a negative area and turns the top row into a jet or a NaN.
// ---------------------------------------------------------------------------

/** Earth, as a default only. Nothing here assumes it. */
export const R_EARTH = 6371e3;
/** Sidereal rotation rate [rad/s] = 2*pi / 86164.0905 s. */
export const OMEGA_EARTH = 7.292115e-5;

const HALF_PI = Math.PI / 2;
const clampLat = (p) => (p > HALF_PI ? HALF_PI : p < -HALF_PI ? -HALF_PI : p);
/** Reflect a latitude about the nearer pole. The cell beyond a pole is a real cell. */
const reflectLat = (p) => (p > HALF_PI ? Math.PI - p : p < -HALF_PI ? -Math.PI - p : p);

/**
 * cos(latitude), via the CO-latitude, which is the only form that is exactly zero
 * at a pole.
 *
 * `Math.cos(Math.PI/2)` is 6.123e-17, not 0, because pi/2 is not representable.
 * That is not a rounding curiosity here: it gives the pole face a length of
 * 2.7e-11 m instead of none, and the pressure flux through a face that should not
 * exist drove the resting-lake residual to 2.8e-10 m/s^2 at 1 degree -- 300
 * times the existing gate -- growing with refinement, and worst at exactly the
 * row where nobody would look for a metric bug. `sin(pi/2 - |p|)` is exact at 0
 * and accurate for small arguments, so a pole face is closed to the bit.
 */
const cosLat = (p) => {
  const co = HALF_PI - Math.abs(p);
  return co <= 0 ? 0 : Math.sin(co);
};

/**
 * Uniform Cartesian metric. Every row is identical; the arrays exist so swe.mjs
 * has one code shape instead of a branch in its hot loops.
 */
export function cartesianGeometry({ nx, ny, dx, dy = dx, ng = 2, coriolis = 0 }) {
  const H = ny + 2 * ng;
  const g = blank('cartesian', nx, ny, ng, H);
  g.dx = dx; g.dy = dy; g.R = Infinity;
  g.totalArea = nx * dx * ny * dy;
  for (let j = 0; j < H; j++) {
    // ASSIGNED, not derived: deriving these would cost bit-identicality.
    g.dxRow[j] = dx; g.dyRowN[j] = dy; g.dyRowS[j] = dy; g.dyCFL[j] = dy;
    g.bedPhi[j] = dy;
    g.area[j] = dx * dy; g.lx[j] = dy; g.lyN[j] = dx; g.lyS[j] = dx;
    g.fRow[j] = coriolis;      // tanPhi and geoCoef stay 0: flat world, no curvature
  }
  return g;
}

/**
 * Latitude-longitude metric on a sphere of radius R.
 *
 * @param nx  cells in longitude, spanning the FULL 360 degrees, so the zonal
 *   direction is periodic. Must be even if the domain reaches a pole, since a
 *   ghost row beyond the pole is the row half a turn away.
 * @param ny  cells in latitude, spanning lat0..lat1 in DEGREES.
 * @param lat0,lat1  domain edges in degrees. +-90 is the whole sphere; a narrower
 *   band is the honest way to dodge the polar timestep, which costs 58x at 1
 *   degree and turns a 10-second tidal cycle into a 10-minute one.
 * @param omega  planetary rotation rate [rad/s]; f = 2 omega sin(phi).
 */
export function sphericalGeometry({
  nx, ny, R = R_EARTH, lat0 = -90, lat1 = 90, ng = 2, omega = 0,
}) {
  if (!(lat1 > lat0)) throw new Error(`lat1 (${lat1}) must exceed lat0 (${lat0})`);
  if (lat0 < -90 || lat1 > 90) throw new Error(`latitudes must lie in [-90, 90]; got ${lat0}..${lat1}`);
  const touchesPole = lat0 <= -90 + 1e-12 || lat1 >= 90 - 1e-12;
  if (touchesPole && nx % 2 !== 0) {
    throw new Error(`nx must be even when the domain reaches a pole (got ${nx}): a ghost row `
      + 'beyond the pole is the row half a turn away in longitude.');
  }

  const H = ny + 2 * ng;
  const g = blank('sphere', nx, ny, ng, H);
  const dlam = 2 * Math.PI / nx;
  const p0 = lat0 * Math.PI / 180, p1 = lat1 * Math.PI / 180;
  const dphi = (p1 - p0) / ny;
  Object.assign(g, {
    R, dlam, dphi, lat0, lat1, omega,
    dy: R * dphi,                              // true meridional cell height
    totalArea: 2 * Math.PI * R * R * (Math.sin(p1) - Math.sin(p0)),
  });

  // Face latitudes. The two DOMAIN EDGES are pinned to p0 and p1 exactly rather
  // than accumulated, so that a domain declared to reach the pole reaches it to
  // the bit and cosLat() can return an exact zero there.
  const faceLat = (k) => (k === 0 ? p0 : k === ny ? p1 : p0 + k * dphi);

  for (let j = 0; j < H; j++) {
    const jj = j - ng;                         // -ng .. ny+ng-1
    const rawS = faceLat(jj), rawN = faceLat(jj + 1);
    const pS = clampLat(rawS), pN = clampLat(rawN);
    const pC = 0.5 * (pS + pN);                // ARITHMETIC mean; see the header
    const half = 0.5 * (pN - pS);

    g.phiC[j] = pC;
    g.lyS[j] = R * dlam * cosLat(pS);          // exactly 0 at a pole
    g.lyN[j] = R * dlam * cosLat(pN);
    g.lx[j] = R * dphi;                        // latitude-INDEPENDENT

    // EXACT spherical area, written as the PRODUCT form rather than as
    // sin(phi_N) - sin(phi_S). The two are the same identity
    //   sin p_N - sin p_S == 2 cos(p_C) sin((p_N - p_S)/2),
    // but the difference form cancels: near a pole sin(90 deg) - sin(88 deg) is
    // 1 - 0.99939, which amplifies epsilon by 1640x. The product form has no
    // cancellation, and -- the reason it is the right choice rather than merely
    // the tidier one -- it is the SAME identity the well-balancing relies on, so
    // area and the tan(phi) source agree by construction instead of agreeing to
    // within whatever the subtraction left behind.
    let A = 2 * R * R * dlam * cosLat(pC) * Math.sin(half);
    if (!(A > 0)) {
      // Entirely beyond a pole: stands for the cell whose latitudes are this
      // row's, reflected about that pole.
      const rS = reflectLat(rawS), rN = reflectLat(rawN);
      A = Math.abs(2 * R * R * dlam * cosLat(0.5 * (rS + rN)) * Math.sin(0.5 * (rN - rS)));
    }
    g.area[j] = A;

    // Effective divisors, so swe.mjs divides exactly as it does in Cartesian.
    // Infinity at a pole face is not a guard; it is the correct statement that a
    // zero-length face transports nothing.
    g.dxRow[j] = A / g.lx[j];
    g.dyRowN[j] = g.lyN[j] > 0 ? A / g.lyN[j] : Infinity;
    g.dyRowS[j] = g.lyS[j] > 0 ? A / g.lyS[j] : Infinity;
    g.dyCFL[j] = Math.min(g.dyRowN[j], g.dyRowS[j], g.dy);

    g.bedPhi[j] = (g.lyN[j] + g.lyS[j]) > 0 ? 2 * A / (g.lyN[j] + g.lyS[j]) : Infinity;
    g.tanPhi[j] = Math.tan(pC);
    g.fRow[j] = 2 * omega * Math.sin(pC);

    // -tan(phi)/4R, but computed FROM THE FACE LENGTHS THE FLUX WILL USE rather
    // than from tan(). The two are the same number --
    //   (ly_N - ly_S)/A == -tan(phi_C)/R   exactly, by the identity in the header
    // so writing it out of the same lengths lets the flux and the source share
    // their operands instead of meeting through two different transcendentals.
    //
    // HOW MUCH THAT IS WORTH -- and it is less than the first measurement said.
    // An ISOLATED algebraic probe of the resting balance (pressure times face
    // length, differenced, against the source) put the tan() form 22-87x worse
    // and GROWING under refinement: 2.50e-12 at 2 deg, 1.00e-11 at 1 deg,
    // 3.96e-11 at 0.5 deg, against a flat 4.6e-13. Run through the actual solver
    // on an uneven bed, both forms sit at rounding level and neither grows:
    //
    //   dphi     shipped (faces)   via tan()   ratio
    //   4 deg    2.96e-13          6.62e-13    2.2
    //   2 deg    3.91e-13          8.48e-13    2.2
    //   1 deg    3.65e-13          9.60e-13    2.6
    //   0.5 deg  3.43e-13          1.02e-12    3.0
    //
    // The standalone probe EXAGGERATED the gap, because the solver forms its geo
    // source and its flux difference out of more shared structure than a
    // hand-written balance reproduces. So the face-length form is still the right
    // choice -- cheaper, fewer transcendentals, a factor 2-3 tighter -- but
    // substituting -tan(phi)/4R is a CONDITIONING regression, not a correctness
    // bug, and tools/ declares it a known survivor rather than pretending a gate
    // catches it. The correctness mistakes that a gate does catch are the other
    // two: the bed coefficient and the h_cell^2 form of the source, both of which
    // need an UNEVEN bed to show at all.
    //
    // tanPhi is still exported, because the CURVATURE term u*tan(phi)/R is a
    // genuine physical force with nothing to cancel against and no reason to be
    // written obliquely.
    g.geoCoef[j] = (g.lyN[j] - g.lyS[j]) / (4 * A);
  }

  for (let j = 0; j < H; j++) {
    if (!(g.area[j] > 0) || !isFinite(g.area[j])) throw new Error(`row ${j}: area ${g.area[j]}`);
    if (!(g.lyN[j] >= 0) || !(g.lyS[j] >= 0)) throw new Error(`row ${j}: negative face length`);
  }
  return g;
}

function blank(kind, nx, ny, ng, H) {
  const f = () => new Float64Array(H);
  return {
    kind, nx, ny, ng, H,
    dxRow: f(), dyRowN: f(), dyRowS: f(), dyCFL: f(), area: f(),
    lx: f(), lyN: f(), lyS: f(), bedPhi: f(), phiC: f(), tanPhi: f(),
    fRow: f(), geoCoef: f(),
  };
}

/** Longitude/latitude of an interior cell centre, in DEGREES. */
export function cellLonLat(g, i, j) {
  if (g.kind !== 'sphere') throw new Error('cellLonLat is spherical-only');
  return [(i + 0.5) * g.dlam * 180 / Math.PI - 180, g.phiC[j + g.ng] * 180 / Math.PI];
}

/**
 * Total area of the interior cells, summed the way the solver sums it.
 *
 * Exported so a suite can compare it against 4*pi*R^2 built from an
 * INDEPENDENTLY DECLARED radius. That indirection is the whole point: every
 * volume-drift check in tools/ divides by its own initial volume, so a metric
 * wrong by a constant factor cancels exactly and is invisible to all of them.
 */
export function interiorArea(g) {
  let s = 0;
  for (let j = g.ng; j < g.H - g.ng; j++) s += g.area[j] * g.nx;
  return s;
}
