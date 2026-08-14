// ---------------------------------------------------------------------------
// MUTATION HARNESS -- what does "ALL PASS" actually mean?
//
//   node tools/mutants.mjs              (~4 min, 15 mutants, 3 suites)
//   node tools/mutants.mjs --list       (print the mutant list, run nothing)
//   node tools/mutants.mjs --anchors    (apply every patch, run no suite; ~1 s.
//                                        This is the check to run after touching
//                                        src/swe.mjs, and it is the one that
//                                        fails when the anchors go stale)
//   node tools/mutants.mjs --only vel   (mutants whose id or name contains "vel")
//   node tools/mutants.mjs --jobs 4     (concurrency; default 6)
//
// WHY THIS FILE EXISTS.
//
// A hostile review broke seven load-bearing pieces of physics in src/swe.mjs --
// gravity, the positivity limiter, the desingularised velocity, the Manning
// exponent, the friction splitting, the HLLC contact wave, and Coriolis -- and
// tools/verify.mjs printed "ALL PASS -- 32/32 checks" for every one of them.
// The suite was not measuring the physics. It was measuring the solver against
// itself, and 32 green lines were 32 statements about internal consistency.
//
// A check that cannot fail is worse than no check, because it is counted. The
// only way to know whether a suite can fail is to make the code wrong on purpose
// and watch. That is all this file does: it breaks one thing at a time in a
// COPY of src/, runs the shipped suites against the copy, and reports whether
// each suite noticed.
//
// WHAT THE VERDICTS MEAN, exactly.
//
//   CAUGHT       at least one shipped suite went red (or crashed, or hung).
//                It does NOT mean the suite failed for the right reason: read
//                the "first:" line in the detail block below the table, which
//                prints the first check that actually failed. A mutant caught
//                only by a check with nothing to do with it is a coincidence,
//                not coverage.
//   SURVIVED     every suite in the repository stayed green with the physics
//                broken. This is a hole, and it exits the harness non-zero.
//   TIMEOUT      the suite did not finish inside 3x its measured baseline. A
//                hang is a detection, but it is not a check failing, so it is
//                labelled separately and never counted as a passing check.
//   CRASH        the suite threw (usually a NaN reaching an invariant). Also a
//                detection, also not the same thing as a check failing.
//   ANCHOR-ERROR the patch text was not found EXACTLY ONCE in the source, so
//                the mutation was never applied. This is the failure mode that
//                would otherwise be invisible: an unapplied mutation and a suite
//                that catches nothing produce the identical green table. Any
//                anchor error exits non-zero, same as a survivor.
//
// IT RUNS THE REAL SUITES, NOT PROBES OF ITS OWN. A targeted probe written here
// would be a probe measuring itself: it would prove that THIS file can detect
// the mutation, which is not the question. The question is whether the suites
// that ship with the repository and print the green numbers can. So the only
// things run are tools/verify.mjs, tools/verify-physics.mjs and
// tools/verify-tide.mjs, unmodified, byte for byte.
//
// RUNTIME is bought by choosing WHICH suite to run per mutant, not by shortening
// the suites. Each mutant declares the suite whose checks are aimed at the thing
// it breaks -- usually tools/verify-physics.mjs, measured at 5.8 s against
// 84 s for verify.mjs and 87 s for verify-tide.mjs on this machine. If the
// declared suites all stay GREEN the harness ESCALATES and runs every remaining
// suite before calling anything a survivor, because "survived" is a strong claim
// and it should cost the harness something to make it.
//
// THE REPOSITORY IS NEVER WRITTEN TO. Everything happens under os.tmpdir(). Two
// guards, both able to fail: every write asserts its path is inside the scratch
// root, and a SHA-256 of every file in src/ and tools/ is taken before and after
// the run and compared.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ---------------------------------------------------------------------------
// The suites. `label` is what the table prints; `file` is run verbatim.
// ---------------------------------------------------------------------------
const SUITES = {
  'verify-physics': { file: 'tools/verify-physics.mjs' },
  'verify': { file: 'tools/verify.mjs' },
  'verify-tide': { file: 'tools/verify-tide.mjs' },
};
const SUITE_ORDER = ['verify-physics', 'verify', 'verify-tide'];

// ---------------------------------------------------------------------------
// THE MUTANTS.
//
// `find` must appear EXACTLY ONCE in the file or the mutant errors out. Anchors
// are whole lines copied verbatim from src/swe.mjs, which makes them brittle
// against reformatting ON PURPOSE: a harness that quietly stops mutating when
// the source moves is a harness that reports a clean bill of health forever.
//
// `review` records what the hostile review measured for that mutation against
// the suite as it stood then, so the table can be compared against it. Those are
// the reviewer's numbers, not mine; where this harness measures something
// different that is worth knowing and the detail block prints both.
//
// `found` is an optional note recording what THIS harness measured on the date
// given. It is printed, never asserted: it is a reference value produced by the
// code under test, so comparing against it automatically would be the exact
// circular check this repository is trying to stop doing. It is there so a human
// reading a later run can see that the answer moved.
// ---------------------------------------------------------------------------
const L = (...lines) => lines.join('\n');

const MUTANTS = [
  {
    id: 'g-x1.01',
    name: 'G scaled by 1.01',
    breaks: 'gravity: every celerity, pressure flux and bed source in the solver',
    expect: 'verify.mjs section 0 (G identity) and section 4 (c = sqrt(gh)); '
      + 'verify-physics section 2, whose Manning targets use a literal g',
    review: 'GREEN at the review -- verify.mjs targets imported G from the solver, '
      + 'so prediction and measurement moved together',
    found: '2026-08-14: caught, but by less than it looks. verify.mjs 3/35 -- the '
      + 'section 0 identity assert, Ritter\'s convergence order and Thacker\'s mean '
      + 'error. Every direct wave-speed check STAYED GREEN: celerity moves by '
      + 'sqrt(1.01)-1 = +0.499% against a 1% tolerance, Merian and Thacker\'s period '
      + 'by -0.496% against 1%. verify-physics 2/43, both spin-down identities (the '
      + 'friction coefficient is linear in g, so the residual is 1.000%); the three '
      + 'normal-depth checks stayed green at -0.496% against a 0.5% tolerance, i.e. '
      + 'they used 99.3% of it. verify-tide 0/14: it imports G from src/swe.mjs '
      + '(line 21) and writes its own targets with it -- T_res = 4L/sqrt(G h) at '
      + 'line 95, c0 = sqrt(G h) at line 159 -- so prediction and measurement still '
      + 'move together there. That is the review\'s original defect, unfixed, in the '
      + 'one suite the fix did not reach',
    // All three suites, deliberately. This was the review's central finding and
    // the suites that were fixed for it should be able to prove it.
    suites: ['verify-physics', 'verify', 'verify-tide'],
    patches: [{
      file: 'src/swe.mjs',
      find: 'export const G = 9.80665;          // standard gravity [m/s^2]',
      repl: 'export const G = 9.80665 * 1.01;   // MUTANT: gravity 1% high',
    }],
  },
  {
    id: 'g-x1.10',
    name: 'G scaled by 1.10',
    breaks: 'the same thing as g-x1.01, ten times harder -- this one brackets the '
      + 'tolerances rather than the coupling',
    expect: 'the point of running BOTH gravity mutants: at 1% the analytic targets '
      + 'are decoupled but the tolerances swallow the error, so only the identity '
      + 'assert and the accumulated-error checks fire. At 10% the wave-speed checks '
      + 'themselves have to fire, and if they do not the decoupling is cosmetic',
    review: 'the reviewer used 1.01; 1.10 is the control the other agents measured '
      + 'their fix against (verify.mjs 12 failures, verify-physics 5)',
    suites: ['verify-physics', 'verify'],
    patches: [{
      file: 'src/swe.mjs',
      find: 'export const G = 9.80665;          // standard gravity [m/s^2]',
      repl: 'export const G = 9.80665 * 1.10;   // MUTANT: gravity 10% high',
    }],
  },
  {
    id: 'positivity-off',
    name: 'positivity limiter disabled',
    breaks: 'a cell may give away more water than it has; the thin film of a front '
      + 'goes negative, gets floored, and its neighbour accelerates into the hole',
    expect: 'verify-physics section 3: "positivity: no cell ends the stage with '
      + 'negative depth", and the clip counter that stops it being vacuous',
    review: 'GREEN at the review',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: '    if (dt > 0) {',
      repl: '    if (false) {   // MUTANT: positivity limiter disabled',
    }],
  },
  {
    id: 'vel-raw',
    name: 'vel() returns raw hu/h',
    breaks: 'the desingularisation: velocity is unbounded as h -> 0 and 0/0 = NaN '
      + 'at a dry cell',
    expect: 'verify-physics section 4: "vel() stays bounded as h -> 0" and '
      + '"vel() -> 0 rather than diverging at h = 0"',
    review: 'GREEN at the review',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: L(
        '    const h4 = h * h * h * h;',
        '    return (Math.SQRT2 * h * hq) / Math.sqrt(h4 + Math.max(h4, this.eps4));',
      ),
      repl: '    return hq / h;   // MUTANT: desingularisation removed',
    }],
  },
  {
    id: 'vel-max-eps',
    name: 'vel() divides by max(h, minDepth)',
    breaks: 'nothing visibly -- this is the plausible refactor. src/swe.mjs claims '
      + 'it would "bias every shallow cell\'s velocity low and quietly damp run-up"',
    expect: 'the run-up checks ought to see the damping the docstring describes',
    review: 'not on the review\'s list -- added here because src/swe.mjs makes a '
      + 'specific claim about this exact alternative and nothing tested it',
    found: '2026-08-14: caught by ONE check, and not the one the claim is about. '
      + 'Only "vel() -> 0 rather than diverging at h = 0" fired, because the mutant '
      + 'returns hq/minDepth = 2 m/s at h = 0 exactly. Every run-up check stayed '
      + 'green. So the docstring\'s claim -- that this alternative would "bias every '
      + 'shallow cell\'s velocity low and quietly damp run-up" -- is still untested '
      + 'by anything in this repository; what is tested is a boundary value at h = 0',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: L(
        '    const h4 = h * h * h * h;',
        '    return (Math.SQRT2 * h * hq) / Math.sqrt(h4 + Math.max(h4, this.eps4));',
      ),
      repl: '    return hq / Math.max(h, this.minDepth);   // MUTANT: clipped, not desingularised',
    }],
  },
  {
    id: 'manning-exponent',
    name: 'Manning h^(4/3) -> h^(1/3)',
    breaks: 'the friction law itself: normal depth becomes u = h^(1/6) sqrt(S)/n '
      + 'instead of h^(2/3) sqrt(S)/n',
    expect: 'verify-physics section 2(a), all three normal-depth checks, and 2(b), '
      + 'whose spin-down identity is written with h^(4/3) explicitly',
    review: 'GREEN at the review',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: '        const denom = 1 + dt * G * n * n * speed / Math.pow(hk, 4 / 3);',
      repl: '        const denom = 1 + dt * G * n * n * speed / Math.pow(hk, 1 / 3);   // MUTANT',
    }],
  },
  {
    id: 'manning-explicit',
    name: 'Manning integrated explicitly',
    breaks: 'the semi-implicit splitting: forward Euler on a stiff drag term, which '
      + 'can and does reverse the flow where the film is thin',
    expect: 'verify-physics section 2(b): the spin-down identity is ALGEBRAICALLY '
      + 'exact for the semi-implicit update (worst residual 1.7e-15) and only for it',
    review: 'GREEN at the review',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: L(
        '        const denom = 1 + dt * G * n * n * speed / Math.pow(hk, 4 / 3);',
        '        this.hu[k] /= denom;',
        '        this.hv[k] /= denom;',
      ),
      repl: L(
        '        const rate = dt * G * n * n * speed / Math.pow(hk, 4 / 3);   // MUTANT: explicit',
        '        this.hu[k] -= rate * this.hu[k];',
        '        this.hv[k] -= rate * this.hv[k];',
      ),
    }],
  },
  {
    id: 'hllc-transverse',
    name: 'HLLC transverse always takes vL',
    breaks: 'the contact wave: transverse momentum is taken from the downwind side '
      + 'when the contact runs backwards, so refraction bleeds',
    expect: 'verify-physics section 6, which runs u0 = -1.2 m/s deliberately -- with '
      + 'u0 > 0 this mutation is exactly equivalent to the real thing and invisible',
    review: 'GREEN at the review',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: '  out[2] = out[0] * (sM >= 0 ? vL : vR);',
      repl: '  out[2] = out[0] * vL;   // MUTANT: contact upwinding removed',
    }],
  },
  {
    id: 'coriolis-off',
    name: 'Coriolis term removed',
    breaks: 'rotation: no inertial oscillation, no geostrophy, no shelf dynamics',
    expect: 'verify-physics section 1, all seven checks -- the state simply does not '
      + 'turn',
    review: 'GREEN at the review',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: '    if (this.coriolis) {',
      repl: '    if (false && this.coriolis) {   // MUTANT: Coriolis removed',
    }],
  },
  {
    id: 'flather-sign',
    name: 'Flather outward normal flipped',
    breaks: 'the radiation boundary: the incoming characteristic is built with the '
      + 'wrong sign, so the boundary drives the domain instead of letting it drain',
    expect: 'verify-tide.mjs -- the reflection coefficient against the solid-wall '
      + 'control, and the forced-tide amplitude and phase',
    review: 'GREEN at the review',
    suites: ['verify-tide'],
    patches: [{
      file: 'src/swe.mjs',
      find: '    const sgn = (side === 0 || side === 2) ? 1 : -1;',
      repl: '    const sgn = (side === 0 || side === 2) ? -1 : 1;   // MUTANT: normal flipped',
    }],
  },
  {
    id: 'wellbalance-off',
    name: 'hydrostatic pressure correction removed',
    breaks: 'well-balancing: the Audusse interface correction is dropped on both '
      + 'sweeps, so a flat lake over a sloping bed starts flowing',
    expect: 'verify.mjs section 1, lake at rest to machine epsilon -- no other suite '
      + 'holds a still-water state over an uneven bed',
    review: 'RED at the review: 8 failures',
    suites: ['verify'],
    patches: [
      {
        file: 'src/swe.mjs',
        find: L(
          '        const pL = 0.5 * G * (hLf * hLf - hsL * hsL);',
          '        const pR = 0.5 * G * (hRf * hRf - hsR * hsR);',
          '        fxM[kL] = flux[0]; fxN[kL] = flux[1]; fxT[kL] = flux[2];',
        ),
        repl: L(
          '        const pL = 0;   // MUTANT: hydrostatic correction removed (x sweep)',
          '        const pR = 0;',
          '        fxM[kL] = flux[0]; fxN[kL] = flux[1]; fxT[kL] = flux[2];',
        ),
      },
      {
        file: 'src/swe.mjs',
        find: L(
          '        const pL = 0.5 * G * (hLf * hLf - hsL * hsL);',
          '        const pR = 0.5 * G * (hRf * hRf - hsR * hsR);',
          '        fyM[kL] = flux[0]; fyN[kL] = flux[1]; fyT[kL] = flux[2];',
        ),
        repl: L(
          '        const pL = 0;   // MUTANT: hydrostatic correction removed (y sweep)',
          '        const pR = 0;',
          '        fyM[kL] = flux[0]; fyN[kL] = flux[1]; fyT[kL] = flux[2];',
        ),
      },
    ],
  },
  {
    id: 'mc-zero',
    name: 'MC limiter returns 0',
    breaks: 'second-order reconstruction: every slope is zero, so the scheme drops '
      + 'to first order and a travelling wave bleeds amplitude to diffusion',
    expect: 'verify-physics section 6: "contact stays sharp: transition width" and '
      + 'the transverse amplitude after one traversal',
    review: 'RED at the review: 8 failures (in verify.mjs)',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: L(
        'function mc(a, b) {',
        '  if (a * b <= 0) return 0;',
        '  const c = 0.5 * (a + b);',
        '  const m = Math.min(Math.abs(c), 2 * Math.abs(a), 2 * Math.abs(b));',
        '  return a > 0 ? m : -m;',
        '}',
      ),
      repl: L(
        'function mc(a, b) {',
        '  return 0;   // MUTANT: every reconstruction slope is zero',
        '}',
      ),
    }],
  },
  {
    id: 'ysweep-unrotated',
    name: 'y sweep passed in x order',
    breaks: 'the axis rotation: the y sweep hands (u, v) to the Riemann solver in x '
      + 'order, so the normal momentum flux it returns is for u and is accumulated '
      + 'into hv',
    expect: 'verify-physics section 5, the transpose test -- run a problem, run its '
      + 'transpose, compare',
    review: 'RED at the review: 8 failures (in verify.mjs)',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: '        hllc(flux, hsL, hsL * vL, hsL * uL, hsR, hsR * vR, hsR * uR, minDepth);',
      repl: '        hllc(flux, hsL, hsL * uL, hsL * vL, hsR, hsR * uR, hsR * vR, minDepth);'
        + '   // MUTANT: not rotated',
    }],
  },
  {
    id: 'bedsource-zero',
    name: 'bed slope source zeroed',
    breaks: 'the centred bed term that pairs with the interface correction: water no '
      + 'longer feels the bed at second order',
    expect: 'verify.mjs section 1, lake at rest -- the interface correction and this '
      + 'term have to cancel each other and one of them is now missing',
    review: 'RED at the review: 10 failures',
    suites: ['verify'],
    patches: [{
      file: 'src/swe.mjs',
      find: '            const term = -G * 0.5 * (hP + hM) * db / (d === 0 ? dx : dy);',
      repl: '            const term = 0;   // MUTANT: bed slope source removed',
    }],
  },
  {
    id: 'hllc-dry-speeds',
    name: 'HLLC dry-state speeds use the wet formula',
    breaks: 'Toro\'s dry-front wave speeds: with h_L = 0 the left speed becomes '
      + 'u_L - c_L = 0 instead of the rarefaction head, so sL >= 0, the flux is the '
      + 'dry state\'s (zero), and the shoreline freezes',
    expect: 'verify-physics section 3: "run-up 2D: the shoreline actually moved" and '
      + '"dam break: the dry bed was actually exercised", which count re-wetted cells',
    review: 'RED at the review: 7 failures',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: L(
        '  if (!wetL) { sL = uR - 2 * cR; sR = uR + cR; }',
        '  else if (!wetR) { sL = uL - cL; sR = uL + 2 * cL; }',
      ),
      repl: L(
        '  if (!wetL) { sL = uL - cL; sR = uR + cR; }        // MUTANT: dry-state wave',
        '  else if (!wetR) { sL = uL - cL; sR = uR + cR; }   // speeds replaced by wet-wet',
      ),
    }],
  },
  {
    id: 'rk2-one-stage',
    name: 'SSP-RK2 second stage removed',
    breaks: 'the time integrator: what is left is forward Euler, which is '
      + 'unconditionally unstable for this spatial discretisation',
    expect: 'verify-physics section 1: "inertial: speed after one revolution", whose '
      + 'note quotes the SSP-RK2 drift (+2.4e-6%) as the prediction -- forward Euler '
      + 'amplifies rotation by sqrt(1 + (f dt)^2) per step',
    review: 'RED at the review: 8 failures',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: L(
        '    // stage 2',
        '    this.applyBC();',
        '    this.residual(h);',
        '    for (let k = 0; k < N; k++) {',
        '      this.h[k] = 0.5 * (this.h0[k] + this.h[k] + h * this.rh[k]);',
        '      this.hu[k] = 0.5 * (this.hu0[k] + this.hu[k] + h * this.rhu[k]);',
        '      this.hv[k] = 0.5 * (this.hv0[k] + this.hv[k] + h * this.rhv[k]);',
        '    }',
        '    this.massFloored += this.dryClean();',
      ),
      repl: '    // MUTANT: SSP-RK2 second stage removed -- what is left is forward Euler.',
    }],
  },
];

// ---------------------------------------------------------------------------
// Patch application. The count assertion is the whole point of this function.
// ---------------------------------------------------------------------------

let SCRATCH = null;               // set in main(); every write is checked against it

/** Refuse to write anywhere but the scratch tree. Cheap, and it can fail. */
function assertInScratch(p) {
  const abs = path.resolve(p);
  if (!SCRATCH || !abs.startsWith(path.resolve(SCRATCH) + path.sep)) {
    throw new Error(`REFUSING to write outside the scratch tree: ${abs}`);
  }
}

/**
 * Replace `find` with `repl` in `text`, asserting the anchor occurs exactly once.
 *
 * Not found -> the mutation silently does not happen and the suite looks like it
 * caught nothing. Found twice -> the mutation is bigger than it claims to be and
 * the table's description is a lie. Both throw.
 */
function patchText(text, find, repl, where) {
  const parts = text.split(find);
  const n = parts.length - 1;
  if (n !== 1) {
    throw new Error(
      `anchor found ${n} times (want exactly 1) in ${where}\n`
      + `      anchor: ${JSON.stringify(find.length > 90 ? find.slice(0, 90) + '...' : find)}`);
  }
  const out = parts.join(repl);
  if (out === text) throw new Error(`patch was a no-op in ${where} (find === repl?)`);
  return out;
}

/**
 * Self-test of the guard above, run every time before anything else.
 *
 * If patchText stopped throwing -- a refactor, a swallowed error, a `catch {}` --
 * every mutant would apply nothing and the harness would print a clean table of
 * survivors-that-are-not, or worse, a clean table of CAUGHTs that are noise. The
 * guard is the load-bearing part of this file, so it gets a check that fails.
 */
function selfTest() {
  const src = 'alpha\nbeta\ngamma\nbeta\n';
  const cases = [
    ['absent anchor', () => patchText(src, 'delta', 'x', 'self-test')],
    ['duplicate anchor', () => patchText(src, 'beta', 'x', 'self-test')],
    ['no-op patch', () => patchText(src, 'alpha', 'alpha', 'self-test')],
  ];
  for (const [what, fn] of cases) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) {
      console.error(`FATAL: patchText did not throw on ${what}. `
        + 'The anchor guard is dead, and an unapplied mutation would read as a '
        + 'green suite. Refusing to run.');
      process.exit(2);
    }
  }
  // ...and it must still work on the happy path, or everything errors instead.
  if (patchText(src, 'gamma', 'GAMMA', 'self-test') !== 'alpha\nbeta\nGAMMA\nbeta\n') {
    console.error('FATAL: patchText broke a valid single-anchor replacement.');
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Running a suite in a child process.
// ---------------------------------------------------------------------------

const SUMMARY_RE = /^(?:ALL PASS|(\d+) FAILURES) -- (\d+)\/(\d+) checks/m;

function runSuite(dir, suite, timeoutMs) {
  const file = path.join(dir, SUITES[suite].file);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [file], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      const m = out.match(SUMMARY_RE);
      const fails = m ? (m[1] ? Number(m[1]) : 0) : null;
      const total = m ? Number(m[3]) : null;
      const failLines = out.split('\n')
        .filter((l) => /^\s*FAIL\s/.test(l))
        .map((l) => l.trim().replace(/^FAIL\s+/, ''));
      let status;
      if (timedOut) status = 'TIMEOUT';
      else if (m === null) status = 'CRASH';
      else if (fails > 0 || code !== 0) status = 'RED';
      else status = 'GREEN';
      resolve({ status, fails, total, ms, code, failLines, stderr: err.trim(), stdout: out });
    });
  });
}

/** Run `items` through `fn` with at most `n` in flight. */
async function pool(items, n, fn) {
  const queue = items.slice();
  const workers = [];
  for (let w = 0; w < Math.max(1, n); w++) {
    workers.push((async () => { while (queue.length) await fn(queue.shift()); })());
  }
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Repo integrity: hash src/ and tools/ before and after.
// ---------------------------------------------------------------------------

function treeHash(root, dirs) {
  const h = createHash('sha256');
  for (const d of dirs) {
    const full = path.join(root, d);
    for (const f of fs.readdirSync(full).sort()) {
      const p = path.join(full, f);
      if (!fs.statSync(p).isFile()) continue;
      h.update(`${d}/${f}\0`);
      h.update(fs.readFileSync(p));
    }
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const pad = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** Print `label   text`, wrapped and hanging-indented so long notes stay readable. */
function field(label, text, width = 88) {
  const indent = ' '.repeat(14);
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  console.log(`     ${pad(label, 9)}${lines[0]}`);
  for (const l of lines.slice(1)) console.log(indent + l);
}

function statusCell(r) {
  if (r.status === 'GREEN') return `GREEN  ${String(r.fails).padStart(2)} FAIL /${String(r.total).padStart(3)}`;
  if (r.status === 'RED') return `RED    ${String(r.fails).padStart(2)} FAIL /${String(r.total).padStart(3)}`;
  if (r.status === 'TIMEOUT') return 'TIMEOUT  did not finish';
  return `CRASH    exit ${r.code}`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };
  const jobs = Number(arg('--jobs', 6));
  const only = arg('--only', null);
  const keep = argv.includes('--keep');

  const selected = only ? MUTANTS.filter((m) => m.id.includes(only) || m.name.includes(only)) : MUTANTS;

  if (argv.includes('--list')) {
    for (const m of selected) {
      console.log(`  ${pad(m.id, 22)} ${pad(m.suites.join(','), 34)} ${m.name}`);
    }
    return 0;
  }
  if (selected.length === 0) {
    console.error(`no mutant matches --only ${only}`);
    return 2;
  }

  selfTest();

  console.log('\n=== mutation harness =================================================\n');
  console.log(`  ${selected.length} mutants, ${jobs} concurrent, node ${process.version}`);

  const hashBefore = treeHash(REPO, ['src', 'tools']);
  console.log(`  repo sha256 (src + tools) before: ${hashBefore.slice(0, 16)}`);

  SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-mutants-'));
  const BASE = path.join(SCRATCH, '_base');
  assertInScratch(BASE);
  fs.mkdirSync(BASE);
  for (const d of ['src', 'tools']) fs.cpSync(path.join(REPO, d), path.join(BASE, d), { recursive: true });
  console.log(`  scratch: ${SCRATCH}\n`);

  // -- apply the patches ---------------------------------------------------
  const state = new Map();
  for (const m of selected) {
    const dir = path.join(SCRATCH, m.id);
    assertInScratch(dir);
    fs.cpSync(BASE, dir, { recursive: true });
    const st = { dir, results: {}, error: null };
    state.set(m.id, st);
    try {
      for (const p of m.patches) {
        const target = path.join(dir, p.file);
        assertInScratch(target);
        const before = fs.readFileSync(target, 'utf8');
        const after = patchText(before, p.find, p.repl, `${m.id} -> ${p.file}`);
        fs.writeFileSync(target, after);
        // Belt and braces: the file on disk must now differ from the pristine one.
        if (fs.readFileSync(target, 'utf8') === fs.readFileSync(path.join(BASE, p.file), 'utf8')) {
          throw new Error(`${p.file} is byte-identical to the pristine copy after patching`);
        }
      }
    } catch (e) {
      st.error = e.message;
    }
  }

  // -- --anchors: prove the patches still apply, run nothing ---------------
  if (argv.includes('--anchors')) {
    console.log('  -- anchors only: every patch applied, no suite run -------------------\n');
    let bad = 0;
    for (const m of selected) {
      const st = state.get(m.id);
      console.log(`     ${pad(m.id, 24)} ${st.error ? 'ANCHOR-ERROR' : 'applied'}`);
      if (st.error) { console.log(`        ${st.error.replace(/\n/g, '\n        ')}`); bad++; }
    }
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    const h2 = treeHash(REPO, ['src', 'tools']);
    console.log(`\n  repo sha256 after: ${h2.slice(0, 16)}  ${h2 === hashBefore ? 'UNCHANGED' : '*** MODIFIED ***'}`);
    console.log(`\n  ${selected.length - bad}/${selected.length} anchors found exactly once\n`);
    return bad || h2 !== hashBefore ? 1 : 0;
  }

  // -- baseline ------------------------------------------------------------
  //
  // Without this the whole table is meaningless: "the suite went red" is only
  // evidence about the mutation if the suite was green on the same copy of the
  // code with nothing done to it. It also measures each suite's runtime, which
  // is what the per-mutant timeout is derived from.
  //
  // Only the suites that are actually going to be used are baselined, so that
  // --only stays quick; escalation adds any missing baseline before it runs.
  const base = {};
  const timeout = {};
  async function baseline(suites) {
    const want = suites.filter((s) => !base[s]);
    if (!want.length) return true;
    console.log('  -- baseline: the unmutated copy must be green ------------------------\n');
    await pool(want, want.length, async (s) => { base[s] = await runSuite(BASE, s, 15 * 60 * 1000); });
    let ok = true;
    for (const s of want) {
      const r = base[s];
      console.log(`     ${pad(s, 16)} ${statusCell(r)}   ${secs(r.ms)}`);
      if (r.status !== 'GREEN') ok = false;
      // 3x the measured baseline, floor 90 s. A mutant that changes the step
      // count enough to triple a suite's runtime is not going to be green
      // either way; the cap exists because a NaN can drive dt to zero and hang
      // the run forever instead of failing.
      timeout[s] = Math.max(90_000, 3 * r.ms);
    }
    console.log('\n     timeouts: ' + want.map((s) => `${s} ${secs(timeout[s])}`).join(', '));
    return ok;
  }
  const declared = [...new Set(selected.flatMap((m) => m.suites))];
  if (!await baseline(SUITE_ORDER.filter((s) => declared.includes(s)))) {
    console.log('\n  BASELINE IS NOT GREEN. Nothing below could be interpreted: a suite that');
    console.log('  is already red cannot demonstrate that it noticed a mutation.\n');
    return 2;
  }

  // -- run: declared suites, then escalate anything still green ------------
  const phase1 = [];
  for (const m of selected) {
    const st = state.get(m.id);
    if (st.error) continue;
    for (const s of m.suites) phase1.push({ m, s, escalated: false });
  }
  console.log(`\n  -- running ${phase1.length} suite runs (declared) ------------------------------\n`);
  await pool(phase1, jobs, async ({ m, s, escalated }) => {
    const st = state.get(m.id);
    const r = await runSuite(st.dir, s, timeout[s]);
    r.escalated = escalated;
    st.results[s] = r;
    console.log(`     ${pad(m.id, 22)} ${pad(s, 16)} ${pad(r.status, 8)} ${secs(r.ms)}`);
  });

  const detected = (m) => Object.values(state.get(m.id).results).some((r) => r.status !== 'GREEN');
  const phase2 = [];
  for (const m of selected) {
    const st = state.get(m.id);
    if (st.error || detected(m)) continue;
    for (const s of SUITE_ORDER) if (!st.results[s]) phase2.push({ m, s, escalated: true });
  }
  if (phase2.length) {
    console.log(`\n  -- ESCALATING: ${phase2.length} more runs; the declared suites stayed green ---\n`);
    if (!await baseline([...new Set(phase2.map((j) => j.s))])) {
      console.log('\n  BASELINE IS NOT GREEN for an escalation suite; cannot interpret it.\n');
      return 2;
    }
    await pool(phase2, jobs, async ({ m, s, escalated }) => {
      const st = state.get(m.id);
      const r = await runSuite(st.dir, s, timeout[s]);
      r.escalated = escalated;
      st.results[s] = r;
      console.log(`     ${pad(m.id, 22)} ${pad(s, 16)} ${pad(r.status, 8)} ${secs(r.ms)} (escalated)`);
    });
  }

  // -- report --------------------------------------------------------------
  console.log('\n\n=== detail ===========================================================');
  for (const m of selected) {
    const st = state.get(m.id);
    const verdict = st.error ? 'ANCHOR-ERROR' : (detected(m) ? 'CAUGHT' : 'SURVIVED');
    console.log(`\n  [${pad(m.id, 22)}] ${pad(m.name, 40)} ${verdict}`);
    field('breaks', m.breaks);
    field('expect', m.expect);
    field('review', m.review);
    if (m.found) field('found', m.found);
    if (st.error) {
      console.log(`     ERROR    ${st.error}`);
      continue;
    }
    for (const s of SUITE_ORDER) {
      const r = st.results[s];
      if (!r) continue;
      const tag = r.escalated ? ' (escalated)' : '';
      let line = `     ${pad(s, 16)} ${pad(statusCell(r), 26)} ${secs(r.ms)}${tag}`;
      console.log(line);
      if (r.failLines.length) {
        for (const fl of r.failLines.slice(0, 3)) console.log(`        FAIL  ${fl.slice(0, 96)}`);
        if (r.failLines.length > 3) console.log(`        ...   ${r.failLines.length - 3} more`);
      } else if (r.status === 'GREEN') {
        console.log('        blind to this mutation');
      }
      if (r.status === 'CRASH' && r.stderr) {
        console.log(`        stderr: ${r.stderr.split('\n')[0].slice(0, 96)}`);
      }
    }
  }

  console.log('\n\n=== summary ==========================================================\n');
  console.log(`  ${'#'.padStart(2)}  ${pad('mutant', 22)} ${pad('breaks', 40)} ${pad('detected by', 30)} verdict`);
  console.log(`  ${'--'}  ${'-'.repeat(22)} ${'-'.repeat(40)} ${'-'.repeat(30)} -------`);
  let survivors = 0, errors = 0;
  selected.forEach((m, i) => {
    const st = state.get(m.id);
    let by, verdict;
    if (st.error) { by = '-- not applied --'; verdict = 'ANCHOR-ERROR'; errors++; }
    else {
      const hits = SUITE_ORDER.filter((s) => st.results[s] && st.results[s].status !== 'GREEN')
        .map((s) => `${s}${st.results[s].status === 'RED' ? `(${st.results[s].fails})` : `(${st.results[s].status})`}`);
      by = hits.length ? hits.join(' ') : 'nothing';
      verdict = hits.length ? 'CAUGHT' : 'SURVIVED';
      if (!hits.length) survivors++;
    }
    console.log(`  ${String(i + 1).padStart(2)}  ${pad(m.id, 22)} ${pad(m.breaks, 40)} ${pad(by, 30)} ${verdict}`);
  });

  // BLIND SPOTS. A mutant counts as CAUGHT if ANY suite noticed, which is the
  // right bar for "is this a hole in the repository" and the wrong bar for "is
  // this suite doing its job". Every (suite, mutant) pair that was actually run
  // and came back green is listed here, because that is a suite being handed a
  // broken solver and reporting ALL PASS. Escalation pairs are excluded: those
  // suites were only run because nothing else had caught the mutant yet, and
  // most of them have no business seeing it.
  const blind = [];
  for (const m of selected) {
    const st = state.get(m.id);
    if (st.error) continue;
    for (const s of SUITE_ORDER) {
      const r = st.results[s];
      if (r && r.status === 'GREEN' && !r.escalated) blind.push([m, s]);
    }
  }
  if (blind.length) {
    console.log('\n  blind spots -- a suite that was asked and answered ALL PASS:\n');
    for (const [m, s] of blind) console.log(`     ${pad(s, 16)} green against ${m.id}`);
  }

  const hashAfter = treeHash(REPO, ['src', 'tools']);
  console.log(`\n  repo sha256 (src + tools) after:  ${hashAfter.slice(0, 16)}   `
    + `${hashAfter === hashBefore ? 'UNCHANGED' : '*** THE REPOSITORY WAS MODIFIED ***'}`);

  if (keep) console.log(`  scratch kept at ${SCRATCH}`);
  else { fs.rmSync(SCRATCH, { recursive: true, force: true }); console.log('  scratch removed (--keep to retain it)'); }

  if (hashAfter !== hashBefore) {
    console.log('\n  FATAL: src/ or tools/ changed while this ran. This harness never writes');
    console.log('  outside os.tmpdir(), so either that guarantee broke or something else was');
    console.log('  editing the tree at the same time. Either way the table above described a');
    console.log('  moving target -- re-run it against a still tree before believing it.\n');
    return 3;
  }
  if (errors) {
    console.log(`\n  ${errors} MUTANT(S) NEVER APPLIED. An unapplied mutation is indistinguishable`);
    console.log('  from a suite that caught nothing, so this is a hard failure, not a warning.');
    console.log('  The anchors are verbatim lines of src/; if the source moved, move them too.\n');
    return 1;
  }
  if (survivors) {
    console.log(`\n  ${survivors} MUTANT(S) SURVIVED. Every suite in this repository stayed green with`);
    console.log('  that physics broken. Read the "expect" line for each: that is the check');
    console.log('  which ought to have caught it, and it did not.\n');
    return 1;
  }
  console.log(`\n  all ${selected.length} mutants detected. Note what this does and does not say:`);
  console.log('  it says the suites can go red when the physics is wrong in these');
  console.log('  specific ways. It says nothing about the ways not on the list, and a');
  console.log('  CAUGHT is not a claim that the right check fired -- read the FAIL lines.\n');
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('\nharness failed:', e && e.stack || e);
  process.exit(2);
});
