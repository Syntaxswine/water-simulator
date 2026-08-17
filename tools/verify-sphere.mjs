// ---------------------------------------------------------------------------
// Verification: the SPHERICAL path.
//
//   node tools/verify-sphere.mjs                  every section (~4 min)
//   node tools/verify-sphere.mjs --list           section ids, run nothing
//   node tools/verify-sphere.mjs --only merian    one section (comma-separated for
//                                                 several: --only lake,baseline)
//   node tools/verify-sphere.mjs --table          the mutation table for the
//                                                 src/geometry.mjs header (~1.5 min)
//   node tools/verify-sphere.mjs --bless          re-record tools/sphere-baseline.json.
//                                                 TWO STEPS: bless, then run with no
//                                                 flags so section 9 reads the new file
//   node tools/verify-sphere.mjs --probe          internal; one JSON line of resting-lake
//                                                 max speeds, used by --table out of a
//                                                 mutant tree. Not a suite; prints no total.
//
// An unrecognised argument, or an --only that names no section, EXITS 2. A
// filter that silently matches nothing and then prints "ALL PASS -- 0/0" is the
// most expensive kind of green there is.
//
// WHY THIS FILE EXISTS. The Cartesian path has tools/verify.mjs (35),
// tools/verify-physics.mjs (75), tools/verify-tide.mjs (64), tools/waves.mjs and
// tools/mutants.mjs standing behind it. When the spherical metric landed in
// f3d1351 it arrived with its numbers written into a header comment in
// src/geometry.mjs and into a scratchpad script that no longer reproduces them,
// which is not verification -- it is a claim with nothing checking it, and the
// header has already drifted: its summary table at lines 26-28 disagrees with
// the code three lines below it. Everything here is measured by this file, in
// this tree, on the run that prints it.
//
// WHAT THE MODULE ACTUALLY SHIPS, read off src/geometry.mjs rather than off its
// header, because the header is the thing that went wrong:
//
//   area     2*R*R*dlam*cosLat(phi_C)*sin(half)      PRODUCT form   (:190)
//   bedPhi   2*A/(ly_N + ly_S)                                      (:207)
//   geoCoef  (ly_N - ly_S)/(4*A)                     FACE-LENGTH form (:243)
//   cosLat   sin(pi/2 - |p|), exactly zero at a pole                (:106)
//
// Section 10 regenerates that header table from live measurement, so the next
// person to quote it does not have to trust anyone's memory -- which is the
// mechanism behind all three of the errors now in it.
//
// THE TEST OWNS ITS CONSTANTS. G_REF, R_REF and OMEGA_REF are declared below and
// every analytic target is built from them. Nothing in this file imports the
// solver's G at all: the name `G` is deliberately not in scope, so a target that
// reaches for the constant under test is a ReferenceError and not a tautology.
// R_EARTH and OMEGA_EARTH are imported ONLY as subjects of section 1.
//
// WHAT IS VERIFICATION HERE AND WHAT IS NOT.
//   Sections 1, 4, 5, 6 test against closed forms or exact algebraic identities
//     built from this file's own constants.
//   Section 2, 3 and 7 test EXACT properties of the scheme (a lake stays still,
//     mass is conserved, longitude is periodic) against tolerances derived from
//     floating-point round-off; the derivation is written out at section 2.
//   Section 9 is a REGRESSION baseline, not theory, and its lines say so.
//   Section 10 is a mutation probe, not a check of physics.
//
// EVERY SECTION CARRIES ITS OWN FALSIFICATION. Where a bound could be met by a
// solver that had thrown the physics away, the same measurement is repeated
// against a deliberately corrupted copy -- geom.fRow forced constant,
// geom.geoCoef zeroed, geom.bedPhi set to R*dphi, geom.tanPhi zeroed, the
// periodic boundary replaced by a wall -- and the run asserts that the corrupted
// variant VIOLATES the bound. Those lines are labelled `refutation:`. They are
// the only evidence in the file that a green line means anything.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { ShallowWater, reflect } from '../src/swe.mjs';
import {
  sphericalGeometry, cartesianGeometry, cellLonLat, interiorArea, R_EARTH, OMEGA_EARTH,
} from '../src/geometry.mjs';

// ---------------------------------------------------------------------------
// Reference constants. Declared, never imported.
// ---------------------------------------------------------------------------
/** Standard gravity [m/s^2], exact by definition (CGPM 1901). */
const G_REF = 9.80665;
/** The radius src/geometry.mjs defaults to, declared here so section 1 can compare. */
const R_REF = 6371e3;
/** Sidereal rotation rate [rad/s] = 2*pi / 86164.0905 s. */
const OMEGA_REF = 7.292115e-5;
const EPS = Number.EPSILON;
const D = Math.PI / 180;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let checks = 0, failures = 0;

function fmt(v) {
  if (v === 0) return '0';
  if (!isFinite(v)) return String(v);
  const a = Math.abs(v);
  return (a < 1e-3 || a >= 1e5) ? v.toExponential(4) : v.toFixed(6);
}
function line(ok, label, tail) {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${tail}`);
}
/** got vs want, relative (absolute when want is ~0). */
function check(label, got, want, tol, note = '') {
  const rel = Math.abs(want) > 1e-12 ? Math.abs(got - want) / Math.abs(want) : Math.abs(got - want);
  const pct = (x) => (x === 0 ? '0%' : x < 1e-6 ? `${(100 * x).toExponential(2)}%` : `${(100 * x).toFixed(6)}%`);
  line(rel <= tol, label, `got ${fmt(got)}  want ${fmt(want)}  rel ${pct(rel)}  tol ${pct(tol)}`
    + `${note ? '   ' + note : ''}`);
}
/** |got| must not exceed limit. Prints the margin, because a bound with no margin is luck. */
function bound(label, got, limit, note = '') {
  const a = Math.abs(got);
  line(a <= limit, label, `got ${fmt(got)}  limit ${fmt(limit)}  margin ${a > 0 ? (limit / a).toFixed(1) : 'inf'}x`
    + `${note ? '   ' + note : ''}`);
}
function assert(label, ok, note = '') {
  line(ok, label, note);
}
/**
 * An informational line that is NOT counted as a check.
 *
 * There are three things this file has to say that are not claims it could be
 * wrong about -- a finding, a declared gap, and a declared survivor -- and
 * dressing them as PASS lines would inflate the total with lines that cannot
 * fail. They print as NOTE and the total does not see them.
 */
function note(label, text) {
  console.log(`  NOTE  ${label.padEnd(52)} ${text}`);
}
/**
 * A check that passes only when a DELIBERATELY BROKEN variant fails the bound
 * the shipped code just passed. `violated` is true when the broken run went out
 * of bounds, which is the outcome that means the bound has teeth.
 */
function refute(label, violated, note) {
  line(violated, `refutation: ${label}`, note);
}
function throws(label, fn, want) {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  const ok = msg !== null && (!want || msg.includes(want));
  line(ok, label, msg === null ? 'did NOT throw' : `threw ${JSON.stringify(msg.slice(0, 72))}`);
}
const head = (t) => console.log(`\n=== ${t} ${'='.repeat(Math.max(3, 70 - t.length))}\n`);

// Measurements that section 9 pins to tools/sphere-baseline.json.
const record = { restingOcean: [], areaIdentity: [], merian: [] };

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const H_OCEAN = 4000;                       // reference ocean depth [m]
const wrap180 = (x) => ((x + 180) % 360 + 360) % 360 - 180;

/** Flat bed at ocean depth. Sees ONE of the four metric mistakes; see section 2. */
const bedFlat = () => -H_OCEAN;
/**
 * Uneven bed. Peak-to-trough relief is asserted into the 1800-2500 m band in
 * section 2, because the two subtle metric errors are invisible without relief
 * and a fixture that quietly flattened would take the gate with it.
 */
const bedUneven = (lon, lat) =>
  -H_OCEAN + 900 * Math.sin(3 * lon * D) * Math.cos(2 * lat * D) + 350 * Math.sin(5 * lat * D);
/**
 * The same bed plus a seamount that actually breaks the surface. The previous
 * "piercing island" fixture in this repository's history was 890 m UNDER water
 * with zero dry cells; section 2 asserts the dry-cell count is positive so this
 * one cannot silently stop piercing.
 */
const bedPiercing = (lon, lat) => {
  const dl = wrap180(lon - 30), dp = lat - 20;
  return bedUneven(lon, lat) + 5000 * Math.exp(-(dl * dl + dp * dp) / 128);
};

function sphere({ bed, eta0 = 0, deg, lat0 = -90, lat1 = 90, order = 2, omega = 0, cfl = 0.45 }) {
  const nx = Math.round(360 / deg), ny = Math.round((lat1 - lat0) / deg);
  return new ShallowWater({
    nx, ny, bed, eta0, manning: 0, cfl, order,
    sphere: { R: R_REF, lat0, lat1, omega },
  });
}
function dryCells(sim) {
  let n = 0;
  for (let j = 0; j < sim.ny; j++) for (let i = 0; i < sim.nx; i++) if (sim.h[sim.idx(i, j)] <= sim.minDepth) n++;
  return n;
}
/** Largest |b| or h anywhere: the scale at which eta = b + h loses its low bits. */
function vertScale(sim) {
  let s = 0;
  for (let j = 0; j < sim.ny; j++) for (let i = 0; i < sim.nx; i++) {
    const k = sim.idx(i, j);
    s = Math.max(s, Math.abs(sim.b[k]), sim.h[k]);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
const SECTIONS = [];
const section = (id, title, fn) => SECTIONS.push({ id, title, fn });

// ===========================================================================
section('metric', '1. the metric, against independently declared constants', () => {
// ===========================================================================
  //
  // A metric wrong by a CONSTANT FACTOR is invisible to every other section in
  // this file. Volume drift divides by its own initial volume; a resting lake
  // divides a flux by a length and a source by the same length; a wave period
  // is a ratio. The naive area R^2 cos(phi) dlam dphi is exactly that bug --
  // the true area times 1/sinc(dphi/2), a factor INDEPENDENT of latitude -- and
  // it survives every still-water test at every resolution (section 10 measures
  // that, it is not a story). The only thing that catches it is summing the
  // areas the solver actually uses and comparing against 4*pi*R_REF^2 built
  // from a radius this file declares.

  head('1a. the module\'s own constants are the reference constants');
  // Exact equality, and a tolerance would be wrong: these are meant to be the
  // same decimal literal, so one ulp of difference is an edit, not arithmetic.
  assert('R_EARTH is the reference radius', R_EARTH === R_REF,
    `module ${R_EARTH} vs reference ${R_REF} m, difference ${fmt(R_EARTH - R_REF)}`);
  assert('OMEGA_EARTH is the reference rotation rate', OMEGA_EARTH === OMEGA_REF,
    `module ${OMEGA_EARTH} vs reference ${OMEGA_REF} rad/s, difference ${fmt(OMEGA_EARTH - OMEGA_REF)}`);

  head('1b. the area identity: sum of cell areas vs 4 pi R^2');
  const FOUR_PI_R2 = 4 * Math.PI * R_REF * R_REF;
  for (const deg of [6, 4, 3, 2, 1]) {
    const g = sphericalGeometry({ nx: 360 / deg, ny: 180 / deg, R: R_REF, lat0: -90, lat1: 90, ng: 2 });
    const A = interiorArea(g);
    const rel = (A - FOUR_PI_R2) / FOUR_PI_R2;
    // The naive-area bias for comparison: 1 - sinc(dphi/2) = dphi^2/24.
    const naive = 1 / (Math.sin(g.dphi / 2) / (g.dphi / 2)) - 1;
    check(`whole sphere at ${deg} deg`, A, FOUR_PI_R2, 1e-14,
      `the naive R^2 cos dlam dphi area would read ${fmt(naive)} here, ${(naive / 1e-14).toExponential(1)}x the tolerance`);
    record.areaIdentity.push({ deg, lat0: -90, lat1: 90, area: A, rel });
  }
  for (const [lat0, lat1, deg] of [[-80, 80, 2], [-60, 60, 4], [10, 70, 1]]) {
    const g = sphericalGeometry({
      nx: 360 / deg, ny: Math.round((lat1 - lat0) / deg), R: R_REF, lat0, lat1, ng: 2,
    });
    const A = interiorArea(g);
    const want = 2 * Math.PI * R_REF * R_REF * (Math.sin(lat1 * D) - Math.sin(lat0 * D));
    check(`cap ${lat0}..${lat1} at ${deg} deg`, A, want, 1e-14);
    record.areaIdentity.push({ deg, lat0, lat1, area: A, rel: (A - want) / want });
  }

  head('1c. per-band sums: a metric right in TOTAL and mis-distributed by row');
  {
    // 1 degree, so every band edge below is a face latitude to the bit.
    const g = sphericalGeometry({ nx: 360, ny: 180, R: R_REF, lat0: -90, lat1: 90, ng: 2 });
    const band = (lo, hi) => {
      let s = 0;
      for (let jj = lo + 90; jj < hi + 90; jj++) s += g.area[jj + g.ng] * g.nx;
      return s;
    };
    for (const [lo, hi] of [[30, 60], [-60, -30], [0, 30], [80, 90]]) {
      const want = 2 * Math.PI * R_REF * R_REF * (Math.sin(hi * D) - Math.sin(lo * D));
      check(`band ${lo}..${hi} deg`, band(lo, hi), want, 1e-13);
    }
  }

  head('1d. the pole is a zero-length boundary, exactly');
  {
    const g = sphericalGeometry({ nx: 72, ny: 36, R: R_REF, lat0: -90, lat1: 90, ng: 2 });
    // === 0, not < eps. Math.cos(Math.PI/2) is 6.123e-17, which gives the pole
    // face a length of 2.7e-11 m and lets pressure cross a face that is not there.
    assert('south pole face length === 0 (not merely small)', g.lyS[g.ng] === 0,
      `lyS[first interior] = ${g.lyS[g.ng]}, Math.cos would give ${fmt(R_REF * g.dlam * Math.cos(Math.PI / 2))} m`);
    assert('north pole face length === 0 (not merely small)', g.lyN[g.H - g.ng - 1] === 0,
      `lyN[last interior] = ${g.lyN[g.H - g.ng - 1]}`);
    let ghostClosed = true;
    for (const j of [0, 1, g.H - 2, g.H - 1]) if (g.lyN[j] !== 0 || g.lyS[j] !== 0) ghostClosed = false;
    assert('every row beyond a pole is closed on both faces', ghostClosed,
      `4 ghost rows, all lyN and lyS === 0`);
  }

  head('1e. every row, ghosts included, has a positive finite area');
  for (const [nx, ny, lat0, lat1] of [[72, 36, -90, 90], [90, 45, -90, 90], [180, 80, -80, 80], [120, 60, 10, 70]]) {
    const g = sphericalGeometry({ nx, ny, R: R_REF, lat0, lat1, ng: 2 });
    let bad = -1, minA = Infinity, maxA = 0;
    for (let j = 0; j < g.H; j++) {
      const a = g.area[j];
      if (!(a > 0) || !isFinite(a)) { bad = j; break; }
      minA = Math.min(minA, a); maxA = Math.max(maxA, a);
    }
    assert(`${nx}x${ny} ${lat0}..${lat1}: all ${g.H} rows positive+finite`, bad < 0,
      bad < 0 ? `area ${minA.toExponential(4)} .. ${maxA.toExponential(4)} m^2` : `row ${bad} area ${g.area[bad]}`);
  }

  head('1f. face lengths and the arithmetic-mean latitude');
  {
    const g = sphericalGeometry({ nx: 90, ny: 45, R: R_REF, lat0: -90, lat1: 90, ng: 2 });
    let lxSpread = 0, lyMismatch = 0;
    for (let j = 0; j < g.H; j++) lxSpread = Math.max(lxSpread, Math.abs(g.lx[j] - g.lx[0]));
    for (let j = 0; j < g.H - 1; j++) lyMismatch = Math.max(lyMismatch, Math.abs(g.lyN[j] - g.lyS[j + 1]));
    assert('lx is latitude-independent (all rows the same double)', lxSpread === 0,
      `max |lx[j] - lx[0]| = ${lxSpread} over ${g.H} rows, lx = ${fmt(g.lx[0])} m`);
    // Not "to within a tolerance": the two cells sharing a face must divide the
    // SAME flux by the SAME length, or mass conservation is only approximate.
    assert('ly_N of row j === ly_S of row j+1 (the same face, the same double)', lyMismatch === 0,
      `max |lyN[j] - lyS[j+1]| = ${lyMismatch} over ${g.H - 1} shared faces`);

    // phi_C is the ARITHMETIC mean of the face latitudes. Rebuilt here from the
    // domain this file asked for, not read back from the module.
    const p0 = -90 * D, p1 = 90 * D, dphi = (p1 - p0) / g.ny;
    const faceLat = (k) => (k === 0 ? p0 : k === g.ny ? p1 : p0 + k * dphi);
    const clamp = (p) => Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p));
    let worst = 0;
    for (let j = 0; j < g.H; j++) {
      const jj = j - g.ng;
      const want = 0.5 * (clamp(faceLat(jj)) + clamp(faceLat(jj + 1)));
      worst = Math.max(worst, Math.abs(g.phiC[j] - want));
    }
    bound('phi_C is the arithmetic mean of its two face latitudes', worst, 1e-16,
      `over all ${g.H} rows, in radians`);

    // The mean that MATTERS, stated as an identity a different choice breaks.
    // cos(p_S) + cos(p_N) == 2 cos(p_C) cos(half) holds only for the arithmetic
    // mean; the area-bisecting latitude asin((sin p_N + sin p_S)/2) looks more
    // principled and fails it, which is what would take the well-balancing with it.
    const halfOf = (j) => {
      const jj = j - g.ng;
      return 0.5 * (clamp(faceLat(jj + 1)) - clamp(faceLat(jj)));
    };
    let idErr = 0, bisectErr = 0;
    for (let j = g.ng; j < g.H - g.ng; j++) {
      const two = 2 * R_REF * g.dlam * Math.cos(g.phiC[j]) * Math.cos(halfOf(j));
      idErr = Math.max(idErr, Math.abs(g.lyS[j] + g.lyN[j] - two) / (R_REF * g.dlam));
      const jj = j - g.ng;
      const pB = Math.asin(0.5 * (Math.sin(clamp(faceLat(jj + 1))) + Math.sin(clamp(faceLat(jj)))));
      const twoB = 2 * R_REF * g.dlam * Math.cos(pB) * Math.cos(halfOf(j));
      bisectErr = Math.max(bisectErr, Math.abs(g.lyS[j] + g.lyN[j] - twoB) / (R_REF * g.dlam));
    }
    bound('ly_S + ly_N == 2 R dlam cos(phi_C) cos(half)', idErr, 1e-15, 'normalised by R dlam');
    refute('the area-bisecting latitude breaks that identity', bisectErr > 1e-15 * 100,
      `asin((sin p_N + sin p_S)/2) reads ${fmt(bisectErr)} against the shipped ${fmt(idErr)}`);

    // geoCoef is written out of the face lengths; it must equal -tan(phi_C)/4R.
    let gcErr = 0;
    for (let j = g.ng; j < g.H - g.ng; j++) {
      const want = -Math.tan(g.phiC[j]) / (4 * R_REF);
      gcErr = Math.max(gcErr, Math.abs(g.geoCoef[j] - want) / Math.max(Math.abs(want), 1e-30));
    }
    bound('geoCoef == -tan(phi_C)/(4R) to round-off', gcErr, 1e-13,
      'the face-length form and the tan form are the same number');

    // bedPhi = 2A/(ly_N + ly_S) collapses to 2 R tan(dphi/2) -- latitude-
    // independent, and NOT R dphi. The gap is dphi^2/12 relative, which is what
    // the uneven-bed lake catches in section 2 and the flat bed cannot.
    const bedWant = 2 * R_REF * Math.tan(dphi / 2);
    let bedErr = 0;
    for (let j = g.ng; j < g.H - g.ng; j++) bedErr = Math.max(bedErr, Math.abs(g.bedPhi[j] - bedWant) / bedWant);
    bound('bedPhi == 2 R tan(dphi/2), every interior row', bedErr, 1e-14,
      `bedPhi = ${fmt(bedWant)} m; R dphi = ${fmt(R_REF * dphi)} m, short by ${fmt(bedWant / (R_REF * dphi) - 1)}`);
    // tan(x)/x = 1 + x^2/3 + 2x^4/15, so with x = dphi/2 the leading term is
    // dphi^2/12 and the next one is dphi^4/120 -- 4.9e-4 of it at 4 degrees,
    // which is why the tolerance here is 1e-3 and not tighter.
    check('bedPhi / (R dphi) - 1 == dphi^2/12', bedWant / (R_REF * dphi) - 1, dphi * dphi / 12, 1e-3,
      `the whole size of the bedPhi := R dphi mistake; next term dphi^4/120 = ${fmt(dphi ** 4 / 120)}`);

    // dxRow = A/lx, and it is emphatically NOT latitude-independent: that is the
    // reason sim.dx does not exist on a sphere.
    let dxErr = 0, dxMin = Infinity, dxMax = 0;
    for (let j = g.ng; j < g.H - g.ng; j++) {
      dxErr = Math.max(dxErr, Math.abs(g.dxRow[j] - g.area[j] / g.lx[j]) / g.dxRow[j]);
      dxMin = Math.min(dxMin, g.dxRow[j]); dxMax = Math.max(dxMax, g.dxRow[j]);
    }
    bound('dxRow == area / lx', dxErr, 1e-15, `spread ${fmt(dxMin)} .. ${fmt(dxMax)} m, ratio ${(dxMax / dxMin).toFixed(1)}x`);
    assert('dxRow varies with latitude by more than 10x', dxMax / dxMin > 10,
      `${(dxMax / dxMin).toFixed(1)}x between the polar row and the equator at ${g.ny} rows`);
  }

  head('1g. the constructor refuses what it cannot mean');
  throws('nx odd with a pole in the domain', () =>
    sphericalGeometry({ nx: 91, ny: 45, R: R_REF, lat0: -90, lat1: 90, ng: 2 }), 'nx must be even');
  {
    // ...and the guard is not a blanket ban: odd nx away from a pole is legal.
    let ok = true;
    try { sphericalGeometry({ nx: 91, ny: 30, R: R_REF, lat0: -60, lat1: 60, ng: 2 }); } catch { ok = false; }
    assert('nx odd is allowed when no pole is in the domain', ok, 'nx = 91, -60..60');
  }
  throws('lat1 === lat0', () => sphericalGeometry({ nx: 90, ny: 10, R: R_REF, lat0: 20, lat1: 20 }), 'must exceed');
  throws('lat1 < lat0', () => sphericalGeometry({ nx: 90, ny: 10, R: R_REF, lat0: 40, lat1: 20 }), 'must exceed');
  throws('lat0 < -90', () => sphericalGeometry({ nx: 90, ny: 10, R: R_REF, lat0: -91, lat1: 20 }), '[-90, 90]');
  throws('lat1 > 90', () => sphericalGeometry({ nx: 90, ny: 10, R: R_REF, lat0: 20, lat1: 91 }), '[-90, 90]');

  head('1h. a spherical cell has no x in metres');
  {
    const s = sphere({ bed: bedFlat, deg: 6 });
    assert('sim.dx is undefined on a sphere', s.dx === undefined, `sim.dx = ${s.dx}, sim.dy = ${fmt(s.dy)} m`);
    throws('cellCentre() on a sphere', () => s.cellCentre(0, 0), 'Cartesian-only');
    const c = new ShallowWater({ nx: 8, ny: 8, dx: 10, bed: () => -5, eta0: 0 });
    throws('cellLonLat() on a Cartesian grid', () => c.cellLonLat(0, 0), 'spherical-only');
    throws('cellLonLat(geom) on a Cartesian metric', () =>
      cellLonLat(cartesianGeometry({ nx: 8, ny: 8, dx: 10 }), 0, 0), 'spherical-only');
  }
});

// ===========================================================================
section('lake', '2. a lake at rest, which is the state the model lives in', () => {
// ===========================================================================
  //
  // On a sphere this is a HARDER test than in Cartesian. A cell's north and
  // south faces have different lengths, so the hydrostatic pressure g h^2/2 --
  // identical on both faces -- does not cancel; at h = 4000 m and 45 degrees the
  // leftover is 12.3 m/s^2, larger than g. The curvature source absorbs it
  // exactly, and only if the area, the bed divisor and the geometric source are
  // all written the same way.
  //
  // ------------------------------------------------------------------------
  // THE TOLERANCE, DERIVED. Do NOT copy the Cartesian 1e-12: that number was set
  // on a coastal domain in 8 m of water, and the quantity that sets the floor
  // here is g h^2 at OCEAN depth, which is 2.7e5 times larger.
  //
  // The balance the scheme must hold is, per cell and per RK stage,
  //
  //     (pressure flux on the north face) - (same on the south face)
  //         + (geometric source)  ==  0
  //
  // Each of those terms is formed, in the solver, as a hydrostatic pressure
  // G*h^2/2 divided by an effective length A/ly. So the largest number that
  // appears in the cancellation is
  //
  //     P  =  G * h^2 / (2 * R * dphi)          [m/s^2]
  //
  // (using A/ly ~ R*dphi, the meridional cell height). Two doubles of that size
  // cannot cancel to better than their own last bit, so one stage of the balance
  // leaves an acceleration of at most
  //
  //     a_eps  =  EPS * G * h^2 / (2 * R * dphi)
  //
  // That error is a fresh rounding every stage, not a bias, so over N steps of
  // length dt it accumulates as a random walk rather than linearly:
  //
  //     u_tol  =  K_u * a_eps * dt * sqrt(N)
  //            =  K_u * EPS * G * h^2 * dt * sqrt(N) / (2 * R * dphi)
  //
  // The surface has its own, different floor: eta = b + h is a difference of two
  // numbers of size h_max, so it cannot be known better than one ulp of h_max,
  // and that too random-walks:
  //
  //     eta_tol  =  K_e * EPS * h_max * sqrt(N)
  //
  // and the volume is a sum of nx*ny terms re-summed every step:
  //
  //     drift_tol = K_v * EPS * (sqrt(N) + sqrt(nx*ny))     [relative]
  //
  // K_u = K_e = K_v = 4 is the whole of the fudge, and every line below prints
  // the margin it actually had so the fudge is auditable. Measured margins on
  // this tree run 20x to 500x, and the metric mutations section 10 exercises
  // land 8 to 12 ORDERS above the bound, so the safety factor is not what
  // decides anything.
  // ------------------------------------------------------------------------
  const K_U = 4, K_E = 4, K_V = 4;

  head('2a. the fixtures are what they claim to be');
  {
    const s2 = sphere({ bed: bedUneven, deg: 2 });
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < s2.ny; j++) for (let i = 0; i < s2.nx; i++) {
      const b = s2.b[s2.idx(i, j)]; lo = Math.min(lo, b); hi = Math.max(hi, b);
    }
    const relief = hi - lo;
    assert('uneven bed relief is in the 1800-2500 m band', relief >= 1800 && relief <= 2500,
      `${relief.toFixed(1)} m, from ${lo.toFixed(1)} to ${hi.toFixed(1)} m; a flat bed sees only 1 of 4 metric mistakes`);
    assert('uneven bed has NO dry cells', dryCells(s2) === 0, `${dryCells(s2)} dry of ${s2.nx * s2.ny}`);
  }
  for (const deg of [6, 4, 3, 2]) {
    const s = sphere({ bed: bedPiercing, deg });
    let top = -Infinity;
    for (let j = 0; j < s.ny; j++) for (let i = 0; i < s.nx; i++) top = Math.max(top, s.b[s.idx(i, j)]);
    const n = dryCells(s);
    assert(`piercing bed actually pierces at ${deg} deg`, n > 0,
      `${n} dry cells of ${s.nx * s.ny}, summit ${top.toFixed(1)} m above the datum`);
  }

  const cases = [];
  for (const deg of [6, 4, 3, 2]) {
    for (const [name, bed] of [['flat', bedFlat], ['uneven', bedUneven], ['piercing', bedPiercing]]) {
      cases.push({ name, bed, deg, steps: 400, order: 2, lat0: -90, lat1: 90 });
    }
  }
  // The ONLY place the bed-guard mistake shows: at order 1 the Cartesian bed
  // term is skipped, and a port that copies that guard skips the spherical
  // geometric source with it -- which is not a 2nd-order correction, it is
  // 3.1e-3 m/s^2 at rest.
  cases.push({ name: 'uneven', bed: bedUneven, deg: 2, steps: 400, order: 1, lat0: -90, lat1: 90 });
  // A capped domain has no pole row, so its timestep is 10x longer and the
  // round-off has 10x longer to walk.
  cases.push({ name: 'uneven', bed: bedUneven, deg: 2, steps: 400, order: 2, lat0: -80, lat1: 80 });

  head('2b. max speed, max |eta| and volume drift against the derived bounds');
  const measured = new Map();
  for (const c of cases) {
    const sim = sphere({ bed: c.bed, deg: c.deg, order: c.order, lat0: c.lat0, lat1: c.lat1 });
    const hMax = vertScale(sim), dry = dryCells(sim);
    const v0 = sim.volume(), dt = sim.maxDt();
    for (let s = 0; s < c.steps; s++) sim.step(dt);
    const speed = sim.maxSpeed(), eta = sim.maxSurfaceDeviation(0);
    const drift = Math.abs(sim.volume() - v0) / v0;
    const aEps = EPS * G_REF * hMax * hMax / (2 * R_REF * sim.geom.dphi);
    const tol = {
      speed: K_U * aEps * dt * Math.sqrt(c.steps),
      eta: K_E * EPS * hMax * Math.sqrt(c.steps),
      drift: K_V * EPS * (Math.sqrt(c.steps) + Math.sqrt(sim.nx * sim.ny)),
    };
    const tag = `${c.name} ${c.deg}deg`
      + (c.order !== 2 ? ` order${c.order}` : '') + (c.lat0 !== -90 ? ` ${c.lat0}..${c.lat1}` : '');
    bound(`${tag}: max speed`, speed, tol.speed, `dt ${dt.toFixed(2)} s, ${c.steps} steps, ${dry} dry`);
    bound(`${tag}: max |eta|`, eta, tol.eta, `h_max ${hMax.toFixed(0)} m`);
    bound(`${tag}: volume drift`, drift, tol.drift, 'relative');
    measured.set(tag, { speed, eta, drift, tol });
    record.restingOcean.push({
      case: c.name, deg: c.deg, order: c.order, lat0: c.lat0, lat1: c.lat1, steps: c.steps,
      dry, maxSpeed: speed, maxEta: eta, volumeDrift: drift,
    });
  }

  head('2c. does the coastline earn its place? (it does not, at baseline)');
  {
    // Honest answer, printed rather than implied. A dry cell changes the
    // Riemann problem at its faces, but a lake at rest has nothing crossing
    // them, so a genuine coastline is worth NOTHING here at baseline. It is
    // worth something on a mutant -- section 10 measures the geo-hcell-squared
    // column, where the piercing bed reads two orders above the uneven one.
    let same = 0, differ = 0, lines = [];
    for (const deg of [6, 4, 3, 2]) {
      const u = measured.get(`uneven ${deg}deg`), p = measured.get(`piercing ${deg}deg`);
      const identical = u.speed === p.speed;
      if (identical) same++; else differ++;
      lines.push(`${deg}deg ${identical ? 'IDENTICAL' : `${fmt(u.speed)} vs ${fmt(p.speed)}`}`);
    }
    // The failable half: the two fixtures must really be different beds. If
    // bedPiercing ever drifted back into being bedUneven with a bump that stays
    // under water -- which is exactly what the previous fixture in this
    // repository's history was, 890 m down with zero dry cells -- the finding
    // below would be true for the wrong reason.
    const s2 = sphere({ bed: bedUneven, deg: 2 }), p2 = sphere({ bed: bedPiercing, deg: 2 });
    let dbMax = 0;
    for (let j = 0; j < s2.ny; j++) for (let i = 0; i < s2.nx; i++) {
      dbMax = Math.max(dbMax, Math.abs(p2.b[p2.idx(i, j)] - s2.b[s2.idx(i, j)]));
    }
    assert('the two fixtures are genuinely different beds', dbMax > 1000,
      `max |b_piercing - b_uneven| = ${dbMax.toFixed(1)} m, and ${dryCells(p2)} of those cells are dry`);
    // ...and the finding, stated as measured and not implied.
    note('THE FINDING: a coastline buys nothing at baseline',
      `${same} of 4 resolutions give a max speed identical to the last bit, ${differ} differ: ${lines.join(', ')}. `
      + 'It pays on a mutant, not here -- see section 10, geo-hcell-squared.');
  }

  head('2d. refutations: the bound has teeth');
  {
    // bedPhi := R dphi, done by overwriting the metric the solver reads each
    // stage. This is the mistake the flat bed cannot see.
    const run = (breakIt) => {
      const sim = sphere({ bed: bedUneven, deg: 2 });
      breakIt(sim);
      const dt = sim.maxDt();
      for (let s = 0; s < 400; s++) sim.step(dt);
      return sim.maxSpeed();
    };
    // The SAME bound the shipped run above was measured against, not a fresh one.
    const ref = measured.get('uneven 2deg');
    const good = ref.speed, tol = ref.tol.speed;
    const rec = record.restingOcean.find((r) => r.case === 'uneven' && r.deg === 2 && r.order === 2 && r.lat0 === -90);
    const bedBroken = run((s) => s.geom.bedPhi.fill(R_REF * s.geom.dphi));
    refute('bedPhi := R dphi wrecks the uneven-bed lake', bedBroken > tol,
      `${fmt(bedBroken)} m/s against a shipped ${fmt(good)} and a bound of ${fmt(tol)}`);
    const geoBroken = run((s) => s.geom.geoCoef.fill(0));
    refute('the geometric source deleted wrecks it', geoBroken > tol,
      `${fmt(geoBroken)} m/s -- ${(geoBroken / good).toExponential(1)}x the shipped value`);
    assert('...and the shipped run above was not accidentally the broken one', rec && rec.maxSpeed === good,
      `recorded ${fmt(rec ? rec.maxSpeed : NaN)} m/s`);
  }
});

// ===========================================================================
section('mass', '3. mass', () => {
// ===========================================================================
  //
  // THE DRIFT RATIO IS STRUCTURALLY BLIND TO A CONSTANT-FACTOR METRIC ERROR.
  // volume() sums h*area and this check divides by its own initial volume, so a
  // metric scaled by any latitude-independent constant -- which is exactly what
  // the naive area R^2 cos(phi) dlam dphi is, the true area times 1/sinc(dphi/2)
  // -- cancels identically and reads zero drift forever. Section 1's area
  // identity against 4*pi*R_REF^2 is the check that covers that, and it is the
  // ONLY one in this file that does. What this section covers is the other
  // thing: that the two cells sharing a face divide the same flux*length by
  // their OWN areas, so nothing is created at a row boundary.
  head('3a. a resting ocean over an uneven bed, long');
  for (const steps of [2000, 6000]) {
    const sim = sphere({ bed: bedUneven, deg: 4 });
    const v0 = sim.volume(), dt = sim.maxDt();
    for (let s = 0; s < steps; s++) sim.step(dt);
    const drift = (sim.volume() - v0) / v0;
    const tol = 4 * EPS * (Math.sqrt(steps) + Math.sqrt(sim.nx * sim.ny));
    bound(`volume drift over ${steps} steps`, drift, tol,
      `t = ${(sim.t / 3600).toFixed(1)} h, max speed ${fmt(sim.maxSpeed())} m/s`);
  }

  head('3b. mass with water actually moving');
  {
    const sim = sphere({
      bed: bedUneven, deg: 4,
      eta0: (lon, lat) => 3 * Math.exp(-(wrap180(lon - 20) ** 2 + (lat - 30) ** 2) / 300),
    });
    const v0 = sim.volume(), dt = sim.maxDt();
    let floored = 0;
    for (let s = 0; s < 2000; s++) { sim.step(dt); floored += sim.massFloored; }
    const drift = (sim.volume() - v0) / v0;
    bound('volume drift, 3 m bump released, 2000 steps',
      drift, 4 * EPS * (Math.sqrt(2000) + Math.sqrt(sim.nx * sim.ny)),
      `max speed ${fmt(sim.maxSpeed())} m/s, mass floored by dryClean ${fmt(floored)} m`);
    assert('nothing was floored, so the drift is the scheme and not the wetting fix',
      floored === 0, `dryClean added ${floored} m of depth`);
  }
});

// ===========================================================================
section('merian', '4. the spherical free oscillation, in closed form', () => {
// ===========================================================================
  //
  // THE DERIVATION, written out because there is no citation behind it.
  //
  // Linearise the shallow-water equations about rest, uniform depth H, over a
  // sphere of radius R, with Omega = 0:
  //
  //     du/dt   = -g grad_s eta
  //     deta/dt = -H div_s u
  //
  // Differentiate the second in time and substitute the first:
  //
  //     d2eta/dt2 = -H div_s(-g grad_s eta) = g H laplacian_s eta
  //
  // The eigenfunctions of the Laplace-Beltrami operator on a sphere are the
  // spherical harmonics, with
  //
  //     laplacian_s Y_nm = -n(n+1)/R^2 Y_nm
  //
  // so eta = Y_nm exp(-i omega t) gives -omega^2 = -g H n(n+1)/R^2, i.e.
  //
  //     omega^2 = g H n(n+1) / R^2       T = 2 pi R / sqrt(g H n(n+1))
  //
  // n = 0 is the uniform mode and has no frequency; n = 1 is a RIGID TRANSLATION
  // of the shell -- the free surface stays a sphere, displaced off centre -- so
  // it is not an oscillation of the fluid and is excluded here. n >= 2 are the
  // real thing.
  //
  // This is the non-rotating limit of the Laplace tidal equations and is
  // textbook. NO PRIMARY CITATION WAS RETRIEVED for it. It is presented as a
  // derivation, from the two lines above, and nothing in this file claims a
  // source for it.
  //
  // The zonal wavenumber used is m = 0, for which Y_n0 is proportional to
  // P_n(sin phi), so the initial surface is a Legendre polynomial in sin(lat)
  // and the projection below is the same polynomial, area-weighted.
  //
  // THE ERROR IS EXPECTED TO BE NEGATIVE. A cell-averaged finite-volume scheme
  // resolves a smooth mode slightly stiffly and the measured period comes out
  // SHORT; what matters is that it falls at second order, which is asserted
  // between every successive pair of resolutions.

  const legendre = (n, x) => {
    let p0 = 1, p1 = x;
    if (n === 0) return 1;
    for (let k = 1; k < n; k++) { const p2 = ((2 * k + 1) * x * p1 - k * p0) / (k + 1); p0 = p1; p1 = p2; }
    return p1;
  };

  function merian(n, deg) {
    const omega = Math.sqrt(G_REF * H_OCEAN * n * (n + 1) / (R_REF * R_REF));
    const Tclosed = 2 * Math.PI / omega;
    const sim = sphere({ bed: bedFlat, deg, eta0: (lon, lat) => legendre(n, Math.sin(lat * D)) });
    const nx = sim.nx, ny = sim.ny;
    const w = new Float64Array(ny), pn = new Float64Array(ny);
    for (let j = 0; j < ny; j++) {
      pn[j] = legendre(n, Math.sin(sim.cellLonLat(0, j)[1] * D));
      w[j] = pn[j] * sim.geom.area[j + sim.ng];
    }
    const proj = () => {
      let s = 0;
      for (let j = 0; j < ny; j++) { let r = 0; for (let i = 0; i < nx; i++) r += sim.eta(i, j); s += r * w[j]; }
      return s;
    };
    const dt = sim.maxDt(), tEnd = 1.3 * Tclosed;
    const zeros = [];
    let prev = proj(), tprev = 0;
    while (sim.t < tEnd) {
      sim.step(dt);
      const c = proj();
      // Linear interpolation between the two straddling samples.
      if ((prev > 0 && c <= 0) || (prev < 0 && c >= 0)) zeros.push(tprev + (sim.t - tprev) * prev / (prev - c));
      prev = c; tprev = sim.t;
    }
    // Consecutive zero crossings of a single mode are half a period apart.
    const T = 2 * (zeros[zeros.length - 1] - zeros[0]) / (zeros.length - 1);
    // How much of the surface is still the mode that was excited. A period read
    // off a MIXTURE of modes is not the period of either of them, and both of
    // the numbers below are how this file knows it is not reading one.
    let num = 0, den = 0, pnn = 0;
    for (let j = 0; j < ny; j++) {
      const a = sim.geom.area[j + sim.ng];
      let r = 0, r2 = 0;
      for (let i = 0; i < nx; i++) { const e = sim.eta(i, j); r += e; r2 += e * e; }
      num += r * pn[j] * a; den += r2 * a; pnn += nx * pn[j] * pn[j] * a;
    }
    const coef = num / pnn;
    const gaps = [];
    for (let k = 1; k < zeros.length; k++) gaps.push(zeros[k] - zeros[k - 1]);
    const gapMean = gaps.reduce((x, y) => x + y, 0) / gaps.length;
    return {
      n, deg, Tclosed, T, errPct: 100 * (T - Tclosed) / Tclosed, zeros: zeros.length,
      steps: sim.steps, dphi: sim.geom.dphi,
      captured: coef * coef * pnn / den,
      gapSpread: (Math.max(...gaps) - Math.min(...gaps)) / gapMean,
    };
  }

  const DEGS = [6, 4, 3, 2];
  for (const n of [2, 3, 4]) {
    const T0 = 2 * Math.PI * R_REF / Math.sqrt(G_REF * H_OCEAN * n * (n + 1));
    head(`4.${n - 1}. n = ${n}, closed form T = ${(T0 / 3600).toFixed(4)} h`);
    const errs = [];
    for (const deg of DEGS) {
      const r = merian(n, deg);
      // A second-order scheme on a smooth mode: the period error is a truncation
      // term proportional to n(n+1)*dphi^2. The bound is stated in those terms so
      // it refines with the grid instead of being one flat number that the
      // coarsest case sets and the finest case can never fail.
      const lim = 12 * n * (n + 1) * r.dphi * r.dphi;
      bound(`${deg} deg: period error`, r.errPct, lim,
        `T = ${(r.T / 3600).toFixed(5)} h, ${r.zeros} zero crossings, ${r.steps} steps`);
      // The two half-periods must be the SAME half-period, and the surface at
      // the end must still be the mode that was excited. Without these the
      // number above is a period read off whatever the field has become.
      bound(`${deg} deg: half-periods agree with each other`, r.gapSpread, 1e-3,
        `spread over ${r.zeros - 1} intervals, relative`);
      line(r.captured > 0.99, `${deg} deg: the surface is still mode n=${n}`,
        `P_${n} accounts for ${(100 * r.captured).toFixed(4)}% of the area-weighted surface variance at t = 1.3 T,`
        + ' want > 99%');
      errs.push({ deg, err: Math.abs(r.errPct) });
      record.merian.push({ n, deg, closed_h: r.Tclosed / 3600, measured_h: r.T / 3600, errPct: r.errPct });
    }
    // A bound alone would be met by a scheme that was merely CLOSE. The order is
    // the statement that it is close for the right reason.
    for (let k = 1; k < errs.length; k++) {
      const p = Math.log(errs[k - 1].err / errs[k].err) / Math.log(errs[k - 1].deg / errs[k].deg);
      const ok = p > 1.6 && p < 2.3;
      line(ok, `n=${n} observed order, ${errs[k - 1].deg} -> ${errs[k].deg} deg`,
        `p = ${p.toFixed(3)}  want 1.6 .. 2.3   (${errs[k - 1].err.toFixed(4)}% -> ${errs[k].err.toFixed(4)}%)`);
    }
  }
  // n = 1 is excluded on purpose -- see the derivation above; it is a rigid
  // translation of the shell rather than an oscillation of the fluid. There is
  // deliberately no check for it here: a line that asserts a thing was left out
  // cannot fail, and this file does not print lines that cannot fail.
});

// ===========================================================================
section('coriolis', '5. Coriolis, and the proof that f actually varies', () => {
// ===========================================================================
  head('5a. f = 2 Omega sin(phi), row by row');
  {
    const lat0 = -60, lat1 = 60, ny = 60;
    const g = sphericalGeometry({ nx: 90, ny, R: R_REF, lat0, lat1, ng: 2, omega: OMEGA_REF });
    for (const j of [0, 15, 30, 44, 59]) {
      // The row's latitude, computed from the domain this file asked for.
      const latC = lat0 + (j + 0.5) * (lat1 - lat0) / ny;
      check(`row ${j} (lat ${latC})`, g.fRow[g.ng + j], 2 * OMEGA_REF * Math.sin(latC * D), 1e-14);
    }
  }

  head('5b. antisymmetry about the equator, and an exact zero on it');
  {
    const g = sphericalGeometry({ nx: 90, ny: 60, R: R_REF, lat0: -60, lat1: 60, ng: 2, omega: OMEGA_REF });
    let asym = 0, fmax = 0;
    for (let j = 0; j < 60; j++) {
      asym = Math.max(asym, Math.abs(g.fRow[g.ng + j] + g.fRow[g.H - g.ng - 1 - j]));
      fmax = Math.max(fmax, Math.abs(g.fRow[g.ng + j]));
    }
    bound('max |f(phi) + f(-phi)| over 60 mirrored rows', asym, 8 * EPS * fmax,
      `f_max = ${fmt(fmax)} 1/s, i.e. ${(asym / fmax).toExponential(2)} of it`);
    // An odd row count puts a cell centre ON the equator; the arithmetic-mean
    // latitude is then exactly 0 and sin(0) is exactly 0, so f is exactly 0 --
    // not "small", which is what Math.cos-style arithmetic would have given.
    const go = sphericalGeometry({ nx: 90, ny: 45, R: R_REF, lat0: -90, lat1: 90, ng: 2, omega: OMEGA_REF });
    const mid = go.ng + 22;
    assert('f === 0 exactly on the equatorial row', go.fRow[mid] === 0,
      `phi_C = ${go.phiC[mid]}, f = ${go.fRow[mid]} (ny = 45, so a row centre lands on the equator)`);
  }

  head('5c. an inertial oscillation at two well-separated latitudes');
  //
  // Everything above would pass with f hard-wired to a single number. This does
  // not. An initially uniform zonal current over a resting flat-bottomed globe
  // turns at the local inertial rate, and the ratio of the two measured rates is
  // a prediction with no free parameter: sin(phi_1)/sin(phi_2).
  //
  // Measured over a SHORT window on purpose. f varies with latitude, so the
  // meridional velocity it makes is latitude-dependent, so the flow diverges and
  // starts building the surface tilt that geostrophic adjustment ends in; that
  // contamination grows like t^2 and is what sets the window, not the timestep.
  // At 0.05 of an inertial period it is a few tenths of a percent, measured
  // below; at a quarter period it is several percent.
  function inertial({ latA = 20, latB = 60, U0 = 0.05, deg = 4, tFrac = 0.05, killVar = false }) {
    const sim = sphere({ bed: bedFlat, deg, omega: OMEGA_REF });
    if (killVar) {
      // An f-plane in a globe costume: one magnitude everywhere, sign by hemisphere.
      const c = 2 * OMEGA_REF * Math.sin(45 * D);
      for (let j = 0; j < sim.geom.H; j++) sim.geom.fRow[j] = sim.geom.phiC[j] >= 0 ? c : -c;
    }
    for (let k = 0; k < sim.hu.length; k++) sim.hu[k] = sim.h[k] * U0;
    const pick = (lat) => {
      let best = 0, bv = Infinity;
      for (let j = 0; j < sim.ny; j++) {
        const d = Math.abs(sim.cellLonLat(0, j)[1] - lat);
        if (d < bv) { bv = d; best = j; }
      }
      return best;
    };
    const jA = pick(latA), jB = pick(latB);
    const pA = sim.cellLonLat(0, jA)[1], pB = sim.cellLonLat(0, jB)[1];
    const fA = 2 * OMEGA_REF * Math.sin(pA * D), fB = 2 * OMEGA_REF * Math.sin(pB * D);
    const tEnd = tFrac * 2 * Math.PI / fB, dt = sim.maxDt();
    while (sim.t < tEnd) sim.step(dt);
    const phase = (j) => {
      let su = 0, sv = 0;
      for (let i = 0; i < sim.nx; i++) { const k = sim.idx(i, j); su += sim.hu[k]; sv += sim.hv[k]; }
      return Math.atan2(-sv, su);
    };
    return {
      pA, pB, fA, fB, t: sim.t, steps: sim.steps,
      mA: phase(jA) / sim.t, mB: phase(jB) / sim.t,
    };
  }
  {
    const r = inertial({});
    check(`f measured at ${r.pA.toFixed(0)} deg by the flow itself`, r.mA, r.fA, 0.015,
      `${r.steps} steps, t = ${(r.t / 3600).toFixed(2)} h`);
    check(`f measured at ${r.pB.toFixed(0)} deg by the flow itself`, r.mB, r.fB, 0.015);
    check('ratio of the two rates == sin(phi_B)/sin(phi_A)', r.mB / r.mA, r.fB / r.fA, 0.01,
      `predicted ${(r.fB / r.fA).toFixed(6)} with no free parameter`);
    const k = inertial({ killVar: true });
    const kerr = Math.abs((k.mB / k.mA) / (k.fB / k.fA) - 1);
    refute('an f-plane wearing a globe costume fails that ratio', kerr > 0.01,
      `ratio ${(k.mB / k.mA).toFixed(6)} against ${(k.fB / k.fA).toFixed(6)}, off by ${(100 * kerr).toFixed(2)}%`);
  }
});

// ===========================================================================
section('curvature', '6. the metric curvature term u tan(phi)/R', () => {
// ===========================================================================
  //
  // The term is easy to leave out and, the header of src/swe.mjs says, nearly
  // impossible to catch afterwards: exactly zero at rest, and about 1.5e-3 of f
  // at 45 degrees for a 1 m/s current. Both halves of that are MEASURED below
  // rather than repeated -- and then the section goes looking for a
  // configuration where it is not small, because a term you can only justify and
  // never test is not verified.
  //
  // The lever is latitude. u tan(phi)/R over f = u tan(phi) / (2 Omega R
  // sin(phi)) grows without bound toward the pole, so a fast zonal flow at 85
  // degrees puts the curvature at 60% of f, where no tolerance can miss it.

  function jet({ U = 50, deg = 2, kill = false }) {
    const sim = sphere({ bed: bedFlat, deg, omega: OMEGA_REF });
    if (kill) sim.geom.tanPhi.fill(0);
    for (let k = 0; k < sim.hu.length; k++) sim.hu[k] = sim.h[k] * U;
    return sim;
  }
  const rowAt = (sim, lat) => {
    let best = 0, bv = Infinity;
    for (let j = 0; j < sim.ny; j++) {
      const d = Math.abs(sim.cellLonLat(0, j)[1] - lat);
      if (d < bv) { bv = d; best = j; }
    }
    return best;
  };

  head('6a. at rest it contributes exactly nothing');
  {
    // "Bit-identical" was the first thing tried here and it is FALSE, so it is
    // not what is claimed. A lake at rest is not at rest to the last bit: it
    // carries a round-off velocity u_eps of about 1e-12 m/s, and the curvature
    // term feeds on exactly that, contributing u_eps*tan(phi)/R times a momentum
    // that is itself proportional to u_eps. The right statement is therefore
    // QUADRATIC, and it is checked as one:
    //
    //     |d(hu)|  <=  K * h_max * u_eps^2 * max|tan phi| / R * T
    //
    // A term that was zero at rest for a weaker reason -- say, one that entered
    // linearly in u -- would sit a dozen orders above this.
    const a = sphere({ bed: bedUneven, deg: 4, omega: OMEGA_REF });
    const b = sphere({ bed: bedUneven, deg: 4, omega: OMEGA_REF });
    b.geom.tanPhi.fill(0);
    const dt = a.maxDt();
    for (let s = 0; s < 200; s++) { a.step(dt); b.step(dt); }
    let worst = 0, bits = true;
    for (let k = 0; k < a.h.length; k++) {
      if (a.h[k] !== b.h[k] || a.hu[k] !== b.hu[k] || a.hv[k] !== b.hv[k]) bits = false;
      worst = Math.max(worst, Math.abs(a.hu[k] - b.hu[k]), Math.abs(a.hv[k] - b.hv[k]));
    }
    let tanMax = 0;
    for (let j = a.ng; j < a.geom.H - a.ng; j++) tanMax = Math.max(tanMax, Math.abs(a.geom.tanPhi[j]));
    const uEps = Math.max(a.maxSpeed(), b.maxSpeed()), hMax = vertScale(a), T = 200 * dt;
    bound('deleting tan(phi) moves a resting lake only at O(u_eps^2)', worst,
      4 * hMax * uEps * uEps * tanMax / R_REF * T,
      `u_eps = ${fmt(uEps)} m/s, max|tan phi| = ${tanMax.toFixed(1)}, ${bits ? 'fields bit-identical' : 'NOT bit-identical'}`);
  }

  head('6b. how small it is where people look for it');
  {
    const sim = jet({ U: 1, deg: 2 });
    const j = rowAt(sim, 45), lat = sim.cellLonLat(0, j)[1];
    const dt = sim.maxDt(), hu0 = sim.hu[sim.idx(0, j)];
    sim.step(dt);
    const fe = -sim.hv[sim.idx(0, j)] / (dt * hu0);
    const f = 2 * OMEGA_REF * Math.sin(lat * D);
    check(`curvature / f at ${lat.toFixed(0)} deg for a 1 m/s current`, fe / f - 1, 1.5e-3, 0.05,
      `f_eff = ${fmt(fe)} vs f = ${fmt(f)} 1/s -- an inertial-oscillation check with a 1% tolerance cannot see this`);
  }

  head('6c. where it is NOT small: a fast zonal flow at high latitude');
  //
  // ONE STEP, and the balance is algebraic. With eta flat, the bed flat and
  // hv = 0, the pressure flux and the geometric source cancel to round-off and
  // the transverse momentum flux is zero, so the whole of the v-residual is the
  // rotation term. SSP-RK2 then gives hv = -dt*(f + u tan(phi)/R)*hu exactly:
  // stage 1 leaves hu and h untouched (the zonal flow is uniform, so its
  // divergence is zero), so the two stages average two identical coefficients.
  // What is being tested is therefore the COEFFICIENT, read back to nine digits.
  for (const lat of [85, 83, 60, 45]) {
    const sim = jet({ U: 50, deg: 2 });
    const j = rowAt(sim, lat), p = sim.cellLonLat(0, j)[1];
    const dt = sim.maxDt(), k = sim.idx(0, j), hu0 = sim.hu[k];
    sim.step(dt);
    const fe = -sim.hv[k] / (dt * hu0);
    const f = 2 * OMEGA_REF * Math.sin(p * D), cur = 50 * Math.tan(p * D) / R_REF;
    check(`f_eff at ${p.toFixed(0)} deg, 50 m/s zonal`, fe, f + cur, 1e-3,
      `curvature is ${(100 * cur / f).toFixed(1)}% of f here; f alone would read ${((fe / f - 1) * 100).toFixed(2)}% off`);
  }
  {
    const sim = jet({ U: 50, deg: 2, kill: true });
    const j = rowAt(sim, 85), p = sim.cellLonLat(0, j)[1];
    const dt = sim.maxDt(), k = sim.idx(0, j), hu0 = sim.hu[k];
    sim.step(dt);
    const fe = -sim.hv[k] / (dt * hu0);
    const f = 2 * OMEGA_REF * Math.sin(p * D), cur = 50 * Math.tan(p * D) / R_REF;
    const rel = Math.abs(fe - (f + cur)) / (f + cur);
    refute(`deleting tan(phi) breaks f_eff at ${p.toFixed(0)} deg`, rel > 1e-3,
      `${fmt(fe)} against ${fmt(f + cur)} 1/s, off by ${(100 * rel).toFixed(1)}%`);
  }

  head('6d. sustained: the jet turns at a rate this file integrates itself');
  //
  // The one-step probe measures a coefficient. This measures a TRAJECTORY: over
  // many steps the velocity vector rotates, the zonal component shrinks as it
  // does, and so the curvature contribution changes with it. The reference is
  // this file's own RK4 integration of
  //
  //     dtheta/dt = f + (U cos theta) tan(phi) / R
  //
  // which is a different integrator, a different equation form and a different
  // step size from the solver's. The window is 0.01 of an inertial period, set
  // by the same geostrophic-adjustment contamination as section 5c.
  {
    const odePhase = (f, kc, tEnd, n = 20000) => {
      const h = tEnd / n, g = (x) => f + kc * Math.cos(x);
      let th = 0;
      for (let s = 0; s < n; s++) {
        const a = g(th), b = g(th + 0.5 * h * a), c = g(th + 0.5 * h * b), d = g(th + h * c);
        th += h * (a + 2 * b + 2 * c + d) / 6;
      }
      return th;
    };
    const measure = (kill) => {
      const sim = jet({ U: 50, deg: 2, kill });
      const j = rowAt(sim, 84), p = sim.cellLonLat(0, j)[1];
      const f = 2 * OMEGA_REF * Math.sin(p * D), kc = 50 * Math.tan(p * D) / R_REF;
      const tEnd = 0.01 * 2 * Math.PI / f, dt = sim.maxDt();
      while (sim.t < tEnd) sim.step(dt);
      let su = 0, sv = 0;
      for (let i = 0; i < sim.nx; i++) { const k = sim.idx(i, j); su += sim.hu[k]; sv += sim.hv[k]; }
      return { p, theta: Math.atan2(-sv, su), want: odePhase(f, kc, sim.t), flat: f * sim.t, t: sim.t, steps: sim.steps };
    };
    const g = measure(false);
    check(`accumulated turn at ${g.p.toFixed(0)} deg over ${g.steps} steps`, g.theta, g.want, 0.02,
      `f*t alone predicts ${g.flat.toFixed(6)} rad, i.e. ${((g.theta / g.flat - 1) * 100).toFixed(1)}% low`);
    const k = measure(true);
    const rel = Math.abs(k.theta - k.want) / k.want;
    refute('the same trajectory with tan(phi) deleted', rel > 0.02,
      `${k.theta.toFixed(6)} rad against ${k.want.toFixed(6)}, off by ${(100 * rel).toFixed(1)}%`);
  }
  // The declared gap, stated precisely rather than generously. The term IS
  // covered -- 6c and 6d both go red when it is deleted, by 38% and 31% -- so
  // this is not the "I could not make it fail" case the brief allows for. What
  // is missing is the OTHER design the src/swe.mjs header names.
  note('DECLARED GAP: nothing here advects a parcel ACROSS a pole',
    'src/swe.mjs names two things that notice this term, "advection over a pole, or a long '
    + 'high-latitude jet". The jet is 6c and 6d and it fails when the term is deleted. Trans-polar '
    + 'advection was NOT attempted and is not covered by this suite.');
});

// ===========================================================================
section('periodic', '7. longitude is periodic; there is no seam at the antimeridian', () => {
// ===========================================================================
  head('7a. cellLonLat wraps rather than running off the end');
  {
    const s = sphere({ bed: bedFlat, deg: 4 });
    const nx = s.nx;
    // The ghost column at i = -1 IS the column at i = nx-1, so a bed sampled
    // there has to see the same place or every MUSCL slope across the seam is
    // taken over a discontinuity that is not there.
    for (const [a, b] of [[-1, nx - 1], [-2, nx - 2], [nx, 0], [nx + 1, 1]]) {
      assert(`lon(i=${a}) === lon(i=${b})`, s.cellLonLat(a, 0)[0] === s.cellLonLat(b, 0)[0],
        `${s.cellLonLat(a, 0)[0]} vs ${s.cellLonLat(b, 0)[0]} deg`);
    }
    const lons = [];
    for (let i = 0; i < nx; i++) lons.push(s.cellLonLat(i, 0)[0]);
    assert('every interior longitude lies in [-180, 180)', lons.every((L) => L >= -180 && L < 180),
      `${fmt(Math.min(...lons))} .. ${fmt(Math.max(...lons))} deg over ${nx} columns`);
  }

  head('7b. the same water, rotated: bit-identical');
  //
  // The initial condition is rotated by a whole number of cells in longitude and
  // the run compared cell-for-cell against the unrotated one. On a grid whose
  // cells are an integer number of degrees wide the rotation is exact in
  // floating point and the metric depends only on the row, so the answer is not
  // merely close: it is the SAME DOUBLE. Anything less means the solver knows
  // where the antimeridian is.
  const bedOf = (shiftDeg) => (lon, lat) => bedUneven(wrap180(lon - shiftDeg), lat);
  const etaOf = (shiftDeg) => (lon, lat) => {
    const L = wrap180(lon - shiftDeg);
    return 2 * Math.exp(-(wrap180(L - 40) ** 2 + (lat - 25) ** 2) / 200);
  };
  const rotated = (deg, shiftCells, wall) => {
    const mk = (sh) => {
      const s = sphere({ bed: bedOf(sh * deg), eta0: etaOf(sh * deg), deg, omega: OMEGA_REF });
      if (wall) { s.boundaries.west = reflect; s.boundaries.east = reflect; }
      return s;
    };
    const A = mk(0), B = mk(shiftCells), nx = A.nx;
    const dt = Math.min(A.maxDt(), B.maxDt());
    for (let s = 0; s < 200; s++) { A.step(dt); B.step(dt); }
    let bits = true, dh = 0, dq = 0, scale = 0;
    for (let j = 0; j < A.ny; j++) for (let i = 0; i < nx; i++) {
      const a = A.idx(i, j), b = B.idx((i + shiftCells) % nx, j);
      if (A.h[a] !== B.h[b] || A.hu[a] !== B.hu[b] || A.hv[a] !== B.hv[b]) bits = false;
      dh = Math.max(dh, Math.abs(A.h[a] - B.h[b]));
      dq = Math.max(dq, Math.abs(A.hu[a] - B.hu[b]), Math.abs(A.hv[a] - B.hv[b]));
      scale = Math.max(scale, A.h[a]);
    }
    return { bits, dh, dq, scale, nx, ny: A.ny };
  };
  {
    const r = rotated(4, 23, false);
    assert('4 deg grid, rotated 23 cells (92 deg, across the antimeridian)', r.bits,
      `${r.nx}x${r.ny}, 200 steps, max |dh| = ${r.dh}, max |d(hu,hv)| = ${r.dq}`);
  }
  {
    // A grid whose cells are 3.6 degrees wide: the shift is no longer exact in
    // binary, so the two beds differ in their last bits before the run starts.
    // The right claim there is round-off, not bit-identity, and saying so is the
    // difference between a tolerance and a wish.
    const r = rotated(3.6, 23, false);
    bound('3.6 deg grid, rotated 23 cells: max |dh| / h', r.dh / r.scale, 1e-11,
      `${r.nx}x${r.ny}, 200 steps; the shift of 82.8 deg is not exact in binary`);
  }
  {
    const r = rotated(4, 23, true);
    refute('walls at the antimeridian instead of a periodic seam', !r.bits && r.dh / r.scale > 1e-11,
      `max |dh|/h = ${fmt(r.dh / r.scale)}, max |d(hu,hv)| = ${fmt(r.dq)} -- the seam becomes visible`);
  }
});

// ===========================================================================
section('finite', '8. a blow-up is reported, not survived', () => {
// ===========================================================================
  head('8a. finite() answers the question it is asked');
  {
    const ok = sphere({ bed: bedUneven, deg: 6 });
    const dt = ok.maxDt();
    for (let s = 0; s < 50; s++) ok.step(dt);
    assert('a healthy run reports finite', ok.finite() === true, `50 steps, max speed ${fmt(ok.maxSpeed())} m/s`);
    const a = sphere({ bed: bedFlat, deg: 6 });
    a.h[a.idx(3, 3)] = NaN;
    assert('one NaN in h is reported', a.finite() === false, 'h[3,3] := NaN');
    const b = sphere({ bed: bedFlat, deg: 6 });
    b.hv[b.idx(5, 5)] = Infinity;
    assert('one Infinity in hv is reported', b.finite() === false, 'hv[5,5] := Infinity');
  }

  head('8b. an actual blow-up');
  {
    // cfl 4.0 is nine times the shipped Courant number. This is not a check that
    // the solver is robust -- it is a check that when it is driven past its
    // stability limit the failure ARRIVES as a non-finite field rather than as a
    // plausible-looking answer.
    const bad = sphere({
      bed: bedFlat, deg: 6, cfl: 4.0, omega: OMEGA_REF,
      eta0: (lon, lat) => 50 * Math.exp(-(lon * lon + lat * lat) / 50),
    });
    const dt = bad.maxDt();
    let blew = -1;
    for (let s = 0; s < 400 && blew < 0; s++) { bad.step(dt); if (!bad.finite()) blew = s; }
    assert('cfl 4.0 goes non-finite, and finite() says so', blew >= 0,
      blew >= 0 ? `at step ${blew} of 400, dt = ${dt.toFixed(2)} s` : `still finite after 400 steps, max speed ${fmt(bad.maxSpeed())}`);
  }

  head('8c. step() refuses a step it cannot take');
  {
    const s = sphere({ bed: bedFlat, deg: 6 });
    const r = [s.step(NaN), s.step(-1), s.step(0), s.step(Infinity)];
    assert('step(NaN), step(-1), step(0), step(Infinity) all return 0', r.every((x) => x === 0), `returned ${r.join(', ')}`);
    assert('...and none of them advanced the clock', s.t === 0 && s.steps === 0, `t = ${s.t}, steps = ${s.steps}`);
    const dry = sphere({ bed: () => 100, deg: 6 });
    assert('an entirely dry globe has no CFL step and takes none',
      dry.maxDt() === Infinity && dry.step() === 0, `maxDt = ${dry.maxDt()}, step() = ${dry.step()}`);
  }
});

// ===========================================================================
section('baseline', '9. the checked-in baseline', () => {
// ===========================================================================
  //
  // NOT VERIFICATION. Every line here compares this run against numbers recorded
  // from an earlier one, so it can only say "unchanged", never "right". It is
  // here because until now the spherical path's only recorded numbers lived in a
  // src/ header comment and a scratchpad that no longer reproduces them, which
  // is the state the Cartesian path was rescued from by having three suites and
  // a byte-diff.
  //
  // WHAT EACH TOLERANCE MEANS, because they are not the same kind of number:
  //   interiorArea      a real quantity; bit-reproducible, pinned at 1e-15.
  //   rel (area)        a ROUND-OFF residual. Pinning its value would pin the
  //                     last bits of Math.sin across Node versions, so what is
  //                     pinned is that it stays at round-off: |rel| < 1e-13.
  //   maxSpeed/maxEta   also round-off residuals, for the same reason bounded by
  //                     ORDER OF MAGNITUDE (a factor of 4 either way). A metric
  //                     regression moves these by 8 to 12 orders; a Math library
  //                     change moves them by a factor of 2.
  //   merian errPct     physical; pinned to 0.005 percentage points absolute.
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sphere-baseline.json');
  if (!fs.existsSync(file)) {
    assert('tools/sphere-baseline.json exists', false, `${file} not found -- run with --bless to record it`);
    return;
  }
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert('baseline names the tree it was recorded from', typeof base.recorded === 'string' && base.recorded.length > 0,
    `recorded ${base.recorded} by node ${base.node}, ${base.restingOcean.length} resting rows, `
    + `${base.areaIdentity.length} area rows, ${base.merian.length} Merian rows`);

  const keyR = (r) => `${r.case}|${r.deg}|${r.order}|${r.lat0}|${r.lat1}|${r.steps}`;
  const keyA = (r) => `${r.deg}|${r.lat0}|${r.lat1}`;
  const keyM = (r) => `${r.n}|${r.deg}`;
  const cmp = (name, want, got, key, fn) => {
    const map = new Map(got.map((r) => [key(r), r]));
    let missing = 0;
    for (const w of want) {
      const g = map.get(key(w));
      if (!g) { missing++; continue; }
      fn(w, g);
    }
    if (missing) {
      // A baseline row with nothing to compare it against is only acceptable
      // because a filter was given. Without one it means a section that should
      // have produced the measurement did not.
      assert(`${name}: unmeasured baseline rows are explained by --only`, ONLY !== null,
        `${missing} of ${want.length} rows were not measured in this run`
        + (ONLY ? ` (--only ${ONLY})` : ' -- and no filter was given, so this is a hole'));
    }
  };
  cmp('resting ocean', base.restingOcean, record.restingOcean, keyR, (w, g) => {
    const tag = `${w.case} ${w.deg}deg${w.order !== 2 ? ` order${w.order}` : ''}${w.lat0 !== -90 ? ` ${w.lat0}..${w.lat1}` : ''}`;
    const band = (got, want) => (got === 0 || want === 0
      ? { ok: got === want, r: NaN }
      : { ok: got / want >= 0.25 && got / want <= 4, r: got / want });
    const sp = band(g.maxSpeed, w.maxSpeed), et = band(g.maxEta, w.maxEta);
    line(sp.ok, `baseline ${tag}: max speed`,
      `got ${fmt(g.maxSpeed)}  want ${fmt(w.maxSpeed)}  ratio ${sp.r.toFixed(3)}  band 0.25 .. 4`);
    line(et.ok, `baseline ${tag}: max |eta|`,
      `got ${fmt(g.maxEta)}  want ${fmt(w.maxEta)}  ${isFinite(et.r) ? `ratio ${et.r.toFixed(3)}  band 0.25 .. 4` : 'both must be exactly 0'}`);
    assert(`baseline ${tag}: dry cells`, g.dry === w.dry, `got ${g.dry}  want ${w.dry}`);
  });
  cmp('area identity', base.areaIdentity, record.areaIdentity, keyA, (w, g) => {
    const tag = `${w.lat0}..${w.lat1} at ${w.deg} deg`;
    check(`baseline area ${tag}`, g.area, w.area, 1e-15);
    bound(`baseline area ${tag}: residual still round-off`, g.rel, 1e-13, `recorded ${fmt(w.rel)}`);
  });
  cmp('merian', base.merian, record.merian, keyM, (w, g) => {
    line(Math.abs(g.errPct - w.errPct) <= 0.005, `baseline Merian n=${w.n} at ${w.deg} deg`,
      `got ${g.errPct.toFixed(4)}%  want ${w.errPct.toFixed(4)}%  d ${(g.errPct - w.errPct).toFixed(5)} pp  tol 0.005 pp`);
  });
});

// ---------------------------------------------------------------------------
// Section 10: the header table, regenerated from live measurement.
// ---------------------------------------------------------------------------
//
// src/geometry.mjs's header carries a mutation table that was written from
// memory, and it is wrong in three places. The mechanism is the problem, not the
// three entries: a table nobody can re-run is a table that drifts. So this mode
// re-measures it.
//
// HOW. The tree is copied to a temp directory, src/ is text-patched there, and
// THIS FILE -- copied alongside -- is re-run out of the mutant tree with --probe,
// which prints one JSON line of max speeds. Nothing is ever written inside the
// repository. An anchor that does not match exactly once is an ERROR and exits
// non-zero, because an unapplied mutation and a mutation nothing catches print
// the same green row.
const PROBE_DEG = 2, PROBE_STEPS = 400;
const PROBE_BEDS = [['flat', bedFlat], ['uneven', bedUneven], ['piercing', bedPiercing]];

const MUTANTS = [
  { id: 'none', label: '(none)', patches: [], lake: false, metric: false },
  {
    id: 'bedphi-rdphi',
    label: 'bedPhi := R dphi',
    lake: true, metric: true,
    patches: [{
      file: 'src/geometry.mjs',
      find: '    g.bedPhi[j] = (g.lyN[j] + g.lyS[j]) > 0 ? 2 * A / (g.lyN[j] + g.lyS[j]) : Infinity;',
      repl: '    g.bedPhi[j] = R * dphi;',
    }],
  },
  {
    id: 'geo-hcell-squared',
    label: 'geo on h_cell^2 not h_N,h_S',
    lake: true, metric: false,
    patches: [{
      file: 'src/swe.mjs',
      find: '              if (sph) rhv[k] += gc * G * (hP * hP + hM * hM);',
      repl: '              if (sph) rhv[k] += gc * G * (2 * h[k] * h[k]);',
    }],
  },
  {
    id: 'geo-deleted',
    label: 'geo source deleted',
    lake: true, metric: false,
    patches: [{
      file: 'src/swe.mjs',
      find: '              if (sph) rhv[k] += gc * G * (hP * hP + hM * hM);',
      repl: '              if (false && sph) rhv[k] += gc * G * (hP * hP + hM * hM);',
    }],
  },
  {
    id: 'area-naive',
    label: 'area := R^2 cos(phi) dlam dphi',
    lake: false, metric: true,
    patches: [{
      file: 'src/geometry.mjs',
      find: '    let A = 2 * R * R * dlam * cosLat(pC) * Math.sin(half);',
      repl: '    let A = R * R * dlam * dphi * cosLat(pC);',
    }],
  },
  {
    id: 'geocoef-tan',
    label: 'geoCoef via -tan/4R',
    lake: false, metric: false,
    patches: [{
      file: 'src/geometry.mjs',
      find: '    g.geoCoef[j] = (g.lyN[j] - g.lyS[j]) / (4 * A);',
      repl: '    g.geoCoef[j] = -Math.tan(pC) / (4 * R);',
    }],
  },
  {
    id: 'coslat-math-cos',
    label: 'cosLat := Math.cos',
    lake: false, metric: true,
    patches: [{
      file: 'src/geometry.mjs',
      find: [
        'const cosLat = (p) => {',
        '  const co = HALF_PI - Math.abs(p);',
        '  return co <= 0 ? 0 : Math.sin(co);',
        '};',
      ].join('\n'),
      repl: 'const cosLat = (p) => Math.cos(p);',
    }],
  },
];

/** The measurement one table cell holds. Also the whole of --probe. */
function probe() {
  const out = {};
  for (const [name, bed] of PROBE_BEDS) {
    const sim = sphere({ bed, deg: PROBE_DEG });
    const dry = dryCells(sim), dt = sim.maxDt();
    for (let s = 0; s < PROBE_STEPS; s++) sim.step(dt);
    out[name] = { speed: sim.maxSpeed(), dry, finite: sim.finite() };
  }
  return out;
}

const toLF = (s) => (s.indexOf('\r') === -1 ? s : s.replace(/\r\n/g, '\n'));
/** Replace `find` with `repl`, asserting the anchor occurs EXACTLY once. */
function patchText(text, find, repl, where) {
  const parts = text.split(find);
  if (parts.length - 1 !== 1) {
    throw new Error(`anchor found ${parts.length - 1} times (want exactly 1) in ${where}: `
      + JSON.stringify(find.length > 80 ? find.slice(0, 80) + '...' : find));
  }
  const out = parts.join(repl);
  if (out === text) throw new Error(`patch was a no-op in ${where}`);
  return out;
}

/**
 * The guard in patchText() is the load-bearing part of section 10, so it gets a
 * check that fails. If it ever stopped throwing -- a refactor, a swallowed
 * error -- every mutation would apply nothing and the table would print a clean
 * row for each, which reads exactly like a mutation nothing catches.
 */
function patchSelfTest() {
  const src = ['alpha', 'beta', 'gamma', 'beta', ''].join('|');
  const dies = (fn) => { try { fn(); return false; } catch { return true; } };
  assert('patchText refuses an anchor that is not there',
    dies(() => patchText(src, 'delta', 'x', 'self-test')), 'anchor "delta" in a text without one');
  assert('patchText refuses an anchor that appears twice',
    dies(() => patchText(src, 'beta', 'x', 'self-test')), 'anchor "beta" appears twice');
  assert('patchText refuses a patch that changes nothing',
    dies(() => patchText(src, 'gamma', 'gamma', 'self-test')), 'find === repl');
  assert('patchText still applies a valid single-anchor replacement',
    patchText(src, 'gamma', 'delta', 'self-test') === ['alpha', 'beta', 'delta', 'beta', ''].join('|'),
    'one occurrence, replaced');
}

function runTable() {
  head('10. the src/geometry.mjs header table, measured');
  patchSelfTest();
  console.log('');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.dirname(here);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-sphere-'));
  console.log(`  ${PROBE_BEDS.length} beds x ${MUTANTS.length} mutants, ${PROBE_DEG} deg, `
    + `${PROBE_STEPS} steps, max speed [m/s] -- and, in the last column, what section 1 of this`);
  console.log('  same file says about the same mutant tree, because the resting lake is not the');
  console.log('  only gate the sphere has and the header table reads as though it were.');
  console.log(`  scratch: ${scratch}\n`);
  const rows = [];
  let anchorErrors = 0;
  try {
    // Pristine copy, LF-normalised so a multi-line anchor cannot miss on a CRLF
    // clone -- and normalised in the COPY only; the repository is never written to.
    const base = path.join(scratch, '_base');
    fs.mkdirSync(base);
    fs.cpSync(path.join(repo, 'src'), path.join(base, 'src'), { recursive: true });
    fs.mkdirSync(path.join(base, 'tools'));
    fs.cpSync(path.join(here, 'verify-sphere.mjs'), path.join(base, 'tools', 'verify-sphere.mjs'));
    for (const rel of ['src', 'tools']) {
      for (const f of fs.readdirSync(path.join(base, rel))) {
        const p = path.join(base, rel, f);
        if (!fs.statSync(p).isFile()) continue;
        fs.writeFileSync(p, toLF(fs.readFileSync(p, 'utf8')));
      }
    }
    for (const m of MUTANTS) {
      const dir = path.join(scratch, m.id);
      fs.cpSync(base, dir, { recursive: true });
      let err = null;
      try {
        for (const p of m.patches) {
          const target = path.join(dir, p.file);
          fs.writeFileSync(target, patchText(fs.readFileSync(target, 'utf8'), p.find, p.repl, `${m.id} -> ${p.file}`));
        }
      } catch (e) { err = e.message; }
      if (err) { anchorErrors++; rows.push({ m, err }); continue; }
      const self = path.join(dir, 'tools', 'verify-sphere.mjs');
      // The resting-lake columns.
      const stdout = execFileSync(process.execPath, [self, '--probe'], { encoding: 'utf8', maxBuffer: 1 << 22 });
      const jsonLine = stdout.split('\n').find((l) => l.startsWith('PROBE '));
      if (!jsonLine) { anchorErrors++; rows.push({ m, err: `no PROBE line from ${m.id}` }); continue; }
      // ...and section 1, run out of the mutant tree, which is the OTHER gate.
      // A crash counts as a detection and is labelled as one; it is not the same
      // thing as a check failing.
      let metric;
      try {
        const out = execFileSync(process.execPath, [self, '--only', 'metric'], { encoding: 'utf8', maxBuffer: 1 << 22 });
        metric = { text: (out.match(/ALL PASS -- (\d+\/\d+)/) || [, '?'])[1], caught: false };
      } catch (e) {
        const out = String(e.stdout || '');
        const f = out.match(/(\d+) FAILURES -- (\d+\/\d+)/);
        metric = f ? { text: `${f[2]} (${f[1]} fail)`, caught: true } : { text: 'CRASH', caught: true };
      }
      rows.push({ m, r: JSON.parse(jsonLine.slice(6)), metric });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad('mutation', 32)}${pad('flat bed', 13)}${pad('uneven bed', 13)}${pad('piercing bed', 14)}section 1`);
  for (const row of rows) {
    if (row.err) { console.log(`  ${pad(row.m.label, 32)}ANCHOR-ERROR  ${row.err}`); continue; }
    const c = (k, w) => pad(row.r[k].speed.toExponential(1), w);
    console.log(`  ${pad(row.m.label, 32)}${c('flat', 13)}${c('uneven', 13)}${c('piercing', 14)}${row.metric.text}`);
  }
  const dry = rows.find((r) => r.m.id === 'none');
  console.log(`\n  dry cells at ${PROBE_DEG} deg: flat ${dry.r.flat.dry}, uneven ${dry.r.uneven.dry}, `
    + `piercing ${dry.r.piercing.dry} -- the piercing column is the only one with a coastline.`);
  console.log('  A row whose three speeds sit at 1e-13 and whose section 1 says ALL PASS is a');
  console.log('  mutation NOTHING in this repository catches. There is one, and it is declared.');

  head('10a. the table is a measurement, so it is also a gate');
  assert('every anchor applied exactly once', anchorErrors === 0,
    `${MUTANTS.length - anchorErrors} of ${MUTANTS.length} mutants patched; an unapplied mutation reads as a clean row`);
  const get = (id) => rows.find((r) => r.m.id === id);
  const base = get('none');
  bound('shipped: flat bed at rest', base.r.flat.speed, 1e-11, 'the row every other row is read against');
  bound('shipped: uneven bed at rest', base.r.uneven.speed, 1e-11);
  bound('shipped: piercing bed at rest', base.r.piercing.speed, 1e-11);
  assert('shipped: section 1 is green in the pristine copy', !base.metric.caught, `section 1 read ${base.metric.text}`);
  let known = 0;
  for (const m of MUTANTS.slice(1)) {
    const r = get(m.id);
    if (!r || r.err) { assert(`${m.label}: measured`, false, r ? r.err : 'missing'); continue; }
    const worst = Math.max(r.r.flat.speed, r.r.uneven.speed, r.r.piercing.speed);
    const lakeCaught = worst > 1e-6;
    // The DECLARED verdict, checked. Getting this wrong in either direction is a
    // finding: a mutation that stops being caught is a hole, and one that starts
    // being caught means the declaration is stale.
    assert(`${m.label}: resting lake ${m.lake ? 'CATCHES' : 'survives'}, as declared`, lakeCaught === m.lake,
      `worst column ${fmt(worst)} m/s, ${(worst / base.r.uneven.speed).toExponential(1)}x the shipped uneven bed`);
    assert(`${m.label}: section 1 ${m.metric ? 'CATCHES' : 'survives'}, as declared`, r.metric.caught === m.metric,
      `section 1 read ${r.metric.text}`);
    if (!m.lake && !m.metric) {
      known++;
      note(`${m.label}: DECLARED SURVIVOR of everything here`,
        'a conditioning regression, not a correctness bug -- the two forms are the same number, '
        + 'and src/geometry.mjs measures the factor 2-3 it costs');
    }
  }
  assert('exactly one mutation survives both gates', known === 1,
    `${known} of ${MUTANTS.length - 1}; anything else means the declarations above have gone stale`);
  {
    const r = get('geo-hcell-squared').r;
    assert('geo-hcell-squared: the coastline is worth something HERE',
      r.piercing.speed > r.uneven.speed,
      `uneven ${fmt(r.uneven.speed)} vs piercing ${fmt(r.piercing.speed)} m/s `
      + `-- ${(r.piercing.speed / r.uneven.speed).toFixed(1)}x, which is the one place the piercing fixture pays`);
  }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const KNOWN = new Set(['--help', '-h', '--list', '--only', '--table', '--bless', '--probe']);
let ONLY = null, MODE = 'run';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--only=')) { ONLY = a.slice(7); continue; }
  if (a === '--only') { ONLY = argv[++i] ?? ''; continue; }
  if (a === '--table') { MODE = 'table'; continue; }
  if (a === '--probe') { MODE = 'probe'; continue; }
  if (a === '--bless') { MODE = 'bless'; continue; }
  if (a === '--list') { MODE = 'list'; continue; }
  if (a === '--help' || a === '-h') { MODE = 'help'; continue; }
  console.error(`verify-sphere: unrecognised argument ${JSON.stringify(a)}.`);
  console.error(`  known: ${[...KNOWN].join(' ')}; sections: ${SECTIONS.map((s) => s.id).join(' ')}`);
  process.exit(2);
}

if (MODE === 'help') {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
    .filter((l) => l.startsWith('//')).slice(0, 21).join('\n'));
  process.exit(0);
}
if (MODE === 'list') {
  for (const s of SECTIONS) console.log(`  ${s.id.padEnd(12)} ${s.title}`);
  console.log(`\n  also: --table (section 10, the src/geometry.mjs header table), --bless (record the baseline)`);
  process.exit(0);
}
if (MODE === 'probe') {
  console.log('PROBE ' + JSON.stringify(probe()));
  process.exit(0);
}
if (MODE === 'table') {
  runTable();
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} -- ${checks - failures}/${checks} checks\n`);
  process.exit(failures ? 1 : 0);
}

let selected = SECTIONS;
if (ONLY !== null) {
  // Comma-separated, so `--only lake,baseline` can run a section together with
  // the baseline that pins it. Every name must resolve: one typo in a list is
  // still a filter that silently drops a section.
  const want = ONLY.split(',').map((x) => x.trim()).filter((x) => x.length);
  const unknown = want.filter((w) => !SECTIONS.some((x) => x.id === w));
  if (want.length === 0 || unknown.length) {
    console.error(`verify-sphere: --only ${JSON.stringify(ONLY)} names no section`
      + `${unknown.length ? ` (${unknown.map((u) => JSON.stringify(u)).join(', ')})` : ''}.`);
    console.error(`  sections: ${SECTIONS.map((x) => x.id).join(' ')}`);
    process.exit(2);
  }
  selected = SECTIONS.filter((x) => want.includes(x.id));
}
if (MODE === 'bless') {
  if (ONLY !== null) {
    console.error('verify-sphere: --bless records the whole baseline and cannot be combined with --only.');
    process.exit(2);
  }
  // Section 9 compares this run against the file --bless is about to overwrite,
  // which would be a check of a thing that is being replaced. It is skipped, and
  // the RITUAL IS TWO STEPS: bless, then run the suite again with no flags so
  // that section 9 reads the new file and has to agree with it.
  selected = SECTIONS.filter((x) => x.id !== 'baseline');
}

const t0 = Date.now();
console.log(`\nverify-sphere: ${selected.length} of ${SECTIONS.length} sections, node ${process.version}`);
for (const s of selected) {
  console.log(`\n${'#'.repeat(74)}\n# ${s.title}\n${'#'.repeat(74)}`);
  s.fn();
}

if (MODE === 'bless') {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sphere-baseline.json');
  const out = {
    what: 'Recorded output of tools/verify-sphere.mjs on the spherical path. Regenerate with '
      + '`node tools/verify-sphere.mjs --bless`, which runs every section and overwrites this file. '
      + 'A regression baseline, not a theory: section 9 of that suite states what each tolerance means.',
    recorded: new Date().toISOString().slice(0, 10),
    node: process.version,
    constants: { G_REF, R_REF, OMEGA_REF, H_OCEAN, probeDeg: PROBE_DEG, probeSteps: PROBE_STEPS },
    ...record,
  };
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n  blessed ${file}`);
  console.log(`  ${record.restingOcean.length} resting rows, ${record.areaIdentity.length} area rows, `
    + `${record.merian.length} Merian rows`);
}

console.log(`\n${(Date.now() - t0) / 1000} s wall clock`);
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} -- ${checks - failures}/${checks} checks\n`);
process.exit(failures ? 1 : 0);
