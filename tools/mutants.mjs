// ---------------------------------------------------------------------------
// MUTATION HARNESS -- what does "ALL PASS" actually mean?
//
//   node tools/mutants.mjs              (every mutant against its declared suites)
//   node tools/mutants.mjs --list       (print the mutant list, run nothing)
//   node tools/mutants.mjs --anchors    (apply every patch, run no suite; ~1 s.
//                                        This is the check to run after touching
//                                        src/swe.mjs, and it is the one that
//                                        fails when the anchors go stale)
//   node tools/mutants.mjs --only vel   (mutants whose id or name contains "vel")
//   node tools/mutants.mjs --jobs 4     (concurrency; default 6)
//
// The usage line above used to read "(~4 min, 15 mutants, 3 suites)" and all
// three numbers had drifted -- there were 16 mutants in the list when it still
// said 15. A count in a comment is a claim with nothing checking it, so the
// counts and the elapsed time are now PRINTED BY THE RUN instead: the banner
// names the mutants and suites it is about to use, and the last line reports
// wall-clock. Nothing here repeats them.
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
//                the FAIL lines in the detail block, which quote the first
//                three checks that actually failed (this used to say "the
//                'first:' line", and no such line has ever been printed). A
//                mutant caught only by a check with nothing to do with it is a
//                coincidence, not coverage.
//   SURVIVED     every suite the harness RUNS stayed green with the physics
//                broken. Not the same as "every check in the repository":
//                escalation covers the six suites in SUITE_ORDER, and five of
//                waves.mjs's eight cases are too slow to be among them. This is
//                a hole, and it exits the harness non-zero.
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
//   KNOWN        a mutation this repository is DECLARED unable to catch. It is
//                run anyway, printed in its own table, and does not fail the
//                run. See KNOWN SURVIVORS below.
//
// IT RUNS THE REAL SUITES, NOT PROBES OF ITS OWN. A targeted probe written here
// would be a probe measuring itself: it would prove that THIS file can detect
// the mutation, which is not the question. The question is whether the suites
// that ship with the repository and print the green numbers can. So the only
// things run are tools/verify.mjs, tools/verify-physics.mjs,
// tools/verify-tide.mjs and tools/waves.mjs, exactly as they ship -- with one
// stated exception, line endings, below.
//
// LINE ENDINGS, and why this file now normalises them.
//
// The multi-line anchors below are built with lines.join('\n'). Source read
// straight off a default Windows clone -- core.autocrlf=true, no .gitattributes
// -- is CRLF, and an LF anchor cannot match it. Measured on a deliberately CRLF
// copy of this tree: `--anchors` printed "9/16 anchors found exactly once" and
// exited 1, and the seven that failed were exactly the seven mutants whose
// anchors span more than one line. Every single-line anchor still matched,
// because a single-line anchor has no newline in it to disagree about. So the
// repository's headline instrument reported a hard failure to anyone who cloned
// it on Windows -- which is worse than shipping no harness at all, because it
// fails in a way that looks like the physics is broken.
//
// Two fixes, deliberately both: a .gitattributes with `* text=auto eol=lf` so
// the checkout stops varying, and the normalisation below so this file does not
// depend on that. What the normalisation does is EXACTLY \r\n -> \n in the
// scratch copy, nowhere else, and it reports how many files it touched; the
// self-test asserts both halves of the bug (that a CRLF buffer misses an LF
// anchor, and that the normalised one does not).
//
// RUNTIME is bought by choosing WHICH suite to run per mutant, not by shortening
// the suites. Each mutant declares the suite whose checks are aimed at the thing
// it breaks. Baselines, measured by the clean run of 2026-08-14 that added
// waves.mjs -- six of them started at once, so each is an upper bound on what it
// would cost alone: verify-physics 8.6 s, waves:damping 2.6 s,
// waves:fringingReef 25.7 s, waves:snell 40.6 s, verify 99.6 s, verify-tide
// 113.3 s. That run did 32 mutated suite runs plus those six baselines, six at a
// time, in 305.3 s of wall clock. The figure is PRINTED at the end of every run
// as well, because this line is a comment and the printed one is a measurement.
//
// The slow waves cases are deliberately NOT used. Measured on the same tree, one
// case per process, all eight at once: see the note above SUITES for the table.
// Every mutation aimed at waves.mjs here is pointed at the cheapest case that
// was MEASURED to catch it, not at the case whose name best matches the physics.
// If the declared suites all stay GREEN the harness ESCALATES and runs every
// remaining suite before calling anything a survivor, because "survived" is a
// strong claim and it should cost the harness something to make it.
//
// KNOWN SURVIVORS. Six mutations are declared here that no check in this
// repository catches. They come from the reviewer who found them, they are run
// every time like everything else, and they are reported in a table of their
// own with the reason. They do NOT fail the run: a hole that is measured,
// named and printed is a different thing from a hole nobody has noticed, and
// the point of listing them is that the gap is VISIBLE rather than absent.
// What they are not is a known correctness gap -- the reviewer could not make
// any of them change an answer on any closed-form benchmark either, so what is
// established is that these six are not distinguishable by anything this
// repository currently measures, not that the solver is wrong. If one of them
// is ever CAUGHT the run fails, loudly, because the declaration has gone stale.
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
// The suites. The key is what the table prints; `file` is run verbatim, with
// `args` appended to the command line.
//
// tools/waves.mjs WAS NOT UNDER THIS HARNESS AT ALL until 2026-08-14, and it
// carries the whole of the repository's third claim -- that waves respond to the
// bathymetry. Its 39 checks had never been shown able to go red by anything.
//
// It is here now, but not as one suite. Measured 2026-08-14, all eight cases
// started at once so each figure is an upper bound on what it costs alone:
//
//     damping           1 check      3.4 s
//     fringingReef      3 checks    28.4 s
//     snell             4 checks    46.1 s
//     barredBeach       9 checks    64.4 s
//     planeBeach        5 checks    93.0 s
//     shoal             2 checks   182.5 s
//     headlandBay       9 checks   289.6 s
//     submarineCanyon   6 checks   333.2 s
//
// Run whole that is a quarter of an hour, which no mutant can afford to pay
// twenty-four times over. So waves.mjs is entered as one suite PER CASE and only
// the three cheap ones are wired up. The five expensive cases are deliberately
// absent, which means a mutation only they could see will read SURVIVED here.
// That is a stated limit of this harness, not a statement about the solver, and
// it is the first thing to fix if the budget ever grows.
//
// waves.mjs exits 2 on a bad case name, which is a different thing from a check
// failing; the runner reports that as CRASH, and the case names below are the
// ones in its own CASES list.
// ---------------------------------------------------------------------------
const SUITES = {
  'verify-physics': { file: 'tools/verify-physics.mjs' },
  'waves:damping': { file: 'tools/waves.mjs', args: ['damping'] },
  'waves:fringingReef': { file: 'tools/waves.mjs', args: ['fringingReef'] },
  'waves:snell': { file: 'tools/waves.mjs', args: ['snell'] },
  'verify': { file: 'tools/verify.mjs' },
  'verify-tide': { file: 'tools/verify-tide.mjs' },
};
// Cheapest first: escalation walks this order, so a survivor pays for the fast
// suites before it pays for verify-tide.
const SUITE_ORDER = ['verify-physics', 'waves:damping', 'waves:fringingReef',
  'waves:snell', 'verify', 'verify-tide'];

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
//
// `known` marks a KNOWN SURVIVOR and carries the reason. See the header.
//
// NOTES THAT QUOTE A LINE NUMBER GO STALE, and one of them did. The g-x1.01
// note below used to say that tools/verify-tide.mjs "imports G from src/swe.mjs
// (line 21)" and wrote its targets with it "at line 95 ... at line 159", and
// called that the review's original defect unfixed. All of it was true when it
// was written. By 2026-08-14 verify-tide imported gravity under an alias,
// defined its own reference constant, and compared the two at tolerance zero;
// the cited lines had become a comment and a blank line, and the run measured
// 1 failure out of 15 rather than 0 out of 14. Every note here has since been
// re-derived from a run in one session, and rewritten to describe the MECHANISM
// -- "it aliases the solver's constant and compares it against its own" -- which
// stays true when the file moves, instead of a coordinate that does not. Where a
// number is quoted it is a measurement, dated, and it is labelled as a value
// produced by the code under test.
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
    found: '2026-08-14, RE-DERIVED from a run of all three suites against a patched '
      + 'copy; the previous version of this note said "verify-tide 0/14" and that had '
      + 'become false. Caught by all three, but by less than it looks. verify.mjs '
      + '3/35: the gravity identity (solver 9.9047165 against the reference 9.80665), '
      + 'Ritter\'s convergence order (0.29), and Thacker\'s mean error (22.263% of the '
      + '10 m depth scale). Every direct wave-speed check STAYED GREEN against its 1% '
      + 'tolerance -- Merian\'s seiche period 710.498 s against 714.043 (0.497%), '
      + 'Thacker\'s 1339.208 s against 1345.940 (0.500%), celerity 0.889 / 0.642 / '
      + '0.592% at h = 2 / 10 / 50 m, which is those checks\' own 0.307 / 0.060 / '
      + '0.011% discretisation error plus the shift. verify-physics 2/43, both '
      + 'spin-down identities, whose residual is exactly the 1.000% by which g moved; '
      + 'the three normal-depth checks stayed green, their signed error going '
      + '+0.0585 / +0.1239 / +0.0493% unmutated to -0.4378 / -0.3724 / -0.4470% -- a '
      + 'uniform -0.4963 point shift, worst case 89% of the 0.5% tolerance. '
      + 'verify-tide 1/15, and only the identity check: it now aliases the solver\'s '
      + 'gravity, defines its own reference beside it and compares the two at '
      + 'tolerance ZERO, so that one fires and nothing else can miss it. The other '
      + 'fourteen -- the quarter-wave resonance sweep (peak still exactly at '
      + 'T/T_res = 1, gain 2.78x), the Flather reflection coefficient (0.36%), the '
      + 'drying flat -- stay green, because half a percent of celerity is inside '
      + 'every tolerance they carry. So the COUPLING defect the review found there '
      + 'is fixed; what is left is a sensitivity limit, which is a different '
      + 'complaint and should not be described as the old one',
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
      + 'their fix against, and they recorded verify.mjs 12 failures, verify-physics 5',
    found: '2026-08-14, re-measured against a patched copy because the review line '
      + 'above quotes two counts and a count is a claim: verify.mjs 12/35 and '
      + 'verify-physics 5/43, so both still hold. What the ten-times-harder version '
      + 'buys is the part g-x1.01 could not show: all three celerity checks now fire '
      + '(5.7-6.0% against 1%), so do Merian (4.654%) and Thacker\'s period (4.659%) '
      + 'and all three normal-depth checks (4.53-4.60% against 0.5%). The decoupling '
      + 'is therefore real and not cosmetic -- the analytic targets held still while '
      + 'the solver moved, which is the whole content of the review\'s finding',
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
    found: '2026-08-14, re-measured against a patched copy: still caught by exactly '
      + 'ONE check, and still not the one the claim is about. verify-physics 1/43, '
      + 'and the line is "vel() -> 0 rather than diverging at h = 0 -- vel(0.002, 0) '
      + '= 2", i.e. the mutant returns hq/minDepth = 2 m/s where h is exactly zero. '
      + 'All nine run-up and dry-bed checks stayed green, including "run-up 2D: the '
      + 'shoreline actually moved" (764 cells dry at t = 0, 764 re-wetted) and the '
      + 'volume-drift check at rel 0.000%. So the docstring\'s claim -- that this '
      + 'alternative would "bias every shallow cell\'s velocity low and quietly damp '
      + 'run-up" -- is STILL untested by anything in this repository; what is tested '
      + 'is a boundary value at h = 0, and a note that says otherwise would be '
      + 'crediting the suite with a check it does not have',
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
      + 'the transverse amplitude after one traversal. Also declared against the two '
      + 'cheap waves cases, because dropping to first order is the mutation that '
      + 'attacks the RESOLUTION FLOOR: waves.mjs asserts nothing without 40 cells per '
      + 'wavelength, and 40 cells per wavelength is only worth having if the scheme '
      + 'carries a wave at that resolution',
    review: 'RED at the review: 8 failures (in verify.mjs)',
    found: '2026-08-14: the resolution floor is a NUMBER THIS SUITE PRINTS AND DOES '
      + 'NOT ASSERT, and this mutant is how that was measured. waves.mjs damping is '
      + 'the instrument that justifies the floor, and against this mutation its table '
      + 'goes from 0.9887 amplitude retained per wavelength at 40 cells to 0.6109 '
      + '(84.4% of the wave left after fifteen wavelengths, down to 0.1%) -- and its '
      + 'one assertion, that the decay is exponential, PASSES both times, at rel '
      + '0.58% unmutated and 0.02% mutated. It is a check on the shape of the decay '
      + 'and it is blind to the size of it, which is what the floor is about. The '
      + 'floor is asserted in verify.mjs instead. waves:fringingReef does see the '
      + 'mutation, 2/3: the offshore height arrives at 1.2999 m for a requested 1.6 '
      + '(18.76%, tolerance 12%) and the lagoon setup falls from 12.9% of the breaker '
      + 'height to 4.4%, outside the documented 10-25% band',
    suites: ['verify-physics', 'waves:damping', 'waves:fringingReef'],
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

  // =========================================================================
  // AIMED AT tools/waves.mjs.
  //
  // Everything above was aimed at the three suites that were already here.
  // waves.mjs carries the claim that waves respond to the bathymetry -- Green's
  // law, Snell refraction, breaking, setup -- and until these two mutants
  // existed nothing had shown any of it able to go red. Both are pointed at the
  // CHEAPEST case measured to catch them, not at the case whose name matches
  // the physics best: refraction is most obviously about headlandBay, which
  // takes four minutes, and snell measures the same law directly in 37 s.
  // =========================================================================
  {
    id: 'ysweep-zero-flux',
    name: 'y sweep accumulated with zero weight',
    breaks: 'the alongshore half of the solver: the y interface fluxes are computed '
      + 'and then multiplied by zero on the way into the residual, so every row of '
      + 'the grid becomes an independent 1D problem. Mass is still conserved exactly '
      + '(both sides of the face get the same zero) and a y-invariant problem is '
      + 'untouched, which is the point -- what is gone is the coupling that lets a '
      + 'crest turn as the depth under it changes',
    expect: 'waves:snell, which fixes ky by geometry and measures kx off the phase '
      + 'field. With no y coupling each row satisfies its own 1D dispersion, so kx '
      + 'comes out at omega/sqrt(gh) instead of sqrt((omega/sqrt(gh))^2 - ky^2) and '
      + '|k| = hypot(kx, ky) has to overshoot',
    review: 'not on the review\'s list. Written for this harness because the refraction '
      + 'claim had no mutant at all',
    found: '2026-08-14: waves:snell RED, 3 of its 4 checks. |k| against the local '
      + 'dispersion relation reads 1.0955 where it should read 1 (9.55% against a 3% '
      + 'tolerance); sin(theta)/sqrt(h) spreads 4.21% across the middle half against '
      + 'a 2% tolerance, on a no-refraction null the case itself prints as 156%; and '
      + 'the crest angle is 3.64 deg from snellAngle() at worst against 1.5 deg. The '
      + 'ky regression check still passes, correctly -- ky is imposed by the periodic '
      + 'boundary and the wavemaker still imposes it. waves:fringingReef was measured '
      + 'GREEN against this same mutant and is NOT declared: that case is a shore-'
      + 'normal transect with a y-invariant bed, so there is no alongshore signal in '
      + 'it to lose. A blind spot that is a property of the geometry, not a hole',
    suites: ['waves:snell'],
    patches: [{
      file: 'src/swe.mjs',
      find: '        const inv = th / dy;',
      repl: '        const inv = 0;   // MUTANT: the y sweep contributes nothing',
    }],
  },
  {
    id: 'flux-advection-off',
    name: 'advective momentum flux dropped',
    breaks: 'the nonlinear term in the momentum flux: hu*u + g h^2/2 becomes g h^2/2, '
      + 'i.e. the momentum equation is linearised. This is the plausible '
      + 'simplification, not an obvious error -- it is what the LINEAR shallow-water '
      + 'equations are -- and it removes the u^2 part of the radiation stress that '
      + 'drives setup, along with the steepening that makes a bore',
    expect: 'waves:fringingReef, whose setup is a fraction of the breaker height and '
      + 'whose band (10-25%) is the tightest quantitative claim in waves.mjs',
    review: 'not on the review\'s list. Written for this harness as the cheapest '
      + 'mutation that attacks SHOALING AND BREAKING rather than refraction',
    found: '2026-08-14: waves:fringingReef RED, 1 of 3 -- the lagoon setup falls from '
      + '12.9% of the breaker height to 9.9%, just outside the 10-25% band, and that '
      + 'margin is thin enough to say out loud: this mutant is caught by 0.1 of a '
      + 'percentage point. It is deterministic (no RNG anywhere in the case) so it '
      + 'will not flicker, and if it ever does go green the harness escalates to '
      + 'every other suite before calling it a survivor. Measured on the same tree, '
      + 'waves:snell also goes RED at 1 of 4 (sin(theta)/sqrt(h) spread 2.54% against '
      + '2%), which is thinner still, so fringingReef is the declared one and it is '
      + 'also the cheaper of the two',
    suites: ['waves:fringingReef'],
    patches: [{
      file: 'src/swe.mjs',
      find: '  out[1] = hu * u + 0.5 * G * h * h;',
      repl: '  out[1] = 0.5 * G * h * h;   // MUTANT: momentum flux linearised',
    }],
  },

  // =========================================================================
  // KNOWN SURVIVORS.
  //
  // Six mutations that nothing in this repository catches. They are the
  // reviewer's, found by a pass over the solver that this harness had not
  // covered, and they are declared here rather than left out so that the gap is
  // printed on every run instead of being invisible.
  //
  // WHAT THIS IS AND IS NOT. The reviewer could not make any of the six change
  // an answer on any closed-form benchmark either -- not Stoker, not Ritter,
  // not Thacker. So what is established is that these six are indistinguishable
  // from the shipped solver BY ANYTHING CURRENTLY MEASURED. That is a coverage
  // gap. It is NOT a known correctness gap, and it is not evidence that the
  // shipped choice is arbitrary: three of them (Einfeldt vs Davis speeds, the
  // HLLC contact estimate, the CFL number) are cases where the shipped version
  // is the one with the better guarantee and the alternative is merely not
  // WORSE on anything measured so far.
  //
  // Each still declares a suite and is still run, because a declaration nobody
  // re-measures is exactly the kind of stale claim this file exists to stop.
  // They are declared against verify-physics, the cheapest suite, plus the
  // cheap waves cases for the two whose effect is a wave effect. If one of them
  // is ever CAUGHT the run FAILS -- being caught is good news, but it means the
  // sentence "we cannot catch this" has become false and the list must be
  // edited before it misleads someone.
  // =========================================================================
  {
    id: 'einfeldt-davis',
    name: 'HLL wave speeds: two-rarefaction -> plain Davis',
    breaks: 'the wave-speed estimate. The shipped version solves the two-rarefaction '
      + 'problem for h* and widens the fan by the shock factors q_L, q_R, which is '
      + 'what makes the estimate BOUND the true speeds and keeps the scheme positive '
      + 'at a strong shock. Davis takes the plain min/max of u -+ c and can '
      + 'underestimate the fan',
    expect: 'a Riemann-solver difference that only shows up when the two states are '
      + 'far apart, so it needs a strong dam break, and the strong dam-break checks '
      + 'have tolerances sized for the shock, not for the wave-speed estimate',
    review: 'SURVIVED all 93 checks at the review',
    known: 'the shipped estimate is the one with the positivity guarantee; Davis '
      + 'agrees with it wherever the states are close, which is everywhere except a '
      + 'strong shock, and the strong-shock checks measure the shock position rather '
      + 'than the fan. Catching it needs a check on the wave speeds themselves',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: L(
        '    const hStar = ((cL + cR) / 2 + (uL - uR) / 4) ** 2 / G;',
        '    const qL = hStar > hL ? Math.sqrt(0.5 * (hStar + hL) * hStar / (hL * hL)) : 1;',
        '    const qR = hStar > hR ? Math.sqrt(0.5 * (hStar + hR) * hStar / (hR * hR)) : 1;',
        '    sL = uL - cL * qL;',
        '    sR = uR + cR * qR;',
      ),
      repl: L(
        '    sL = Math.min(uL - cL, uR - cR);   // MUTANT: plain Davis speeds,',
        '    sR = Math.max(uL + cL, uR + cR);   // no two-rarefaction h* estimate',
      ),
    }],
  },
  {
    id: 'sm-average',
    name: 'HLLC contact speed -> 0.5*(uL + uR)',
    breaks: 'the contact-wave speed, which decides which side\'s transverse momentum '
      + 'crosses the face. The shipped version is the Riemann invariant expression; '
      + 'the mutant averages the two normal velocities',
    expect: 'the two differ in SIGN only where uL and uR straddle the true contact '
      + 'speed, so it takes a transverse shear across a strong normal discontinuity',
    review: 'SURVIVED all 93 checks at the review',
    known: 'the two expressions agree in sign almost everywhere, and out[2] uses '
      + 'nothing but the SIGN of sM. Catching this needs a case built to put the true '
      + 'contact speed between uL and uR while a transverse gradient crosses it -- '
      + 'the HLLC section runs a uniform-shear contact, which does not',
    suites: ['verify-physics', 'waves:snell'],
    patches: [{
      file: 'src/swe.mjs',
      find: '  const sM = Math.abs(den) > 1e-30 ? num / den : 0.5 * (sL + sR);',
      repl: '  const sM = 0.5 * (uL + uR);   // MUTANT: contact speed averaged',
    }],
  },
  {
    id: 'flather-fixed-depth',
    name: 'Flather celerity uses the still-water depth',
    breaks: 'the characteristic split at the open boundary: sqrt(g/h) is evaluated at '
      + 'the bed depth rather than at the instantaneous interior depth, so the '
      + 'boundary linearises about still water',
    expect: 'verify-tide\'s reflection coefficient, if the difference between h and '
      + '-bed at the boundary is ever large enough to matter',
    review: 'SURVIVED all 93 checks at the review',
    known: 'the two celerities differ by sqrt(-bed / h_interior), and every open '
      + 'boundary in this repository sits where that ratio is within a per-cent of 1. '
      + 'verify-tide\'s reflection test sends a 0.1 m pulse into 30 m of still water, '
      + '0.33% of the depth; waves.mjs fringingReef forces a wave that arrives 1.585 m '
      + 'crest to trough at a gauge in 25.58 m (both measured 2026-08-14). Separating '
      + 'them needs a boundary in shallow water, or a forcing amplitude comparable '
      + 'with the depth -- neither of which any case here has',
    suites: ['verify-physics', 'waves:fringingReef'],
    patches: [{
      file: 'src/swe.mjs',
      find: '    const r = Math.sqrt(G / hInt);',
      repl: '    const r = Math.sqrt(G / Math.max(sim.minDepth, -bed));   // MUTANT: still-water celerity',
    }],
  },
  {
    id: 'cfl-0.9',
    name: 'default CFL 0.45 -> 0.9',
    breaks: 'the stability margin. 0.45 is the safe number for 2D SSP-RK2 with MUSCL '
      + 'reconstruction; 0.9 is the 1D first-order figure and leaves no room for the '
      + 'two sweeps to add',
    expect: 'anything that integrates long enough to accumulate, or any check on the '
      + 'step count',
    review: 'SURVIVED all 93 checks at the review',
    known: 'the number is in charge less often than it looks. Most callers write '
      + 'sim.step(Math.min(sim.maxDt(), <time to the next output>)), so the step is '
      + 'frequently set by the output cadence and not by the Courant condition at '
      + 'all; where the solver does choose freely -- verify.mjs calls sim.step() with '
      + 'no argument -- 0.9 is evidently still stable on these problems, because '
      + 'verify-physics and waves:damping both stayed entirely green against it '
      + '(measured 2026-08-14). What is missing is any check that asserts something '
      + 'about the step SIZE or the step COUNT rather than about the state at a fixed '
      + 'time. A stability margin only becomes visible when it has been spent',
    suites: ['verify-physics', 'waves:damping'],
    patches: [{
      file: 'src/swe.mjs',
      find: '    minDepth = 1e-3, cfl = 0.45, coriolis = 0, order = 2, limiter = \'mc\',',
      repl: '    minDepth = 1e-3, cfl = 0.9, coriolis = 0, order = 2, limiter = \'mc\',   // MUTANT',
    }],
  },
  {
    id: 'theta-left-only',
    name: 'positivity limiter takes the left cell\'s theta',
    breaks: 'which cell\'s draw-down factor scales a face. The shipped version picks '
      + 'the UPWIND cell -- the one actually giving water away; the mutant always '
      + 'takes the left one, so a face draining leftward is scaled by the receiving '
      + 'cell instead',
    expect: 'verify-physics section 3, the positivity checks and the mass audit at a '
      + 'dry front, since that is the only place theta is ever below 1',
    review: 'SURVIVED all 93 checks at the review',
    known: 'the same scale factor is still applied to BOTH sides of the face, so mass '
      + 'is conserved exactly either way and the mass audit cannot see it. And theta '
      + 'is 1 everywhere except at a cell that would over-draw inside one step -- on '
      + 'these cases a handful of cells in the thin film of a front -- so the mutation '
      + 'has almost nowhere to act, and where it does act the checks assert positivity '
      + 'and mass rather than WHICH cell did the limiting. Catching it needs a check '
      + 'that counts clip events per side, not one that counts water',
    suites: ['verify-physics'],
    patches: [
      {
        file: 'src/swe.mjs',
        find: '        const th = fxM[kL] >= 0 ? theta[kL] : theta[kR];',
        repl: '        const th = theta[kL];   // MUTANT: not upwinded (x sweep)',
      },
      {
        file: 'src/swe.mjs',
        find: '        const th = fyM[kL] >= 0 ? theta[kL] : theta[kR];',
        repl: '        const th = theta[kL];   // MUTANT: not upwinded (y sweep)',
      },
    ],
  },
  {
    id: 'dryclean-silent',
    name: 'dryClean() stops reporting the mass it invents',
    breaks: 'the audit trail, not the physics. Flooring a negative depth to zero '
      + 'CREATES water; dryClean() returns how much so that step() can accumulate it '
      + 'into massFloored, which is what the "no mass invented by flooring" checks '
      + 'read. The mutant still floors and returns zero',
    expect: 'verify-physics section 3: "dam break: no mass invented by flooring" and '
      + 'the 2D run-up equivalent',
    review: 'SURVIVED all 93 checks at the review',
    known: 'those checks currently read total floored mass = 0 exactly, which means '
      + 'the positivity limiter upstream is doing its job and dryClean() has nothing '
      + 'to report on any case in the suite. A counter that is always zero cannot '
      + 'tell a working counter from a disconnected one. Catching this needs a case '
      + 'that deliberately drives a cell negative -- which is what positivity-off '
      + 'does, so the two mutants together would be caught even though neither is '
      + 'alone. Higher-order mutation is not something this harness does',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: '    return added;',
      repl: '    return 0;   // MUTANT: the floored mass is not reported',
    }],
  },
];

// ---------------------------------------------------------------------------
// Patch application. The count assertion is the whole point of this function.
// ---------------------------------------------------------------------------

let SCRATCH = null;               // set in main(); every write is checked against it

/**
 * CRLF -> LF, and nothing else.
 *
 * The anchors below are LF, because they are written as lines.join('\n') in a
 * source file that is itself LF. A default Windows clone -- core.autocrlf=true
 * and, until 2026-08-14, no .gitattributes -- checks the tree out CRLF, and
 * then every multi-line anchor misses. Measured on a CRLF copy of this tree,
 * before this function existed: "9/16 anchors found exactly once", exit 1, and
 * the seven that failed were exactly the seven multi-line ones.
 *
 * The whole of the fix is this substitution. It is applied to the SCRATCH COPY
 * only -- the repository is never written to -- and it is applied to every file
 * rather than only the patched ones, so that the pristine copy a mutant is
 * compared against has the same endings the patched copy does. Otherwise the
 * "the patched file must differ from the pristine one" guard would be satisfied
 * by the line endings alone and would stop being able to fail.
 */
const toLF = (s) => (s.indexOf('\r') === -1 ? s : s.replace(/\r\n/g, '\n'));

/**
 * Rewrite every file under `root/dirs` with LF endings. Returns what it did, so
 * the run can print it: a harness that silently repairs its input teaches the
 * next person nothing about why their clone was different.
 */
function normaliseEols(root, dirs) {
  let converted = 0, total = 0, crlfLines = 0;
  for (const d of dirs) {
    const full = path.join(root, d);
    for (const f of fs.readdirSync(full).sort()) {
      const p = path.join(full, f);
      if (!fs.statSync(p).isFile()) continue;
      total++;
      const raw = fs.readFileSync(p, 'utf8');
      const lf = toLF(raw);
      if (lf === raw) continue;
      assertInScratch(p);
      fs.writeFileSync(p, lf);
      converted++;
      crlfLines += raw.length - lf.length;
    }
  }
  return { converted, total, crlfLines };
}

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

  // THE CRLF BUG, asserted in both directions.
  //
  // Half a test here would be worthless. Asserting only that the normalised
  // text matches would pass even if toLF() were the identity function on a tree
  // that was LF already -- which is every tree this ever runs on, since the
  // .gitattributes landed. So the first half asserts that the bug is REAL: a
  // multi-line LF anchor must MISS a CRLF buffer. If that stops being true --
  // someone makes patchText ending-insensitive, say -- this fires and says so,
  // rather than quietly leaving a second mechanism nobody knows about.
  const crlf = 'alpha\r\nbeta\r\ngamma\r\n';
  const multi = L('alpha', 'beta');
  let missed = false;
  try { patchText(crlf, multi, 'AB', 'self-test'); } catch { missed = true; }
  if (!missed) {
    console.error('FATAL: a multi-line LF anchor MATCHED a CRLF buffer. That is not '
      + 'how string comparison works here, so something has changed underneath this '
      + 'file -- and the normalisation below is now covering for a mechanism nobody '
      + 'has read. Refusing to run.');
    process.exit(2);
  }
  if (patchText(toLF(crlf), multi, 'AB', 'self-test') !== 'AB\ngamma\n') {
    console.error('FATAL: toLF() did not make a CRLF buffer patchable by an LF anchor. '
      + 'Every multi-line mutant is about to report ANCHOR-ERROR on a CRLF clone, '
      + 'which is the exact failure this was written to stop. Refusing to run.');
    process.exit(2);
  }
  if (toLF('a\nb\r\nc\r\r\n') !== 'a\nb\nc\r\n') {
    console.error('FATAL: toLF() is not the \\r\\n -> \\n substitution it claims to be.');
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Running a suite in a child process.
// ---------------------------------------------------------------------------

const SUMMARY_RE = /^(?:ALL PASS|(\d+) FAILURES) -- (\d+)\/(\d+) checks/m;

function runSuite(dir, suite, timeoutMs) {
  const file = path.join(dir, SUITES[suite].file);
  const args = SUITES[suite].args ?? [];
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [file, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
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
      console.log(`  ${pad(m.id, 22)} ${pad(m.suites.join(','), 40)} ${m.known ? 'KNOWN  ' : '       '}${m.name}`);
    }
    console.log(`\n  ${selected.length} mutants, ${selected.filter((m) => m.known).length} of them declared KNOWN SURVIVORS,`
      + ` over ${new Set(selected.flatMap((m) => m.suites)).size} declared suites`);
    return 0;
  }
  if (selected.length === 0) {
    console.error(`no mutant matches --only ${only}`);
    return 2;
  }

  selfTest();

  const wallStart = Date.now();
  console.log('\n=== mutation harness =================================================\n');
  const nKnown = selected.filter((m) => m.known).length;
  const usedSuites = SUITE_ORDER.filter((s) => selected.some((m) => m.suites.includes(s)));
  console.log(`  ${selected.length} mutants (${nKnown} declared KNOWN SURVIVORS), `
    + `${usedSuites.length} suites declared, ${jobs} concurrent, node ${process.version}`);
  console.log(`  suites: ${usedSuites.join(', ')}`);

  const hashBefore = treeHash(REPO, ['src', 'tools']);
  console.log(`  repo sha256 (src + tools) before: ${hashBefore.slice(0, 16)}`);

  SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-mutants-'));
  const BASE = path.join(SCRATCH, '_base');
  assertInScratch(BASE);
  fs.mkdirSync(BASE);
  for (const d of ['src', 'tools']) fs.cpSync(path.join(REPO, d), path.join(BASE, d), { recursive: true });
  // CRLF -> LF in the copy, before anything reads it for an anchor. See toLF().
  const eol = normaliseEols(BASE, ['src', 'tools']);
  console.log(`  line endings: ${eol.converted} of ${eol.total} copied files contained CRLF`
    + (eol.converted
      ? `, normalised to LF in the scratch copy (${eol.crlfLines} carriage returns removed).`
        + ' An LF anchor cannot match CRLF text, so without this every multi-line anchor'
        + ' in an affected file would report ANCHOR-ERROR.'
      : ' -- nothing to normalise, which is what the .gitattributes is for.'));
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
    console.log(`\n  ${selected.length - bad}/${selected.length} anchors found exactly once`);
    console.log(`  ${secs(Date.now() - wallStart)} wall clock\n`);
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
  // KNOWN SURVIVORS ARE NOT ESCALATED. Escalation exists to decide whether
  // "survived" is true before the harness says it, and for these six that
  // question has already been answered -- by the reviewer, against every suite,
  // which is where the declaration comes from. Re-running six mutants against
  // verify-tide every time would add most of ten minutes to prove a sentence
  // that is already written down. What they DO still get is their declared
  // suites, every run, so that a stale declaration is caught.
  const phase2 = [];
  for (const m of selected) {
    const st = state.get(m.id);
    if (st.error || m.known || detected(m)) continue;
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
    const caught = !st.error && detected(m);
    const verdict = st.error ? 'ANCHOR-ERROR'
      : m.known ? (caught ? 'KNOWN -> CAUGHT (declaration stale)' : 'KNOWN SURVIVOR')
        : (caught ? 'CAUGHT' : 'SURVIVED');
    console.log(`\n  [${pad(m.id, 22)}] ${pad(m.name, 40)} ${verdict}`);
    field('breaks', m.breaks);
    field('expect', m.expect);
    field('review', m.review);
    if (m.known) field('known', m.known);
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

  const hitsFor = (m) => {
    const st = state.get(m.id);
    return SUITE_ORDER.filter((s) => st.results[s] && st.results[s].status !== 'GREEN')
      .map((s) => `${s}${st.results[s].status === 'RED' ? `(${st.results[s].fails})` : `(${st.results[s].status})`}`);
  };

  console.log('\n\n=== summary ==========================================================\n');
  console.log(`  ${'#'.padStart(2)}  ${pad('mutant', 22)} ${pad('breaks', 40)} ${pad('detected by', 34)} verdict`);
  console.log(`  ${'--'}  ${'-'.repeat(22)} ${'-'.repeat(40)} ${'-'.repeat(34)} -------`);
  let survivors = 0, errors = 0, promoted = 0;
  const realMutants = selected.filter((m) => !m.known);
  realMutants.forEach((m, i) => {
    const st = state.get(m.id);
    let by, verdict;
    if (st.error) { by = '-- not applied --'; verdict = 'ANCHOR-ERROR'; errors++; }
    else {
      const hits = hitsFor(m);
      by = hits.length ? hits.join(' ') : 'nothing';
      verdict = hits.length ? 'CAUGHT' : 'SURVIVED';
      if (!hits.length) survivors++;
    }
    console.log(`  ${String(i + 1).padStart(2)}  ${pad(m.id, 22)} ${pad(m.breaks, 40)} ${pad(by, 34)} ${verdict}`);
  });

  // ---- KNOWN SURVIVORS: mutations we cannot yet catch ---------------------
  //
  // Printed in their own table so the gap is visible instead of absent. They do
  // not fail the run. What they are is a list of things this repository is
  // DECLARED unable to distinguish from the shipped solver -- and the reviewer
  // who found them could not make any of them change an answer on a closed-form
  // benchmark either, so this is a coverage gap and not a known correctness
  // gap. The two are different claims and the difference matters: nothing here
  // says the solver is wrong, it says nothing currently measured would notice
  // if it were wrong in these particular ways.
  const knowns = selected.filter((m) => m.known);
  if (knowns.length) {
    console.log('\n\n=== known survivors: mutations we cannot yet catch ====================\n');
    console.log('  Declared, run every time, and NOT counted as failures. Each line is a hole');
    console.log('  in what this repository measures -- not a defect found in the solver. The');
    console.log('  reviewer who found these could not make any of them change an answer on any');
    console.log('  closed-form benchmark either, so what is established is that nothing here');
    console.log('  can tell them apart from the shipped code, not that the shipped code is');
    console.log('  wrong. They are not escalated: the "survives everything" half of the claim');
    console.log('  is the reviewer\'s measurement, and re-proving it would cost most of ten');
    console.log('  minutes a run. What is re-measured every time is the declared suites below.\n');
    console.log(`  ${'#'.padStart(2)}  ${pad('mutant', 22)} ${pad('ran against', 40)} still surviving?`);
    console.log(`  ${'--'}  ${'-'.repeat(22)} ${'-'.repeat(40)} ----------------`);
    knowns.forEach((m, i) => {
      const st = state.get(m.id);
      let ran, verdict;
      if (st.error) { ran = '-- not applied --'; verdict = 'ANCHOR-ERROR'; errors++; }
      else {
        const hits = hitsFor(m);
        ran = m.suites.join(' ');
        verdict = hits.length ? `NO -- caught by ${hits.join(' ')}` : 'yes';
        if (hits.length) promoted++;
      }
      console.log(`  ${String(i + 1).padStart(2)}  ${pad(m.id, 22)} ${pad(ran, 40)} ${verdict}`);
    });
    console.log('\n  why each one gets through -- read these as a to-do list for the suites:\n');
    for (const m of knowns) { console.log(`  [${m.id}]`); field('', m.known); }
  }

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
    for (const [m, s] of blind) {
      console.log(`     ${pad(s, 20)} green against ${pad(m.id, 22)}${m.known ? '   (known survivor)' : ''}`);
    }
  }

  const hashAfter = treeHash(REPO, ['src', 'tools']);
  console.log(`\n  repo sha256 (src + tools) after:  ${hashAfter.slice(0, 16)}   `
    + `${hashAfter === hashBefore ? 'UNCHANGED' : '*** THE REPOSITORY WAS MODIFIED ***'}`);

  if (keep) console.log(`  scratch kept at ${SCRATCH}`);
  else { fs.rmSync(SCRATCH, { recursive: true, force: true }); console.log('  scratch removed (--keep to retain it)'); }

  const totalRuns = selected.reduce((a, m) => a + Object.keys(state.get(m.id).results).length, 0);
  console.log(`  ${secs(Date.now() - wallStart)} wall clock: ${totalRuns} mutated suite runs `
    + `+ ${Object.keys(base).length} baselines, ${jobs} at a time`);

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
  if (promoted) {
    console.log(`\n  ${promoted} KNOWN SURVIVOR(S) WERE CAUGHT. This is GOOD NEWS and it is still a`);
    console.log('  failure, because the file now says something false: "we cannot yet catch');
    console.log('  this" has stopped being true and nothing but this exit code will make');
    console.log('  anyone edit it. Move the entry out of the known-survivor block, give it a');
    console.log('  `found` note with the numbers from this run, and delete its `known` line.');
    console.log('  A declared gap that has quietly closed is the same disease as a `found`');
    console.log('  note that has quietly gone stale.\n');
    return 1;
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  console.log(`\n  All ${plural(realMutants.length, 'mutant', 'mutants')} detected; `
    + `all ${plural(knowns.length, 'known survivor', 'known survivors')} still surviving.`);
  console.log('  Note what this does and does not say. It says these suites CAN go red when');
  console.log('  the physics is wrong in these specific ways. It says nothing about the ways');
  console.log('  not on the list, a CAUGHT is not a claim that the right check fired (read');
  console.log('  the FAIL lines), and the known-survivor table above is the part of the list');
  console.log('  that is admitted rather than fixed.\n');
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('\nharness failed:', e && e.stack || e);
  process.exit(2);
});
