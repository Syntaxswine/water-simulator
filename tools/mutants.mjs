// ---------------------------------------------------------------------------
// MUTATION HARNESS -- what does "ALL PASS" actually mean?
//
//   node tools/mutants.mjs              (every mutant against its declared suites)
//   node tools/mutants.mjs --list       (print the mutant list, run nothing)
//   node tools/mutants.mjs --anchors    (apply every patch, run no suite; ~1 s.
//                                        This is the check to run after touching
//                                        src/swe.mjs OR src/tide.mjs, and it is
//                                        the one that fails when anchors go stale)
//   node tools/mutants.mjs --only vel   (mutants whose id or name contains "vel")
//   node tools/mutants.mjs --jobs 4     (concurrency; the default is sized from
//                                        the machine and printed in the banner)
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
// it breaks.
//
// THE FIGURES THAT USED TO BE HERE WERE WRONG BY A FACTOR OF THREE. They read
// "verify-physics 8.6 s ... verify-tide 113.3 s. That run did 32 mutated suite
// runs plus those six baselines, six at a time, in 305.3 s of wall clock."
// Measured 2026-08-14, each suite run alone on an idle 16-core machine:
// verify-physics 8.2 s, verify-tide 343.3 s. verify-tide had TRIPLED -- hostile
// review kept adding to it, and it was measured at 29 checks in the morning of
// the day this paragraph was rewritten, 57 by mid-afternoon and larger again by
// evening -- while this comment went on quoting the figure from before any of
// it. So the per-suite costs are no longer written down here at all, beyond the
// two that justify a decision in this file (the sort below and the default
// concurrency): the run BASELINES every suite it is about to use and prints the
// table three lines under the banner, and prints its own wall clock at the end.
// Read those. A cost in a comment is a claim with nothing checking it.
//
// What the shape of those costs buys is worth stating, though, because it does
// not change: verify-physics is forty times cheaper than verify-tide, so a
// mutant aimed at the right suite costs almost nothing and a mutant aimed at
// the wrong one costs the whole run. That is the only reason the `suites` field
// exists.
//
// The slow waves cases are deliberately NOT used. Measured on the same tree, one
// case per process, all eight at once: see the note above SUITES for the table.
// Every mutation aimed at waves.mjs here is pointed at the cheapest case that
// was MEASURED to catch it, not at the case whose name best matches the physics.
// If the declared suites all stay GREEN the harness ESCALATES and runs every
// remaining suite before calling anything a survivor, because "survived" is a
// strong claim and it should cost the harness something to make it.
//
// KNOWN SURVIVORS are mutations declared here that no check in this repository
// catches. THE COUNT IS NOT WRITTEN DOWN HERE. This paragraph used to open
// "Six mutations are declared here", which was true on the day it was written
// and is the same disease as the usage line at the top: a count in a comment is
// a claim with nothing checking it. The run prints the counts instead, in a
// `=== counts ===` block at the end that names every bucket and sums to the
// number of mutants run.
//
// They come from the reviewers who found them, they are run every time like
// everything else, and they are reported in a table of their own with the
// reason. They do NOT fail the run: a hole that is measured, named and printed
// is a different thing from a hole nobody has noticed, and the point of listing
// them is that the gap is VISIBLE rather than absent. If one of them is ever
// CAUGHT the run fails, loudly, because the declaration has gone stale.
//
// A KNOWN SURVIVOR IS NOT A CLAIM THAT THE MUTATION DOES NOTHING, and the two
// batches of them differ on exactly that point. For the reviewer's original six
// the reviewer could not make any of them change an answer on a closed-form
// benchmark either, so the honest summary there is "indistinguishable by
// anything measured". The one left over from the 2026-08-14 suite audit is not
// like that: hstar-half demonstrably moves the solver -- an 81% wider HLLC fan
// on a converging jump, computed this session -- and survives because nothing
// asserts the quantity it moves. That is the sharper kind of hole, because
// there is a specific number to go and pin down.
//
// THE LIST IS MEANT TO SHRINK, and it does. Of the nine mutations that audit
// found, THREE were byte-identical -- cmp-clean against the unmutated stdout,
// because the tide exports they touch were never called by anything -- and the
// other six moved real physics behind a check that was one-sided, band-shaped
// or absent. Eight of the nine were caught by checks that landed the same
// afternoon; one of those checks quotes this file's own mutation back at it
// ("the same rig with theta halved leaves 2.500e-1 m"), which is what a named,
// printed hole is for. None of them is a known correctness gap; what is
// established is only what this repository can and cannot see.
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
  // FROM THE 2026-08-14 MUTATION AUDIT OF tools/verify-physics.mjs AND
  // tools/verify-tide.mjs.
  //
  // Nine mutations that got through every check in this repository -- 146 of
  // them that morning, 43 in verify-physics and 29 in verify-tide plus verify's
  // 35 and waves's 39. They are here so that whether each one is caught is a
  // PRINTED FACT on every run instead of something the next reviewer has to
  // rediscover by hand. Any that are still not caught are in the known-survivor
  // block below with a reason, on the same terms as the reviewer's original six.
  //
  // FOUR OF THEM ARE THE FIRST MUTATIONS THIS HARNESS HAS EVER PUT IN
  // src/tide.mjs, and that is most of the point of them. Grepped 2026-08-14:
  // tools/verify-tide.mjs is the only file under tools/ that imports that
  // module -- index.html is the repository's only other importer. So for a tide
  // mutation verify-tide is not the cheapest suite that might catch it, it is
  // the ONLY suite that can, and declaring one of these anywhere else would be
  // declaring a suite that cannot see the file. It is also why they are the
  // expensive entries in this list: verify-tide is 343.3 s measured alone on
  // this machine against 8.2 s for verify-physics, and there is no cheaper aim
  // to take.
  //
  // THE n/N IN THE `found` NOTES BELOW IS FROM THE RUN THAT MEASURED IT, and
  // BOTH halves of it move. verify-physics went 43 -> 47 -> 75 checks over the
  // afternoon these entries were written and verify-tide 29 -> 57 -> 64, because
  // two other passes were closing these exact holes at the same time -- and the
  // numerator moved with it: resper-2L was 4 red when it was first caught and 11
  // in the green run three hours later, flather-dirichlet 10 then 12. An earlier
  // draft of this paragraph asserted that the numerator at least held still.
  // It did not. So the figures quoted below are dated, the FAIL TEXT is what is
  // stable and is quoted verbatim, and the live n/N is printed by every run in
  // the detail block -- read that, not this. Where a note says a mutation was
  // BYTE-IDENTICAL against a named earlier version of a suite, that is a cmp of
  // the whole stdout with the character count given, which is the one claim here
  // that no n/N can express.
  // =========================================================================
  {
    id: 'bstar-average',
    name: 'hydrostatic reconstruction datum -> mean bed',
    breaks: 'the Audusse datum. Both sides of a face have to be reconstructed down from '
      + 'the SAME bed and it has to be the HIGHER one. Against the mean, a cell whose '
      + 'neighbour bed stands above its own free surface still trades water across the '
      + 'face, and a lake at rest over an obstacle that pierces the surface flows',
    expect: 'verify.mjs section 1, the lake-at-rest family, and inside it the island '
      + 'that PIERCES the surface -- the configuration where max(bL, bR) and the mean '
      + 'are furthest apart. verify-physics is declared as well because it is the 8 s '
      + 'suite and it does go red; read the found note before crediting it with the '
      + 'detection',
    review: 'not on the reviewer\'s list. From the 2026-08-14 audit of verify-physics.mjs, '
      + 'where it was reported as caught ONLY by a 1.9e-19 rounding crumb',
    found: '2026-08-14, measured on patched copies of the tree as it stood that afternoon '
      + '(verify-physics 75 checks, verify.mjs 35, verify-tide 57 -- the first and last were '
      + 'still growing that day, so read the live figures off the run). verify-physics goes '
      + 'red 1/75 and the single line is "run-up 2D: no mass invented by flooring -- total '
      + 'floored mass 1.8821735835809258e-19". That is a rounding crumb landing in an exact '
      + 'comparison against a quantity that is identically zero on every unmutated case: '
      + 'the suite is not measuring a broken datum, it is measuring that a number which '
      + 'used to be 0.0 is now 1.9e-19, and it would go green again the day anyone gives '
      + 'that assertion a sane tolerance. verify.mjs 2/35 is the detection that is about '
      + 'the physics -- "lake at rest, island (pierces surface): surface, max |eta - 2| = '
      + '0.022956 m over 400 steps" and "...velocity, max speed = 0.554322 m/s", a still '
      + 'lake moving at half a metre a second. That is why both are declared: the 8 s suite '
      + 'is a crumb and the 100 s one is the check. verify-tide is the interesting blind '
      + 'one and is deliberately NOT declared, at a tenth of the cost verify.mjs already '
      + 'covers it: ALL PASS 57/57 with 24 lines of its stdout moved and the headline '
      + 'resonant gain going 2.784x -> 3.180x. It cannot see this because the fitted peak '
      + 'moves from T/T_res = 1.02167 to 0.98403 -- CLOSER to 1 -- so a symmetric tolerance '
      + 'about the right answer scores the broken solver BETTER than the correct one',
    suites: ['verify-physics', 'verify'],
    patches: [
      {
        file: 'src/swe.mjs',
        find: L(
          '        // hydrostatic reconstruction against the higher bed',
          '        const bStar = Math.max(bL, bR);',
        ),
        repl: L(
          '        // MUTANT: reconstruction datum is the MEAN bed, not the higher one (x sweep)',
          '        const bStar = 0.5 * (bL + bR);',
        ),
      },
      {
        file: 'src/swe.mjs',
        find: L(
          '        const bStar = Math.max(bL, bR);',
          '        const hsL = Math.max(0, etaL - bStar);',
          '        const hsR = Math.max(0, etaR - bStar);',
          '        // Same solver, axes swapped: pass v as the normal component and u as the',
        ),
        repl: L(
          '        const bStar = 0.5 * (bL + bR);   // MUTANT: mean bed, not the higher one (y sweep)',
          '        const hsL = Math.max(0, etaL - bStar);',
          '        const hsR = Math.max(0, etaR - bStar);',
          '        // Same solver, axes swapped: pass v as the normal component and u as the',
        ),
      },
    ],
  },
  {
    id: 'pos-overlimit',
    name: 'positivity limiter over-limits by 2x',
    breaks: 'the draw-down factor. theta is DEFINED as exactly the factor that empties '
      + 'an over-drawing cell and no more; halving it stops the cell at half the water '
      + 'it should have given away, so the front the limiter exists to keep positive is '
      + 'instead held back, and the shoreline under-advances',
    expect: 'verify-physics section 3, the deliberate over-draw rig -- the only place in '
      + 'the repository where theta is ever below 1 at all',
    review: 'not on the reviewer\'s list. From the 2026-08-14 audit of verify-physics.mjs, '
      + 'where it SURVIVED: the positivity assertion was one-sided, min(h + dt*rh) >= '
      + '-1e-15, and over-limiting moves that quantity the SAFE way',
    found: '2026-08-14: verify-physics 3/75, from checks written that same day. "positivity: '
      + 'theta is the factor that JUST empties the cell, got 0.333333 want 0.666667"; '
      + '"positivity: the over-drawing cell ends the stage at 0, got 0.250000 want 0 ... '
      + 'measured exactly 2.500e-1 m"; "positivity: its neighbours hold everything it lost, '
      + '0.125000 + 0.125000 m against 0.5 m released". Probed independently on the same '
      + 'over-draw rig (40 cells of 0.5 m water diverging at 9 m/s, one residual at 5x the '
      + 'CFL step): the same 38 of 40 cells clip either way, worst theta goes 6.6315e-1 -> '
      + '3.3157e-1, and min(h + dt*rh) goes from exactly 0 to 2.5000e-1 m. What had been '
      + 'missing was only ever the OTHER SIDE of an inequality -- positivity is a floor and '
      + 'this defect is a ceiling. Everything else is still blind and correctly so: '
      + 'verify.mjs 35/35, verify-tide 57/57 with its stdout BYTE-IDENTICAL to the '
      + 'unmutated run (11797 characters), waves damping/fringingReef/snell all green, '
      + 'because theta is 1 everywhere on every case any of them runs',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: '          if (out * dt > avail) theta[k] = avail > 0 ? avail / (out * dt) : 0;',
      repl: '          if (out * dt > avail) theta[k] = avail > 0 ? 0.5 * avail / (out * dt) : 0;   // MUTANT: over-limits',
    }],
  },
  {
    id: 'maxdt-max',
    name: 'CFL: the two-axis sum becomes a max',
    breaks: 'the 2D Courant condition. For a dimensionally-unsplit two-sweep scheme the '
      + 'stable step is set by the SUM of the two directional wave rates, not by the '
      + 'larger of them; taking the max asks for a step that would only be safe if the '
      + 'y sweep cost nothing',
    expect: 'verify-physics section 8, "the CFL step" -- the check that asserts the step '
      + 'SIZE instead of the state at a fixed time. Nothing that only integrates to a '
      + 'fixed t can see this, because the mutant reaches the same t in fewer, bigger '
      + 'steps and on a smooth problem the answer survives it, so section 8 is not merely '
      + 'the cheapest suite that catches it, it is the only check anywhere that does. '
      + 'verify.mjs was declared here for one revision and is not any more: it is the '
      + 'suite that calls sim.step() with no argument and therefore actually lets maxDt() '
      + 'choose, so it looked like the right second opinion, and it was measured GREEN at '
      + '35/35. A hundred seconds a run to print one more blind-spot line is not a trade '
      + 'worth making when the note can say it instead',
    review: 'not on the reviewer\'s list. From the 2026-08-14 audit, which recorded it as '
      + 'surviving BOTH suites while roughly doubling the timestep',
    found: '2026-08-14, and this one CHANGED VERDICT inside the session, which is worth '
      + 'recording rather than tidying away. Measured against the suites as they stood '
      + 'that afternoon it was green everywhere: verify-physics 47/47, verify.mjs 35/35, '
      + 'verify-tide 57/57 with 40 lines of its stdout moved -- it noticed and never said '
      + 'so -- and waves damping 1/1, fringingReef 3/3, snell 4/4. It went into the '
      + 'known-survivor block with the reason "nothing here asserts the step, only the '
      + 'state at a fixed time; the fix is one line comparing maxDt() with the analytic '
      + 'CFL step". verify-physics then grew that line, on an ANISOTROPIC grid so that the '
      + 'sum and the max cannot coincide, and the mutant is now caught 2/75: "maxDt = '
      + 'cfl/((|u|+c)/dx + (|v|+c)/dy), dx=7 dy=11 -- got 0.442166 want 0.282552, rel '
      + '56.490%" and the same check with dx and dy exchanged, 71.686%. Probed separately '
      + 'on a 200x60 flat-bed dam break, where dx = dy and u = v = 0 make the ratio exactly '
      + '2: maxDt() at t = 0 goes 0.103705 s -> 0.207411 s and reaching t = 20 s takes 101 '
      + 'steps instead of 193, both runs finite, volumes agreeing to 0.0000%. That last '
      + 'part is why a fixed-time check could never have done it',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: '        const s = (u + c) / dx + (v + c) / dy;',
      repl: '        const s = Math.max((u + c) / dx, (v + c) / dy);   // MUTANT: 2D CFL sum -> max',
    }],
  },
  {
    id: 'flather-dirichlet',
    name: 'Flather boundary reverts to Dirichlet',
    breaks: 'the radiation boundary, completely. The ghost elevation becomes the '
      + 'PRESCRIBED external one instead of the characteristic combination, so the open '
      + 'boundary is a wall that oscillates and nothing leaves. This is not an invented '
      + 'mutation: it is the defect this repository actually shipped, the one that '
      + 'mirrored almost all of an outgoing wave',
    expect: 'verify-tide section 3, the reflection coefficient against the solid-wall '
      + 'control at every angle of incidence; and section 2, because a mouth that '
      + 'mirrors cannot resonate at the right period',
    review: 'not on the reviewer\'s list. Re-installed on purpose as a regression guard '
      + 'for a bug that has been in this file\'s own history',
    found: '2026-08-14: verify-tide 10/57 when first caught, 12/64 in the green run. The '
      + 'headline is "Flather absorbs an outgoing long '
      + 'wave -- reflection coefficient 49.14% at NORMAL incidence and A/h = 0.0033", '
      + 'against 0.12% on the same line unmutated. With it go all four angle-of-incidence '
      + 'ceilings (40.777 / 37.491 / 29.983 / 26.933% against 0.2 / 8 / 10 / 13%), the '
      + 'monotonic-degradation check, both amplitude-sweep checks, and the resonance fit '
      + '("got 1.05968 want 1.00000 ... peak gain 2.65x"). verify-physics is blind at 75/75 '
      + 'and is deliberately NOT declared: it never builds an open boundary at all, so a '
      + 'green line from it would be a suite reporting on something it does not run',
    suites: ['verify-tide'],
    patches: [{
      file: 'src/swe.mjs',
      find: '    sim.h[g] = Math.max(0, en - bed);',
      repl: '    sim.h[g] = Math.max(0, e0 - bed);   // MUTANT: prescribe the external elevation (Dirichlet)',
    }],
  },
  {
    id: 'resper-2L',
    name: 'quarter-wave resonant period 4L -> 2L',
    breaks: 'Tide.resonantPeriod(), the closed-form T = 4L/sqrt(gh) that src/tide.mjs '
      + 'offers as "the Bay of Fundy in one formula", and with it every gain, detuning '
      + 'and ranking resonanceReport() produces',
    expect: 'verify-tide section 1e, which exercises resonanceReport() and therefore calls '
      + 'the formula. NOT section 2: section 2 is the simulated resonance sweep and it '
      + 'builds its own resonant period from the basin it is about to run, which is the '
      + 'right way round for a simulation check and is exactly why it cannot see this. No '
      + 'other suite imports src/tide.mjs, so no other suite could',
    review: 'not on the reviewer\'s list. From the 2026-08-14 audit of verify-tide.mjs, '
      + 'where it was BYTE-IDENTICAL -- the export was never called',
    found: '2026-08-14: verify-tide 4/57 when first caught, and 11/64 in the green run three '
      + 'hours later as section 1e grew. The reason it is catchable at all is that the '
      + 'suite now CALLS the formula instead of recomputing it inline. "idealGain is '
      + '|sec(pi/2 Tr/T)|, recomputed here from the published period -- got 1.45942 want '
      + '16.39726, rel 91.100%", plus the old-sort-key demonstration, the gain cap, and the '
      + 'explicit gainCap argument. Measured against the 29-check version of the suite '
      + 'earlier the same day this mutation was BYTE-IDENTICAL: 7301 characters of stdout, '
      + 'character for character, cmp-clean. That is why it is worth keeping -- the failure '
      + 'it guards against is not a wrong number, it is a published export that nothing '
      + 'executes',
    suites: ['verify-tide'],
    patches: [{
      file: 'src/tide.mjs',
      find: '    return 4 * length / Math.sqrt(g * depth);',
      repl: '    return 2 * length / Math.sqrt(g * depth);   // MUTANT: half-wave, not quarter-wave',
    }],
  },
  {
    id: 'n2k2-swap',
    name: 'N2 and K2 periods swapped',
    breaks: 'the constituent table. N2 (12.65834751 h) and K2 (11.96723606 h) exchange '
      + 'periods, so a tide built from either is at the wrong frequency and the '
      + 'lunar-elliptic and lunisolar beats against M2 swap places',
    expect: 'verify-tide section 1, the constituent arithmetic -- the only place a '
      + 'published period is compared with anything',
    review: 'not on the reviewer\'s list. From the 2026-08-14 audit of verify-tide.mjs, '
      + 'where it was BYTE-IDENTICAL: the table was pinned only by band membership, '
      + '"semidiurnal is between 11.5 and 13 hours", and both swapped values satisfy it',
    found: '2026-08-14: verify-tide 4/57, still exactly 4 of 64 in the green run. Two are the '
      + 'per-constituent period assertions, '
      + 'each pinned to its Doodson number -- "N2 = 2 -3 2 1 on (T,s,h,p), got 11.96724 '
      + 'want 12.65835, rel 5.460%" and "K2 = 2 0 2 0, got 12.65835 want 11.96723, rel '
      + '5.775%" -- and two are the resonance-ranking demonstrations, which reorder when '
      + 'the periods do. Against the 29-check version of the suite earlier the same day '
      + 'this was BYTE-IDENTICAL (7301 characters, cmp-clean), because a SWAP keeps both '
      + 'values inside the band that was the only thing pinning them',
    suites: ['verify-tide'],
    patches: [{
      file: 'src/tide.mjs',
      find: L(
        "  N2: { period: 12.65834751, name: 'larger lunar elliptic semidiurnal' },",
        "  K2: { period: 11.96723606, name: 'lunisolar semidiurnal' },",
      ),
      repl: L(
        "  N2: { period: 11.96723606, name: 'larger lunar elliptic semidiurnal' },   // MUTANT: N2 and K2",
        "  K2: { period: 12.65834751, name: 'lunisolar semidiurnal' },               // periods swapped",
      ),
    }],
  },
  {
    id: 'k1-period-25',
    name: 'K1 period 23.93447213 h -> 25.0 h',
    breaks: 'the constituent table again, this time by putting in a number that is not '
      + 'any constituent at all. 25.0 h against the published 23.93447213 is 4.452% high, '
      + '1.06553 h per cycle; arithmetic on those two figures gives 14.958 h of '
      + 'accumulated phase error over a fortnight, which is 0.625 of a K1 cycle -- i.e. '
      + 'the diurnal inequality ends up on the wrong side of the day',
    expect: 'verify-tide section 1. It is the sister of n2k2-swap and it is here as well '
      + 'because the two fail differently: a swap keeps the set of published numbers '
      + 'intact and only misfiles them, this one puts a number in that is not a '
      + 'constituent at all',
    review: 'not on the reviewer\'s list. From the 2026-08-14 audit of verify-tide.mjs, '
      + 'BYTE-IDENTICAL: the only assertion touching K1 was that a diurnal sits between '
      + '23 and 27 hours, a band four hours wide',
    found: '2026-08-14: verify-tide 1/57, still exactly 1 of 64 in the green run -- "K1 = 1 0 '
      + '1 0 on (T,s,h,p), got 25.00000 want '
      + '23.93447, rel 4.452%, 44518.6555 ppm". One line, and one is the honest number: '
      + 'nothing else in the suite runs a diurnal constituent, so the period assertion is '
      + 'the whole of the coverage, and the ppm column is what would make a transcription '
      + 'slip in the eighth digit visible as well. BYTE-IDENTICAL against the 29-check '
      + 'version earlier the same day',
    suites: ['verify-tide'],
    patches: [{
      file: 'src/tide.mjs',
      find: "  K1: { period: 23.93447213, name: 'lunisolar diurnal' },",
      repl: "  K1: { period: 25.0, name: 'lunisolar diurnal' },   // MUTANT: 4.45% off the sidereal day",
    }],
  },
  {
    id: 'eta-phase-sign',
    name: 'tidal phase enters eta() with the wrong sign',
    breaks: 'the phase convention of the constituent sum: cos(wt - phi) becomes '
      + 'cos(wt + phi), so every term with a non-zero phase arrives at the wrong time '
      + 'relative to the others and the superposition is rebuilt from a different set '
      + 'of relative phases. rate() is deliberately left alone, so eta() also stops '
      + 'being the function rate() claims to differentiate',
    expect: 'verify-tide section 4, the only place in the repository that runs a tide '
      + 'with a NON-ZERO phase on a real constituent (S2 at 30 deg). Where every phase '
      + 'is 0 the mutation is algebraically invisible, which is why nothing else can '
      + 'see it however long it runs',
    review: 'not on the reviewer\'s list. From the 2026-08-14 audit of verify-tide.mjs: '
      + 'ALL PASS 29/29 while it moved the range at the mouth from 6.53 m to 6.07 m',
    found: '2026-08-14: verify-tide 4/57, still exactly 4 of 64 in the green run. Two of them '
      + 'attack the convention head-on -- '
      + '"phase +63 deg puts high water 63/360 of a cycle later, got -0.94046 want '
      + '1.60000" and the cycle scan that then finds the maximum at 10.2470 h instead of '
      + '2.1736 h. The other two catch the collateral damage, which is the part worth '
      + 'noticing: this mutation leaves rate() alone, so eta() stops being the function '
      + 'rate() differentiates, and "rate() matches a central difference of eta()" goes to '
      + '29.053% of the largest rate in the cycle -- with a companion check that the '
      + 'residual falls as d^2, which is what turns "close" into "actually the derivative". '
      + 'Probed directly on the same constituent set, the worst |d(eta)/dt - rate(t)| over '
      + '24 h goes 2.4989e-13 m/s shipped to 7.2722e-5 m/s mutated. Against the 29-check '
      + 'version earlier the same day it was ALL PASS while moving the range at the mouth '
      + '6.53 -> 6.07 m and the flood/ebb asymmetry 107.9% -> 104.9%: the first was printed '
      + 'and not asserted, and the band that did cover the second was 10-152% wide',
    suites: ['verify-tide'],
    patches: [{
      file: 'src/tide.mjs',
      find: '    for (const k of this.terms) e += k.amp * Math.cos(k.omega * t - k.phase * Math.PI / 180);',
      repl: '    for (const k of this.terms) e += k.amp * Math.cos(k.omega * t + k.phase * Math.PI / 180);   // MUTANT: phase sign',
    }],
  },

  // =========================================================================
  // PROMOTED OUT OF THE KNOWN-SURVIVOR BLOCK, 2026-08-14.
  //
  // Both of these were the reviewer's, both were declared uncatchable, and both
  // were caught by checks that landed while this file was being edited. They
  // are here rather than deleted because a mutation that has just started being
  // caught is exactly the one worth re-running: it is the regression guard for
  // a check written today.
  //
  // THE MECHANISM THAT FOUND THEM IS THE POINT. A known survivor is still run
  // against its declared suite on every run, and being caught FAILS the run --
  // "we cannot catch this" becoming false is good news and a stale sentence at
  // the same time. That is what happened here: the run went red, the two lines
  // below moved, and the file stopped lying. Note also that one of the two
  // reasons was wrong about WHY it survived (see theta-left-only's found note),
  // which is an argument for keeping the reason text short on mechanism and
  // long on what was measured.
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
    found: '2026-08-14. This was a KNOWN SURVIVOR of the reviewer\'s -- "SURVIVED all 93 '
      + 'checks" -- and its reason read, in full, "the strong-shock checks measure the '
      + 'shock position rather than the fan. Catching it needs a check on the wave '
      + 'speeds themselves". verify-physics grew exactly that check and the mutant is '
      + 'now caught 5 red: "hllc uses the declared two-rarefaction speeds, hL=10 hR=0.1 '
      + '-- got 9.902853 want 21.529455, rel 54.003% (h* = 3.025000 m)", the same at '
      + 'hL=10 hR=1 (6.931%) and hL=1 hR=0.9 (1.255%), plus "strong shock hL=10 hR=0.1: '
      + 'sR bounds the exact right wave -- sR = 9.902853 against the exact shock '
      + '12.331739 m/s, -19.7% over" and the weak-Riemann right speed at 1.256%. The '
      + 'declaration was true when it was written and is not any more, and the only '
      + 'reason anybody found out is that the harness re-runs a declared survivor '
      + 'against its suite every time and exits non-zero when one is caught',
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
    id: 'theta-left-only',
    name: 'positivity limiter takes the left cell\'s theta',
    breaks: 'which cell\'s draw-down factor scales a face. The shipped version picks '
      + 'the UPWIND cell -- the one actually giving water away; the mutant always '
      + 'takes the left one, so a face draining leftward is scaled by the receiving '
      + 'cell instead',
    expect: 'verify-physics section 3, the positivity checks and the mass audit at a '
      + 'dry front, since that is the only place theta is ever below 1',
    review: 'SURVIVED all 93 checks at the review',
    found: '2026-08-14. Another of the reviewer\'s KNOWN SURVIVORS, caught the same '
      + 'afternoon, and its reason turned out to be wrong about the fix. It said '
      + '"catching it needs a check that counts clip events per side, not one that '
      + 'counts water". No per-side counter was written. What caught it, 2 red, is the '
      + 'two-sided end-state pair added for pos-overlimit: "positivity: the '
      + 'over-drawing cell ends the stage at 0 -- got -0.125000 want 0" and "positivity: '
      + 'its neighbours hold everything it lost -- 0.375000 + 0.250000 m against 0.5 m '
      + 'released". Taking the left cell\'s theta on a face draining leftward does not '
      + 'just mislabel which cell limited: it under-limits, and the cell ends the stage '
      + 'at MINUS 0.125 m. The old reason was reasoning about the mechanism instead of '
      + 'measuring the consequence, and the consequence was a negative depth in the one '
      + 'rig built to look for one',
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

  // =========================================================================
  // KNOWN SURVIVORS.
  //
  // Mutations that nothing in this repository catches. The count is not written
  // here -- the run prints it. This block opened "Six mutations" for as long as
  // there were six, and then two of the six were caught in an afternoon and the
  // word was wrong; they are two entries up, under PROMOTED.
  //
  // Most of them are the reviewer's, found by a pass over the solver that this
  // harness had not covered. They are declared rather than left out so that the
  // gap is printed on every run instead of being invisible.
  //
  // WHAT THIS IS AND IS NOT. For the reviewer's, the reviewer could not make any
  // of them change an answer on a closed-form benchmark either -- not Stoker,
  // not Ritter, not Thacker -- so what is established is that they are
  // indistinguishable from the shipped solver BY ANYTHING CURRENTLY MEASURED.
  // That is a coverage gap. It is NOT a known correctness gap, and it is not
  // evidence that the shipped choice is arbitrary: the HLLC contact estimate and
  // the CFL number are cases where the shipped version is the one with the
  // better guarantee and the alternative is merely not WORSE on anything
  // measured so far.
  //
  // Each still declares a suite and is still run, because a declaration nobody
  // re-measures is exactly the kind of stale claim this file exists to stop.
  // They are declared against verify-physics, the cheapest suite, plus the
  // cheap waves cases for the two whose effect is a wave effect. If one of them
  // is ever CAUGHT the run FAILS -- being caught is good news, but it means the
  // sentence "we cannot catch this" has become false and the list must be
  // edited before it misleads someone. That has now happened twice, which is
  // the strongest argument there is for keeping this block rather than deleting
  // the entries in it.
  // =========================================================================
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

  // -------------------------------------------------------------------------
  // KNOWN SURVIVORS, second batch: what was left over from the 2026-08-14 suite
  // audit after the checks written that day landed.
  //
  // This one is a different animal from the six above and the difference is the
  // honest part. For the reviewer's six the summary is "nothing measured can
  // tell them apart from the shipped code". Here the mutation demonstrably
  // MOVES the solver -- the numbers below were measured this session, not
  // inferred -- and it survives because nothing asserts the quantity it moves.
  // That is the sharper kind of to-do, because there is a specific number to go
  // and pin down and the check needed has no simulation in it.
  //
  // It started the day as a pair. maxdt-max, the other half, was a known
  // survivor for about an hour: its reason said the missing check was "one line
  // asserting maxDt() against the analytic CFL step on a state with a known
  // celerity", tools/verify-physics.mjs grew exactly that check on an
  // anisotropic grid, and it moved up into the caught list above. That is what
  // this block is FOR -- a named, printed hole is a thing somebody can close,
  // and this one was closed the same afternoon it was written down.
  // -------------------------------------------------------------------------
  {
    id: 'hstar-half',
    name: 'HLLC two-rarefaction estimate: (uL - uR)/4 -> /2',
    breaks: 'the depth estimate h* that sizes the HLL fan. The 1/4 is the shallow-water '
      + 'two-rarefaction solution; 1/2 is not the solution of anything, and it inflates '
      + 'h* wherever the two states converge, which widens sL and sR through the shock '
      + 'factors q_L and q_R',
    expect: 'verify-physics section 6, the HLLC section, or any strong-shock check. The '
      + 'estimate only reaches the wave speeds when h* > h, so it needs a converging '
      + 'normal jump to show at all',
    review: 'not on the reviewer\'s list. From the 2026-08-14 audit, which recorded it as '
      + 'surviving both suites',
    known: 'the estimate only reaches the wave speeds through the shock factors q_L, q_R, '
      + 'and those are exactly 1 unless h* > h. Computed on four Riemann states: at hL = hR '
      + '= 2 m CONVERGING at uL = +3, uR = -3 the estimate goes h* 3.5842 -> 5.6273 m and '
      + 'the fan widens from sL, sR = -+4.0050 to -+7.2582 m/s, 81% wider; at hL = hR = 5 m '
      + 'DIVERGING at -+1.2 it moves h* 4.1799 -> 3.4331 m and the speeds do not move at '
      + 'all, because h* < h and q clamps; and at the two dam breaks (1 m against 0.001 m, '
      + '10 m against 1 m) uL - uR is zero and the mutant IS the shipped estimate to the '
      + 'last bit. So it acts only on a strongly converging normal jump, and when it acts '
      + 'it WIDENS the fan -- the diffusive, positivity-safe direction -- which is why '
      + 'nothing goes unstable and nothing goes red. AND THE OBVIOUS FIX HAS ALREADY BEEN '
      + 'TRIED AND MISSES, which is the part worth knowing. verify-physics now carries '
      + '"hllc uses the declared two-rarefaction speeds" -- the wave-speed check whose '
      + 'absence let einfeldt-davis survive, and which caught einfeldt-davis the moment it '
      + 'landed -- and it does not see this one at all. Its three Riemann states are '
      + 'hL=10 hR=0.1, hL=10 hR=1 and hL=1 hR=0.9, and every one has uL = uR = 0, where '
      + '(uL - uR)/4 and (uL - uR)/2 are both zero and the mutant IS the shipped formula '
      + 'bit for bit (its printed h* values, 3.025000 / 4.331139 / 0.949342 m, are '
      + 'identical either way). So the missing thing is no longer "a check on the wave '
      + 'speeds", it is ONE MORE STATE in the check that already exists, with uL != uR: '
      + 'hL = hR = 2 m at uL = +3, uR = -3 makes h* 3.5842 m shipped against 5.6273 m '
      + 'mutated. That is a sharper to-do than the one this entry started with, and it is '
      + 'sharper only because the near-miss was measured',
    found: '2026-08-14, re-measured last thing against the tree as the other two passes left '
      + 'it -- verify-physics at 75 checks, verify-tide at 64: verify-physics 75/75, '
      + 'verify-tide 64/64 with 22 lines of its stdout moved, verify.mjs 35/35, and waves '
      + 'damping 1/1, fringingReef 3/3, snell 4/4 (those three measured against the '
      + 'earlier tree, but neither src/ nor tools/waves.mjs changed after it). All six '
      + 'suites measured, which is what the known declaration rests on; only '
      + 'verify-physics is re-run every time, being the suite whose section 6 is where a '
      + 'check for this would have to go. The 22 moved lines are the important part of '
      + 'that line: the suite is not blind because the mutation is inert, it is blind '
      + 'because it prints what moved and asserts something else',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: '    const hStar = ((cL + cR) / 2 + (uL - uR) / 4) ** 2 / G;',
      repl: '    const hStar = ((cL + cR) / 2 + (uL - uR) / 2) ** 2 / G;   // MUTANT: not the two-rarefaction h*',
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
  // CONCURRENCY. This used to be a flat 6. It is sized from the machine now,
  // because the number that decides the wall clock is how many of the SLOWEST
  // suite can be in flight at once: this list declares several verify-tide
  // runs, and verify-tide is 343.3 s measured alone on the 16-core machine this
  // was changed on against 8.2 s for verify-physics. At six workers the
  // verify-tide jobs need a second wave and the run costs an extra six minutes
  // to learn nothing. Capped at 8 so a 64-core box does not start sixty node
  // processes contending for memory bandwidth, floored at 2 so a small one
  // still overlaps something. It is printed in the banner, and --jobs wins.
  const jobs = Number(arg('--jobs', String(Math.min(8, Math.max(2, os.cpus().length - 2)))));
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
  // LONGEST JOB FIRST. `pool` is FIFO, so the finishing time of the whole phase
  // is decided by when its longest job STARTS -- and until this sort existed the
  // order was the order the mutants happen to be written in. The baseline above
  // has just measured every suite, so the harness knows the costs; sorting by
  // them is free and it is the standard makespan heuristic. Measured 2026-08-14
  // on the 16-core machine this was written on: verify-tide 343.3 s run alone,
  // against verify-physics 8.2 s, so a single verify-tide job that starts last
  // adds most of six minutes to the run for nothing.
  phase1.sort((a, b) => (base[b.s]?.ms ?? 0) - (base[a.s]?.ms ?? 0));
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
    // Same makespan sort as phase 1, and it matters more here: escalation is
    // where the expensive suites pile up, because it runs every suite a mutant
    // did NOT declare and the cheap ones are the ones already done.
    phase2.sort((a, b) => (base[b.s]?.ms ?? 0) - (base[a.s]?.ms ?? 0));
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
    console.log('  in what this repository MEASURES -- not a defect found in the solver. None of');
    console.log('  them is a known correctness gap. Beyond that they divide in two, and the');
    console.log('  difference is in the reason text, which is worth reading rather than skipping:');
    console.log('  for some, nothing measured anywhere can tell the mutation from the shipped');
    console.log('  code at all; for others the mutation demonstrably MOVES the solver and');
    console.log('  survives because no check asserts the quantity it moved. The second kind is');
    console.log('  the sharper to-do, because there is a specific number to go and pin down.');
    console.log('  They are not escalated: re-proving the "survives everything" half every run');
    console.log('  would cost most of ten minutes. What is re-measured every run is the declared');
    console.log('  suites below, which is what makes a stale declaration fail loudly.\n');
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

  // ---- COUNTS -------------------------------------------------------------
  //
  // The two tables above are the evidence. This is the one-line answer, and it
  // exists because a reader who skims still has to be able to say what a green
  // run MEANS. Every mutant lands in exactly one bucket and the buckets sum to
  // the number run -- that sum is asserted below, because a summary that can
  // quietly drop a row is a summary that can hide a survivor.
  const nErrReal = realMutants.filter((m) => state.get(m.id).error).length;
  const nErrKnown = knowns.filter((m) => state.get(m.id).error).length;
  const nCaught = realMutants.length - survivors - nErrReal;
  const nStillKnown = knowns.length - promoted - nErrKnown;
  console.log('\n\n=== counts ===========================================================\n');
  const row = (n, label, text) => console.log(`  ${String(n).padStart(3)}  ${pad(label, 17)}${text}`);
  row(selected.length, 'MUTANTS RUN',
    `against ${usedSuites.length} declared suite${usedSuites.length === 1 ? '' : 's'}, ${jobs} at a time`);
  row(nCaught, 'caught', 'a shipped suite went RED, TIMEOUT or CRASH');
  row(survivors, 'SURVIVED', 'every suite stayed green and it is NOT declared -- a hole');
  row(nStillKnown, 'known survivor', 'declared uncatchable, re-run anyway, not a failure');
  if (promoted) row(promoted, 'known -> CAUGHT', 'the declaration has gone stale and must be edited');
  if (nErrReal + nErrKnown) {
    row(nErrReal + nErrKnown, 'ANCHOR-ERROR', 'the patch never applied, so nothing was measured');
  }
  // The sum is checked, not assumed. It does NOT return here: an early return
  // would skip the repo-integrity hash and leave the scratch tree behind, so
  // the failure is recorded and the epilogue below still runs.
  const bucketSum = nCaught + survivors + nStillKnown + promoted + nErrReal + nErrKnown;
  const bucketsBroken = bucketSum !== selected.length;
  if (bucketsBroken) {
    console.log(`\n  FATAL: the buckets sum to ${bucketSum} but ${selected.length} mutant`
      + `${selected.length === 1 ? ' was' : 's were'} run. A mutant has`);
    console.log('  fallen out of the accounting, which is the one thing this block exists to');
    console.log('  make impossible. Nothing else printed above can be trusted either.');
  }
  if (bucketsBroken || survivors || promoted || nErrReal + nErrKnown) {
    console.log('\n  THIS RUN IS NOT GREEN, so it is making no claim yet. A SURVIVED row is a hole');
    console.log('  in what this repository measures; a known-survivor that was CAUGHT is a sentence');
    console.log('  in this file that has become false; an ANCHOR-ERROR row means that mutant was');
    console.log('  never applied and nothing about it was measured at all.');
  } else {
    console.log(`\n  So this green run says: those ${nCaught} mutations CAN be caught by these suites as`);
    console.log(`  they ship, those ${nStillKnown} cannot and are admitted rather than fixed, and it says`);
    console.log('  nothing whatever about any mutation that is not on the list.');
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

  if (bucketsBroken) {
    console.log('\n  FATAL: the counts block did not balance -- see above. Every other number in');
    console.log('  this run is produced by the same bookkeeping, so none of them is evidence.\n');
    return 3;
  }
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
