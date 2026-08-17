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
//   node tools/mutants.mjs --sphere-full
//                                       (run tools/verify-sphere.mjs WHOLE instead of
//                                        the filtered invocation the ladder uses --
//                                        see THE SPHERE SUITE, AND WHAT IT COSTS)
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
//                broken. Not the same as "every check in the repository", and
//                the difference is NOT a fixed number -- escalation covers
//                exactly the suites in SUITE_ORDER, which the banner prints, and
//                two things are deliberately left outside it: five of waves.mjs's
//                eight cases, and section 4 of tools/verify-sphere.mjs. Both
//                exclusions are stated where they are made, both are on cost
//                grounds, and both mean a mutation only they could see would read
//                SURVIVED. This is a hole, and it exits the harness non-zero.
//   TIMEOUT ONLY the mutant's ONLY non-green result was a suite that was killed
//                without printing a summary. NOT scored as a catch, its own
//                bucket, and it FAILS the run: a killed process cannot say
//                whether a check failed or whether the mutation made the
//                simulation slow, and treating the two alike is how a hole comes
//                to read as covered. A mutant with a TIMEOUT and a RED is CAUGHT
//                by the RED, and escalation is what looks for that RED.
//   TIMEOUT      the suite did not finish inside its timeout (3x its measured
//                baseline by default, per-suite overridable in SUITES) AND
//                printed no summary line. A hang is a detection, but it is not a
//                check failing, so it is labelled separately and never counted as
//                a passing check -- see TIMEOUT ONLY above for what the verdict
//                does with it. A suite that printed its complete summary and
//                then failed to TERMINATE is NOT this: it is reported as whatever
//                its summary said, with the non-termination counted separately as
//                an anomaly about the suite. That distinction was added on
//                2026-08-17 after it produced a false CAUGHT -- see runSuite(),
//                which carries the measurement (18 sequential runs of
//                tools/verify-render.mjs, 2 of them alive when killed, both with
//                all 14583 bytes of their output and their ALL PASS line already
//                written). A spurious CAUGHT is the worst thing this harness can
//                print, because a hole then reads as covered.
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
// things run are the files named in SUITES below, exactly as they ship -- with
// two stated exceptions: line endings, below, and the SECTION FILTER on
// tools/verify-sphere.mjs, which is stated where it is applied and printed in
// the banner of every run. THE LIST OF SUITES IS NOT REPEATED HERE. It was, and
// it went stale twice over: it named four files when there were eight, and it
// went on naming four after tools/verify-sphere.mjs landed. SUITES is the list;
// the banner prints it.
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
// AND IT DRIFTED AGAIN, in the other direction. Re-measured 2026-08-17, each
// suite alone and sequentially on the same 16-core machine: verify-physics 6.9 s,
// verify-tide 260.0 s. So the 343.3 s above is now high by a third, and four
// other comments in this file were quoting it as current until that pass. The
// paragraph above was right about the mechanism and wrong to think writing the
// number down once was the last time it would need doing.
//
// What the shape of those costs buys is worth stating, though, because it does
// not change: verify-physics is nearly forty times cheaper than verify-tide, so
// a mutant aimed at the right suite costs almost nothing and a mutant aimed at
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
// FOUR ANCHORS WERE STALE WHEN THIS FILE WAS OPENED ON 2026-08-17, and the
// harness was exiting 1. This is the failure this file's own header calls the
// invisible one, arriving exactly as advertised, and it is worth reading before
// the sphere section because it is the same lesson from the other end.
//
// The spherical port (f3d1351) rewrote the four lines that carry the metric out
// of src/swe.mjs's hot loops -- the scalar dx and dy became per-row dxRow[j],
// dyRowN[j], dyRowS[j+1], dyCFL[j] and bedDiv0/bedDiv1, and the Cartesian
// Coriolis block became the `else` of a new spherical one. `--anchors` printed
// "29/33 anchors found exactly once" and named them: coriolis-off, bedsource-zero,
// ysweep-zero-flux, maxdt-max. All four are Cartesian mutants whose physics the
// port did not touch at all; what moved was the TEXT they were pinned to. Repaired
// in place, each with a note saying what moved and what the repair does and does
// not still cover -- coriolis-off, in particular, now breaks only HALF of what its
// name says, because the sphere has its own Coriolis block and a mutant that reads
// CAUGHT while covering half its subject is worse than one that errors.
//
// The brittleness is deliberate and it worked: the harness refused to run rather
// than quietly mutating nothing. What it cost is that the instrument was RED for
// three days and the file it was reporting on was fine.
//
// THE SPHERE ARRIVED WITHOUT ITS SUITE, AND THEN THE SUITE ARRIVED AND THIS FILE
// DID NOT NOTICE. Both halves matter, and the second half is the one that should
// be read first, because it is the failure mode this harness exists to prevent
// happening to somebody else's file.
//
// The first half is history. When the spherical mutants below were written
// there was exactly ONE gate anywhere in the repository that ran a
// spherical simulation -- section 8 of src/globe.mjs, a closed-form mode period
// over a FLAT bed at ORDER 2 with omega = 0 -- and tools/verify-sphere.mjs had
// been specified in detail, had its targets measured in advance, and had not been
// delivered. TEN of those mutants were declared survivors on that basis, EIGHT of
// them carrying `blocked: 'tools/verify-sphere.mjs'`, and this header said in so
// many words that the file "does not exist".
//
// The second half is the defect. tools/verify-sphere.mjs DOES exist. It is green
// at 248/248 in 237.2 s measured alone on this machine, and it
// carries exactly the checks the ten declarations said were missing -- an area
// identity against a locally declared radius, per-band sums, a resting lake over
// relief at BOTH orders, an inertial oscillation at two latitudes, a zonal jet at
// high latitude, and a rotation-invariance test across the antimeridian. All TEN
// declarations were false. Measured 2026-08-17, each mutant against the full
// 248-check suite in a scratch tree: every one of the ten is CAUGHT, and so are
// the five spherical mutants that were already caught by globe. Fifteen for
// fifteen.
//
// WHAT WENT WRONG IS NOT THAT THE DECLARATIONS WERE WRONG WHEN WRITTEN. They were
// right on the morning they were written. What went wrong is that a declaration
// of the form "the file that would catch this does not exist" is a claim about
// the FILESYSTEM, and nothing in this harness was looking at the filesystem. The
// `known` field is re-tested every run -- that is what promotion is for, and it
// works -- but only against the suites the entry DECLARES, and these entries
// declared `globe`, which cannot see them. So the one sentence in each entry that
// could go stale was the one sentence nothing was checking. There is now a guard,
// assertBlockedFilesAbsent(), which reads every `blocked` path off the disk and
// FAILS if it is present; it is self-tested in both directions like the CRLF one,
// and it would have turned this three-day-old lie into a hard error on day one.
//
// WHAT A FLAT BED AT ORDER 2 CANNOT SEE is still worth stating, because it is why
// globe alone was never enough and why the entries below name a SECOND suite
// rather than a tighter tolerance. Of the five spherical CORRECTNESS mutations on
// the list, one shows on any bed at any order (the geometric source, 2.6e+2 m/s),
// two need RELIEF and second order and are arithmetically identical to the shipped
// code without it, one needs ORDER 1 and is identical at order 2, and one -- the
// naive area -- cannot be caught by a still-water test at any resolution on any
// bed, ever, because the error is a latitude-independent factor that divides out
// of the balance. Two more (rotation) cannot be caught by any FLAT-bed omega = 0
// case, because f is multiplied by nothing there. That was never five tolerances
// to tighten; it was four cases and one identity, and verify-sphere has all five.
//
// THE SPHERE SUITE, AND WHAT IT COSTS. Dropping tools/verify-sphere.mjs whole into
// the ladder would roughly double this harness: 237.2 s pristine, 217-237 s per
// mutant measured, against verify-tide's 260.0 s, and it would be paid by every
// escalating mutant as well as by every spherical one. Worse than the money, a
// mutant that merely SLOWED the solver past 3x would read TIMEOUT, TIMEOUT used to
// count as a detection, and the hole would print as covered -- the exact
// false-CAUGHT hazard documented under runSuite().
//
// Both halves are dealt with, and neither by pretending:
//
//   COST.  The suite is entered as ONE FILTERED INVOCATION, `sphere`, which runs
//          every section except 4 (merian). Section 4 is 185.9 s of the 237.2 s;
//          the other eight sections together are 46.0 s and 192 of the 248 checks.
//          MEASURED, not assumed: all fifteen spherical mutants were run against
//          the full 248 and against the 192, and the filtered invocation catches
//          every one of the fifteen -- same mutants, same verdicts, one fifth of
//          the clock. What the filter drops is a closed-form spherical mode
//          period, which is the one spherical thing globe ALREADY does, so the
//          ladder is not blind to it either. `--sphere-full` runs the whole 248
//          and the banner prints which of the two is in force, because a filtered
//          suite reported under an unfiltered name is how this rot starts.
//   TIMEOUT. A TIMEOUT is no longer scored as a catch. A mutant whose only
//          non-green result is a suite that did not finish lands in its own
//          bucket, prints as `TIMEOUT ONLY (not scored as a catch)`, and FAILS the
//          run -- because a suite that never printed a summary cannot tell you
//          whether a check failed or whether the mutation just made the sim slow.
//          The sphere suite additionally gets a generous per-suite timeout (6x its
//          baseline, floor 300 s) so that a slow mutant is given the chance to go
//          RED honestly instead of being killed into an ambiguity.
//
// BOTH NEW GUARDS WERE BROKEN ON PURPOSE, because this file has no standing to
// ask that of anyone else otherwise. Measured 2026-08-17, and the temporary edits
// were reverted and the file checksummed back to the byte afterwards:
//
//   the `blocked` guard.  A `blocked: 'tools/verify-sphere.mjs'` was added to one
//     entry. The run refused before baselining anything -- "FATAL: 1 mutant(s) are
//     declared blocked on a file that IS PRESENT ... <-- this file exists" -- and
//     exited 2. Pointed at a path that really is absent
//     (tools/verify-sphere-refinement-sweep.mjs) the same run printed "blocked
//     declarations: 1, every named file checked against the disk and still absent"
//     and exited 0. Both directions, which is what makes it a check and not a
//     formality.
//   the TIMEOUT-ONLY bucket.  verify-render and globe were given a 300 ms timeout
//     and SUITE_ORDER cut to those two, so that ramp-lab-crest -- a mutant this
//     harness normally reports CAUGHT with ten named failures -- could produce
//     nothing but kills. It printed "TIMEOUT ONLY (not scored as a catch)", put 0
//     in the `caught` bucket and 1 in the `TIMEOUT ONLY` bucket, and exited 1.
//     The identical situation used to print CAUGHT.
//   the escalation change, in the same pass. With verify-physics alone given a
//     2 s timeout, manning-exponent read TIMEOUT on its declared suite, escalated
//     across the whole ladder because a timeout is no longer treated as a
//     detection, and came back CAUGHT on verify-tide(RED) at 262.0 s -- i.e. the
//     extra runs bought a real answer where the old code would have stopped at
//     the ambiguity and called it a catch.
//
// A MUTATION OF A SUITE, not of the solver, is on the list for the first time:
// merian-eigenvalue replaces n(n+1) with n(n+2) in globe's own closed form. Every
// other entry breaks the subject and asks whether the gate notices; this one
// breaks the GATE and asks whether it was ever pointing outwards. It is the g x
// 1.10 test applied to a target instead of to a constant, and it is the only way
// to find out whether a closed form written beside the code it judges is doing any
// judging. It goes red by 15.2%, and the measured period does not move at all.
//
// THE REPOSITORY IS NEVER WRITTEN TO. Everything happens under os.tmpdir(). Two
// guards, both able to fail: every write asserts its path is inside the scratch
// root, and a SHA-256 of every file in src/ and tools/ is taken before and after
// the run and compared.
//
// ONE MUTANT PATCHES src/globe.mjs, WHICH IS ALSO A SUITE. That is not a mistake
// and it is not circular: the harness copies the whole tree per mutant, so the
// suite that runs is the mutated one, which is exactly what "does this gate
// compare itself against itself" requires. It does mean the `globe` suite is both
// subject and judge for one entry, and that entry's note says so.
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
// RE-MEASURED 2026-08-17, because every other count in this header had drifted
// and this one had no reason to be exempt: all eight CHECK COUNTS are unchanged
// and still sum to 39. The TIMES are lower -- the three cheap cases 1.7 / 16.1 /
// 26.2 s run one at a time, the five expensive ones 42.3 / 59.9 / 119.2 / 191.3 /
// 223.3 s run five at a time -- which is the table above behaving exactly as its
// own caveat says it will, an upper bound measured with eight processes in flight.
// So this is the one count in the file that was still true, and it is now true
// with a date on it.
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
//
// THREE SUITES JOINED THE LIST ON 2026-08-17, and one of them is not in tools/.
// The check counts below are measured BY THIS HARNESS, in the tree this harness
// builds, and that is not always the same number the repository prints. Where it
// differs the difference is stated, because "104 checks" sat in this comment
// while the file carried 115 and nothing in a run contradicted it.
//
//   verify-render   tools/verify-render.mjs, 115 checks, 1.0 s measured alone.
//                   The renderer had NO automated coverage at all before that
//                   file landed: src/render.mjs's exported rampSymmetry() had no
//                   caller anywhere in the tree. It carried 104 checks the day it
//                   was wired up here and this comment went on saying so.
//   globe           src/globe.mjs, 10.1 s. THE COUNT IS NOT WRITTEN DOWN, and
//                   this is the entry that shows why. Two separate reasons:
//                   (a) globe prints a DIFFERENT total here than in the
//                   repository, by construction and not by drift -- its last
//                   block reads index.html for the page defaults, the scratch
//                   tree holds src/ and tools/ only, and globe SKIPs those checks
//                   by name rather than passing them. The stable statement is the
//                   IDENTITY: counted-here + SKIPPED == counted-in-the-repository.
//                   Measured 2026-08-17 17:15, that was 110 + 6 == 116.
//                   (b) src/globe.mjs was being edited by another session while
//                   this paragraph was written -- it grew by 9910 bytes at
//                   17:08 and its scratch total went 108 -> 110 inside one hour.
//                   A total written here would have been wrong before the file
//                   was saved. The run baselines it and prints it; read that.
//                   Its checks live in src/ behind a basename guard rather than
//                   in tools/, which its own header admits and asks to have
//                   moved. They are wired up here in the place they actually are,
//                   because a check in an awkward directory is still a check.
//   sphere          tools/verify-sphere.mjs, FILTERED -- see below. 192 checks in
//                   46.0 s against 248 in 237.2 s for the whole file.
//
// THE SPHERE FILTER, stated where it is applied. `sphere` runs
//   --only metric,lake,mass,coriolis,curvature,periodic,finite,baseline
// i.e. every section except 4, the closed-form Merian oscillation. Measured alone
// on this machine, section by section: metric 0.1 s / 41, lake 23.0 / 52, mass
// 17.8 / 4, MERIAN 185.9 / 45, coriolis 0.3 / 11, curvature 1.5 / 9, periodic
// 2.5 / 8, finite 0.2 / 7, baseline 0.1 / 4. Section 4 is 79% of the clock. What
// justifies dropping it is not that it is expensive but that it is REDUNDANT
// HERE: globe section 8 is a closed-form spherical mode period too, it is on the
// ladder, and it costs 10 s. And the substitution was MEASURED rather than
// argued -- all fifteen spherical mutants were run against the full 248 and
// against the filtered 192, and the verdict is identical on every one.
// `--sphere-full` swaps the filter out; the banner prints which is in force.
//
// A FILTERED SUITE IS STILL A HOLE, on the same terms as the five absent waves
// cases above: a mutation only section 4 could see would read SURVIVED here. The
// difference is that this one has been measured against its own full version once
// and can be re-measured with one flag, which is what makes the claim checkable
// rather than a promise.
//
// `globe` and `sphere` are the only two suites in this list that construct a
// spherical simulation, and until `sphere` was wired in on 2026-08-17 `globe` was
// the only one -- which is what put ten false "declared survivor" entries in the
// table below. Every mutation that lives behind `if (sph)` or inside
// sphericalGeometry() is invisible to the other seven BY CONSTRUCTION, not by
// weakness, and escalation to them is a formality that the runs below nevertheless
// pay for in full, because "survived" is a strong claim and it should cost the
// harness something.
const SPHERE_SECTIONS = 'metric,lake,mass,coriolis,curvature,periodic,finite,baseline';
/** --sphere-full: run tools/verify-sphere.mjs whole. Read here so SUITES is a const. */
const SPHERE_FULL = process.argv.includes('--sphere-full');
const SUITES = {
  'verify-render': { file: 'tools/verify-render.mjs' },
  'verify-physics': { file: 'tools/verify-physics.mjs' },
  'globe': { file: 'src/globe.mjs' },
  'waves:damping': { file: 'tools/waves.mjs', args: ['damping'] },
  'waves:fringingReef': { file: 'tools/waves.mjs', args: ['fringingReef'] },
  'waves:snell': { file: 'tools/waves.mjs', args: ['snell'] },
  // TIMEOUT IS NOT A VERDICT HERE, so this suite is given room to fail honestly.
  // The generic rule -- 3x baseline, floor 90 s -- would give the filtered sphere
  // 138 s, and a mutant that merely made the sim slow would be killed into an
  // ambiguity instead of printing "n FAILURES". Measured, mutated full-suite runs
  // cost 217-237 s against 237.2 s pristine, i.e. a broken metric barely moves the
  // clock; 6x with a 300 s floor is therefore slack that costs nothing on a green
  // run and buys a real answer on a red one.
  'sphere': {
    file: 'tools/verify-sphere.mjs',
    args: SPHERE_FULL ? [] : ['--only', SPHERE_SECTIONS],
    timeoutMul: 6,
    timeoutFloor: 300_000,
  },
  'verify': { file: 'tools/verify.mjs' },
  'verify-tide': { file: 'tools/verify-tide.mjs' },
};
// Cheapest first: escalation walks this order, so a survivor pays for the fast
// suites before it pays for verify-tide. Measured 2026-08-17 on the 16-core
// machine this was extended on, each suite run ALONE and sequentially:
// verify-render 1.0 s, waves:damping 1.7 s, verify-physics 6.9 s, globe 10.1 s,
// waves:fringingReef 16.1 s, waves:snell 26.2 s, sphere 46.0 s, verify 71.5 s,
// verify-tide 260.0 s (and tools/verify-sphere.mjs UNFILTERED, which is not on
// this ladder, 237.2 s). VERIFY-TIDE IS NOT 343.3 s ANY MORE, which is what four
// other comments in this file still said when this list was rewritten: measured
// 260.0 s alone, and 259.2 / 259.6 / 259.9 s in the concurrent baseline of three
// separate full runs. The order below follows those costs; the run re-baselines
// them anyway and prints the table, and the numbers there run slightly high
// because the baseline runs nine suites at once and this list did not.
const SUITE_ORDER = ['verify-render', 'waves:damping', 'verify-physics', 'globe',
  'waves:fringingReef', 'waves:snell', 'sphere', 'verify', 'verify-tide'];

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
    found: '2026-08-17: THIS ANCHOR WAS STALE and the harness was exiting 1 on it. '
      + 'The spherical port (f3d1351) gave the sphere its own Coriolis block -- '
      + 'f = 2 omega sin(phi) plus the metric curvature term -- and turned the Cartesian '
      + 'one into the `else` of it, so `if (this.coriolis) {` stopped existing and this '
      + 'mutant reported ANCHOR-ERROR along with three others. Re-anchored on the else '
      + 'branch. WHAT THAT MEANS FOR THE COVERAGE is the part worth writing down: this '
      + 'mutant now breaks the CARTESIAN rotation only. The spherical Coriolis is a '
      + 'separate block, and a mutant that reads CAUGHT while covering half of what its '
      + 'name says is the more dangerous of the two failure modes. curvature-off and '
      + 'f-constant below are the two halves it no longer reaches',
    suites: ['verify-physics'],
    patches: [{
      file: 'src/swe.mjs',
      find: '    } else if (this.coriolis) {',
      repl: '    } else if (false && this.coriolis) {   // MUTANT: Cartesian Coriolis removed',
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
    found: '2026-08-17: STALE ANCHOR, repaired. The scalar divisors dx and dy in this line '
      + 'became the per-row bedDiv0/bedDiv1 of the spherical port. Zeroing the term still '
      + 'removes exactly the Cartesian bed source and, on a sphere, leaves the geometric '
      + 'source on the line below it alone -- which is the right scope for a mutant named '
      + 'after the bed, and is why this one was not widened to cover both',
    suites: ['verify'],
    patches: [{
      file: 'src/swe.mjs',
      find: '            const term = -G * 0.5 * (hP + hM) * db / (d === 0 ? bedDiv0 : bedDiv1);',
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
      // STALE 2026-08-17 and repaired: the single `const inv = th / dy;` became TWO
      // divisors in the spherical port, because the two cells sharing a zonal face
      // lie in different ROWS and on a sphere different rows have different areas.
      // Zeroing both keeps this mutant's whole point -- mass is still conserved
      // exactly, both sides of the face receiving the same zero -- which zeroing
      // only one of them would destroy, turning a coupling mutant into a mass
      // leak that any volume check would catch for the wrong reason.
      find: L(
        '        const invL = th / dyRowN[j];',
        '        const invR = th / dyRowS[j + 1];',
      ),
      repl: L(
        '        const invL = 0;   // MUTANT: the y sweep contributes nothing',
        '        const invR = 0;',
      ),
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
  // expensive entries in this list: verify-tide is 260.0 s measured alone on
  // this machine (343.3 s when this paragraph was written) against 6.9 s for
  // verify-physics, and there is no cheaper aim to take.
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
      find: '        const s = (u + c) / dxRow[j] + (v + c) / dyCFL[j];',
      repl: '        const s = Math.max((u + c) / dxRow[j], (v + c) / dyCFL[j]);   // MUTANT: 2D CFL sum -> max',
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

  // =========================================================================
  // THE SPHERE, and the suite this file spent three days saying did not exist.
  //
  // Commit f3d1351 put shallow water on a rotating sphere: src/geometry.mjs
  // supplies per-row metric arrays and src/swe.mjs consumes them. Its header
  // names three choices as non-negotiable and records that a FLAT-BED resting
  // ocean cannot see two of them. The mutants that break those three are here,
  // with five more pieces of the port that nothing above reaches at all, the two
  // alternatives the same header declares harmless, three constant-scaling
  // mutants that exist to test each other, and one mutation of a SUITE rather
  // than of the solver.
  //
  // THE STATE OF PLAY, AND THE CORRECTION THAT REPLACED IT.
  //
  // WHAT THIS BLOCK USED TO SAY, verbatim in substance: the spherical solver has
  // exactly ONE gate anywhere in this repository -- section 8 of src/globe.mjs, a
  // closed-form mode period on a FLAT bed at ORDER 2 with omega = 0 -- and
  // tools/verify-sphere.mjs "was specified in detail and measured in advance ...
  // and then never written". TEN entries below were declared survivors on that
  // basis and EIGHT carried `blocked: 'tools/verify-sphere.mjs'`.
  //
  // WHAT IS TRUE, measured 2026-08-17 in a scratch tree: tools/verify-sphere.mjs
  // exists, is 1541 lines, and is green at 248/248 in 237.2 s. It carries every
  // check the ten declarations said was missing and several they did not think to
  // ask for -- an area identity against a locally declared R_REF, per-band sums, a
  // resting lake over relief and over a piercing island at four resolutions and at
  // BOTH orders, f row-by-row against 2*Omega*sin(phi) at tolerance 1e-14, an
  // inertial oscillation measured by the flow itself at two latitudes, a 50 m/s
  // zonal jet at four latitudes with the curvature term isolated, and a
  // rotate-the-planet-and-compare test across the antimeridian. And it carries its
  // own refutations, so its bounds are shown to have teeth.
  //
  // ALL TEN DECLARATIONS WERE FALSE. Every one of the fifteen spherical mutants
  // below is CAUGHT by it -- the ten that were declared survivors and the five
  // globe already caught. The per-mutant numbers are in each `found` note, against
  // the full 248 and against the filtered 192 the ladder actually runs, and each
  // one names WHICH checks fire, because "caught" without "by what" is the exact
  // sentence that rotted here: it is unfalsifiable prose, and the eight `blocked`
  // lines proved that prose in this file does not get re-read.
  //
  // THE FIVE THAT ONE FLAT-BED GATE COULD NOT SEE are still worth naming, because
  // they are why globe alone was never sufficient and why every entry below now
  // declares TWO suites. area-naive-cos is a latitude-independent factor that
  // divides out of any resting balance and needs a metric identity with no
  // simulation in it. geo-hcell-squared and bedphi-Rdphi are arithmetically
  // identical to the shipped code on a flat bed and need RELIEF at order 2.
  // bed-guard-order2 is arithmetically identical at order 2 and needs an order-1
  // run. curvature-off and f-constant and omega-div1.1-alone are exactly zero
  // wherever u = 0 or omega = 0, which is every case globe has. None of that was
  // a tolerance to tighten, and none of it is expensive -- verify-sphere gets all
  // of it for 46 s of the 237 with section 4 filtered out.
  //
  // ONE FINDING BEFORE THE LIST, because it corrects the source file this list is
  // derived from. src/geometry.mjs says the well-balancing identity "hangs on
  // phi_C being the ARITHMETIC mean of the two face latitudes" and names the
  // area-bisecting latitude as the plausible mistake that breaks it. Measured, a
  // resting lake CANNOT see that substitution at all -- 8.2189e-14 m/s against a
  // baseline of 7.7132e-14 -- and the algebra says why: with a = ly_N/A and
  // b = ly_S/A the resting residual is
  //     G/4 [ -2a hP^2 + 2b hM^2 - (hM^2 - hP^2)(a + b) + (a - b)(hP^2 + hM^2) ],
  // which is identically zero in a and b. The cancellation needs geoCoef and
  // bedPhi to be built out of the SAME face lengths and area the flux divisors
  // use, and it does not care what latitude those lengths were evaluated at. phi_C
  // enters only through A (a per-row scale, which cancels), tan(phi) (a force that
  // is zero at rest) and f (zero at omega = 0). What the area-bisecting latitude
  // actually breaks is the METRIC -- the area identity goes to 2.0321e-4 -- which
  // is a different check, and phic-area-bisecting below is caught by a different
  // thing than the header would predict.
  //
  // TWO SETS OF NUMBERS APPEAR IN THE `found` NOTES BELOW, and they are not the
  // same kind of thing. Keeping them apart is the point of this paragraph.
  //
  //   THE SCRATCH PROBE, quoted as "resting ocean at order 2: flat ... uneven ..."
  //   and dated 2026-08-17. A resting ocean, 180 x 90 (2 deg), 400 steps, omega 0,
  //   manning 0, cfl 0.45, over three beds -- flat 4000 m; uneven 1800-2500 m
  //   (three lobes in longitude, two in latitude); the same uneven bed with a cone
  //   that pierces the surface and leaves 4 dry cells -- plus a +-80 deg capped
  //   variant, at BOTH orders, with the area identity against a locally declared
  //   R_REF. It is a SCRATCH INSTRUMENT AND NOT A GATE, it is not in the
  //   repository, and it is what the false declarations were built on. It is kept
  //   because the figures are real and they say how large each effect is, which a
  //   PASS/FAIL line does not. Its baseline, max speed over the grid after 400
  //   steps:
  //
  //     order 2   flat 7.7132e-14   uneven 6.2598e-13   island 6.2598e-13   cap80 1.2030e-12
  //     order 1   flat 6.2601e-14   uneven 1.4033e-13   island 1.4033e-13   cap80 2.0786e-13
  //     area identity at 1 deg  +1.2253e-16 relative      band 30..60 deg  +6.6954e-16
  //
  //   Volume drift is EXACTLY zero in all eight, and |eta| is measured over WET
  //   cells only: a dry cell's surface elevation IS its bed, which stands above
  //   the sea beside an island, and including it would swamp the metric with 211 m
  //   of something that is not an error.
  //
  //   THE SUITE, quoted as "CAUGHT by sphere, n of 248" with the failing check
  //   named and its got/want. That is a shipped gate going red in a scratch copy
  //   of the tree, it is reproducible with one command, and it is the only half of
  //   each note that is EVIDENCE. Where the two disagree about how alarming a
  //   mutation is, the suite wins.
  //
  // THE 248 AND THE 192. Each note gives both: n/248 is the whole of
  // tools/verify-sphere.mjs, n/192 is the filtered invocation the ladder runs
  // (every section but 4, see SUITES). Fifteen mutants were measured both ways in
  // one pass; the verdict agrees on all fifteen, and the counts differ only
  // because section 4 and its eleven baseline rows are absent. Both are recorded
  // so that the claim "the filter loses nothing" is a number somebody can check
  // rather than a decision somebody made.
  //
  // WHAT REPLACED THE OLD ESCALATION EXPERIMENT. This block used to carry a
  // paragraph justifying "survives everything" from a 1391 s run of every known
  // survivor against all eight Cartesian suites -- 124 mutated runs to establish
  // that suites which never construct a spherical simulation cannot see spherical
  // mutations. That is still true and it is no longer load-bearing: there is a
  // spherical suite now, every entry below declares it, and the answer is
  // re-measured on every run at 46 s apiece instead of argued from a dated
  // experiment. The figures that experiment quoted (verify-render 104/104, globe
  // 60/60) have both since gone stale, which is its own argument for measuring
  // rather than quoting.
  // =========================================================================
  {
    id: 'area-naive-cos',
    name: 'cell area -> R^2 cos(phi) dlam dphi',
    breaks: 'the metric itself. Every cell is too big by 1/sinc(dphi/2) -- 1.27e-5 at '
      + '1 degree, 2.0e-4 at 4 -- so every area, every effective divisor and the total '
      + 'surface of the planet are wrong by a fixed factor, and refinement does not '
      + 'rescue it because it is a bias and not a truncation',
    expect: 'NOTHING THAT EXISTS, and this is the one spherical mutation whose blindness '
      + 'was predicted before it was measured. src/geometry.mjs: the naive area is the '
      + 'exact area times a factor INDEPENDENT OF LATITUDE, so it scales dxRow, dyRow and '
      + 'bedPhi up and geoCoef down, the flux divergence and the geometric source move '
      + 'together, and the resting balance holds identically. It is the g x 1.10 disease '
      + 'in new clothes -- a wrong constant that every relative check divides out. What '
      + 'catches it is an AREA IDENTITY against an independently declared radius, a check '
      + 'with no simulation in it at all. That check now exists -- verify-sphere section '
      + '1b -- and the prediction that nothing else would catch it is exactly right',
    review: 'not on any reviewer\'s list. Measured in the session that wrote the sphere, '
      + 'and recorded there as surviving every resting test at every resolution on every '
      + 'bed',
    found: '2026-08-17, re-measured, and the prediction holds exactly. Resting ocean at '
      + 'order 2: flat 9.2272e-14 (baseline 7.7132e-14), uneven 5.6952e-13 (6.2598e-13), '
      + 'island 5.6952e-13, cap80 1.1671e-12 (1.2030e-12) -- three of the four AT OR '
      + 'BELOW their own baseline, which is the signature of a mutation that is not '
      + 'perturbing the balance but rescaling both sides of it. Order 1 the same. Where '
      + 'it shows is the area identity, and it shows enormously: the sum of cell areas '
      + 'against 4 pi R_REF^2 goes +1.2253e-16 -> +1.2693e-5 at 1 degree, with the '
      + '30..60 deg band at the same +1.2693e-5 -- ELEVEN ORDERS of margin, a check that '
      + 'would need no tolerance argument at all, only a comparison. globe GREEN, every '
      + 'Cartesian suite green on escalation. '
      + 'CAUGHT BY sphere, 42 of 248 (30 of 192 filtered), and this entry was a DECLARED '
      + 'SURVIVOR blocked on a file that already existed -- see the block header. WHICH '
      + 'CHECKS: section 1b, the area identity against a locally declared R_REF, at every '
      + 'resolution -- "whole sphere at 6 deg got 5.1030e+14 want 5.1006e+14 rel 0.045707% '
      + 'tol 1.00e-12%", and the same at 4/3/2/1 deg down to 0.001269%, plus the three '
      + 'capped variants; section 1c, the per-band sums, "band 30..60 deg" at 0.001269% '
      + 'against a 1e-11% tolerance; two identity lines in 1f (geoCoef == -tan(phi_C)/4R '
      + 'and bedPhi == 2R tan(dphi/2), both to 2.03e-4 against limits of 1e-13 and 1e-14); '
      + 'and 28 rows of the section 9 baseline, which records the area residual and its '
      + 'round-off bound. NOT ONE resting-lake line fires, at either order, on any of the '
      + 'four beds -- which is the prediction above, confirmed by a shipped gate rather '
      + 'than by a scratch probe. Nine to ten orders of margin on every failing line: this '
      + 'is the cheapest check on the list and it needs no tolerance argument, only a '
      + 'comparison',
    suites: ['globe', 'sphere'],
    patches: [{
      file: 'src/geometry.mjs',
      find: '    let A = 2 * R * R * dlam * cosLat(pC) * Math.sin(half);',
      repl: '    let A = R * R * dlam * cosLat(pC) * (pN - pS);   // MUTANT: naive area = exact / sinc(dphi/2)',
    }],
  },
  {
    id: 'geo-hcell-squared',
    name: 'geometric source on 2 h_cell^2, not h_N^2 + h_S^2',
    breaks: 'the well-balanced form of the spherical curvature source. The two agree '
      + 'EXACTLY wherever the reconstructed face depths are equal -- every flat bed, and '
      + 'every first-order run anywhere -- and over a slope they differ by the square of '
      + 'the reconstruction. What is left is a persistent along-slope current on every '
      + 'shelf break and seamount flank and nowhere else, which src/geometry.mjs calls '
      + 'the hardest artefact here to disbelieve, because a slope current at the shelf '
      + 'break is what the real ocean has',
    expect: 'a spherical lake at rest over an UNEVEN bed at ORDER 2. Nothing else can '
      + 'see it, and not because of tolerances: elsewhere the mutant is the shipped '
      + 'expression bit for bit',
    review: 'measured in the sphere session at 7.463e-2 m/s on the uneven bed and on the '
      + 'island, against 6.7e-13 clean, and at 7.713e-14 -- unchanged -- on the flat bed',
    found: '2026-08-17: the blindness is confirmed and it is two-sided, which is SHARPER '
      + 'than the note it came from. Order 2: flat 7.7132e-14, identical to baseline to '
      + 'every digit; uneven 3.2027e-4; cap80 1.6473e-3; island 1.0086e-1 m/s with '
      + '0.5067 m of spurious surface. ORDER 1: 1.4032e-13 on the uneven bed against a '
      + 'baseline of 1.4033e-13 -- INERT, because at first order sE and sB are zero, so '
      + 'hP = hM = h[k] and hP^2 + hM^2 IS 2 h[k]^2. So this mutation needs an uneven bed '
      + 'AND second order, and the order-1 run that bed-guard-order2 requires would '
      + 'report it clean. globe GREEN: its only spherical case is an aquaplanet of '
      + 'uniform 4000 m depth, where the difference is the square of a 1 m mode amplitude '
      + 'against 2h^2 = 3.2e7, about 1e-8 relative, which no 1% tolerance can see. '
      + 'CAUGHT BY sphere, 36 of 248 (36 of 192 filtered) -- a declared survivor blocked '
      + 'on a file that already existed. WHICH CHECKS: section 2b, the resting lake, and '
      + 'ONLY on the beds with relief, exactly as predicted -- "uneven 6deg: max speed got '
      + '0.203569 limit 2.2370e-10", "piercing 6deg: max |eta| got 8.551786 limit '
      + '9.2764e-11", the same pairs at 4, 3 and 2 deg down to 0.0229 m/s -- plus 18 rows '
      + 'of the section 9 baseline carrying those same cases. The FLAT-bed lines stay '
      + 'GREEN at every resolution and so does every ORDER 1 line, which is the two-sided '
      + 'blindness the probe measured, now confirmed by a shipped gate rather than by a '
      + 'scratch script: at first order sE and sB are zero, hP = hM = h[k], and '
      + 'hP^2 + hM^2 IS 2 h[k]^2. That is why this mutant and bed-guard-order2 need '
      + 'OPPOSITE orders, and why a suite has to run both rather than pick one',
    suites: ['globe', 'sphere'],
    patches: [{
      file: 'src/swe.mjs',
      find: '              if (sph) rhv[k] += gc * G * (hP * hP + hM * hM);',
      repl: '              if (sph) rhv[k] += gc * G * 2 * h[k] * h[k];   // MUTANT: cell-centred h^2',
    }],
  },
  {
    id: 'geo-source-deleted',
    name: 'the spherical geometric source removed entirely',
    breaks: 'the curvature term that absorbs the leftover of a hydrostatic pressure that '
      + 'does not cancel, because a cell\'s north and south faces have different lengths. '
      + 'The leftover is not small: at h = 4000 m and 45 degrees it is 12.3 m/s^2, larger '
      + 'than g, and the whole ocean drains to the equator in minutes',
    expect: 'anything spherical at all, on any bed, at any order. This is the one '
      + 'spherical mutation a flat bed catches, and the reason a flat-bed gate looked '
      + 'sufficient for a while',
    review: 'measured in the sphere session at 3.088e+02 m/s on all three beds',
    found: '2026-08-17: 2.5990e+2 m/s on the FLAT bed at order 2 with 7.3e+3 m of '
      + 'spurious elevation, 2.0340e+2 uneven, 4.5040e+1 capped, and the same again at '
      + 'order 1 (2.4608e+2 flat). CAUGHT by globe, 5 checks: the mode period comes back '
      + 'NaN at both 6 and 4 degrees against a closed form of 82512.836103 s, and both '
      + 'sign checks fall with it. ALSO CAUGHT BY sphere, and this is the calibration '
      + 'line for the whole spherical block -- 121 of 248 (69 of 192 filtered), the '
      + 'largest count on the list after ycoef-single-divisor, because a mutation that '
      + 'shows on ANY bed at ANY order shows in nearly every section at once: "flat 6deg: '
      + 'max speed got 586.493520 limit 1.4996e-10", 42252 m of spurious elevation on the '
      + 'flat bed, volume drift NaN on the uneven one, and 40 baseline rows behind them. '
      + 'A mutant caught by 121 checks and one caught by 3 are both CAUGHT; the count is '
      + 'the only thing that says which of the two the suite is aimed at. Volume drift '
      + 'stays at 1e-16 in the SCRATCH PROBE throughout, which is the '
      + 'part worth noticing -- the mutant conserves mass perfectly while destroying the '
      + 'momentum balance, so a conservation check on its own would have passed it',
    suites: ['globe', 'sphere'],
    patches: [{
      file: 'src/swe.mjs',
      find: '              if (sph) rhv[k] += gc * G * (hP * hP + hM * hM);',
      repl: '              if (false) rhv[k] += gc * G * (hP * hP + hM * hM);   // MUTANT: geometric source deleted',
    }],
  },
  {
    id: 'bedphi-Rdphi',
    name: 'bedPhi 2A/(ly_N + ly_S) -> R dphi',
    breaks: 'the meridional divisor of the CENTRED BED TERM. R dphi is the obvious thing '
      + 'to write and it is the true meridional cell height; it is still wrong, because '
      + 'the two pressure fluxes this term has to cancel against are weighted by ly_N and '
      + 'ly_S, so the bed term must be divided by their mean and not by the arc it spans. '
      + 'The two agree only where ly_N = ly_S, which is the equator and nowhere else',
    expect: 'a spherical lake at rest over an UNEVEN bed at ORDER 2, exactly as '
      + 'geo-hcell-squared: with no bed slope there is no bed term to mis-divide',
    review: 'measured in the sphere session at 5.877e-03 uneven and 1.302e-02 island '
      + 'against a flat bed at 7.713e-14, unchanged to every digit',
    found: '2026-08-17: 4.6646e-4 m/s uneven, 4.0013e-3 capped, 9.0574e-3 island with '
      + '0.0599 m of spurious surface, against a flat bed at 7.7132e-14 which is the '
      + 'baseline to every digit. Smaller than the sphere session\'s figures because this '
      + 'probe\'s bed is smoother, not because the mutation is weaker: it scales with '
      + 'relief, which is the point. AND IT IS INERT AT ORDER 1 -- 1.4033e-13 against a '
      + 'baseline of 1.4033e-13 -- because at first order sB = 0, so db = 0 and the term '
      + 'this divisor divides is identically zero. bedphi-Rdphi and bed-guard-order2 '
      + 'therefore need OPPOSITE orders, and a suite that ran only one of the two would '
      + 'declare the metric verified while blind to the other. globe GREEN. '
      + 'CAUGHT BY sphere, 37 of 248 (37 of 192 filtered) -- a declared survivor blocked '
      + 'on a file that already existed. WHICH CHECKS, and the first one is a surprise '
      + 'worth keeping: the sharpest line is not in the lake at all, it is the METRIC '
      + 'identity, section 1f, "bedPhi == 2 R tan(dphi/2), every interior row -- got '
      + '4.0619e-4 limit 1.0000e-14", i.e. a closed-form statement about the divisor with '
      + 'no simulation in it and ten orders of margin. R dphi and 2 R tan(dphi/2) differ '
      + 'in the third term of the tangent series, which is the whole mutation, and a '
      + 'still grid can see it. The other 36 are the ones the note above predicted: '
      + 'section 2b over relief, "uneven 6deg: max speed got 0.074581", "piercing 6deg: '
      + 'max |eta| got 2.280334", down to 0.0071 m/s at 3 deg, plus 18 baseline rows. '
      + 'FLAT stays green and ORDER 1 stays green, as predicted -- at first order sB = 0 '
      + 'and the term this divisor divides is identically zero',
    suites: ['globe', 'sphere'],
    patches: [{
      file: 'src/geometry.mjs',
      find: '    g.bedPhi[j] = (g.lyN[j] + g.lyS[j]) > 0 ? 2 * A / (g.lyN[j] + g.lyS[j]) : Infinity;',
      repl: '    g.bedPhi[j] = R * dphi;   // MUTANT: the true cell height, which is not the right divisor',
    }],
  },
  {
    id: 'bed-guard-order2',
    name: "the bed/geo guard reverts to 'order >= 2'",
    breaks: 'nothing whatever at second order, and everything at first. On a sphere the '
      + 'centred bed block must run at EVERY order, because the geometric source lives '
      + 'inside it and that source is not zero when the slopes are: at order 1, hP = hM = '
      + 'h and -(tan phi / 4R) G 2h^2 is 3.1e-3 m/s^2 at 45 degrees, i.e. 268 m/s per '
      + 'day. Deleting `|| sph` is the single most plausible way to get this port wrong, '
      + 'because the Cartesian guard it restores is CORRECT in Cartesian and the comment '
      + 'beside it explains why',
    expect: 'an ORDER 1 spherical run, and nothing else anywhere. At order 2 the patched '
      + 'condition is the same condition',
    review: 'measured in the sphere session as passing at order 2 and 2.799e+02 m/s at '
      + 'ORDER 1 -- the only line in that table whose verdict depends on the order',
    found: '2026-08-17: at order 2 it reproduces the baseline to every digit on all four '
      + 'cases (7.7132e-14 flat, 6.2598e-13 uneven, 1.2030e-12 cap80, 6.2598e-13 island). '
      + 'So it is not merely undetected at order 2, it is INERT there, and no tolerance '
      + 'could ever catch it. At ORDER 1: 2.4608e+2 m/s flat, 1.9181e+2 uneven, 3.7908e+1 '
      + 'capped, 6.2e+3 m of spurious elevation -- the same catastrophe as '
      + 'geo-source-deleted, which is exactly what it becomes at first order. globe '
      + 'GREEN, because measureModePeriod defaults to order 2 and section 8 never asks '
      + 'for anything else. '
      + 'CAUGHT BY sphere, and it is the NARROWEST catch in the whole spherical block: 4 '
      + 'of 248, 4 of 192, and all four are the SAME CASE seen twice -- "uneven 2deg '
      + 'order1: max speed got 309.562100 limit 8.0216e-11" and "max |eta| got '
      + '8515.222514" in section 2, and the two matching rows in the section 9 baseline, '
      + 'where the recorded value is 3.0630e-13 and the ratio is 1.0e+15. Section 2 runs '
      + 'ONE order-1 case out of its whole matrix, and that one case is the entire margin '
      + 'between this mutant being caught and this mutant being invisible. Two things '
      + 'follow and both are worth writing down: the declaration that used to sit here -- '
      + '"the gate that catches this is one extra ARGUMENT, not one extra idea" -- was '
      + 'exactly right, and it was also already implemented; and a suite that dropped its '
      + 'single order-1 row for being redundant would silently give this mutant back, '
      + 'which is what a 4-of-248 catch is warning about',
    suites: ['globe', 'sphere'],
    patches: [{
      file: 'src/swe.mjs',
      find: '    if (this.order >= 2 || sph) {',
      repl: '    if (this.order >= 2) {   // MUTANT: the spherical half of the guard deleted',
    }],
  },
  {
    id: 'phic-area-bisecting',
    name: 'phi_C -> asin((sin phi_N + sin phi_S)/2)',
    breaks: 'the cell-centre latitude, replacing the arithmetic mean of the two face '
      + 'latitudes with the AREA-BISECTING latitude -- the one that halves the cell. It '
      + 'looks more principled, and src/geometry.mjs names it by name as the plausible '
      + 'mistake',
    expect: 'src/geometry.mjs says this breaks the well-balancing identity. IT DOES NOT, '
      + 'and the measurement below is a correction to that file rather than a result '
      + 'about it. The cancellation holds for ANY phi_C, because geoCoef and bedPhi are '
      + 'built out of the same face lengths and area the flux divisors use; the algebra '
      + 'is written out in the block header above. phi_C enters the resting state only '
      + 'through A, which cancels. What it does break is the METRIC, so the check that '
      + 'ought to catch it is the area identity -- and specifically the PER-BAND one, '
      + 'because the error is not a constant factor',
    review: 'not measured by anyone before this. It is on the list because '
      + 'src/geometry.mjs singles it out',
    found: '2026-08-17, and it changed the story twice. Resting ocean: 8.2189e-14 flat, '
      + '7.2599e-13 uneven, 1.1051e-12 capped, 7.2599e-13 island -- all at baseline, so '
      + 'the lake at rest is blind to it. The metric is where it shows: the area identity '
      + 'goes to +2.0321e-4 at 1 degree, 16x the naive-area error, and the 30..60 deg '
      + 'band reads +4.1774e-5, DIFFERENT from the total -- which is the signature of a '
      + 'metric mis-distributed by row rather than wrong by a factor, and the reason both '
      + 'checks were specified. CAUGHT by globe, 4 checks, and WHICH four is the '
      + 'interesting part: two are the renderer agreeing with the metric ("row centres '
      + 'agree with geometry.mjs phiC", worst 0.6212 deg; "sampled point is inside the '
      + 'chosen cell (latitude)", worst 2.1212 deg against a half-cell of 1.5) and two '
      + 'are the merian SIGN checks ("n = 2 at 6 deg is LATE, not early" at +0.9055%, and '
      + '+0.4542% at 4 deg). The 1% MAGNITUDE tolerance did not fire: 0.9055% came within '
      + '9% of its own tolerance and stayed green. So this is caught by a check on the '
      + 'SIGN of a discretisation error -- which has margin where a tolerance does not -- '
      + 'and by two consistency checks in a renderer that has no business being the '
      + 'metric\'s gate. Both were luck rather than design. THE CHECK THAT WAS DESIGNED '
      + 'FOR IT EXISTS, and it fires: sphere goes RED at 55 of 248 (37 of 192 filtered), '
      + 'and the four sharpest lines are all closed-form statements about the grid with no '
      + 'simulation in them -- "phi_C is the arithmetic mean of its two face latitudes got '
      + '0.014454 limit 1.0000e-16", "ly_S + ly_N == 2 R dlam cos(phi_C) cos(half) got '
      + '0.028864 limit 1e-15", "geoCoef == -tan(phi_C)/(4R) got 6.0954e-4", "bedPhi == '
      + '2 R tan(dphi/2) got 0.413783". Then the area identity at 0.485758% and the '
      + 'per-band sums DIFFERING from the total, which is the mis-distributed-by-row '
      + 'signature this entry predicted, and five f rows off by 0.015230% against a '
      + 'tolerance of 1e-12%. Note what still does NOT fire: not one resting-lake line, at '
      + 'either order, on any bed. The correction this entry makes to src/geometry.mjs -- '
      + 'that the well-balancing identity survives ANY phi_C -- is confirmed by a shipped '
      + 'gate that had every opportunity to contradict it',
    suites: ['globe', 'sphere'],
    patches: [{
      file: 'src/geometry.mjs',
      find: '    const pC = 0.5 * (pS + pN);                // ARITHMETIC mean; see the header',
      repl: '    const pC = Math.asin(0.5 * (Math.sin(pS) + Math.sin(pN)));   // MUTANT: area-bisecting latitude',
    }],
  },
  {
    id: 'ycoef-single-divisor',
    name: 'the two rows across a latitude face share one area',
    breaks: 'exact mass conservation across a latitude face. The face is ONE length '
      + 'shared by two cells and each must divide the same flux*length by its OWN area; '
      + 'handing the receiving cell the donor\'s divisor is the plausible simplification, '
      + 'because it is what Cartesian does, where the two areas are equal. On a sphere '
      + 'they differ by cos(phi + dphi)/cos(phi), which is a factor 3 between the last '
      + 'two rows at 6 degrees',
    expect: 'any spherical volume check, or the mode period once the mode has leaked '
      + 'mass. Note that this mutation is INVISIBLE AT REST, where every fyM is zero and '
      + 'there is nothing to divide -- so it is the one spherical mutation on this list '
      + 'that the missing lake-at-rest gate would ALSO have missed',
    review: 'not measured by anyone before this',
    found: '2026-08-17: catastrophic and, unusually for this list, catastrophic on the '
      + 'flat bed too -- 2.6145e+2 m/s at order 2 with volume drift +1.350e-2, i.e. the '
      + 'ocean gains 1.35% of its own mass in 400 steps (+1.299e-1, thirteen percent, in '
      + 'the capped run). Order 1 the same. CAUGHT by globe, 2 checks, and by the '
      + 'MAGNITUDE checks rather than the sign ones this time: n = 2 at 4 deg reads '
      + '79335.313729 s against 82512.836103 (3.850%) and n = 3 at 6 deg reads '
      + '51233.985350 against 58345.385944 (12.18%). The n = 2 check at 6 deg stayed '
      + 'GREEN, which is worth recording: the coarsest resolution is the one that missed '
      + 'it, so a gate that ran only the cheapest case would have reported this clean. '
      + 'ALSO CAUGHT BY sphere, 140 of 248 (83 of 192 filtered) -- the largest count on '
      + 'the list, and the entry that disproves the `expect` line above. "Invisible at '
      + 'rest" was wrong, and wrong for an instructive reason: 400 steps of a lake that is '
      + 'only ALMOST at rest is enough for a non-conservative divisor to feed on its own '
      + 'round-off, so section 2 reports "flat 6deg: max speed got 157.985231 limit '
      + '1.4996e-10" and "flat 6deg: volume drift got 0.230470 limit 5.5446e-14" -- the '
      + 'FLAT bed, at rest, gaining 23% of its own mass. The prediction was made from the '
      + 'algebra of a single step and the measurement is over four hundred of them',
    suites: ['globe', 'sphere'],
    patches: [{
      file: 'src/swe.mjs',
      find: '        const invR = th / dyRowS[j + 1];',
      repl: '        const invR = invL;   // MUTANT: the receiving row divides by the donor row area',
    }],
  },
  {
    id: 'curvature-off',
    name: 'metric curvature u tan(phi)/R dropped from the effective f',
    breaks: 'the metric half of the rotation term. src/swe.mjs makes the case against '
      + 'itself better than a mutant can: the term "is easy to omit and nearly impossible '
      + 'to catch afterwards -- it is exactly zero at rest, it is 1.5e-3 of f at 45 '
      + 'degrees so an inertial-oscillation check cannot see it, and it is absent from '
      + 'any zonal-strip test. Only advection over a pole, or a long high-latitude jet, '
      + 'notices"',
    expect: 'a spherical case with a sustained ZONAL velocity at high latitude. There is '
      + 'exactly one, and it was written for this: tools/verify-sphere.mjs section 6, a '
      + '50 m/s zonal flow evaluated at 45, 59, 83 and 85 degrees, plus a jet integrated '
      + 'for 64 steps. Every OTHER spherical case in the tree is a zonally symmetric '
      + 'P_n(sin lat) mode, where u is zero by symmetry for the whole run and this term '
      + 'is exactly zero',
    review: 'not measured by anyone before this. It is on the list because the source '
      + 'file predicts its own blind spot in writing, and a prediction like that deserves '
      + 'to be tested rather than admired',
    found: '2026-08-17: byte-for-byte inert on every RESTING case measured. All eight '
      + 'resting-ocean figures reproduce the baseline exactly (7.7132e-14 / 6.2598e-13 / '
      + '1.2030e-12 / 6.2598e-13 at order 2, and the order-1 four likewise) and globe is '
      + 'GREEN. The source file\'s prediction about what CANNOT see it is exactly right, '
      + 'including the reason. '
      + 'CAUGHT BY sphere, 6 of 248 (6 of 192 filtered) -- a declared survivor whose '
      + 'declaration named a file that already contained the case it was asking for. '
      + 'WHICH CHECKS: all six are section 6, and nothing else in 248 moves. The '
      + 'decisive line quotes the blind spot back at the mutant: "curvature / f at 45 deg '
      + 'for a 1 m/s current -- got -8.1930e-10 want 0.001500 rel 100.000055% tol 5% ... '
      + 'an inertial-oscillation check with a 1% tolerance cannot see this". Then the '
      + 'jet: "f_eff at 85 deg, 50 m/s zonal got 1.4529e-4 want 2.3499e-4 rel 38.17% tol '
      + '0.1% -- curvature is 61.7% of f here", 30.63% at 83 deg, 9.46% at 59, 7.07% at '
      + '45; and the integrated version, "accumulated turn at 83 deg over 64 steps got '
      + '0.063342 want 0.091439 rel 30.73% tol 2%". THE SHAPE OF THE FIX IS THE LESSON: '
      + 'the term is 1.5e-3 of f at 1 m/s and 45 deg, so no tolerance was ever going to '
      + 'reach it -- what reached it was choosing a latitude and a speed where the term '
      + 'is 61.7% of f, i.e. a CASE and not a threshold, exactly as the declaration said',
    suites: ['globe', 'sphere'],
    patches: [{
      file: 'src/swe.mjs',
      find: '          const fe = f0 + U[k] * tR;',
      repl: '          const fe = f0;   // MUTANT: metric curvature term dropped',
    }],
  },
  {
    id: 'f-constant',
    name: 'f-plane: f taken at mid-domain, beta = 0',
    breaks: 'the variation of the Coriolis parameter with latitude. f = 2 omega sin(phi) '
      + 'becomes 2 omega sin((lat0 + lat1)/2), which on a full pole-to-pole sphere is '
      + 'f = 0 EVERYWHERE: no beta effect, no Rossby waves, no western intensification, '
      + 'and no rotation at all outside a capped band',
    expect: 'any spherical case with omega != 0 that measures something. globe has none -- '
      + 'its only spherical run is the aquaplanet mode period at omega = 0, and its only '
      + 'non-zero omega is in a label check that asserts the string "Coriolis ON" is '
      + 'present and never looks at the number. tools/verify-sphere.mjs sections 5 and 6 '
      + 'have five: f row by row, an inertial oscillation measured by the flow at two '
      + 'latitudes, and the zonal-jet family',
    review: 'not measured by anyone before this',
    found: '2026-08-17: inert on every RESTING case, for the stated reason -- omega is 0 '
      + 'in every spherical case globe runs, and 2*0*sin(anything) is 0 either way. All '
      + 'eight resting figures identical to baseline and globe GREEN. '
      + 'CAUGHT BY sphere, 14 of 248 (14 of 192 filtered) -- a declared survivor whose '
      + 'declaration asked for "one rotating spherical run" that was already written. '
      + 'WHICH CHECKS: five in section 5a, f row by row against 2*Omega_REF*sin(phi) at a '
      + 'tolerance of 1e-12% -- "row 0 (lat -59) got 0 want -1.2501e-4 rel 100%" -- which '
      + 'is the beta effect deleted and read off directly with no simulation involved; '
      + 'two in 5c, the inertial oscillation MEASURED BY THE FLOW ITSELF, "f measured at '
      + '20 deg by the flow itself got 2.8563e-9 want 4.9881e-5"; one more in 5c that is '
      + 'the sharpest of the set, "ratio of the two rates == sin(phi_B)/sin(phi_A) got '
      + '4.756409 want 2.532089 ... predicted with no free parameter", i.e. a check on '
      + 'the SHAPE of f(phi) that no constant error can satisfy; and six in section 6 as '
      + 'collateral, because f_eff is built on f. This mutant was always a measurement of '
      + 'the CASE LIST rather than of the solver, and what it now reports is that the '
      + 'case list has a rotating sphere in it',
    suites: ['globe', 'sphere'],
    patches: [{
      file: 'src/geometry.mjs',
      find: '    g.fRow[j] = 2 * omega * Math.sin(pC);',
      repl: '    g.fRow[j] = 2 * omega * Math.sin(0.5 * (p0 + p1));   // MUTANT: f-plane at mid-domain',
    }],
  },
  {
    id: 'lon-wrap-reflect',
    name: 'longitude stops being periodic: the wrap becomes a wall',
    breaks: 'the topology. src/swe.mjs is explicit that on a sphere longitude "WRAPS -- '
      + 'it is not a boundary, it is the same water"; the mutant makes east and west '
      + 'reflecting, so the planet becomes a bounded strip 360 degrees wide with two '
      + 'invisible glass walls down the same meridian. Every zonally propagating wave now '
      + 'bounces instead of returning, which is the difference between a Kelvin wave '
      + 'circling the globe and a seiche in a very long tank',
    expect: 'any spherical case with zonal structure or zonal flow. There is none, and '
      + 'that is what this mutant is on the list to say out loud: the only spherical case '
      + 'anywhere is a P_n(sin lat) mode, which is zonally SYMMETRIC by construction, so '
      + 'every cell in a row holds the same value and a wall between two identical cells '
      + 'transports the same nothing a wrap does',
    review: 'not measured by anyone before this. Added because the periodic longitude is '
      + 'one of the port\'s headline claims and nothing was pointed at it',
    found: '2026-08-17: SURVIVES everything, measured under full escalation. Resting '
      + 'ocean at order 2: 7.7132e-14 flat (baseline 7.7132e-14), 6.0099e-13 uneven '
      + '(6.2598e-13), 1.1609e-12 capped (1.2030e-12), 6.0099e-13 island; order 1 '
      + 'identical to baseline on all four, and every Cartesian suite GREEN under full '
      + 'escalation together with globe. Worth noting that the numbers DO move in the '
      + 'thirteenth digit rather '
      + 'than being byte-identical -- the ghost cells really are different, so the '
      + 'arithmetic really is different -- so this was never an inert mutation reported '
      + 'as a survivor. It is a live topological change, and it WAS unmeasured. AND THIS '
      + 'IS THE MUTANT THAT FOUND THE EXIT HANG: the first escalation of it printed '
      + '"CAUGHT, detected by verify-render(TIMEOUT)", which was false in a way worth '
      + 'remembering -- tools/verify-render.mjs had run every one of its checks (104 of '
      + 'them that day, 115 now), printed ALL PASS, and then failed to terminate. See the '
      + 'TIMEOUT paragraph at the top of this file. '
      + 'CAUGHT BY sphere, 9 of 248 (9 of 192 filtered) -- a declared survivor blocked on '
      + 'a file that already existed. WHICH CHECKS: the two that are ABOUT the topology '
      + 'are section 7b, rotate the whole planet by a whole number of cells and compare -- '
      + '"4 deg grid, rotated 23 cells (92 deg, across the antimeridian): 90x45, 200 '
      + 'steps, max |dh| = 4.8496e-4, max |d(hu,hv)| = 9.2550e-2" against a shipped '
      + 'residual at round-off, and "3.6 deg grid, rotated 23 cells: max |dh| / h got '
      + '8.4809e-10 limit 1.0000e-11". That is a cheaper and stronger instrument than the '
      + 'travelling wave the declaration asked for: it needs no closed form and no transit '
      + 'time, only the fact that a sphere has no preferred meridian. The other seven are '
      + 'sections 5c and 6 as collateral -- the jet cases have zonal flow, so a wall in '
      + 'the way of it moves the answer -- which is the same sentence the declaration '
      + 'wrote about curvature-off, from the other end',
    suites: ['globe', 'sphere'],
    patches: [{
      file: 'src/swe.mjs',
      find: '      ? { west: periodic, east: periodic, south: reflect, north: reflect }',
      repl: '      ? { west: reflect, east: reflect, south: reflect, north: reflect }   // MUTANT: the wrap is a wall',
    }],
  },
  {
    id: 'merian-eigenvalue',
    name: "the SUITE's own closed form: n(n+1) -> n(n+2)",
    breaks: 'nothing in the solver. This mutant breaks THE TARGET and not the subject, '
      + 'and it is the only one in this file that does. The spherical Laplacian '
      + 'eigenvalue -n(n+1)/R^2 is what turns a measured period into a prediction; '
      + 'n(n+2) moves the closed form by sqrt(8/6) = 1.1547 for n = 2 and leaves the '
      + 'solver untouched',
    expect: 'globe section 8 must go RED. If it stayed green the "gate" would be '
      + 'comparing the solver against itself and the 22.9202 h in the on-screen label '
      + 'would be decoration. This is the g x 1.10 test applied to a suite instead of to '
      + 'a constant, and it is the only way to find out whether measureModePeriod\'s '
      + 'refusal to import G buys anything',
    review: 'not measured by anyone before this. It exists because a closed-form gate '
      + 'that cannot fail is the exact defect this whole harness was built after',
    found: '2026-08-17: CAUGHT by globe, 5 checks, and the numbers say the gate is genuinely '
      + 'external. The MEASURED period does not move -- 82331.848650 s at 6 deg, '
      + '82430.283373 at 4, the same values the unmutated run produces -- while the '
      + 'target moves to 71458.212204 s, leaving 15.2168% and 15.3545% against a 1% '
      + 'tolerance, and both sign checks fall with them. A circular gate would have '
      + 'printed ALL PASS here: the measurement and the prediction would have moved '
      + 'together, exactly as they did for g in the original review',
    // `sphere` is deliberately NOT declared here, and this is the one spherical
    // entry where that is true. tools/verify-sphere.mjs does not import
    // src/globe.mjs at all, so it would be GREEN by construction rather than by
    // blindness, and a blind-spot row that was arranged in advance teaches
    // nothing. verify-sphere has its OWN closed form for the same oscillation --
    // mutating that one would be a separate entry, and a worthwhile one.
    suites: ['globe'],
    patches: [{
      file: 'src/globe.mjs',
      find: '  const closed = 2 * Math.PI * R / Math.sqrt(gRef * H * n * (n + 1));',
      repl: '  const closed = 2 * Math.PI * R / Math.sqrt(gRef * H * n * (n + 2));   // MUTANT: wrong eigenvalue',
    }],
  },
  {
    id: 'R-x1.1-alone',
    name: 'planetary radius 10% high',
    breaks: 'the scale of everything -- every area, face length and divisor, the '
      + 'timestep, and every wave transit time. Applied INSIDE sphericalGeometry so that '
      + 'a caller passing R explicitly is fooled too: mutating the exported R_EARTH '
      + 'default would be inert, because every spherical case in the tree passes its own '
      + 'radius, and an inert mutant that reads CAUGHT-by-nothing teaches nothing',
    expect: 'globe section 8: the closed form is built from the R the CALLER declared '
      + 'while the solver runs on 1.1 R, so the measured period must come out about 10% '
      + 'long against a 1% tolerance. This is one of the two controls for the pair below',
    review: 'not measured by anyone before this',
    found: '2026-08-17: CAUGHT by globe -- 90565.418278 s against 82512.836103 (9.7592%) '
      + 'at 6 deg and 9.8903% at 4 deg, plus the sign checks. Slightly under 10% because '
      + 'the discretisation error is negative and partly cancels it, which is itself '
      + 'evidence the two effects are being measured separately rather than fitted. Also '
      + 'CAUGHT by sphere, 70 of 248 (37 of 192 filtered), and by a completely different '
      + 'route: the area identity, "whole sphere at 6 deg got 6.1718e+14 want 5.1006e+14 '
      + 'rel 21.000000% tol 1.00e-12%", at every resolution. R is SQUARED there, so a 10% '
      + 'error is exactly 21%, and the check needs no wave and no clock. That the two '
      + 'suites catch the same mutant through a transit time and through a surface area '
      + 'is the useful part: neither is a re-implementation of the other',
    suites: ['globe', 'sphere'],
    patches: [
      {
        file: 'src/geometry.mjs',
        find: '  nx, ny, R = R_EARTH, lat0 = -90, lat1 = 90, ng = 2, omega = 0,',
        repl: '  nx, ny, R: R_IN = R_EARTH, lat0 = -90, lat1 = 90, ng = 2, omega: OM_IN = 0,',
      },
      {
        file: 'src/geometry.mjs',
        find: L(
          '  const H = ny + 2 * ng;',
          "  const g = blank('sphere', nx, ny, ng, H);",
          '  const dlam = 2 * Math.PI / nx;',
        ),
        repl: L(
          '  const H = ny + 2 * ng;',
          "  const g = blank('sphere', nx, ny, ng, H);",
          '  const R = R_IN * 1.1, omega = OM_IN;   // MUTANT: radius 10% high',
          '  const dlam = 2 * Math.PI / nx;',
        ),
      },
    ],
  },
  {
    id: 'omega-div1.1-alone',
    name: 'rotation rate 10% low',
    breaks: 'f everywhere, by 9.09%. On its own that is a large error in the only force '
      + 'that makes an ocean circulate',
    expect: 'a spherical case with omega != 0 that measures something -- the same case '
      + 'f-constant needs. This is the other control for the pair below, and the reason '
      + 'both controls are on the list: if omega alone were not catchable either, then '
      + 'the pair surviving would say nothing about the a*omega degeneracy and everything '
      + 'about a missing case',
    review: 'not measured by anyone before this',
    found: '2026-08-17: globe GREEN -- nothing globe runs multiplies by omega on a sphere '
      + 'and then checks the answer, so the constant could be off by any factor at all '
      + 'and globe would stay green. '
      + 'CAUGHT BY sphere, 13 of 248 (13 of 192 filtered) -- a declared survivor blocked '
      + 'on a file that already existed. WHICH CHECKS: five rows of section 5a, f against '
      + '2*Omega_REF*sin(phi) row by row, every one off by exactly 9.090909% (which is '
      + '1 - 1/1.1, i.e. the mutation read straight off a still grid at a tolerance of '
      + '1e-12%); two in 5c, the inertial oscillation measured by the FLOW -- "f measured '
      + 'at 60 deg by the flow itself got 1.1416e-4 want 1.2630e-4 rel 9.612063% tol '
      + '1.5%" -- which is the one that matters, because it is the solver turning and not '
      + 'a constant being read back; and six in section 6 as collateral. THE DECLARATION '
      + 'THAT USED TO SIT HERE said the repository could see neither the VALUE of omega '
      + 'nor its LATITUDE DEPENDENCE and that one geostrophic case would close both '
      + 'entries at once. Both halves are now measured, and by two DIFFERENT instruments: '
      + 'this entry is caught by the value (a uniform 9.09%) and f-constant by the shape '
      + '(the ratio check at 87.85%), which is what stops the pair below from hiding',
    suites: ['globe', 'sphere'],
    patches: [
      {
        file: 'src/geometry.mjs',
        find: '  nx, ny, R = R_EARTH, lat0 = -90, lat1 = 90, ng = 2, omega = 0,',
        repl: '  nx, ny, R: R_IN = R_EARTH, lat0 = -90, lat1 = 90, ng = 2, omega: OM_IN = 0,',
      },
      {
        file: 'src/geometry.mjs',
        find: L(
          '  const H = ny + 2 * ng;',
          "  const g = blank('sphere', nx, ny, ng, H);",
          '  const dlam = 2 * Math.PI / nx;',
        ),
        repl: L(
          '  const H = ny + 2 * ng;',
          "  const g = blank('sphere', nx, ny, ng, H);",
          '  const R = R_IN, omega = OM_IN / 1.1;   // MUTANT: rotation 10% low',
          '  const dlam = 2 * Math.PI / nx;',
        ),
      },
    ],
  },
  {
    id: 'R-and-omega-paired',
    name: 'radius x1.1 AND rotation /1.1 together',
    breaks: 'both scales at once, in the combination that hides. Geostrophy, the Rossby '
      + 'radius, the Rossby number and the beta parameter all reach the answer through '
      + 'the PRODUCT a*omega or through groupings of it, so a compensating pair can leave '
      + 'a whole class of rotating measurements exactly where it found them while both '
      + 'constants are wrong. Two mutations that are each catchable can be uncatchable '
      + 'together, and that is a property of the QUESTION a suite asks rather than of its '
      + 'tolerances',
    expect: 'either outcome is worth having in writing. If the pair survives while each '
      + 'half is caught, the suite is measuring a rotating balance and the degeneracy is '
      + 'real. If the pair is caught, then whatever catches it is NOT a geostrophic '
      + 'measurement -- it is something that sees a and omega separately, which for a '
      + 'non-rotating gravity-wave period means it sees a alone',
    review: 'not measured by anyone before this',
    found: '2026-08-17, and the answer changed once a rotating suite was pointed at it. '
      + 'AGAINST globe: CAUGHT by the second branch above, and therefore vacuously -- '
      + '90565.418278 s against 82512.836103, 9.7592% at 6 deg and 9.8903% at 4, numbers '
      + 'IDENTICAL to R-x1.1-alone digit for digit, because globe runs at omega = 0 and '
      + 'the omega half of this pair is literally inert in it. Caught by the radius alone. '
      + 'AGAINST sphere: CAUGHT at 77 of 248 (44 of 192 filtered), and the SEVEN-CHECK '
      + 'DIFFERENCE from R-x1.1-alone is the whole result. Diffed line by line: the pair '
      + 'fails everything R-alone fails, plus exactly seven more, and all seven are the '
      + 'omega half -- five rows of "f = 2 Omega sin(phi)" at 9.090909% and the two '
      + 'inertial-oscillation rates measured by the flow ("f measured at 60 deg by the '
      + 'flow itself got 1.1428e-4 want 1.2630e-4"). Nothing R-alone fails is repaired by '
      + 'the pairing. SO THE DEGENERACY IS REAL AND IT IS NOT WHAT SAVES THIS MUTANT: the '
      + 'two constants are caught SEPARATELY, by an area identity that sees a alone and '
      + 'an f identity that sees omega alone, and a compensating pair cannot hide from '
      + 'two checks that never form the product. That is a stronger property than a '
      + 'geostrophic-balance test would have, because a geostrophic test IS the thing '
      + 'a*omega hides in. What is still absent is a check whose answer depends on the '
      + 'product -- a Rossby radius, a western-boundary width -- and the honest statement '
      + 'is that this mutant no longer probes the degeneracy at all; it probes two '
      + 'independent constants',
    suites: ['globe', 'sphere'],
    patches: [
      {
        file: 'src/geometry.mjs',
        find: '  nx, ny, R = R_EARTH, lat0 = -90, lat1 = 90, ng = 2, omega = 0,',
        repl: '  nx, ny, R: R_IN = R_EARTH, lat0 = -90, lat1 = 90, ng = 2, omega: OM_IN = 0,',
      },
      {
        file: 'src/geometry.mjs',
        find: L(
          '  const H = ny + 2 * ng;',
          "  const g = blank('sphere', nx, ny, ng, H);",
          '  const dlam = 2 * Math.PI / nx;',
        ),
        repl: L(
          '  const H = ny + 2 * ng;',
          "  const g = blank('sphere', nx, ny, ng, H);",
          '  const R = R_IN * 1.1, omega = OM_IN / 1.1;   // MUTANT: a*omega preserved, both wrong',
          '  const dlam = 2 * Math.PI / nx;',
        ),
      },
    ],
  },
  {
    id: 'cosLat-plain-cos',
    name: 'cosLat() -> Math.cos(p)',
    breaks: 'the exactness of a pole face, and nothing else. Math.cos(Math.PI/2) is '
      + '6.123e-17 rather than 0, because pi/2 is not representable, so a face that '
      + 'should not exist gets a length of 2.7e-11 m and a pressure flux crosses it. '
      + 'src/geometry.mjs records that this drove the resting residual to 2.8e-10 m/s^2 '
      + 'at 1 degree, GROWING with refinement, and worst at exactly the row nobody would '
      + 'look at',
    expect: 'declared a CONDITIONING regression rather than a correctness bug, so the '
      + 'honest expectation used to be that it survives. It is on the list because the '
      + 'header quotes a specific number -- 2.8e-10, three hundred times the gate of the '
      + 'day -- and a number like that should have a mutant standing next to it. What '
      + 'actually catches it is not a conditioning threshold at all: it is an EXACTNESS '
      + 'claim about the pole face, verify-sphere section 1d, which asserts the length is '
      + 'zero rather than small and needs no tolerance to do it',
    review: 'the sphere session measured it SURVIVING all three resting beds: 7.532e-14 '
      + 'flat, 7.503e-13 uneven, 6.040e-13 island, against 7.713e-14 / 6.689e-13 / '
      + '5.311e-13 clean',
    found: '2026-08-17: the SOLVER is blind to it and at 2 degrees it is not even a '
      + 'regression. Order 2: '
      + '7.5315e-14 flat (baseline 7.7132e-14 -- BELOW it), 7.3897e-13 uneven (6.2598e-13 '
      + '-- 1.18x), 1.0795e-12 capped (1.2030e-12 -- below), 7.3897e-13 island. Order 1 '
      + 'the same picture. The area identity does not move at all (1.2253e-16, unchanged), '
      + 'which is the useful part: the mutation is a pole-row effect and the pole rows '
      + 'contribute almost no area, so a global metric check cannot see it either. globe '
      + 'GREEN. '
      + 'AND YET CAUGHT BY sphere, 3 of 248 (3 of 192 filtered) -- the joint-narrowest '
      + 'catch on the list, and the one that best shows what kind of check reaches a '
      + 'conditioning bug. All three are section 1d, and NONE of them runs a simulation: '
      + '"south pole face length === 0 (not merely small) -- lyS[first interior] = '
      + '3.40436277491709e-11, Math.cos would give 3.4044e-11 m", the north-pole twin, '
      + 'and "every row beyond a pole is closed on both faces -- 4 ghost rows, all lyN '
      + 'and lyS === 0". The declaration that used to sit here was right that no '
      + 'THRESHOLD could reach this -- the residual moves by less than a factor of two -- '
      + 'and wrong that no check could: an EXACTNESS claim (=== 0, not < eps) has '
      + 'infinite margin by construction, and 3.4e-11 m is not zero. It is the same move '
      + 'as a sign check having margin where a magnitude tolerance does not. NOTE what '
      + 'this still does NOT settle -- the sphere header\'s 2.8e-10 figure was measured at '
      + '1 DEGREE and described as GROWING with refinement, and nothing here tests a '
      + 'trend. The refinement sweep is still unwritten and is still the only instrument '
      + 'that would confirm or refute that claim',
    // NOT `blocked`, then or now: nobody ever specified a gate for this one, and
    // padding that count would have cheapened it -- which is the opposite mistake
    // from the eight entries in this block that named a file and were wrong about
    // it. If a sweep is ever written, this is the shape it needs -- residual
    // against dphi at 4, 2, 1 and 0.5 deg, asserting the trend does not GROW --
    // because the claim in src/geometry.mjs is about refinement and a single
    // resolution cannot test it. The exactness check above does not test it either.
    suites: ['globe', 'sphere'],
    patches: [{
      file: 'src/geometry.mjs',
      find: '  return co <= 0 ? 0 : Math.sin(co);',
      repl: '  return Math.cos(p);   // MUTANT: 6.1e-17 at the pole instead of an exact zero',
    }],
  },
  {
    id: 'geocoef-via-tan',
    name: 'geoCoef from tan(phi) instead of the face lengths',
    breaks: 'nothing algebraically -- (ly_N - ly_S)/A and -tan(phi_C)/R are the SAME '
      + 'number, by the identity in src/geometry.mjs\'s header -- and something '
      + 'numerically: the flux and the source stop sharing operands and meet through two '
      + 'different transcendentals instead',
    expect: 'declared a CONDITIONING regression, not a correctness bug, and therefore '
      + 'expected to survive. This entry exists so that the declaration is TESTED every '
      + 'run rather than asserted once. If it ever starts being caught, either somebody '
      + 'tightened a gate to rounding level or the identity stopped holding, and both are '
      + 'things somebody should be told about. Somebody did: see `found`',
    review: 'the sphere session measured an ISOLATED algebraic probe 22-87x worse and '
      + 'growing under refinement, then measured the same substitution THROUGH THE SOLVER '
      + 'at a flat 2.2-3.0x: 2.96e-13 vs 6.62e-13 at 4 deg, 3.65e-13 vs 9.60e-13 at 1 '
      + 'deg, 3.43e-13 vs 1.02e-12 at 0.5 deg. The standalone probe exaggerated the gap, '
      + 'which is exactly why this is a declared survivor and not a gate',
    found: '2026-08-17: SURVIVES, with the largest conditioning penalty of any mutant on '
      + 'this list and still fourteen orders below anything that matters. Order 2: '
      + '1.2589e-12 flat against a baseline of 7.7132e-14 -- 16x, the biggest ratio here '
      + '-- 1.0297e-12 uneven (1.6x), 1.1688e-12 capped (0.97x, i.e. no penalty at all), '
      + '1.0297e-12 island. Order 1: 9.8079e-13 flat against 6.2601e-14, again 16x. So '
      + 'the ratio depends on the case and not just on the resolution, which is one more '
      + 'reason to declare rather than gate: a threshold tuned on the flat bed would be '
      + 'loose on the uneven one and vice versa. globe GREEN, area identity '
      + 'unchanged at 1.2253e-16. '
      + 'CAUGHT BY sphere, 6 of 248 (6 of 192 filtered), and by the one part of that '
      + 'suite that is NOT verification: all six are section 9, the CHECKED-IN BASELINE, '
      + 'and nothing else in 248 moves. "baseline flat 2deg: max speed got 1.2589e-12 '
      + 'want 7.7132e-14 ratio 16.322 band 0.25 .. 4", the same at 3 and 4 deg, and three '
      + '"max |eta|" rows where the recorded value is EXACTLY 0 and the mutant produces '
      + '2.7285e-12, so the comparison is exact-or-not rather than a ratio. THAT IS THE '
      + 'HONEST READING AND IT IS NOT "the gate got tighter": section 9 says of itself '
      + 'that it can only report "unchanged", never "right", and it pins these residuals '
      + 'by ORDER OF MAGNITUDE (a factor of 4 either way) precisely so that a Math-library '
      + 'change does not fire it. A 16x conditioning penalty walks straight through a 4x '
      + 'band. So this entry is no longer a declared survivor -- but what caught it is a '
      + 'REGRESSION line, not a physics one, and the argument against gating the '
      + 'conditioning directly still stands unchanged: a threshold on 1e-12 against '
      + '1e-14 would be a threshold on the last bits of a double. The refinement TREND is '
      + 'still the only instrument that would settle whether the tan form is worse in '
      + 'kind rather than worse on this machine, and it is still unwritten',
    // NOT `blocked`, then or now: no gate was ever specified for it, so there was
    // no filename to name. The instrument that would judge it HONESTLY is still
    // the refinement trend rather than a threshold at one resolution -- what
    // caught it is a baseline row, which is a different claim.
    suites: ['globe', 'sphere'],
    patches: [{
      file: 'src/geometry.mjs',
      find: '    g.geoCoef[j] = (g.lyN[j] - g.lyS[j]) / (4 * A);',
      repl: '    g.geoCoef[j] = -Math.tan(pC) / (4 * R);   // MUTANT: the same number through two transcendentals',
    }],
  },

  // =========================================================================
  // THE RENDERER. It had no automated coverage at all until 2026-08-17:
  // src/render.mjs exported rampSymmetry() and NOTHING in the tree called it, so
  // every colour figure in its header was reproducible by hand and by nothing
  // else. tools/verify-render.mjs carried 104 checks the day it landed and carries
  // 115 as this was rewritten, which is why the count is no longer repeated in the
  // entries below: the run prints it. These two mutants
  // are here to find out whether those checks can fail. The first is the control that
  // suite's own author broke to prove it; the second attacks a claim in
  // src/render.mjs that the same author reports is misattributed.
  // =========================================================================
  {
    id: 'ramp-lab-crest',
    name: 'LAB_CREST b* 44 -> 45',
    breaks: 'one unit of b* at the crest end of the colour ramp -- a single byte in a '
      + 'single pixel at full scale. It is the smallest change that can be made to the '
      + 'ramp and still be a change, which is what makes it the right control: a suite '
      + 'that cannot see this is pinning nothing',
    expect: 'tools/verify-render.mjs, which claims ten independent failures for exactly '
      + 'this mutation. globe is declared as well, and is expected to stay GREEN: its '
      + 'colour path calls the same exported surfaceColour and compares byte-for-byte '
      + 'against it, so it moves with the ramp by construction. That blind spot is the '
      + 'reason it is declared -- an intentional circularity should be visible in the '
      + 'blind-spots table rather than described in a comment',
    review: 'the suite\'s author measured it in a copy of the tree, against the 104-check version of that file: 94/104 for b* 45, '
      + '86/104 for L* 84, 86/104 for crest = msl -- i.e. 10, 18 and 18 failures. Those are that agent\'s numbers; this '
      + 'harness re-measures the first of them every run, and the FAILURE COUNT is the half that stays comparable now that the denominator has moved to 115',
    found: '2026-08-17: CAUGHT, and the author\'s count reproduces EXACTLY -- 10 failures, '
      + '10 failures of the 104 checks it then had, from one unit of b*. The three '
      + 'sharpest lines: the exact-ramp '
      + 'asymmetry about msl reads 1.1945e-4 against a target of 1.1740e-4; the 8-bit '
      + 'asymmetry 0.464215 against 0.441000; and "the coarse sweep understates the 8-bit '
      + 'worst case" fires because the two readings TIE at 0.4642, which is a check '
      + 'written to notice exactly that. globe GREEN as predicted, so the blind '
      + 'spot is confirmed rather than assumed',
    suites: ['verify-render', 'globe'],
    patches: [{
      file: 'src/render.mjs',
      find: 'const LAB_CREST = [86, 6, 44];',
      repl: 'const LAB_CREST = [86, 6, 45];   // MUTANT: one unit of b*',
    }],
  },
  {
    id: 'ramp-even-length',
    name: 'RAMP_N 1025 -> 1024',
    breaks: 'the odd entry count, so there is no LUT entry at t = 0 and mean sea level '
      + 'falls half a bin off the midpoint. src/render.mjs calls the odd count '
      + '"load-bearing" and quotes 0.304 RGB units of step at msl and 6.45e-2 L* of '
      + 'asymmetry for an even ramp',
    expect: 'a DISPUTED claim, which is why it is on the list. The verify-render author '
      + 'reports that the header\'s two figures reproduce only under the naive index '
      + 'mapping the ramp does NOT use, and that under the shipped symmetric indexing an '
      + 'even count gives a step of exactly 0 and an asymmetry of 1.1713e-4 against the '
      + 'shipped 1.1737e-4 -- i.e. there are two independent defences and the header '
      + 'credits the wrong one. What an even count does cost is L*(msl): 52.9687 instead '
      + 'of 53.0009. So this mutant asks whether the suite pins the quantity that '
      + 'actually moves, rather than the one the comment talks about',
    review: 'not measured by anyone before this',
    found: '2026-08-17: CAUGHT by both, and the author\'s correction is vindicated. '
      + 'verify-render 6 failures of the 104 checks it then had -- 7 of 115 when the run '
      + 'that rewrote this note re-measured it, the extra one being "...and that step is '
      + 'the figure this suite quotes" -- and the two decisive '
      + 'lines are the ones about the mean '
      + 'level -- "L*(msl) is the L* the ramp was declared with", 52.968655 against '
      + '53.000000, and "L*(msl) is the midpoint of the two endpoints", the same figure. '
      + 'The msl STEP is not what fires; the asymmetry lines that do fire read 0.495494 '
      + 'and 0.485676 against 0.441000 and 0.404500, nowhere near the 6.45e-2 the header '
      + 'attributes to this cause. globe also goes red -- 1 check when this note was '
      + 'written, 2 in the run that rewrote it -- by a route worth '
      + 'recording: its baked byte table stops matching live surfaceColour() over a '
      + '20001-point sweep by exactly 1 byte, because an even ramp shifts which half-bin '
      + 'a sampled t lands in. That is a self-consistency check catching a real defect by '
      + 'accident, which is worth having but is not coverage',
    suites: ['verify-render', 'globe'],
    patches: [{
      file: 'src/render.mjs',
      find: 'const RAMP_N = 1025;',
      repl: 'const RAMP_N = 1024;   // MUTANT: even ramp, no entry at mean sea level',
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

  // THE `blocked` PREDICATE, asserted in both directions, for the same reason the
  // CRLF pair above is. A guard that answered "absent" to everything would let the
  // exact rot it exists to stop walk straight past it, and a guard that answered
  // "PRESENT" to everything would make the harness unrunnable in a way somebody
  // would fix by deleting the guard. So: a file that is certainly here must read
  // PRESENT, and a file that certainly is not must read absent.
  if (blockedFileState('tools/mutants.mjs') !== 'PRESENT') {
    console.error('FATAL: blockedFileState() cannot see tools/mutants.mjs, which is the file '
      + 'it is running out of. It would answer "absent" to every `blocked` declaration in this '
      + 'list, which is precisely the failure it exists to catch. Refusing to run.');
    process.exit(2);
  }
  if (blockedFileState('tools/no-such-suite-8f3a1c.mjs') !== 'absent') {
    console.error('FATAL: blockedFileState() reports a file that does not exist as PRESENT. '
      + 'Every `blocked` declaration is about to be flagged stale. Refusing to run.');
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// THE `blocked` GUARD -- the check that would have caught this file's own lie.
//
// A `blocked: 'tools/verify-sphere.mjs'` line says "the gate that would catch this
// mutation has not been written yet". That is not a claim about the solver and it
// is not a claim about a suite: it is a claim about the FILESYSTEM, and it is the
// only kind of claim in this file that nothing was re-testing. `known` is re-tested
// every run against the suites the entry declares -- but an entry blocked on a
// missing file declares, by construction, only the suites that CANNOT see it, so a
// green run confirmed the declaration forever.
//
// It duly went stale. tools/verify-sphere.mjs landed, green at 248/248, carrying
// exactly the checks eight entries here said were missing; this header went on
// printing "blocked on a suite that does not exist" for three days, and the
// harness exited 0 every time. Ten declared survivors were false and the
// instrument said so in a heading.
//
// One line of fs.existsSync closes it. It is a check that can fail, it is proven
// able to fail in selfTest() above, and it is loud: a `blocked` path that is
// PRESENT is a hard error before a single suite runs, because the cheapest moment
// to learn that a gate now exists is before spending twenty minutes measuring
// against the assumption that it does not.
// ---------------------------------------------------------------------------

/** 'PRESENT' or 'absent' for a repository-relative path. The whole of the guard. */
const blockedFileState = (rel) => (fs.existsSync(path.join(REPO, rel)) ? 'PRESENT' : 'absent');

/**
 * Every `blocked` path must be absent. Returns the offenders; the caller decides.
 * `blocked` is a bare repository-relative path and nothing else -- no prose, no
 * parenthetical -- precisely so that this function can be one existsSync.
 */
function blockedFilesThatExist(mutants) {
  return mutants.filter((m) => m.blocked && blockedFileState(m.blocked) === 'PRESENT')
    .map((m) => ({ id: m.id, file: m.blocked }));
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
      // HUNG AT EXIT is not the same thing as HUNG, and telling them apart is the
      // difference between a verdict and a coin toss.
      //
      // Measured 2026-08-17: tools/verify-render.mjs intermittently fails to
      // TERMINATE after finishing. Sequentially, one process at a time, on an
      // otherwise ordinary tree: 18 runs, 16 of them 1.0 s, two of them still alive
      // when killed -- and both of those had already written all 14583 bytes of
      // their output, including the line "ALL PASS -- 104/104 checks". Every check
      // ran, every check passed, and the process would not exit. (That quote is the
      // line those runs actually printed, and it is left as printed:
      // tools/verify-render.mjs carried 104 checks that morning and carries 115
      // now. The fix here does not depend on the number -- it depends on there
      // being a summary line at all.)
      //
      // Under the old classification that read as TIMEOUT, TIMEOUT counts as a
      // detection, and the harness printed "lon-wrap-reflect ... CAUGHT, detected by
      // verify-render(TIMEOUT)" for a mutation of the spherical longitude wrap that
      // tools/verify-render.mjs cannot reach: it never builds a spherical sim. A
      // spurious CAUGHT is the worst failure this harness has, worse than a
      // spurious survivor, because it makes a real hole read as covered.
      //
      // So the summary line decides. If the suite printed a complete summary, it
      // finished: believe the summary and record the non-termination as an anomaly.
      // If it did not, it really did hang and TIMEOUT stands. That distinction
      // cannot hide a detection -- a mutation that stalls the checks themselves
      // prints no summary, and one that makes them fail prints "n FAILURES" and is
      // still RED.
      const hungAtExit = timedOut && m !== null;
      let status;
      if (hungAtExit) status = fails > 0 ? 'RED' : 'GREEN';
      else if (timedOut) status = 'TIMEOUT';
      else if (m === null) status = 'CRASH';
      else if (fails > 0 || code !== 0) status = 'RED';
      else status = 'GREEN';
      resolve({ status, hungAtExit, fails, total, ms, code, failLines, stderr: err.trim(), stdout: out });
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
  // runs, and verify-tide is 260.0 s measured alone on the 16-core machine this
  // was last checked on against 6.9 s for verify-physics. At six workers the
  // verify-tide jobs need a second wave and the run costs an extra four minutes
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
  console.log(`  sphere: tools/verify-sphere.mjs ${SPHERE_FULL
    ? 'WHOLE (--sphere-full): every section, 248 checks, 237.2 s measured alone'
    : `FILTERED: --only ${SPHERE_SECTIONS} -- section 4 (merian, 79% of the clock) is NOT run`}`);

  // THE `blocked` GUARD, before anything expensive. A declaration that a gate does
  // not exist is re-tested against the disk on every run; see blockedFilesThatExist.
  const nBlocked = selected.filter((m) => m.blocked).length;
  const liars = blockedFilesThatExist(selected);
  if (liars.length) {
    console.log('');
    console.error(`  FATAL: ${liars.length} mutant(s) are declared blocked on a file that IS PRESENT:`);
    for (const l of liars) console.error(`     ${pad(l.id, 24)} blocked on ${l.file}   <-- this file exists`);
    console.error('  A `blocked` declaration is a claim about the filesystem, and it has stopped');
    console.error('  being true. Wire that suite into SUITES and SUITE_ORDER, declare it on each');
    console.error('  entry above, RE-MEASURE, and rewrite the declarations from what the run says.');
    console.error('  Do not delete the field: this happened once already, with');
    console.error('  tools/verify-sphere.mjs, and ten entries were false for three days because');
    console.error('  nothing looked. Refusing to run.');
    return 2;
  }
  console.log(`  blocked declarations: ${nBlocked}`
    + (nBlocked
      ? `, every named file checked against the disk and still absent`
      : ' -- no entry claims to be waiting on a file that has not been written'));

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
      // 3x the measured baseline, floor 90 s, unless the suite overrides both.
      // A mutant that changes the step count enough to triple a suite's runtime
      // is not going to be green either way; the cap exists because a NaN can
      // drive dt to zero and hang the run forever instead of failing.
      //
      // THE OVERRIDE EXISTS BECAUSE A TIMEOUT IS AN AMBIGUITY, not a verdict. A
      // killed suite printed no summary, so it cannot say whether a check failed
      // or whether the mutation merely made the simulation slow; the accounting
      // below refuses to score it as a catch, and this is the other half of the
      // same decision -- give the expensive suite enough room to reach its own
      // summary line, so that the honest answer is available at all. See SUITES.
      const mul = SUITES[s].timeoutMul ?? 3;
      const floor = SUITES[s].timeoutFloor ?? 90_000;
      timeout[s] = Math.max(floor, mul * r.ms);
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
  // on the 16-core machine this was written on: verify-tide 260.0 s run alone,
  // against verify-physics 6.9 s, so a single verify-tide job that starts last
  // adds four minutes to the run for nothing.
  phase1.sort((a, b) => (base[b.s]?.ms ?? 0) - (base[a.s]?.ms ?? 0));
  console.log(`\n  -- running ${phase1.length} suite runs (declared) ------------------------------\n`);
  await pool(phase1, jobs, async ({ m, s, escalated }) => {
    const st = state.get(m.id);
    const r = await runSuite(st.dir, s, timeout[s]);
    r.escalated = escalated;
    st.results[s] = r;
    console.log(`     ${pad(m.id, 22)} ${pad(s, 16)} ${pad(r.status, 8)} ${secs(r.ms)}`);
  });

  // A DETECTION IS NOT ALWAYS A CATCH, and keeping the two words apart is the
  // whole of the anti-false-CAUGHT machinery.
  //
  //   detected   some suite came back anything but GREEN.
  //   scored     some suite came back RED (a check failed and said which) or
  //              CRASH (the suite threw, and the stderr is printed). Both are
  //              evidence about the MUTATION.
  //   timeoutOnly  detected, but only by a suite that never printed a summary.
  //              That is evidence about the CLOCK. A killed process cannot tell
  //              you whether a check failed or whether the mutation made the
  //              simulation slow, and scoring it as a catch makes a hole read as
  //              covered -- which is the worst thing this file can print. It gets
  //              its own bucket, its own verdict string, and it fails the run.
  //              (A suite that printed its summary and then would not EXIT is a
  //              different animal and is already handled in runSuite(): the
  //              summary is believed and the non-termination is logged as an
  //              anomaly about the suite.)
  const resultsOf = (m) => Object.values(state.get(m.id).results);
  const detected = (m) => resultsOf(m).some((r) => r.status !== 'GREEN');
  const scored = (m) => resultsOf(m).some((r) => r.status === 'RED' || r.status === 'CRASH');
  const timeoutOnly = (m) => detected(m) && !scored(m);
  // KNOWN SURVIVORS ARE NOT ESCALATED. Escalation exists to decide whether
  // "survived" is true before the harness says it, and for these six that
  // question has already been answered -- by the reviewer, against every suite,
  // which is where the declaration comes from. Re-running six mutants against
  // verify-tide every time would add most of ten minutes to prove a sentence
  // that is already written down. What they DO still get is their declared
  // suites, every run, so that a stale declaration is caught.
  //
  // ESCALATION IS GATED ON `scored`, NOT ON `detected`. A mutant whose declared
  // suite only TIMED OUT has told the harness nothing about itself, so it is
  // escalated like a survivor: the point of the extra runs is to find a suite
  // that goes RED and says which check, which is exactly what the timeout failed
  // to produce.
  const phase2 = [];
  for (const m of selected) {
    const st = state.get(m.id);
    if (st.error || m.known || scored(m)) continue;
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
    const hit = !st.error && scored(m);
    const slow = !st.error && timeoutOnly(m);
    const verdict = st.error ? 'ANCHOR-ERROR'
      : m.known ? (hit ? 'KNOWN -> CAUGHT (declaration stale)'
        : slow ? 'KNOWN, but a suite TIMED OUT (inconclusive)' : 'KNOWN SURVIVOR')
        : (hit ? 'CAUGHT' : slow ? 'TIMEOUT ONLY (not scored as a catch)' : 'SURVIVED');
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
      if (r.hungAtExit) {
        console.log('        NOTE  this suite printed its complete summary and then failed to');
        console.log('              TERMINATE; it was killed at the timeout. The verdict above is');
        console.log('              the summary it printed, not the kill. See runSuite().');
      }
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
  let survivors = 0, errors = 0, promoted = 0, slowReal = 0, slowKnown = 0;
  const realMutants = selected.filter((m) => !m.known);
  realMutants.forEach((m, i) => {
    const st = state.get(m.id);
    let by, verdict;
    if (st.error) { by = '-- not applied --'; verdict = 'ANCHOR-ERROR'; errors++; }
    else {
      const hits = hitsFor(m);
      by = hits.length ? hits.join(' ') : 'nothing';
      if (scored(m)) verdict = 'CAUGHT';
      else if (timeoutOnly(m)) { verdict = 'TIMEOUT ONLY'; slowReal++; }
      else { verdict = 'SURVIVED'; survivors++; }
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
        if (scored(m)) { verdict = `NO -- caught by ${hits.join(' ')}`; promoted++; }
        else if (timeoutOnly(m)) { verdict = `UNKNOWN -- ${hits.join(' ')} never finished`; slowKnown++; }
        else verdict = 'yes';
      }
      console.log(`  ${String(i + 1).padStart(2)}  ${pad(m.id, 22)} ${pad(ran, 40)} ${verdict}`);
    });
    console.log('\n  why each one gets through -- read these as a to-do list for the suites:\n');
    for (const m of knowns) { console.log(`  [${m.id}]`); field('', m.known); }

    // ---- BLOCKED ON A GATE THAT HAS NOT BEEN WRITTEN --------------------
    //
    // A known survivor whose reason is "nothing measured can tell it apart" and
    // a known survivor whose reason is "the file that would catch it has not
    // been written" are the same row in the table above and NOT the same fact,
    // and the second kind can be closed by somebody in an afternoon. It also has
    // a failure mode the first kind does not: the declaration stays true forever
    // by default, because nothing is trying to make it false.
    //
    // THAT FAILURE MODE HAPPENED, and this block is the thing that printed the
    // lie. Eight entries carried `blocked: 'tools/verify-sphere.mjs'`, the
    // heading here read "blocked on a suite that does not exist", the file had
    // landed green at 248/248, and the harness exited 0 every time for three
    // days. The field is now checked against the disk before any suite runs (see
    // blockedFilesThatExist), the banner prints the count even when it is zero,
    // and the ELSE branch below prints a line when there are none -- because a
    // block that prints nothing is a block nobody can tell has rotted.
    //
    // The rule for the field: `blocked` is a bare repository-relative path to a
    // file that MUST NOT EXIST. The moment it does, the run refuses. If what is
    // missing is a SECTION of a file that already exists, this is the wrong
    // field -- say it in `known` and declare the suite anyway, so that the claim
    // is re-measured every run rather than asserted once.
    const blocked = knowns.filter((m) => m.blocked && !state.get(m.id).error
      && hitsFor(m).length === 0);
    if (blocked.length) {
      const files = [...new Set(blocked.map((m) => m.blocked))].sort();
      console.log('\n  -- blocked on a gate that has not been written ----------------------\n');
      const isAre = blocked.length === 1 ? 'is' : 'are';
      console.log(`  ${blocked.length} of the known survivors above ${isAre} not waiting on a NEW IDEA, or on a`);
      console.log(`  tolerance. ${blocked.length === 1 ? 'It is' : 'They are'} waiting on a FILE: ${files.join(', ')}.`);
      console.log('  Every one of those paths was checked against the disk before this run started');
      console.log('  and was ABSENT; if any of them appears, the next run REFUSES TO START rather');
      console.log('  than reprinting this heading. What every RUN re-measures is the declared suite');
      console.log('  beside each one, which is what makes a stale declaration fail loudly. This');
      console.log('  kind of hole is the cheapest on the list:\n');
      for (const m of blocked) {
        console.log(`     ${pad(m.id, 24)} blocked on ${m.blocked}`);
        if (m.needs) field('', `the check it is waiting for: ${m.needs}`);
      }
      console.log('\n  Until those exist, a green run from this harness says nothing whatever about');
      console.log('  what those entries are about. Read their `known` text, not this heading.');
    } else {
      console.log('\n  No known survivor is blocked on a file that has not been written. Every one');
      console.log('  of them is a statement about what the suites in SUITE_ORDER CANNOT SEE, and');
      console.log('  that statement is re-measured against the declared suites on every run. This');
      console.log('  line is PRINTED rather than omitted: for three days eight entries claimed to');
      console.log('  be waiting on tools/verify-sphere.mjs while that file sat in the tree green at');
      console.log('  248/248, and an absent block is exactly what that looked like from here.');
    }
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
  const nCaught = realMutants.length - survivors - slowReal - nErrReal;
  const nStillKnown = knowns.length - promoted - slowKnown - nErrKnown;
  console.log('\n\n=== counts ===========================================================\n');
  const row = (n, label, text) => console.log(`  ${String(n).padStart(3)}  ${pad(label, 17)}${text}`);
  row(selected.length, 'MUTANTS RUN',
    `against ${usedSuites.length} declared suite${usedSuites.length === 1 ? '' : 's'}, ${jobs} at a time`);
  row(nCaught, 'caught', 'a shipped suite went RED (named checks failed) or CRASHed');
  row(survivors, 'SURVIVED', 'every suite stayed green and it is NOT declared -- a hole');
  row(nStillKnown, 'known survivor', 'declared uncatchable, re-run anyway, not a failure');
  if (promoted) row(promoted, 'known -> CAUGHT', 'the declaration has gone stale and must be edited');
  if (slowReal + slowKnown) {
    row(slowReal + slowKnown, 'TIMEOUT ONLY',
      'a suite was KILLED without printing a summary -- NOT scored as a catch');
  }
  if (nErrReal + nErrKnown) {
    row(nErrReal + nErrKnown, 'ANCHOR-ERROR', 'the patch never applied, so nothing was measured');
  }
  // The sum is checked, not assumed. It does NOT return here: an early return
  // would skip the repo-integrity hash and leave the scratch tree behind, so
  // the failure is recorded and the epilogue below still runs.
  const bucketSum = nCaught + survivors + nStillKnown + promoted
    + slowReal + slowKnown + nErrReal + nErrKnown;
  const bucketsBroken = bucketSum !== selected.length;
  if (bucketsBroken) {
    console.log(`\n  FATAL: the buckets sum to ${bucketSum} but ${selected.length} mutant`
      + `${selected.length === 1 ? ' was' : 's were'} run. A mutant has`);
    console.log('  fallen out of the accounting, which is the one thing this block exists to');
    console.log('  make impossible. Nothing else printed above can be trusted either.');
  }
  if (bucketsBroken || survivors || promoted || slowReal + slowKnown || nErrReal + nErrKnown) {
    console.log('\n  THIS RUN IS NOT GREEN, so it is making no claim yet. A SURVIVED row is a hole');
    console.log('  in what this repository measures; a known-survivor that was CAUGHT is a sentence');
    console.log('  in this file that has become false; a TIMEOUT ONLY row is a question nobody');
    console.log('  answered, because a killed suite printed no summary and cannot say whether a');
    console.log('  check failed or the mutation merely made the simulation slow; an ANCHOR-ERROR');
    console.log('  row means that mutant was never applied and nothing about it was measured.');
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
  // Non-termination is an anomaly about the SUITE, not about the mutant, so it
  // gets counted here rather than folded into any verdict. If this block starts
  // printing every run, the suite it names has a bug that is costing this harness
  // one full timeout per occurrence -- 90 s each for the fast suites.
  const hung = [];
  for (const m of selected) {
    const st = state.get(m.id);
    if (st.error) continue;
    for (const s of SUITE_ORDER) if (st.results[s]?.hungAtExit) hung.push([m, s]);
  }
  if (hung.length) {
    console.log(`\n  ${hung.length} suite run(s) FINISHED AND THEN FAILED TO EXIT, and were killed at the`);
    console.log('  timeout. Each printed a complete summary line first, so the verdict used above is');
    console.log('  that summary and not the kill; without that distinction each of these would have');
    console.log('  been reported as a TIMEOUT, which this harness counts as a detection, and the');
    console.log('  mutant would have read CAUGHT by a suite that never noticed it. This is a defect');
    console.log('  in the suite, not in the mutant -- and it costs a full timeout every time:\n');
    for (const [m, s] of hung) {
      console.log(`     ${pad(s, 20)} hung at exit while running ${m.id}`);
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
  if (slowReal + slowKnown) {
    console.log(`\n  ${slowReal + slowKnown} MUTANT(S) WERE DETECTED ONLY BY A TIMEOUT, and a timeout is not a catch.`);
    console.log('  The suite was killed before it printed a summary, so nothing in this run knows');
    console.log('  whether a check failed or whether the mutation just made the simulation slow.');
    console.log('  Scoring that as CAUGHT is how a hole comes to read as covered -- it has happened');
    console.log('  once here already, see the TIMEOUT paragraph at the top of this file -- so it is');
    console.log('  a failure instead. Fix it by giving that suite a bigger `timeoutMul` or');
    console.log('  `timeoutFloor` in SUITES and re-running, until it either goes RED and names the');
    console.log('  checks or goes GREEN and is an honest survivor.\n');
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
