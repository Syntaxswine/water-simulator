// ---------------------------------------------------------------------------
// The spherical field, drawn on a sphere. Canvas 2D, no WebGL, no dependency.
//
// src/render.mjs draws a Cartesian patch from above. A latitude-longitude field
// cannot be drawn that way without lying about where things are: an equirect-
// angular plate stretches the last row of a 2 degree grid by 1/cos(89) = 57x, so
// the polar cells -- the ones with the smallest timestep and the largest metric
// terms, i.e. exactly the ones a spherical port gets wrong -- are the biggest
// features on the picture. This file projects instead.
//
// THE PROJECTION IS EXACT, AND IT IS AN INVERSE, NOT A FORWARD MAP. For every
// screen pixel inside the disc, take x, y in units of the sphere's radius, set
// z = sqrt(1 - x^2 - y^2), rotate that surface normal into planetary coordinates
// and read off (lon, lat); then sample the cell that CONTAINS that point. There
// is no resampling filter, no triangle mesh, and nothing is approximated: the
// pixel's value is the value of the finite-volume cell the pixel's line of sight
// hits, which is the only sampling a cell-averaged field has an exact answer for.
//
// REJECTED: ONE drawImage PER LATITUDE BAND ("strip warp"). It is the obvious
// cheap trick -- slice the field into rows and squash each row horizontally by
// cos(lat) -- and it is wrong in the one direction it appears to be right. At a
// fixed latitude the true orthographic abscissa is
//
//     x = R cos(lat) sin(lon - lon_0)
//
// a SINE of longitude, and drawImage can only apply a LINEAR scale. So a strip
// warp is not "a sphere with the curvature left off": it is a sphere with the
// longitude wrong everywhere except on the central meridian, with the error
// growing to the limb, where the true map compresses a whole hemisphere's
// remaining longitude into the last few pixels and the linear one does not
// compress it at all. Measured on the mapping itself, not on a picture, with the
// linear scale pinned to agree at the centre and at the limb (the most flattering
// choice available to it):
//
//   worst |sin(lon) - linear|   0.21051 disc radii, at 50.46 deg from the central
//                               meridian = 69.3 px on a 700 px BUFFER, whose disc
//                               radius is cam.r = 329 and NOT 350: the disc is
//                               inset by `margin`, and taking half the buffer
//                               gives 73.7 px, 6% high. Check 1 asserted the 350
//                               figure for a while, which is the same mistake the
//                               label's own comment warns about, made inside the
//                               check that exists to catch it.
//   a feature drawn half-way    truly at longitude 30.00 deg; a linear strip
//     out along the equator     labels it 45 deg. 15 deg of arc = 1668 km
//
// A per-band drawImage is also not obviously cheaper: it is ny calls to a
// filtered blit, against one memcpy plus a flat loop over the pixels inside the
// disc.
//
// COST, measured on this machine against a 360x180 field (2 deg), node,
// `node src/globe.mjs --bench`, minimum and mean of 30 frames:
//
//   disc     modelled px    bake ms    best ms   mean ms   retained
//    500 px      173,512      19.59       3.64      3.80      4.3 MB
//    700 px      340,076      25.82       7.23      7.47      8.4 MB
//    900 px      562,164      35.74      11.97     12.16     13.8 MB
//   1400 px    1,360,172         --         --        --     33.4 MB  (the cap)
//
// Per-pixel work is a fetch from a baked table, one add, one floor, one modulo
// and three byte reads; the bake is paid once per SIZE, not per frame and not per
// rotation.
//
// RE-MEASURED after the frame loop's `lonBase + rot` was moved out into
// frameLon() -- see that function for why it had to be a function and not an
// expression written twice. The table above is the shipped code as it stands
// (best and mean of 30 frames, minimum over 5 processes) and it reads 1-3% above
// the figures the file carried before the move, which is right at the edge of
// this machine's noise. So it was measured as an A/B instead, interleaved, five
// runs each, so machine load lands on both arms:
//
//   disc     frameLon() called    inline expression    ratio
//    500 px       3.83 ms              3.81 ms         1.005   (arms overlap)
//    700 px       7.66 ms              7.46 ms         1.027   (arms do not)
//    900 px      12.39 ms             12.18 ms         1.017   (arms overlap)
//
// So the call costs somewhere between nothing and 3%, and it buys the only thing
// that makes check 4 a test of the renderer rather than of itself. Those absolute
// figures are higher than the table above because that sweep ran with other work
// on the machine; a per-frame cost measured on a loaded box is a measurement of
// the box, which is why only the RATIO is quoted from it.
//
// AND THE BROWSER IS SLOWER THAN NODE, so the node figure alone would flatter it.
// Chrome, read off index.html's own "solve + draw" counters (30 frames) and by
// timing draw() alone (60 reps, five interleaved runs):
//
//   disc     grid          solve      draw       delivered compression
//   658 px   4 deg  90x45   6.1 ms    10.0 ms    2140x
//   658 px   2 deg 180x90  64.5 ms    10.8 ms     456x
//   698 px   4 deg  90x45   9.1 ms    12.8 ms    1474x
//   draw alone, 698 px / 338,104 modelled pixels: 11.31 11.89 12.09 12.56 12.98 ms
//
// So quote the draw as 10-13 ms, not to three figures: the spread over five
// interleaved runs of the same code is 15%. A COLD window reads higher still --
// "15.1 + 17.0" over the first 30 frames after a load -- because the table bake
// lands inside the first draw frame after any resize and the JIT has not settled;
// the same page warm reads "9.1 + 12.8". At the minimum, 11.31 ms for 338,104
// pixels is 33.5 ns/px against node's 20.6 ns/px -- about 1.6x, in the direction
// that matters. Rendering into the ImageData's own Uint8ClampedArray rather than
// into a scratch buffer and copying took the 658 px draw from 10.60 to 9.96 ms.
//
// THE SOLVE DOMINATES ON A FINE GRID and the panel says so: at 2 degrees the polar
// timestep forces four steps per frame, the page delivers 456x instead of 2140x,
// and the honest mitigation is the latitude cap -- which is why the delivered
// compression is MEASURED against the clock rather than reported as the slice the
// loop asked for.
//
// THE TABLE IS BAKED ONCE PER SIZE, NOT ONCE PER ROTATION STEP, and that is a
// property of the projection rather than an optimisation. With the camera looking
// at latitude phi1 and the central meridian at lam0, the inverse orthographic is
// (the form is usually attributed to Snyder's Working Manual; that source was NOT
// retrieved here, so treat the attribution as UNVERIFIED -- what is checked is the
// pair against ITSELF, in check 1, plus the algebra: substituting the forward map
// into the atan2 below reduces its denominator to cos(lat) cos(lon - lam0)
// exactly, and its numerator to cos(lat) sin(lon - lam0))
//
//     lat = asin(z sin phi1 + y cos phi1)
//     lon = lam0 + atan2(x, z cos phi1 - y sin phi1)
//
// and lam0 appears in exactly one place: as an ADDITIVE constant on longitude.
// Latitude does not contain it at all. So spinning the planet cannot change any
// pixel's latitude (hence its ROW INDEX, which is baked), and changes its
// longitude by adding a scalar. The table stores, for each pixel inside the disc
// and inside the modelled latitude band: the byte offset into the frame buffer,
// the longitude at lam0 = 0, the row index, and the row's base offset into the
// solver's arrays.
//
// PROVING THE TABLE IS THE LIVE COMPUTATION, not merely close to it. The frame
// loop must produce the same double the direct inverse produces, or the picture
// is a second implementation of the projection that can drift from the first.
// It does, by construction: orthoInversePixel() computes lon as
// `view.rotDeg + lamDeg`, the table stores the lamDeg from a rot = 0 view, the
// frame loop computes `lonBase + rot`, and floating-point addition is
// commutative, so the two are the same bits and not merely the same number. That
// is an argument, so it is also a measurement -- check 4 below walks every pixel
// at eight rotations and reports the largest difference, and a control perturbs
// one table entry by one ULP to show the check can fail. Measured:
//
//   largest |baked - live| longitude   EXACTLY 0 over 268,576 pixel-rotations
//   column index mismatches           0        (8 rotations x the whole disc)
//   row index mismatches              0
//   control: one entry nudged by
//     one ULP (-1.42e-14 deg)         detected, on exactly 1 pixel
//
// ===========================================================================
// THE SHADING RULE: THE WATER IS NOT SHADED. THIS IS THE POINT OF THE FILE.
// ===========================================================================
//
// src/render.mjs's ramp was rewritten (commit fc16a64) so that CIE LIGHTNESS
// carries signed surface elevation and nothing else, measured symmetric to
// 1.174e-4 L*. A Lambert term multiplies lightness by cos(incidence), i.e. by a
// number between 0 and 1 that depends on WHERE THE PIXEL IS ON THE SCREEN. Two
// consequences, and the second is the one that decides it:
//
//   1. It inverts the signal. Near the limb cos(incidence) -> 0, so a full-scale
//      crest out there reads darker than a small trough at the centre of the
//      disc, and the reader has no way to separate elevation from geometry.
//   2. It is not a property of the cell. The multiplier follows the SCREEN, so
//      as the globe turns, one cell's brightness sweeps from dark to bright and
//      back -- and A PERFECTLY RESTING OCEAN PULSES. There is no wave in the
//      water at all and the picture shows one, once per revolution, everywhere.
//
// So no Lambert factor, no depth shading, no vignette, no ambient-occlusion rim
// touches a water pixel. A resting ocean is one flat colour over the whole disc
// at every rotation, and check 6 measures exactly that: the largest L* departure
// of any water pixel from the mean-sea-level colour, over a full turn, must be
// zero.
//
// CHECK 6 IS NOT ENOUGH ON ITS OWN, and that is worth stating beside it rather
// than in the errata below: its subject is a field whose correct picture is one
// flat colour, so a renderer that paints one flat colour ALWAYS passes it. It
// says the shading is absent; it cannot say the signal is present. Section 7 is
// the other half -- a field with known extremes at known cells, every painted
// byte against src/render.mjs's surfaceColour() -- and section 8 runs
// GlobeView.draw() itself, because check 6 works on renderGlobe()'s output and a
// vignette applied after it never enters the comparison. The same check then applies the rejected Lambert factor to the same
// buffer to show what it would have cost. Measured, on a resting ocean over a bed
// with 900 m of relief, 24 rotations, 959,616 water pixels:
//
//   shipped                          0 bytes, 0 L*   (exactly, not "small")
//   with the rejected Lambert term   up to 53.070 L* of departure, spread
//                                    53.070 L* across the disc -- against a
//                                    signed-elevation ramp that spans 66 L* in
//                                    total, so the geometry would be LOUDER than
//                                    a full-scale wave
//   the inversion, as a number       a full-scale crest dimmed to
//                                    cos(incidence) = 0.5889 has the same L* as
//                                    flat water, and 49.7% of the modelled disc
//                                    sits at or below that. On half the picture a
//                                    full-scale wave would be indistinguishable
//                                    from no wave at all.
//
// WHERE THE THREE-DIMENSIONALITY COMES FROM INSTEAD. Marks, not gradients. A
// mark at a known geographic position cannot be mistaken for a field value; a
// smooth multiplier over the field can, which is the whole argument above.
//
//   limb        a halo painted OUTSIDE the disc, plus a 1.1 px stroke ON the
//               edge. The stroke does cover water pixels, and that is stated
//               rather than hidden, with the size of what it covers measured.
//               The orthographic radial scale is z pixels per radius, so one
//               pixel spans 1/(r z) radians of arc; at the disc centre z = 1 and
//               that is 0.1742 deg on a 700 px buffer (r = 329), i.e. 0.058
//               cells at 3 degrees.
//
//               THE FIGURE THIS FILE USED TO PUBLISH WAS THE MAXIMUM OF A
//               DISTRIBUTION, PRESENTED AS TYPICAL. "At the outermost pixel of a
//               700 px disc z = 2.149e-3, so that pixel spans 81.0 degrees" is
//               arithmetically right and reproduces exactly -- the outermost
//               MODELLED pixel of that buffer is (125, 109), its centre lands
//               0.00076 px inside the limb, and check 8 asserts both numbers. But
//               that is a lucky draw of the pixel grid, not a property of the
//               limb: ONE pixel out of 340,076, and "27 cells at 3 degrees" was
//               its arc span and no other pixel's.
//
//               THE STROKE'S REAL FOOTPRINT IS 2 px INWARD, not the 0.55 px of a
//               1.1 px line: a canvas antialiases, and the tail is still a byte
//               that is not the ramp's. Measured on the live page -- Chrome, dpr
//               1, 759 px disc, graticule and terminator off, every water pixel
//               compared against surfaceColour():
//
//                 differ from the ramp   2,546 of 399,785 water px   0.64%
//                 all of them within     2.0 px of the limb
//                 at a 2 px exclusion    0 of 395,297 differ  (byte-exact)
//
//               and the arc span over that whole annulus, from check 8 on a 720 px
//               disc: 1.56 to 39.92 deg radially against 0.1693 deg at the disc
//               centre. So the floor is a factor 9, not 465, and about half a cell
//               at 3 degrees. The limb is still a FOLD rather than an edge and
//               those pixels are still the worst-conditioned on the picture, but
//               the honest numbers are 0.64% of the water and 1.6 deg, not 81 deg.
//               Nothing inside is dimmed.
//
//               WHAT THE OTHER TWO MARKS COST, measured the same way on the same
//               frame, since they blend over water too and the file should say by
//               how much: graticule 13,314 px (3.33% of the water), terminator 955
//               px (0.24%), all three together 16,773 px (4.20%). Both are
//               toggleable; the limb is not.
//   graticule   meridians and parallels every 30 degrees, drawn at fixed
//               GEOGRAPHIC positions so they turn with the planet. They blend
//               over the water along a one-pixel line: a discrete mark, at a
//               position the viewer can name, toggleable off.
//   terminator  the great circle where the land light grazes, drawn as a dashed
//               ellipse arc -- a LINE, not a shading boundary. It is labelled as
//               illumination only, because with Omega = 0 there is no rotation
//               and therefore no day and no night to draw.
//   land        IS lit, with a Lambert factor, and this is the one place it is
//               allowed: land here is bed elevation, and bed elevation is not a
//               signed departure from mean sea level, so no claim of the colour
//               ramp applies to it. The light is fixed in the VIEWER's frame, so
//               a mountain does brighten and dim as it crosses the disc. That is
//               a lighting artefact on a quantity that is not being measured; on
//               the water it would be a fabricated wave, which is why the water
//               does not get it.
//
// The water ramp is src/render.mjs's exported surfaceColour(). There is no second
// ramp here. What this file adds is a 1025-entry BYTE table filled by calling
// that function, because 380,000 pixels per frame times a three-element array
// return is the one allocation that would show up; the index arithmetic is copied
// from surfaceColour() so the table entry chosen is the entry surfaceColour()
// would have returned, and check 5 compares them byte for byte over a sweep --
// with a control showing that the naive index formula fails it. The sweep now
// contains every HALF-BIN on both signs as well as the even points: the two
// formulas can only differ on a half-bin, an even sweep of [-1, 1] provably never
// lands on one, and for a while that lesson had been applied to the control and
// not to the check it controls.
//
// ===========================================================================
// WHAT THE LABEL ON THE PICTURE HAS TO SAY, AND WHY EACH LINE IS THERE
// ===========================================================================
//
// A blue sphere with a graticule looks like the Earth. It is not the Earth, and
// it is not this repository's coastal model either. Every line globeLabel()
// emits exists because a viewer could otherwise reasonably believe the opposite:
//
//   radius, grid, cap        so the resolution is never implicit
//   AQUAPLANET, depth        a uniform 4000 m ocean is not bathymetry
//   Omega, friction, tide    all off unless they are actually on, and the label
//                            reads them off the sim rather than being told
//   the spin is a CAMERA     with Omega = 0 the planet is NOT rotating; the
//                            picture turns because the viewpoint does
//   mode period vs theory    the one quantitative claim, with the closed form
//                            written out and marked DERIVED, not cited
//   lightness = elevation,   because the absence of shading is invisible, and a
//     the sphere is NOT      viewer who assumes shading will read the flat limb
//     shaded                 as an error rather than as the point
//   polar timestep tax       measured off this sim's own metric, with the cap
//                            named as the honest mitigation
//   the ramp CLAMPS          the dual of the no-Lambert argument, below. Measured
//                            on the last frame, with the count and the fraction.
//   shorelines not drawn     with all four scale factors COMPUTED from
//                            src/shorelines.mjs's own domain table, and each one
//                            named with the scenario it belongs to. See
//                            coastalScaleFacts() for the three that were wrong.
//                            tidalInlet is 3.12 x 2.64 km = 0.0281 deg of arc
//                            = 0.151 px at r = 309, the radius of a 658 px disc
//                            (r px per RADIAN at the disc CENTRE, the only place
//                            the orthographic scale is a constant); headlandBay
//                            2.56 km = 0.124 px. The disc is whatever the window
//                            gives -- 658 px is one real measured case, and the
//                            label recomputes from the camera every frame rather
//                            than carrying any of these. Wrapping tidalInlet on needs x12,830 in
//                            longitude and x7,581 in latitude -- longitude spans
//                            2 pi R and latitude only pi R, so it SHEARS 1.69x --
//                            and its crest would cross at 150 km/s against a
//                            4000 m ocean's 198 m/s, 759x too fast. headlandBay
//                            is square and therefore shears by EXACTLY 2.00
//                            (x15,637 by x7,818, 219 km/s, 1106x), which is the
//                            cleanest form of the point: a square patch cannot go
//                            on a lat-lon grid without one axis stretching twice
//                            as far as the other, at any size. So the coastal
//                            cases are absent on purpose, and the label says so
//                            rather than leaving their absence to be read as an
//                            oversight.
//
// ===========================================================================
// AND THE RAMP'S OWN CLAMP IS THE LAMBERT ARGUMENT IN ITS OTHER FORM
// ===========================================================================
//
// The case against Lambert above is that it maps two elevations onto one
// lightness over half the disc. THE COLOUR RAMP'S CLAMP DOES THE SAME THING and
// it is two slider drags away: above full scale every elevation is the ramp's
// last entry. That was argued at length in one direction and not measured in the
// other -- renderGlobe() already returned etaMin and etaMax and NOTHING IN THE
// TREE READ THEM.
//
// Measured at index.html's own defaults (4 deg, mode2, full sphere, colour scale
// 0.50 m, 658 px disc, 300,436 water pixels), which check 9 reproduces:
//
//   amplitude slider    eta painted        water px at |t| >= 1
//   0.50 m (default)    -0.250 .. 0.499          0    0.0%
//   + one dropBump      -0.250 .. 0.807      5,160    1.7%
//   1.00 m (mid)        -0.500 .. 0.998     54,482   18.1%
//   2.00 m (max)        -1.000 .. 1.996    216,244   72.0%
//
// "index.html's own defaults" is itself a claim, and for a while it was the only
// unmeasured thing left in this section: the defaults were three constants typed
// into the check. They are now READ OUT OF index.html and compared field by
// field -- the slider attributes, the arithmetic the page turns them into metres
// with, both selects, the Coriolis box and the click handler. See PAGE_REF for
// the three one-line edits to the page that used to leave every suite green
// while making this paragraph false. The 658 px disc is the one figure here that
// is not a default: the canvas is width:100%, so it is whatever the window gives,
// and the water-pixel count is what pins WHICH disc these percentages belong to.
//
// Over 72% of the disc a 0.5 m crest and a 2.0 m crest are the same byte and the
// same L* -- check 9 paints two such cells and measures 0 L* between them.
//
// THOSE ARE t = 0, the state the page shows the instant it builds, and the middle
// row moves as soon as the solver runs: driven in Chrome at a 759 px disc it
// reads 18.14% at t = 0 and 14.02% after 103 s of simulated time. The cause is
// worth keeping because it is the reason the count is `>=` and not `>`. ny is
// ODD at 4 degrees (45 rows), so there is a row centred at EXACTLY lat 0, where
// P2(sin 0) = -1/2 and eta is exactly -0.500 m at an 0.500 m scale: 16,473
// pixels sitting precisely on the clamp. They count as saturated, they are
// saturated, and the first step moves them to -0.4981 and out. A fraction that
// hinges on one row landing on the boundary is exactly the kind of number that
// must be MEASURED PER FRAME and printed with the frame, which is what the label
// does -- not quoted once and remembered.
//
// THIS DOES NOT WANT A FIX TO THE RAMP. Auto-ranging per frame is worse, and
// src/render.mjs says why: a calm frame gets stretched until numerical noise
// fills the colour range and the viewer cannot tell a millimetre from a metre.
// The scale is the caller's, deliberately. What was missing was the NUMBER, so
// the label now carries it, measured, on every frame -- the same treatment the
// bed already gets from surveyBed().
//
// ===========================================================================
// WHY THE CHECKS ARE IN THIS FILE
// ===========================================================================
//
// They belong in tools/verify-globe.mjs. tools/ is not this change's to touch,
// and a renderer that can only be judged by looking at it cannot be judged at
// all -- the preview pane throttles a hidden tab, requestAnimationFrame may
// never fire, and "it looked right" is not a measurement. So the suite lives
// here, behind an import.meta.url guard, and follows the house rules the tools/
// suites follow: one line per check with the measured number AND the target,
// locally declared reference constants (never the module under test's), an
// unknown filter argument is an ERROR rather than "ALL PASS 0/0", and a non-zero
// exit on failure. Move it when tools/ opens.
//
//     node src/globe.mjs                 every check (116)
//     node src/globe.mjs merian          just the mode-period section
//     node src/globe.mjs field,marks     a comma-separated list of sections
//     node src/globe.mjs --bench         the per-frame timing table
//
// The list form exists because `merian` costs 13 of the suite's 15 seconds, and a
// mutation sweep that pays it once per mutant is a sweep nobody runs. Every name
// in the list still has to exist; one typo is an ERROR, not a quiet 0/0.
//
// SIX of the 116 read index.html off the disk beside src/ -- see PAGE_REF -- and
// they are the only ones that can be SKIPPED rather than run: a mutation scratch
// tree holds src/ and tools/ and no page. Each skip prints under its own name,
// is counted, and is named on the summary line -- measured, that tree reads
// `ALL PASS -- 110/110 checks, 6 SKIPPED`. A page that IS there and disagrees, or
// that is there and cannot be parsed, is a FAILURE and not a skip.
//
// STILL HERE, NOT IN tools/, AND ON PURPOSE FOR NOW: tools/ is being edited
// concurrently and a move would collide. Move the whole block to
// tools/verify-globe.mjs when that settles. Nothing in it needs to be in this
// file except the two module-private things it reaches -- CBYTES and landColour
// -- and the land ramp's constants are already re-declared as LAND_*_REF targets
// rather than imported, so only CBYTES would need exporting.
//
// One check in there is not about the renderer at all: section 11 measures the
// spherical mode period against omega^2 = g H n(n+1)/R^2. It is here because the
// LABEL quotes that number, and a label may not quote a figure that nothing in
// the shipped tree can reproduce.
//
// WHAT A HOSTILE REVIEW FOUND IN THE FIRST 60 CHECKS, because the shape of it is
// the lesson and not the individual bugs. Section 6 -- "a resting ocean does not
// pulse" -- was the file's centrepiece, and a resting ocean is eta = 0 in every
// cell, so THE CORRECT PICTURE IS ONE FLAT COLOUR. A renderer that always paints
// mean sea level scores a perfect zero on it. Nothing anywhere read a painted
// water pixel off a field with a wave in it, and nothing called GlobeView.draw()
// at all. Measured, on the 60-check suite:
//
//   mutation of the one line that turns a cell into a colour     result
//   colourOffset(0, scale)      ocean permanently flat           ALL PASS 60/60
//   colourOffset(e, scale * 4)  full scale 4x the label          ALL PASS 60/60
//   colourOffset(-e, scale)     CREST PAINTED AS TROUGH          ALL PASS 60/60
//   e = b + h                   the msl subtraction dropped      ALL PASS 60/60
//   a 45% vignette in draw()    over every water pixel           ALL PASS 60/60
//   '+ rotDeg' -> '- rotDeg'    the frame loop spins backwards   ALL PASS 60/60
//   landColour /2500 -> /2400   the land ramp                    ALL PASS 60/60
//   lit = abs() not max(0, .)   the night side lit like the day  ALL PASS 60/60
//   Lambert forced on                                            1 FAIL 59/60
//
// Sections 7, 8 and 9 exist because of that table. Every one of those mutations
// now fails, most of them on several checks at once, and so do sixteen more.
// ---------------------------------------------------------------------------

import { surfaceColour } from './render.mjs';
// READ, not remembered. The label's "wrapping a coastal field onto a globe would
// need xN" line used to carry four hand-copied figures and three of them were
// wrong; see coastalScaleFacts() for what each one is and how it went wrong. The
// page already imports this module, so nothing is added to the wire.
import { SHORELINES } from './shorelines.mjs';
// G is ALIASED. It is a subject of section 11, never an input to a target: keeping
// the bare name `G` out of this file's scope means a closed form that reaches for
// the solver's gravity is a ReferenceError rather than a silent pass. This is the
// same discipline tools/verify.mjs adopted after a hostile review showed a suite
// printing ALL PASS with g multiplied by 1.1.
import { ShallowWater, G as SWE_G } from './swe.mjs';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ---------------------------------------------------------------------------
// Projection. Pure, and the only place the camera model is written down.
// ---------------------------------------------------------------------------

/**
 * Camera state. `size` is the side of the square pixel buffer; the disc is
 * inscribed with a small margin so the limb stroke and halo have somewhere to
 * live. `tiltDeg` is the latitude the camera looks at, `rotDeg` the longitude on
 * the central meridian.
 *
 * The LUT depends on size, tilt and margin. It does NOT depend on rotDeg -- see
 * the header -- which is why rotDeg is allowed to live in here beside them.
 */
export function globeCamera({ size, tiltDeg = 22, rotDeg = 0, margin = 0.94 }) {
  const r = 0.5 * size * margin;
  return {
    size, margin, r, cx: 0.5 * size, cy: 0.5 * size, tiltDeg, rotDeg,
    sinT: Math.sin(tiltDeg * D2R), cosT: Math.cos(tiltDeg * D2R),
  };
}

/** Longitude folded into [-180, 180). Cells are indexed by colOfLon(), which
 *  accepts any real, so this is for humans and for the label. */
export function wrapLon(lonDeg) {
  return (((lonDeg + 180) % 360) + 360) % 360 - 180;
}

/**
 * Forward orthographic: (lon, lat) -> pixel, plus the visibility test.
 *
 * `vis` is the sign of the outward normal's component towards the viewer. A point
 * on the far side projects to a perfectly plausible pixel -- the projection is
 * two-to-one -- so anything drawing a line has to test this or the graticule
 * comes back with the far side of the planet stencilled through the near side.
 */
export function orthoProject(lonDeg, latDeg, cam) {
  const phi = latDeg * D2R, dl = (lonDeg - cam.rotDeg) * D2R;
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const x = cp * Math.sin(dl);
  const y = cam.cosT * sp - cam.sinT * cp * Math.cos(dl);
  const z = cam.sinT * sp + cam.cosT * cp * Math.cos(dl);
  return { px: cam.cx + cam.r * x, py: cam.cy - cam.r * y, z, vis: z >= 0 };
}

/**
 * Inverse orthographic on NORMALISED sphere coordinates: x, y in radii, origin
 * at the centre of the disc, y up. Returns null outside the disc.
 *
 * Longitude comes back UNWRAPPED, as `cam.rotDeg + lamDeg`. That is deliberate
 * and load-bearing twice over: it is what makes the baked table exactly equal to
 * this function (header), and colOfLon() takes any real, so nothing downstream
 * needs the fold.
 */
export function orthoInverseXY(x, y, cam) {
  const s = x * x + y * y;
  if (s > 1) return null;
  const z = Math.sqrt(1 - s);
  const phi = Math.asin(z * cam.sinT + y * cam.cosT);
  const lam = Math.atan2(x, z * cam.cosT - y * cam.sinT);
  return [cam.rotDeg + lam * R2D, phi * R2D, z];
}

/**
 * Inverse orthographic for the CENTRE of integer pixel (px, py).
 *
 * The +0.5 is the whole reason this wrapper exists rather than being written out
 * at each call site. Sampling the pixel's corner instead of its centre offsets
 * the picture by half a pixel and -- because the disc mask is then computed about
 * a point that is not the centre of the buffer -- makes the mask ASYMMETRIC,
 * which is what check 2 looks for.
 */
export function orthoInversePixel(px, py, cam) {
  return orthoInverseXY((px + 0.5 - cam.cx) / cam.r, (cam.cy - py - 0.5) / cam.r, cam);
}

// ---------------------------------------------------------------------------
// Sampling: which cell contains a point.
// ---------------------------------------------------------------------------

/**
 * The grid, read off the solver's own metric rather than passed in beside it.
 *
 * Longitude cell i spans [i*dlon - 180, (i+1)*dlon - 180), which is the same
 * convention as ShallowWater#cellLonLat: centre (i + 0.5) * dlon - 180. Latitude
 * row j spans [lat0 + j*dlat, lat0 + (j+1)*dlat), matching geometry.mjs's phiC,
 * which is the ARITHMETIC mean of the row's two face latitudes. Check 3 measures
 * the agreement against the solver's arrays instead of trusting this paragraph.
 */
export function gridOf(sim) {
  const g = sim.geom;
  if (!g || g.kind !== 'sphere') {
    throw new Error('globe.mjs draws spherical fields only: sim.geom.kind is '
      + `${g ? g.kind : 'undefined'}. A Cartesian coastal patch is 0.03 degrees of arc `
      + 'wide and cannot be wrapped onto a globe -- see the header. Use src/render.mjs.');
  }
  return {
    nx: g.nx, ny: g.ny, ng: g.ng, W: g.nx + 2 * g.ng,
    lat0: g.lat0, lat1: g.lat1, R: g.R, omega: g.omega,
    dlon: 360 / g.nx, dlat: (g.lat1 - g.lat0) / g.ny,
  };
}

/** Column containing this longitude. Accepts any real; wraps. */
export function colOfLon(lonDeg, nx) {
  const i = Math.floor((lonDeg + 180) * nx / 360);
  return ((i % nx) + nx) % nx;
}

/**
 * Row containing this latitude, or -1 if the latitude is OUTSIDE the modelled
 * band. -1 is not an error: a capped domain does not simulate its poles, and
 * painting them as water would be the single most misleading thing this file
 * could do. renderGlobe() hatches them.
 */
export function rowOfLat(latDeg, grid) {
  const { lat0, lat1, ny } = grid;
  if (latDeg < lat0 || latDeg > lat1) return -1;
  let j = Math.floor((latDeg - lat0) * ny / (lat1 - lat0));
  if (j >= ny) j = ny - 1;                  // latDeg === lat1 exactly
  else if (j < 0) j = 0;
  return j;
}

// ---------------------------------------------------------------------------
// The baked table.
// ---------------------------------------------------------------------------

/**
 * Bake pixel -> cell for one (size, tilt, margin, grid). Rotation-free: see the
 * header for why that is exact rather than lucky.
 *
 * Also bakes two things that are pure geometry and therefore also rotation-free:
 *   bg    the whole frame buffer's worth of everything that is not the modelled
 *         ocean -- background, limb halo, and the hatch over an unmodelled polar
 *         cap. The frame loop starts with one memcpy of this and then writes only
 *         the pixels it actually models.
 *   lit   cos(incidence) for a light fixed in the VIEWER's frame. Read on land
 *         pixels only. It is also exactly the multiplier the water must never be
 *         given, which is what check 6's control uses it for.
 */
export function buildGlobeLut(cam, grid, style = {}) {
  const sun = normalise(style.sun || [-0.42, 0.48, 0.77]);
  const size = cam.size, N = size * size;
  const bg = new Uint8ClampedArray(4 * N);
  const px = new Int32Array(N), lonBase = new Float64Array(N);
  const jRow = new Int32Array(N), rowBase = new Int32Array(N), lit = new Float32Array(N);
  const zero = globeCamera({ size, tiltDeg: cam.tiltDeg, rotDeg: 0, margin: cam.margin });
  const B = style.bg || [8, 11, 16];
  const HALO = style.halo || [36, 58, 84];
  let count = 0, inside = 0, capped = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = y * size + x, o = 4 * p;
      const q = orthoInversePixel(x, y, zero);
      if (q === null) {
        // Outside the disc: background plus a halo that falls off with distance
        // from the limb. Painted here, not over the water, so it can never dim a
        // cell. `s` is the squared radius, so this costs no sqrt.
        const dx = (x + 0.5 - cam.cx) / cam.r, dy = (cam.cy - y - 0.5) / cam.r;
        const s = dx * dx + dy * dy;
        const g = Math.exp(-(s - 1) * 5.5);
        bg[o] = B[0] + (HALO[0] - B[0]) * g;
        bg[o + 1] = B[1] + (HALO[1] - B[1]) * g;
        bg[o + 2] = B[2] + (HALO[2] - B[2]) * g;
        bg[o + 3] = 255;
        continue;
      }
      inside++;
      const j = rowOfLat(q[1], grid);
      if (j < 0) {
        // Inside the disc, outside the modelled band. Hatched, not coloured: a
        // flat grey cap reads as land or as ice, and this is neither -- it is
        // nothing, because the simulation does not go there.
        capped++;
        const t = ((x + y) & 7) < 3 ? 1 : 0;
        bg[o] = 52 + 14 * t; bg[o + 1] = 56 + 14 * t; bg[o + 2] = 62 + 14 * t; bg[o + 3] = 255;
        continue;
      }
      px[count] = o;
      lonBase[count] = q[0];
      jRow[count] = j;
      rowBase[count] = (j + grid.ng) * grid.W + grid.ng;
      const nx3 = (x + 0.5 - cam.cx) / cam.r, ny3 = (cam.cy - y - 0.5) / cam.r, nz3 = q[2];
      lit[count] = Math.max(0, nx3 * sun[0] + ny3 * sun[1] + nz3 * sun[2]);
      count++;
    }
  }
  // slice(), NOT subarray(). A subarray is a VIEW: it keeps the whole size*size
  // buffer alive, so the compact arrays would cost 20 bytes per buffer pixel
  // instead of 20 per modelled pixel and the footprint quoted by benchGlobe() --
  // and in the header -- would be a 44% understatement of what is actually
  // retained. The copy is paid once, inside a bake that already costs 20 ms.
  return {
    size, tiltDeg: cam.tiltDeg, margin: cam.margin, count, inside, capped, sun,
    key: lutKey(cam, grid),
    px: px.slice(0, count), lonBase: lonBase.slice(0, count),
    jRow: jRow.slice(0, count), rowBase: rowBase.slice(0, count),
    lit: lit.slice(0, count), bg,
  };
}

export function lutKey(cam, grid) {
  return `${cam.size}|${cam.tiltDeg}|${cam.margin}|${grid.nx}|${grid.ny}|${grid.lat0}|${grid.lat1}`;
}

function normalise(v) {
  const m = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
}

// ---------------------------------------------------------------------------
// Colour. ONE ramp in this repository, and it is src/render.mjs's.
// ---------------------------------------------------------------------------

// Same entry count and the same odd-length reason as render.mjs's RAMP: with an
// even count there is no entry at t = 0 and mean sea level becomes a step.
const CN = 1025, CMID = (CN - 1) >> 1;

// Filled BY ASSIGNMENT into a Uint8ClampedArray, not by Math.round, because that
// is how ImageData stores a byte: Uint8ClampedArray rounds halves to EVEN
// (128.5 -> 128) and Math.round rounds them up (129). Rounding it myself here
// would make this table differ from render.mjs's own output on exactly the values
// that land on a half.
const CBYTES = (() => {
  const out = new Uint8ClampedArray(3 * CN);
  for (let i = 0; i < CN; i++) {
    const c = surfaceColour(-1 + (2 * i) / (CN - 1), 1);
    out[3 * i] = c[0]; out[3 * i + 1] = c[1]; out[3 * i + 2] = c[2];
  }
  return out;
})();

/**
 * Index into CBYTES for a signed elevation.
 *
 * The arithmetic is surfaceColour()'s, deliberately: index symmetrically about
 * the middle entry rather than mapping t onto [0, N-1] and rounding, because
 * Math.round breaks ties upward on both signs and the naive form is off by one
 * bin on one side of mean sea level at every half-bin value of t. Check 5
 * compares this table against surfaceColour() over a sweep, and shows the naive
 * formula failing that comparison.
 */
export function colourOffset(v, scale) {
  const t = Math.max(-1, Math.min(1, v / scale));
  const q = Math.round(Math.abs(t) * CMID);
  return 3 * (t >= 0 ? CMID + q : CMID - q);
}

/**
 * Land, by bed elevation in KILOMETRES rather than metres.
 *
 * render.mjs's land ramp saturates at 6 m, which is right for a dune and useless
 * for a 2 km seamount. This is a separate ramp for a separate quantity and NOT a
 * second surface ramp: bed elevation is not a signed departure from mean sea
 * level, so none of the ramp symmetry argument applies to it, and none of it is
 * claimed. It is also the only thing in this file that is allowed to be lit.
 *
 * The three numbers are NAMED rather than inlined, because check 7.4 declares its
 * own copy of them as a target and a target you cannot state is not a target. It
 * is a straight line in sRGB bytes from LAND_LO at bed = 0 to LAND_HI at
 * LAND_SAT, CLAMPED at both ends -- and both clamps are load-bearing rather than
 * defensive: a dry cell can sit BELOW sea level (a drained basin), which without
 * the lower clamp darkens past the ramp's own foot, and GLOBE_BEDS.seamount
 * reaches 1200 m while williamsonCone reaches 2000 m and a taller bed would run
 * off the top. Check 7.4 paints dry cells at -50, 0, 1250, 2500 and 3500 m and
 * compares every byte.
 */
const LAND_SAT = 2500;                 // bed elevation [m] at which the ramp tops out
const LAND_LO = [92, 84, 70];          // the colour of a dry cell at bed = 0
const LAND_HI = [188, 172, 144];       // ... and at LAND_SAT and above
function landColour(bedM) {
  const t = Math.max(0, Math.min(1, bedM / LAND_SAT));
  return [
    LAND_LO[0] + (LAND_HI[0] - LAND_LO[0]) * t,
    LAND_LO[1] + (LAND_HI[1] - LAND_LO[1]) * t,
    LAND_LO[2] + (LAND_HI[2] - LAND_LO[2]) * t,
  ];
}

// ---------------------------------------------------------------------------
// The frame.
// ---------------------------------------------------------------------------

/**
 * THE ONE ROTATION-DEPENDENT OPERATION IN THE FRAME, as a function rather than as
 * an expression written twice.
 *
 * It used to be inline in the frame loop, and check 4 -- the check whose whole
 * subject is "the baked table IS the live computation" -- restated it as
 * `lut.lonBase[p] + rot` in its own body. A restatement is not a test of the
 * thing it restates: flipping the sign in renderGlobe left the suite at ALL PASS,
 * because the check was comparing its own copy against orthoInversePixel() and
 * the renderer was not in the comparison at all. Now there is one expression, the
 * frame loop calls it, and check 4 calls it, so a sign flip here is a sign flip in
 * what the check compares.
 *
 * It stays an ADDITION, and that is the property the header rests on:
 * orthoInversePixel() computes longitude as `cam.rotDeg + lam`, the table stores
 * the lamDeg from a rot = 0 view, and floating-point addition is commutative, so
 * `lonBase + rot` is the same DOUBLE and not merely the same number.
 */
export function frameLon(lonBase, rotDeg) { return lonBase + rotDeg; }

/**
 * Render one frame into `out` (a Uint8ClampedArray of 4 * size * size).
 *
 * Callable with no canvas, no document and no rAF, which is the requirement that
 * shaped the signature: everything a check wants to know is either in the LUT or
 * in the returned stats. Returns counts, the extremes it painted, and -- see
 * THE CLAMP IS THE DUAL OF THE LAMBERT ARGUMENT in the header -- how many water
 * pixels it painted at or beyond full scale, which is the number the label has to
 * print for the colour ramp to be as honest as the bed already is.
 *
 * @param __lambertControl NOT A FEATURE. When 1, the water is multiplied by the
 *   Lambert factor this file exists to refuse, so that check 6 can measure what
 *   the refusal is worth. Nothing in index.html sets it, and if it ever does, the
 *   resting-ocean check fails, which is the point.
 */
export function renderGlobe(out, sim, {
  lut, rotDeg = 0, scale = 1, msl = 0, landLight = true, __lambertControl = 0,
}) {
  const grid = gridOf(sim);
  if (lut.key !== lutKey({ size: lut.size, tiltDeg: lut.tiltDeg, margin: lut.margin }, grid)) {
    throw new Error(`LUT was baked for ${lut.key}, grid is now `
      + `${lutKey({ size: lut.size, tiltDeg: lut.tiltDeg, margin: lut.margin }, grid)}`);
  }
  out.set(lut.bg);
  const { count, px, lonBase, rowBase, lit } = lut;
  const h = sim.h, b = sim.b, minDepth = sim.minDepth, nx = grid.nx;
  let wet = 0, dry = 0, lo = Infinity, hi = -Infinity, sat = 0;

  for (let p = 0; p < count; p++) {
    const k = rowBase[p] + colOfLon(frameLon(lonBase[p], rotDeg), nx);
    const o = px[p];
    const hk = h[k];
    if (hk <= minDepth) {
      dry++;
      const c = landColour(b[k]);
      const s = landLight ? 0.30 + 0.70 * lit[p] : 1;
      out[o] = c[0] * s; out[o + 1] = c[1] * s; out[o + 2] = c[2] * s; out[o + 3] = 255;
    } else {
      wet++;
      const e = b[k] + hk - msl;
      if (e < lo) lo = e;
      if (e > hi) hi = e;
      // AT OR BEYOND FULL SCALE. `>=`, not `>`: |t| = 1 is already the ramp's last
      // entry, so a cell exactly at full scale is already sharing its byte with
      // everything above it. Counted here rather than derived afterwards because
      // this is the only place the frame knows both `e` and `scale`.
      if (e >= scale || e <= -scale) sat++;
      const c = colourOffset(e, scale);
      if (__lambertControl) {
        const s = lit[p];
        out[o] = CBYTES[c] * s; out[o + 1] = CBYTES[c + 1] * s; out[o + 2] = CBYTES[c + 2] * s;
      } else {
        out[o] = CBYTES[c]; out[o + 1] = CBYTES[c + 1]; out[o + 2] = CBYTES[c + 2];
      }
      out[o + 3] = 255;
    }
  }
  return {
    wet, dry, capped: lut.capped, inside: lut.inside, etaMin: lo, etaMax: hi,
    sat, satFrac: wet ? sat / wet : 0, scale,
  };
}

// ---------------------------------------------------------------------------
// The label. A pure function, so a headless check can print it verbatim.
// ---------------------------------------------------------------------------

/**
 * What it would cost to wrap one of this repository's COASTAL fields onto this
 * globe -- computed from src/shorelines.mjs's own domain table, never quoted.
 *
 * WHAT WAS WRONG WITH THE QUOTED VERSION, because the shape of the mistake is
 * worth keeping. The label used to read "x12,830 in longitude and x15,637 in
 * latitude ... 127 km/s ... 642x". Measured:
 *
 *   x12,830   RIGHT, and it is tidalInlet's LONGITUDE factor (2 pi R / 3120 m).
 *   x15,637   is 2 pi R / 2560 m: headlandBay's LONGITUDE factor, printed as
 *             though it were a latitude factor. Latitude spans pi R and longitude
 *             spans 2 pi R, so a latitude factor is off by exactly 2 from a
 *             longitude factor for the same width. The honest latitude figures
 *             are x7,581 (tidalInlet, 2640 m) and x7,818 (headlandBay, 2560 m).
 *             So the pair mixed TWO SCENARIOS and was out by a factor 2.
 *   127 km/s  belongs to no scenario at all. It implies c = 9.899 m/s and hence a
 *             9.99 m depth; tidalInlet is 14 m (c 11.72, crest 150 km/s) and
 *             headlandBay 20 m (c 14.00, crest 219 km/s).
 *   642x      is 127 km/s over 198 m/s, so it inherited the same phantom depth.
 *             tidalInlet is 759x, headlandBay 1106x.
 *
 * THE ARGUMENT SURVIVED ALL FOUR -- tidalInlet really does shear 1.69x, and
 * headlandBay, being square, shears by EXACTLY 2.00, which is the cleanest
 * statement of the point available: a square patch cannot be laid on a lat-lon
 * grid without stretching one axis twice as far as the other, whatever its size.
 * The published numbers were still not that argument, and a label that is right
 * by luck is not a label.
 *
 * @param gRef  the caller's OWN gravity. c = sqrt(g h) here, and borrowing the
 *   solver's G would make the crest speed rescale with any error in it.
 */
export function coastalScaleFacts(gRef, R, names = ['tidalInlet', 'headlandBay']) {
  const kmPerDeg = Math.PI * R / 180;             // one degree of GREAT-CIRCLE arc
  return names.map((name) => {
    const s = SHORELINES[name];
    const Lx = s.domain.nx * s.domain.dx, Ly = s.domain.ny * s.domain.dy;
    const depth = s.defaults.offshoreDepth;
    const c = Math.sqrt(gRef * depth);
    // Longitude wraps the whole 2 pi R; latitude only spans pole to pole, pi R.
    const fLon = 2 * Math.PI * R / Lx, fLat = Math.PI * R / Ly;
    return {
      name, title: s.title, Lx, Ly, depth, c, fLon, fLat, shear: fLon / fLat,
      arcX: Lx / kmPerDeg, arcY: Ly / kmPerDeg, crest: c * fLon,
    };
  });
}

/**
 * Every line of the honesty label, read off the SIM rather than off the UI's
 * intentions. If someone switches Coriolis on and forgets to change a caption,
 * the caption changes itself.
 *
 * @param merian  {measured, closed, rel, note} or null. Null prints "not
 *   measured on this grid" plus the closed form -- an empty slot is honest, a
 *   remembered number is not.
 * @param saturation  renderGlobe()'s stats from the last frame, or null. See THE
 *   CLAMP IS THE DUAL OF THE LAMBERT ARGUMENT in the header: the ramp saturates,
 *   and above full scale two different crests are one byte, which is precisely
 *   the fault the Lambert term is refused for. Null prints "not yet measured",
 *   because a remembered fraction is worse than an empty one.
 * @param discR  the radius the CAMERA used, in device pixels. 0 means the globe
 *   has not been drawn yet and no px figure is printed. There is deliberately no
 *   plausible default: the previous one (350) was never the radius the page used
 *   -- index.html's disc is 658 px, so cam.r is 309 -- and the suite spent its
 *   time asserting a string that never appeared on screen.
 */
export function globeLabel(sim, {
  bedName = 'flat', bedNote = '', initName = '', scale = 1, merian = null,
  compression = null, discR = 0, gRef = 9.80665, modeN = 2, saturation = null,
} = {}) {
  const g = gridOf(sim);
  const capped = !(g.lat0 <= -90 + 1e-9 && g.lat1 >= 90 - 1e-9);
  const H = 4000;
  const closed = 2 * Math.PI * g.R / Math.sqrt(gRef * H * modeN * (modeN + 1));
  const L = [];
  L.push('GLOBE VIEW -- an AQUAPLANET. This is not the Earth, and it is not this '
    + "repository's coastal model.");
  L.push(`sphere R = ${(g.R / 1000).toFixed(1)} km   grid ${g.nx} x ${g.ny} = `
    + `${g.dlon.toFixed(2)} deg lon x ${g.dlat.toFixed(2)} deg lat   `
    + (capped ? `latitude cap ${g.lat0}..${g.lat1} deg (the honest mitigation for the polar `
      + 'timestep; the caps below are NOT simulated and are hatched)'
      : 'full sphere, pole to pole, no latitude cap'));
  L.push(`bed: ${bedName}${bedNote ? ' -- ' + bedNote : ''}. NO real bathymetry, NO coastline, `
    + `NO tide, ${sim.manning ? `Manning n = ${sim.manning}` : 'NO bed friction (Manning 0)'}, `
    + (g.omega
      ? `Omega = ${g.omega.toExponential(6)} rad/s (Coriolis ON, f = 2 Omega sin lat)`
      : 'Omega = 0 (no Coriolis, no rotational deformation)'));
  // MEASURED off the sim, not repeated from the caption above. A bed whose title
  // says "pierces the surface" and whose array does not is exactly the kind of
  // disagreement a label is supposed to expose rather than paper over, and it is
  // also the line that tells the reader whether the closed form below applies at
  // all -- it is derived for a bed of UNIFORM depth.
  const bed = surveyBed(sim);
  L.push(`bed as built, measured: relief ${bed.relief.toFixed(0)} m (${(-bed.max).toFixed(0)} to `
    + `${(-bed.min).toFixed(0)} m of water)`
    + (bed.dry
      ? `, ${bed.dry} dry cells -- a shoreline ${bed.crest.toFixed(0)} m above sea level at its `
        + 'highest sampled point'
      : ', nothing pierces the surface, no dry cells'));
  if (initName) L.push(`initial state: ${initName}, released from rest`);
  L.push(`LIGHTNESS = SIGNED SURFACE ELEVATION, +-${scale.toFixed(2)} m full scale (CIE L* `
    + 'symmetric about mean sea level). THE SPHERE IS NOT SHADED: no Lambert term touches the');
  L.push('    water, because a multiplier that depends on screen position makes a resting ocean '
    + 'pulse bright-to-dark once per turn. Only LAND is lit. Limb, graticule and');
  L.push('    terminator are drawn as marks at known positions, never as gradients over the field.');
  // THE OTHER HALF OF THE SAME ARGUMENT. Refusing Lambert because two elevations
  // map to one lightness, and then saying nothing about the clamp -- which maps
  // EVERY elevation past full scale to one lightness, and is two slider drags
  // away -- would be an argument used in one direction only. It needs no fix to
  // the ramp; auto-ranging is worse (render.mjs says why). It needs the number.
  L.push(`RAMP CLAMPS AT +-${scale.toFixed(2)} m, and that is the Lambert fault in its other `
    + 'form: past full scale two different crests are ONE byte and one lightness. Not a bug, but');
  L.push(saturation && saturation.wet > 0
    ? `    not free either -- MEASURED on the last frame: ${saturation.sat} of ${saturation.wet} `
      + `water pixels (${(100 * saturation.satFrac).toFixed(1)}%) are at or past full scale, `
      + `eta ${saturation.etaMin.toFixed(3)}..${saturation.etaMax.toFixed(3)} m. Raise "colour `
      + 'scale +-" to tell them apart.'
    : '    not free either -- the fraction past full scale is NOT YET MEASURED on this frame; '
      + 'renderGlobe() counts it and it appears here after the first draw.');
  L.push(`mode period n = ${modeN}: closed form ${(closed / 3600).toFixed(4)} h from `
    + 'omega^2 = g H n(n+1)/R^2 -- DERIVED (spherical Laplacian eigenvalue -n(n+1)/R^2), '
    + 'no citation retrieved;'
    + (bed.relief > 1
      ? ` NOTE: derived for UNIFORM depth, and this bed has ${bed.relief.toFixed(0)} m of relief, so`
        + ' it does not describe the run on screen. The measurement below builds its own flat ocean.'
      : ''));
  L.push(merian
    ? `    measured on this grid ${(merian.measured / 3600).toFixed(4)} h, `
      + `${(100 * merian.rel).toFixed(4)}%${merian.note ? '   ' + merian.note : ''}`
    : '    NOT YET MEASURED on this grid -- press "measure mode period" (or run '
      + '`node src/globe.mjs merian`).');
  const tax = polarTimestepTax(sim, H);
  L.push(`polar timestep tax: dt = ${tax.pole.toFixed(2)} s in the last row (lat `
    + `${tax.poleLat.toFixed(1)} deg) against ${tax.eq.toFixed(2)} s at the equator, a factor `
    + `${tax.ratio.toFixed(1)}.`);
  // MEASURED, not the setting. The page asks for a fixed slice of simulated time
  // per animation frame and gets whatever the machine can deliver, so the honest
  // number is simulated seconds per wall-clock second, timed.
  L.push(compression
    ? `time compression: measured ${compression.toFixed(0)}x (simulated seconds per wall-clock `
      + 'second). THE SPIN IS A CAMERA, not planetary rotation: the viewpoint moves in longitude,'
      + (g.omega ? ' the planet does not turn.' : ' the planet does not turn, and Omega is 0.')
    : 'time is compressed and THE SPIN IS A CAMERA, not planetary rotation: the viewpoint moves '
      + 'in longitude, the planet does not turn.');
  // px per degree of arc at the CENTRE of the disc, where the orthographic scale
  // is r pixels per radian. NOT diameter/180: the diameter spans 180 degrees only
  // limb to limb, and along that line the scale is a sine and not a constant --
  // the same mistake the rejected strip warp makes, and it overstates this figure
  // by 55%. `discR` is the RADIUS the camera actually used, not half the buffer:
  // the disc is inset by a margin, and taking half the buffer overstates it by
  // another 6%. Zero means no frame has been drawn, so there is no radius to use.
  const pxPerDeg = D2R * discR;
  const cs = coastalScaleFacts(gRef, g.R);
  const wide = cs.reduce((a, s) => (s.Lx > a.Lx ? s : a));
  const narrow = cs.reduce((a, s) => (s.Lx < a.Lx ? s : a));
  const cRef = Math.sqrt(gRef * H);
  L.push(`this repo's coastal fields are ${(narrow.Lx / 1000).toFixed(2)}-`
    + `${(wide.Lx / 1000).toFixed(2)} km across = ${narrow.arcX.toFixed(4)}-${wide.arcX.toFixed(4)} `
    + 'deg of arc = '
    + (discR > 0
      ? `${(narrow.arcX * pxPerDeg).toFixed(3)}-${(wide.arcX * pxPerDeg).toFixed(3)} px at this `
        + `disc's r = ${discR.toFixed(0)} px. NOT DRAWN, and this is what drawing one would cost:`
      : 'NOT YET MEASURABLE in px -- this disc\'s radius is read off the camera after the first '
        + 'frame. NOT DRAWN, and this is what drawing one would cost:'));
  for (const s of cs) {
    L.push(`    ${s.name} ${(s.Lx / 1000).toFixed(2)} x ${(s.Ly / 1000).toFixed(2)} km needs `
      + `x${Math.round(s.fLon).toLocaleString('en-US')} in longitude and `
      + `x${Math.round(s.fLat).toLocaleString('en-US')} in latitude -- longitude spans 2piR and `
      + `latitude piR, so it SHEARS ${s.shear.toFixed(2)}x -- and its ${s.depth} m crest `
      + `(c ${s.c.toFixed(2)} m/s) would cross at ${(s.crest / 1000).toFixed(0)} km/s against a `
      + `${H} m ocean's ${cRef.toFixed(0)} m/s, ${Math.round(s.crest / cRef)}x too fast.`);
  }
  return L;
}

/**
 * What the bed actually IS, over the interior cells: relief, extremes, how many
 * cells are dry, and how high the highest sampled point stands. One pass over
 * nx*ny, called once per readout.
 *
 * `crest` is the highest bed a CELL CENTRE saw, which is not the analytic peak of
 * an analytic bed: at 4 degrees the seamount here samples 1095 m of a 1200 m
 * summit and at 2 degrees it samples 1173 m. The label quotes what the solver has,
 * not what the formula meant.
 */
export function surveyBed(sim) {
  const g = gridOf(sim);
  let min = Infinity, max = -Infinity, dry = 0, crest = -Infinity;
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      const k = sim.idx(i, j), b = sim.b[k];
      if (b < min) min = b;
      if (b > max) max = b;
      if (sim.h[k] <= sim.minDepth) { dry++; if (b > crest) crest = b; }
    }
  }
  return { min, max, relief: max - min, dry, crest: dry ? crest : NaN };
}

/**
 * The cost of the lat-lon grid at the pole, measured off this sim's own metric
 * rather than quoted: the CFL step a uniform-depth ocean allows in the last
 * interior row against the one it allows at the equator.
 */
export function polarTimestepTax(sim, H = 4000) {
  const g = sim.geom, ng = g.ng, G_LOCAL = 9.80665;
  const c = Math.sqrt(G_LOCAL * H);
  const dtOf = (j) => sim.cfl / (c / g.dxRow[j] + c / g.dyCFL[j]);
  let eqJ = ng, best = Infinity;
  for (let j = ng; j < g.H - ng; j++) {
    const a = Math.abs(g.phiC[j]);
    if (a < best) { best = a; eqJ = j; }
  }
  // The row with the smallest step, which is the last one unless the domain is
  // capped, in which case it is still the last one -- but say which it is.
  let worstJ = ng;
  for (let j = ng; j < g.H - ng; j++) if (dtOf(j) < dtOf(worstJ)) worstJ = j;
  const eq = dtOf(eqJ), pole = dtOf(worstJ);
  return { eq, pole, ratio: eq / pole, poleLat: g.phiC[worstJ] * R2D, eqLat: g.phiC[eqJ] * R2D };
}

// ---------------------------------------------------------------------------
// Beds and initial states. Analytic, so nothing here needs a data file.
// ---------------------------------------------------------------------------

/**
 * @property depth  the uniform depth the aquaplanet is built on [m]
 * Each bed is (lonDeg, latDeg) -> bed elevation [m], positive up, so a 4000 m
 * ocean has a bed at -4000.
 */
export const GLOBE_BEDS = {
  flat: {
    title: 'aquaplanet — flat bed, uniform 4000 m',
    note: 'uniform depth 4000 m everywhere; this is the case the closed-form mode period assumes',
    bed: () => -4000,
  },
  zonalRidge: {
    title: 'zonal ridge — 2500 m sill at 18 N',
    note: 'an east-west ridge, 2500 m of relief, crest 1500 m below the surface: submarine, no coastline',
    bed: (lon, lat) => -4000 + 2500 * Math.exp(-(((lat - 18) / 7) ** 2)),
  },
  seamount: {
    title: 'Gaussian seamount — pierces the surface',
    note: 'one seamount at 30 N 40 W, crest 1200 m ABOVE sea level, so there are dry cells and a '
      + 'moving shoreline. Sized to be RESOLVED rather than merely present: sub-aerial out to 10.1 '
      + 'deg of arc, 20.3 deg across = 5.1 cells at 4 deg and 119 px on a 671 px disc. Measured dry '
      + 'cells: 16 at 4 deg, 36 at 3, 80 at 2; sampled crest 1095 m at 4 deg rising to 1173 m at 2, '
      + 'because a coarse grid never samples the peak. The first version was sigma 9 with a 350 m '
      + 'crest and gave FOUR dry cells -- a coastline the picture cannot resolve, which is the same '
      + 'mistake as drawing the coastal shorelines here',
    bed: (lon, lat) => {
      const dl = wrapLon(lon + 40), dp = lat - 30;
      return -4000 + 5200 * Math.exp(-((dl * dl + dp * dp) / (2 * 14 * 14)));
    },
  },
  williamsonCone: {
    title: 'Williamson-case-5-STYLE cone (UNVERIFIED shape)',
    note: 'conical, radius 20 deg of arc, 2000 m tall, centred 30 N 90 W. The SHAPE is quoted from '
      + 'memory of Williamson et al. 1992 case 5 and was NOT checked against the paper in this '
      + 'session: treat the geometry as UNVERIFIED, and note that case 5 is a 5960 m fluid with a '
      + 'rotating frame, which this is not',
    bed: (lon, lat) => {
      const dl = wrapLon(lon + 90), dp = lat - 30;
      const rr = Math.min(20, Math.hypot(dl, dp));
      return -4000 + 2000 * (1 - rr / 20);
    },
  },
};

/** Legendre P_n(x), written out rather than recursed: n is 2, 3 or 4 here. */
export function legendreP(n, x) {
  if (n === 2) return 0.5 * (3 * x * x - 1);
  if (n === 3) return 0.5 * (5 * x * x * x - 3 * x);
  if (n === 4) return (35 * x ** 4 - 30 * x * x + 3) / 8;
  throw new Error(`legendreP: n = ${n} is not one of 2, 3, 4. n = 1 is a rigid translation of `
    + 'the shell and has no restoring force, n = 0 is a change of total volume.');
};

/**
 * Initial free surfaces. Each is (amp) -> (lonDeg, latDeg) -> eta [m].
 *
 * The zonal modes Y(n,0) = P_n(sin lat) are here because they are the ONE thing
 * on a sphere with a closed-form period: the spherical Laplacian's eigenvalue is
 * -n(n+1)/R^2, so linearising about rest at uniform depth H gives
 * omega^2 = g H n(n+1)/R^2 and the field must oscillate in place without
 * travelling. n = 1 is excluded: it is a rigid translation of the whole shell,
 * with nothing to restore it.
 */
export const GLOBE_INITS = {
  still: { title: 'still — nothing moves', mode: 0, eta: () => () => 0 },
  mode2: { title: 'mode P2(sin lat) — closed-form period', mode: 2, eta: (a) => (lon, lat) => a * legendreP(2, Math.sin(lat * D2R)) },
  mode3: { title: 'mode P3(sin lat)', mode: 3, eta: (a) => (lon, lat) => a * legendreP(3, Math.sin(lat * D2R)) },
  mode4: { title: 'mode P4(sin lat)', mode: 4, eta: (a) => (lon, lat) => a * legendreP(4, Math.sin(lat * D2R)) },
  blob: {
    title: 'blob — a 12 deg Gaussian at 20 N, 0 E',
    mode: 0,
    eta: (a) => (lon, lat) => {
      const dl = wrapLon(lon), dp = lat - 20;
      return a * Math.exp(-((dl * dl + dp * dp) / (2 * 12 * 12)));
    },
  },
};

/** Add a Gaussian bump in place, so a click on the globe can drop a stone. */
export function dropBump(sim, lonDeg, latDeg, { amp = 1, sigmaDeg = 8 } = {}) {
  const g = gridOf(sim);
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      const [lo, la] = sim.cellLonLat(i, j);
      const dl = wrapLon(lo - lonDeg), dp = la - latDeg;
      const e = amp * Math.exp(-((dl * dl + dp * dp) / (2 * sigmaDeg * sigmaDeg)));
      const k = sim.idx(i, j);
      if (sim.h[k] > sim.minDepth) sim.h[k] += e;
    }
  }
}

// ---------------------------------------------------------------------------
// The canvas view. Everything above is pure; only this part needs a DOM.
// ---------------------------------------------------------------------------

export class GlobeView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.scale = 0.5;              // metres of elevation at full colour
    this.tiltDeg = 22;
    this.rotDeg = 0;
    this.spinDegPerSec = 6;
    this.graticule = true;
    this.terminator = true;
    this.landLight = true;
    this.label = [];               // set by the page from globeLabel()
    this.exaggeration = null;      // read by the shared readout; a globe has none
    this.discPx = 0;              // last disc size in px, read by the page's label
    // The RADIUS the camera used. ZERO until the first draw, and that is the
    // point: it used to default to 350, globeLabel() defaulted to 350 as well, and
    // the suite then asserted a "0.140-0.172 px at this disc's r = 350 px" string
    // that never once appeared on screen -- index.html passes this field, and the
    // page's disc is 658 px, so the label really reads r = 309 px. A radius nobody
    // measured is not a radius; globeLabel() prints "not yet measured" for 0.
    this.discR = 0;
    // The last frame's renderGlobe() stats, so the page can put the MEASURED
    // saturated fraction on the label instead of a claim about the ramp.
    this.stats = null;
    this._lut = null;
  }

  /** CSS pixels -> device pixels, capped. See the note on MAX_SIZE. */
  resize() {
    // `typeof window` rather than a bare `window`, so draw() runs headlessly
    // against a stand-in canvas. Section 8 needs that: nothing in this file used
    // to gate draw() at all, so a vignette inserted between renderGlobe() and
    // putImageData() passed every check the suite had.
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.dpr = dpr; this.w = w; this.h = h;
  }

  /**
   * Draw the sphere, then the marks, then the label.
   *
   * The label gets a GUTTER rather than an overlay. A translucent panel over the
   * disc would sit on top of the field, and the one thing this file will not do
   * is put anything over the water that a reader has to mentally subtract.
   */
  draw(sim, { msl = 0 } = {}) {
    this.resize();
    const ctx = this.ctx, dpr = this.dpr;
    const lineH = Math.round(13 * dpr), pad = Math.round(10 * dpr);
    const gutter = this.label.length ? this.label.length * lineH + 2 * pad : 0;
    // MAX_SIZE: the table costs 20 bytes per modelled pixel and the frame buffer
    // 4 per buffer pixel, so a 1400 px disc retains 33.4 MB (measured: 1,360,172
    // modelled pixels). Capped, and the cap is stated rather than discovered --
    // above this the disc stops growing and stays centred. 1400 is what a 700 px
    // CSS square gives on a devicePixelRatio-2 display, so this is a ceiling on
    // the plausible rather than a restriction on the useful.
    const MAX_SIZE = 1400;
    const size = Math.max(64, Math.min(MAX_SIZE, this.w, this.h - gutter));
    const ox = Math.round(0.5 * (this.w - size)), oy = 0;

    const cam = globeCamera({ size, tiltDeg: this.tiltDeg, rotDeg: this.rotDeg });
    const grid = gridOf(sim);
    const key = lutKey(cam, grid);
    if (!this._lut || this._lut.key !== key) {
      this._lut = buildGlobeLut(cam, grid);
      this._img = ctx.createImageData(size, size);
    }
    this.discPx = size;
    this.discR = cam.r;
    this._last = { cam, ox, oy, size };
    // STRAIGHT INTO THE ImageData. Its .data IS a Uint8ClampedArray, which is what
    // renderGlobe() writes, so rendering into a scratch buffer and copying it here
    // would be a second 1.8 MB memcpy per frame (671 px disc) for nothing. The
    // headless path passes its own array to the same function.
    this.stats = renderGlobe(this._img.data, sim, {
      lut: this._lut, rotDeg: this.rotDeg, scale: this.scale, msl, landLight: this.landLight,
    });

    ctx.fillStyle = '#080b10';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.putImageData(this._img, ox, oy);

    // ---- marks -----------------------------------------------------------
    ctx.save();
    ctx.translate(ox, oy);
    if (this.graticule) this._graticule(ctx, cam, grid, dpr);
    if (this.terminator && this.landLight) this._terminator(ctx, cam, this._lut.sun, dpr);
    // The limb: a 1 px stroke ON the edge. It covers water pixels, and the
    // header says so; at the limb a pixel spans many cells and carried no
    // readable value.
    ctx.beginPath();
    ctx.arc(cam.cx, cam.cy, cam.r, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(150,200,230,0.55)';
    ctx.lineWidth = 1.1 * dpr;
    ctx.stroke();
    ctx.restore();

    // ---- label -----------------------------------------------------------
    if (gutter) {
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, this.h - gutter, this.w, gutter);
      ctx.strokeStyle = '#243040';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, this.h - gutter + 0.5); ctx.lineTo(this.w, this.h - gutter + 0.5); ctx.stroke();
      ctx.font = `${Math.round(10.5 * dpr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textBaseline = 'top';
      for (let i = 0; i < this.label.length; i++) {
        const s = this.label[i];
        ctx.fillStyle = /NOT SHADED|AQUAPLANET|NOT DRAWN|UNVERIFIED/.test(s)
          ? '#e8b45c' : '#8fa0b4';
        ctx.fillText(s, pad, this.h - gutter + pad + i * lineH);
      }
    }
  }

  /**
   * Screen coordinates (CSS pixels, as an event reports them) -> [lon, lat], or
   * null outside the disc.
   *
   * Runs the same orthoInversePixel() the frame loop's table was baked from, on
   * the camera the last draw() actually used -- so a click and a pixel cannot
   * disagree about where they are. The dpr and gutter arithmetic lives here rather
   * than in the page because getting it wrong is invisible: the bump simply lands
   * somewhere slightly else, and there is nothing to compare it against.
   */
  pickLonLat(clientX, clientY) {
    if (!this._last) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * (this.canvas.width / rect.width) - this._last.ox;
    const y = (clientY - rect.top) * (this.canvas.height / rect.height) - this._last.oy;
    const q = orthoInversePixel(Math.floor(x), Math.floor(y), this._last.cam);
    return q === null ? null : [wrapLon(q[0]), q[1]];
  }

  /** Meridians and parallels at fixed GEOGRAPHIC positions, so they turn with
   *  the planet. Plus the cap edges when the domain is capped, because the edge
   *  of what is simulated is worth a line of its own. */
  _graticule(ctx, cam, grid, dpr) {
    ctx.lineWidth = 0.9 * dpr;
    const path = (pts) => {
      ctx.beginPath();
      let down = false;
      for (const q of pts) {
        if (!q.vis) { down = false; continue; }
        if (!down) { ctx.moveTo(q.px, q.py); down = true; } else ctx.lineTo(q.px, q.py);
      }
      ctx.stroke();
    };
    ctx.strokeStyle = 'rgba(190,215,235,0.16)';
    for (let lon = -180; lon < 180; lon += 30) {
      const pts = [];
      for (let lat = -90; lat <= 90; lat += 2) pts.push(orthoProject(lon, lat, cam));
      path(pts);
    }
    for (const lat of [-60, -30, 30, 60]) {
      const pts = [];
      for (let lon = -180; lon <= 180; lon += 2) pts.push(orthoProject(lon, lat, cam));
      path(pts);
    }
    ctx.strokeStyle = 'rgba(190,215,235,0.30)';
    const eq = [];
    for (let lon = -180; lon <= 180; lon += 2) eq.push(orthoProject(lon, 0, cam));
    path(eq);
    const capped = !(grid.lat0 <= -90 + 1e-9 && grid.lat1 >= 90 - 1e-9);
    if (capped) {
      ctx.strokeStyle = 'rgba(232,180,92,0.55)';
      ctx.lineWidth = 1.2 * dpr;
      for (const lat of [grid.lat0, grid.lat1]) {
        const pts = [];
        for (let lon = -180; lon <= 180; lon += 2) pts.push(orthoProject(lon, lat, cam));
        path(pts);
      }
    }
  }

  /**
   * The terminator as a LINE.
   *
   * The set of surface points where the light grazes is the great circle
   * perpendicular to the light direction. Parametrise it with two unit vectors
   * spanning that plane and project each point; draw only the near half. Nothing
   * is shaded by this -- it marks where the LAND lighting turns over, and with
   * Omega = 0 there is no day and night for it to mean.
   */
  _terminator(ctx, cam, sun, dpr) {
    const s = sun;
    let a = Math.abs(s[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let u = cross(a, s); u = norm3(u);
    const v = norm3(cross(s, u));
    ctx.beginPath();
    ctx.setLineDash([3 * dpr, 4 * dpr]);
    let down = false;
    for (let i = 0; i <= 180; i++) {
      const th = (i / 180) * 2 * Math.PI;
      const c = Math.cos(th), sn = Math.sin(th);
      const p = [u[0] * c + v[0] * sn, u[1] * c + v[1] * sn, u[2] * c + v[2] * sn];
      if (p[2] < 0) { down = false; continue; }
      const px = cam.cx + cam.r * p[0], py = cam.cy - cam.r * p[1];
      if (!down) { ctx.moveTo(px, py); down = true; } else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = 'rgba(232,180,92,0.35)';
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm3(v) { const m = Math.hypot(v[0], v[1], v[2]); return [v[0] / m, v[1] / m, v[2] / m]; }

// ---------------------------------------------------------------------------
// The one physical claim the label makes, measured.
// ---------------------------------------------------------------------------

/**
 * Period of the zonal mode Y(n,0) on a uniform-depth sphere, measured by
 * projection and compared against a closed form the CALLER declares g for.
 *
 * THE CLOSED FORM IS DERIVED, NOT CITED. Linearise the shallow-water equations
 * about a resting ocean of uniform depth H on a non-rotating sphere: the
 * momentum equation is du/dt = -g grad(eta) and continuity is
 * d(eta)/dt = -H div(u), so d2(eta)/dt2 = g H laplacian_s(eta). The spherical
 * Laplacian's eigenfunctions are the surface harmonics, with
 * laplacian_s Y(n,m) = -n(n+1)/R^2 Y(n,m), hence
 *
 *     omega^2 = g H n(n+1) / R^2.
 *
 * That result is textbook, but no primary source was retrieved for it in this
 * session, so it is presented as the derivation above and NOT as a citation.
 *
 * `gRef` is REQUIRED. Building the target out of the solver's own G is the
 * g x 1.1 disease: a gravity wrong by 10% moves the prediction as far as it moves
 * the measurement and the relative error never budges. The caller declares its
 * own constant and, if it wants the comparison to mean anything, checks the
 * solver's G against it separately.
 *
 * The period comes from interpolated zero crossings of the area-weighted
 * projection of eta onto P_n, which is the amplitude of the mode itself rather
 * than the value at a probe point: a probe sits at a nodal latitude for some n
 * and measures nothing.
 */
export function measureModePeriod({
  n = 2, deg = 6, H = 4000, R = 6371e3, gRef, amp = 1, periods = 2, cfl = 0.45,
  lat0 = -90, lat1 = 90, order = 2, onProgress = null,
}) {
  if (!(gRef > 0)) {
    throw new Error('measureModePeriod: gRef is required. A closed form built from the '
      + "solver's own G rescales with any error in it and can never detect one.");
  }
  const nx = Math.round(360 / deg), ny = Math.round((lat1 - lat0) / deg);
  const closed = 2 * Math.PI * R / Math.sqrt(gRef * H * n * (n + 1));
  const sim = new ShallowWater({
    nx, ny, bed: () => -H, manning: 0, cfl, order,
    eta0: (lon, lat) => amp * legendreP(n, Math.sin(lat * D2R)),
    sphere: { R, lat0, lat1, omega: 0 },
  });
  // Projection weights: area per cell times P_n at the cell's latitude. The
  // normalisation cancels in a zero crossing, but it is kept so the series is an
  // amplitude in metres and a caller can see it decay.
  const g = sim.geom, ng = g.ng;
  const wRow = new Float64Array(g.ny), pRow = new Float64Array(g.ny);
  let norm = 0;
  for (let j = 0; j < g.ny; j++) {
    const P = legendreP(n, Math.sin(g.phiC[j + ng]));
    pRow[j] = P; wRow[j] = g.area[j + ng] * nx;
    norm += wRow[j] * P * P;
  }
  const project = () => {
    let s = 0;
    for (let j = 0; j < g.ny; j++) {
      let row = 0;
      for (let i = 0; i < nx; i++) row += sim.b[sim.idx(i, j)] + sim.h[sim.idx(i, j)];
      s += (wRow[j] / nx) * pRow[j] * row;
    }
    return s / norm;
  };
  const tEnd = periods * closed;
  const cross = [];
  let prevT = 0, prevC = project(), steps = 0;
  const c0 = prevC;
  while (sim.t < tEnd) {
    const dt = Math.min(sim.maxDt(), tEnd - sim.t);
    if (!(dt > 0)) break;
    sim.step(dt);
    steps++;
    const c = project();
    if ((prevC < 0) !== (c < 0)) {
      // Linear interpolation between the two samples that straddle zero.
      cross.push(prevT + (sim.t - prevT) * (0 - prevC) / (c - prevC));
    }
    prevT = sim.t; prevC = c;
    if (onProgress && (steps % 200) === 0) onProgress(sim.t / tEnd);
  }
  if (cross.length < 2) {
    return { measured: NaN, closed, rel: NaN, steps, crossings: cross.length, amp0: c0,
      ampEnd: prevC, note: 'fewer than two zero crossings: nothing to measure' };
  }
  const measured = 2 * (cross[cross.length - 1] - cross[0]) / (cross.length - 1);
  return {
    measured, closed, rel: (measured - closed) / closed, steps, crossings: cross.length,
    amp0: c0, ampEnd: prevC, nx, ny, deg,
    note: `${cross.length} crossings, ${steps} steps, amplitude ${c0.toFixed(4)} -> `
      + `${prevC.toFixed(4)} m`,
  };
}

// ---------------------------------------------------------------------------
// CHECKS. See the header for why they live here and not in tools/.
// ---------------------------------------------------------------------------

/**
 * Reference constants, declared HERE. Never imported from the module under test:
 * a target built from the subject's own constant moves with the subject's bugs.
 */
const G_REF = 9.80665;
const R_REF = 6371e3;
/** The land ramp's endpoints, DECLARED rather than imported, for the same reason.
 *  Straight in sRGB bytes from bed = 0 to LAND_SAT_REF metres, clamped at both. */
const LAND_SAT_REF = 2500;
const LAND_LO_REF = [92, 84, 70];
const LAND_HI_REF = [188, 172, 144];
/** The default light direction, declared and normalised here. */
const SUN_REF = (() => {
  const v = [-0.42, 0.48, 0.77], m = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
})();

/**
 * THE PAGE'S OWN DEFAULTS: the slider POSITIONS index.html ships with, and the
 * arithmetic it turns them into metres and degrees with. Declared here as a
 * target, and then GATED against index.html itself -- pageDefaults() reads the
 * file off the disk beside src/ and check 9 compares every field.
 *
 * WHY IT IS NOT THREE NUMBERS ANY MORE. Check 9's headline claim is that the
 * header's saturation table is "reproduced at the page's own defaults", and the
 * defaults it reproduced were three constants written into the check --
 *
 *     const PAGE_SIZE = 658, PAGE_DEG = 4, PAGE_SCALE = 0.5;
 *
 * -- a HAND COPY of index.html's slider attributes, with nothing anywhere in the
 * tree reading index.html at all. Measured, one edit at a time, against the
 * suites as they stood:
 *
 *   edit to index.html   what the page really did       what the suites said
 *   GS value 5 -> 10     colour scale 0.50 -> 1.00 m    globe 108/108, render 115/115
 *   GD value 1 -> 2      grid 4 deg -> 3 deg            globe 108/108, render 115/115
 *   GA value 10 -> 20    amplitude 0.50 -> 1.00 m       globe 108/108, render 115/115
 *
 * Three edits that each falsify the claim, and the check that makes the claim
 * could not see one of them. It is the same defect frameLon() was extracted for
 * -- a check verifying its own copy of the thing it is about -- and it takes the
 * same remedy: one source of truth, read rather than remembered.
 *
 * THE ARITHMETIC IS PART OF THE COPY, not just the value= attributes. The page
 * turns GA into metres by `/ 20` and GS by `/ 10`, and GD into degrees through
 * its own GLOBE_DEG table, so all of that is declared here and all of it is
 * compared: `/ 20` becoming `/ 40` is caught as well as value="10" becoming
 * value="20".
 *
 * NOT IN HERE, ON PURPOSE: the 658 px disc. That is not a page default. The
 * canvas is width:100%, so the disc is whatever the window gives, and 658 px is
 * one real measured case which the header names as such. It is a CONDITION of
 * the published percentages rather than a setting, so check 9 states it and pins
 * the water-pixel count it implies; there is no attribute in index.html it could
 * be read from.
 */
const PAGE_REF = {
  GA: 10, GA_MAX: 40, AMP_DIV: 20,   // amplitude slider -> metres of eta
  GS: 5, SCALE_DIV: 10,              // colour scale slider -> metres at full colour
  GD: 1, DEG: [6, 4, 3, 2],          // grid slider -> degrees per cell
  GC: 0, CAP: [90, 80, 70],          // latitude cap slider -> degrees
  GT: 22,                            // view latitude slider -> degrees
  INIT: 'mode2',                     // the initial-surface select's assigned default
  BED_DEPTH: 4000,                   // the bed select's default is its FIRST option
  BUMP_AMP: 1, BUMP_SIGMA: 8,        // one click on the globe
};

/**
 * index.html, read off the disk NEXT TO src/ -- the file the browser loads, not
 * a copy of it. Node only, and reached through `process.getBuiltinModule` rather
 * than an `import`: the page loads this module, and a top-level `import 'node:fs'`
 * is a request the browser would issue and fail.
 *
 * Returns { file, src } with src === null when the file is not there, and it is
 * not always there: tools/mutants.mjs copies src/ and tools/ into a scratch tree
 * and runs this suite from inside it, where there is no page at all. That case
 * is reported as SKIPPED, with the path that was searched, and never as a pass.
 * The distinction that has to hold is between "the artefact is absent" and "the
 * artefact is here and does not say what the check says it says" -- the second
 * is a FAILURE, and so is a page that is here but cannot be parsed.
 */
function readPageSource() {
  if (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') return null;
  const fs = process.getBuiltinModule('node:fs');
  // fileURLToPath, NOT url.pathname: this repository's path has a space in it,
  // which import.meta.url percent-encodes, and on Windows the pathname carries a
  // leading slash in front of the drive letter. Same class of bug as the
  // `new URL('file://' + argv[1])` one the run guard at the foot of this file
  // exists to avoid, and it bites in the same two places.
  const { fileURLToPath } = process.getBuiltinModule('node:url');
  const file = fileURLToPath(new URL('../index.html', import.meta.url));
  return { file, src: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
}

/**
 * What index.html ACTUALLY says its defaults are. Every lookup has to hit
 * exactly once: a miss, a duplicate or an unparseable number THROWS, and the
 * caller turns that into a failing check. A page that has been restructured
 * until this cannot read it is a page whose defaults nothing is checking, which
 * is the state this whole function exists to end.
 */
function pageDefaults(src) {
  const inputTag = (id) => {
    const tags = src.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`, 'g')) || [];
    if (tags.length !== 1) {
      throw new Error(`${tags.length} <input id="${id}"> tags in index.html, want exactly 1`);
    }
    return tags[0];
  };
  const attr = (id, name) => {
    const m = inputTag(id).match(new RegExp(`\\b${name}="([^"]*)"`));
    if (!m) throw new Error(`<input id="${id}"> carries no ${name}= attribute`);
    return m[1];
  };
  const numAttr = (id, name) => {
    const raw = attr(id, name), v = Number(raw);
    if (!isFinite(v)) throw new Error(`<input id="${id}"> ${name}="${raw}" is not a number`);
    return v;
  };
  // The divisor the page turns a slider position into metres with, taken from
  // EVERY place it does it -- the renderer's copy and the readout's copy have to
  // agree with each other as well as with PAGE_REF, or the number under the
  // slider is not the number the picture was drawn at.
  const divisor = (id) => {
    const all = [...src.matchAll(new RegExp(`\\+\\$\\('${id}'\\)\\.value\\s*/\\s*(\\d+(?:\\.\\d+)?)`, 'g'))]
      .map((m) => Number(m[1]));
    if (!all.length) throw new Error(`index.html never divides $('${id}').value by anything`);
    if (all.some((v) => v !== all[0])) {
      throw new Error(`index.html divides $('${id}').value by ${[...new Set(all)].join(' and ')}`);
    }
    return all[0];
  };
  const table = (name, sliderId) => {
    const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`));
    if (!m) throw new Error(`index.html has no ${name} table`);
    if (!new RegExp(`${name}\\[\\+\\$\\('${sliderId}'\\)\\.value\\]`).test(src)) {
      throw new Error(`index.html does not index ${name} with $('${sliderId}').value`);
    }
    return m[1].split(',').map((s) => Number(s.trim()));
  };
  const bump = src.match(
    /dropBump\(\s*sim\s*,\s*q\[0\]\s*,\s*q\[1\]\s*,\s*\{\s*amp:\s*([\d.]+)\s*,\s*sigmaDeg:\s*([\d.]+)\s*\}\s*\)/);
  if (!bump) throw new Error('index.html has no dropBump(sim, q[0], q[1], { amp, sigmaDeg }) click handler');
  const init = src.match(/\$\('ginit'\)\.value\s*=\s*'([^']+)'/);
  if (!init) throw new Error("index.html never assigns $('ginit').value");
  return {
    GA: numAttr('GA', 'value'), GA_MAX: numAttr('GA', 'max'), AMP_DIV: divisor('GA'),
    GS: numAttr('GS', 'value'), SCALE_DIV: divisor('GS'),
    GD: numAttr('GD', 'value'), DEG: table('GLOBE_DEG', 'GD'),
    GC: numAttr('GC', 'value'), CAP: table('GLOBE_CAP', 'GC'),
    GT: numAttr('GT', 'value'),
    INIT: init[1],
    // The BED select is never assigned, so the browser shows its first <option>
    // and the options are appended in GLOBE_BEDS key order. An assignment would
    // change which bed the published table was measured over, so it is the
    // ABSENCE of one that has to be checked.
    bedAssigned: /\$\('gbed'\)\.value\s*=/.test(src),
    // Coriolis off is the case the closed-form period assumes and the case the
    // table was rendered in. A `checked` here would make it a different ocean.
    omegaChecked: /\bchecked\b/.test(inputTag('gomega')),
    BUMP_AMP: Number(bump[1]), BUMP_SIGMA: Number(bump[2]),
  };
}

/**
 * A canvas 2D context STAND-IN, so GlobeView.draw() can be run and measured with
 * no DOM.
 *
 * Nothing used to gate draw() at all. Every check went through renderGlobe(), so
 * a 45% radial vignette dropped in between renderGlobe() and putImageData()
 * passed the whole suite -- and a vignette over the water is the exact thing the
 * header spends two pages refusing. The graticule, the limb stroke and the
 * terminator had no coverage of any kind for the same reason: they are ctx calls,
 * and there was no ctx.
 *
 * It RECORDS rather than rasterises. A recording is the right instrument here:
 * the question about a mark is "is it at the position it claims", which is
 * answered by inverting the coordinates it was drawn at, not by looking at
 * pixels. putImageData COPIES the buffer it is handed, so a mutation applied to
 * the ImageData before the call is captured, which is the whole point of 8.1.
 *
 * It holds no timer, no worker and no external handle -- it is a plain object, so
 * importing it cannot keep a process alive.
 */
function stubCanvas(cssW, cssH) {
  const calls = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textBaseline: '',
    createImageData(w, h) {
      calls.push(['createImageData', w, h]);
      return { width: w, height: h, data: new Uint8ClampedArray(4 * w * h) };
    },
    putImageData(img, ox, oy) {
      calls.push(['putImageData', Uint8ClampedArray.from(img.data), img.width, ox, oy]);
    },
    fillRect(...a) { calls.push(['fillRect', ...a]); },
    beginPath() { calls.push(['beginPath']); },
    moveTo(x, y) { calls.push(['moveTo', x, y]); },
    lineTo(x, y) { calls.push(['lineTo', x, y]); },
    arc(...a) { calls.push(['arc', ...a]); },
    stroke() { calls.push(['stroke', this.strokeStyle, this.lineWidth]); },
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    translate(x, y) { calls.push(['translate', x, y]); },
    setLineDash(d) { calls.push(['setLineDash', Array.from(d)]); },
    fillText(s, x, y) { calls.push(['fillText', s, x, y]); },
  };
  const canvas = {
    clientWidth: cssW, clientHeight: cssH, width: 0, height: 0, getContext: () => ctx,
  };
  return { canvas, ctx, calls, reset() { calls.length = 0; } };
}

/** sRGB bytes as ImageData would store them: ASSIGNED into a Uint8ClampedArray,
 *  never Math.round -- the two disagree on exact halves. */
function bytes3(c) {
  const u = new Uint8ClampedArray(3);
  u[0] = c[0]; u[1] = c[1]; u[2] = c[2];
  return u;
}

/** The land ramp's target, from the locally declared endpoints. Unrounded, so a
 *  caller can multiply by the light before quantising, exactly as the frame does. */
function refLandRaw(bedM) {
  const t = Math.max(0, Math.min(1, bedM / LAND_SAT_REF));
  return [
    LAND_LO_REF[0] + (LAND_HI_REF[0] - LAND_LO_REF[0]) * t,
    LAND_LO_REF[1] + (LAND_HI_REF[1] - LAND_LO_REF[1]) * t,
    LAND_LO_REF[2] + (LAND_HI_REF[2] - LAND_LO_REF[2]) * t,
  ];
}

export function globeChecks(filter = null) {
  const SECTIONS = ['projection', 'mask', 'sampling', 'lut', 'colour', 'shading',
    'field', 'marks', 'saturation', 'label', 'merian'];
  // A COMMA-SEPARATED LIST is accepted, because `merian` alone costs 13 of the
  // suite's 15 seconds and a mutation sweep that has to pay it for every mutant
  // is a sweep nobody runs. Every name still has to exist: an unknown one is an
  // ERROR, not a silent 0/0, and that holds for each element of the list.
  const want = filter === null ? null : String(filter).split(',').map((s) => s.trim()).filter(Boolean);
  if (want !== null) {
    const bad = want.filter((s) => !SECTIONS.includes(s));
    if (bad.length || want.length === 0) {
      // An unknown filter must be an ERROR. "ALL PASS 0/0" from a typo is a suite
      // that reports success for having done nothing.
      console.error(`unknown section${bad.length > 1 ? 's' : ''} "${bad.join('", "') || filter}"; `
        + `have: ${SECTIONS.join(', ')}`);
      return { checks: 0, failures: 1 };
    }
  }
  let checks = 0, failures = 0, skipped = 0;
  const run = (s) => want === null || want.includes(s);
  const fmt = (v) => {
    if (v === 0) return '0';
    if (!isFinite(v)) return String(v);
    const a = Math.abs(v);
    return (a < 1e-3 || a >= 1e5) ? v.toExponential(4) : v.toFixed(6);
  };
  const assert = (label, ok, note = '') => {
    checks++; if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)}${note ? '  ' + note : ''}`);
  };
  // A check that CANNOT BE RUN in this tree is neither a pass nor a failure, and
  // it may not be silent: it prints, it is counted, and the count rides on the
  // summary line beside the passes. The only thing that reaches this is an
  // artefact that is missing rather than wrong -- see readPageSource(). A
  // malformed artefact FAILS, because a file that is present is a file the claim
  // can be checked against.
  const skip = (label, why) => {
    skipped++;
    console.log(`  SKIP  ${label.padEnd(56)}  ${why}`);
  };
  const near = (label, got, want, tol, note = '') => {
    const rel = Math.abs(want) > 1e-12 ? Math.abs(got - want) / Math.abs(want) : Math.abs(got - want);
    assert(label, rel <= tol, `got ${fmt(got)}  want ${fmt(want)}  rel ${(100 * rel).toFixed(4)}%  `
      + `tol ${(100 * tol).toFixed(4)}%${note ? '   ' + note : ''}`);
  };

  const sphereSim = (o = {}) => new ShallowWater({
    nx: o.nx ?? 120, ny: o.ny ?? 60, manning: 0, cfl: 0.45,
    bed: o.bed ?? (() => -4000), eta0: o.eta0 ?? 0,
    sphere: { R: R_REF, lat0: o.lat0 ?? -90, lat1: o.lat1 ?? 90, omega: o.omega ?? 0 },
  });

  // =======================================================================
  if (run('projection')) {
    console.log('\n=== 1. the projection is its own inverse ==============================\n');
    // If forward and inverse disagree, every mark this file draws sits somewhere
    // the pixels underneath do not. Nothing else in the file can catch that:
    // the pixels come from the inverse and the graticule from the forward map.
    const cam = globeCamera({ size: 501, tiltDeg: 22, rotDeg: 137.5 });
    let worstLat = 0, worstLon = 0, tested = 0;
    for (let lat = -88; lat <= 88; lat += 4) {
      for (let lon = -180; lon < 180; lon += 5) {
        const f = orthoProject(lon, lat, cam);
        if (!f.vis || f.z < 1e-6) continue;   // the limb is the inverse's own singularity
        const q = orthoInverseXY((f.px - cam.cx) / cam.r, (cam.cy - f.py) / cam.r, cam);
        tested++;
        worstLat = Math.max(worstLat, Math.abs(q[1] - lat));
        worstLon = Math.max(worstLon, Math.abs(wrapLon(q[0] - lon)));
      }
    }
    assert('forward then inverse returns the same latitude', worstLat < 1e-9,
      `worst ${fmt(worstLat)} deg over ${tested} visible points`);
    assert('forward then inverse returns the same longitude', worstLon < 1e-9,
      `worst ${fmt(worstLon)} deg`);
    // A hemisphere is two-to-one under projection: the far side must be rejected,
    // or the graticule draws the back of the planet over its front.
    const back = orthoProject(cam.rotDeg + 180, 0, cam);
    const front = orthoProject(cam.rotDeg, 0, cam);
    assert('the far side is marked not-visible', !back.vis && front.vis,
      `antipode z ${fmt(back.z)}, sub-camera point z ${fmt(front.z)}`);
    // The pole's position is a closed form: at lat 90 the forward map gives
    // x = 0, y = cos(tilt), independent of longitude.
    const pole = orthoProject(43, 90, cam);
    near('north pole sits at y = cos(tilt)', (cam.cy - pole.py) / cam.r, Math.cos(22 * D2R), 1e-12,
      'and at x = 0 for every longitude');
    assert('north pole sits on the central meridian', Math.abs(pole.px - cam.cx) < 1e-9,
      `x offset ${fmt(pole.px - cam.cx)} px`);
    // A ROTATION MAY NOT MOVE A LATITUDE. This is the property the whole baked
    // table rests on, checked on the projection itself rather than on the table.
    let worstDrift = 0;
    for (let rot = 0; rot < 360; rot += 17) {
      const c2 = globeCamera({ size: 501, tiltDeg: 22, rotDeg: rot });
      for (let py = 0; py < 501; py += 37) {
        for (let px = 0; px < 501; px += 37) {
          const a = orthoInversePixel(px, py, globeCamera({ size: 501, tiltDeg: 22, rotDeg: 0 }));
          const b = orthoInversePixel(px, py, c2);
          if (a === null || b === null) continue;
          worstDrift = Math.max(worstDrift, Math.abs(a[1] - b[1]));
        }
      }
    }
    assert('rotation cannot change a pixel\'s latitude', worstDrift === 0,
      `worst difference ${fmt(worstDrift)} deg over 22 rotations -- exactly 0 is required, since `
      + 'the baked row index assumes it');
    // THE REJECTED STRIP WARP, measured on the mapping. drawImage can only scale
    // linearly; the truth is a sine.
    //
    // THE PIXEL FIGURE COMES FROM A CAMERA, not from half the buffer. This check
    // used to say "74 px on a 700 px globe", which is 0.2105 x 350 -- and half the
    // buffer is exactly the mistake the label's own comment warns costs 6%,
    // because the disc is inset by `margin`. A 700 px buffer gives cam.r = 329,
    // so the figure is 69.3 px, which is what the header says.
    let worstStrip = 0, worstAt = 0, stripLat = 0;
    for (const lat of [0, 30, 60]) {
      for (let lon = 0; lon <= 90; lon += 0.01) {
        const trueX = Math.cos(lat * D2R) * Math.sin(lon * D2R);
        const linX = Math.cos(lat * D2R) * (lon / 90);
        if (Math.abs(trueX - linX) > worstStrip) {
          worstStrip = Math.abs(trueX - linX); worstAt = lon; stripLat = lat;
        }
      }
    }
    const c700 = globeCamera({ size: 700, tiltDeg: 22, rotDeg: 0 });
    assert('strip warp is wrong by a measurable amount (documented, not shipped)', worstStrip > 0.1,
      `worst |sin(lon) - linear| = ${fmt(worstStrip)} radii at lon ${worstAt.toFixed(2)} deg from `
      + `the central meridian (lat ${stripLat}), i.e. ${(worstStrip * c700.r).toFixed(1)} px at the `
      + `r = ${c700.r} px this file's camera gives a 700 px buffer -- NOT `
      + `${(worstStrip * 350).toFixed(1)} px, which is what half the buffer would say`);
    assert('the strip-warp figure is built from cam.r and not from half the buffer',
      Math.abs(worstStrip * c700.r - 69.3) < 0.1 && Math.abs(worstStrip * 350 - 73.7) < 0.1,
      `cam.r = ${c700.r} = 0.94 x 350, so the two differ by 6% -- ${(worstStrip * c700.r).toFixed(2)}`
      + ` px against ${(worstStrip * 350).toFixed(2)} px`);
  }

  // =======================================================================
  if (run('mask')) {
    console.log('\n=== 2. the disc mask ==================================================\n');
    // The mask is where a half-pixel error hides: it still looks like a circle.
    const size = 400;
    const cam = globeCamera({ size, tiltDeg: 0, rotDeg: 0 });
    const grid = gridOf(sphereSim({ nx: 180, ny: 90 }));
    const lut = buildGlobeLut(cam, grid);
    near('inside-disc pixel count vs pi r^2', lut.inside, Math.PI * cam.r * cam.r, 0.002,
      `${lut.inside} px, r = ${cam.r} -- the residual is the perimeter, O(1/r)`);
    // Symmetry. Sampling a pixel's corner instead of its centre breaks this and
    // nothing else notices.
    const mask = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) mask[y * size + x] = orthoInversePixel(x, y, cam) ? 1 : 0;
    }
    let asymX = 0, asymY = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (mask[y * size + x] !== mask[y * size + (size - 1 - x)]) asymX++;
        if (mask[y * size + x] !== mask[(size - 1 - y) * size + x]) asymY++;
      }
    }
    assert('mask is symmetric left-right', asymX === 0, `${asymX} mismatched pixels`);
    assert('mask is symmetric top-bottom', asymY === 0, `${asymY} mismatched pixels`);
    // AN ANALYTIC TARGET FOR THE CAP, and the reason it is worth having: it is the
    // one check here that knows the difference between the TRUE orthographic
    // latitude, asin(y), and a latitude taken LINEAR in y -- which is the same
    // mistake as the rejected strip warp, turned through 90 degrees, and produces
    // a picture that is still round, still gridded and still wrong.
    //
    // At tilt 0 the mask's latitude is asin(y), so the two unmodelled caps are the
    // parts of the disc with |y| > sin(cap), of area
    //   2 (pi/2 - y0 sqrt(1-y0^2) - asin y0) r^2,  y0 = sin(cap).
    // A bigger disc than the rest of this section uses, because the target is a
    // thin lens and its pixel-quantisation error scales with its PERIMETER: the
    // tolerance below is that perimeter over that area, not a taste.
    const capDeg = 60, y0 = Math.sin(capDeg * D2R);
    const camBig = globeCamera({ size: 800, tiltDeg: 0, rotDeg: 0 });
    const capped = sphereSim({ nx: 180, ny: 60, lat0: -capDeg, lat1: capDeg });
    const lutCap = buildGlobeLut(camBig, gridOf(capped));
    const r2 = camBig.r * camBig.r;
    const want = 2 * (Math.PI / 2 - (y0 * Math.sqrt(1 - y0 * y0) + Math.asin(y0))) * r2;
    const yLin = capDeg / 90;                          // the wrong mapping, for scale
    const wantLin = 2 * (Math.PI / 2 - (yLin * Math.sqrt(1 - yLin * yLin) + Math.asin(yLin))) * r2;
    near('hatched cap area vs the exact projected cap', lutCap.capped, want, 0.02,
      `${lutCap.capped} px hatched, exact ${want.toFixed(1)} px^2 at a +-${capDeg} deg cap on an `
      + `${camBig.size} px disc`);
    assert('the cap area can tell a latitude linear in y apart from asin(y)',
      Math.abs(lutCap.capped - wantLin) / wantLin > 0.5,
      `the wrong mapping predicts ${wantLin.toFixed(0)} px^2, a factor `
      + `${(wantLin / want).toFixed(2)} out -- so the 2% tolerance above has 25x of margin `
      + 'against the mistake it exists to catch');
    assert('an uncapped sphere hatches nothing', lut.capped === 0, `${lut.capped} px`);
    assert('modelled + hatched = inside the disc',
      lutCap.count + lutCap.capped === lutCap.inside,
      `${lutCap.count} + ${lutCap.capped} = ${lutCap.count + lutCap.capped} vs ${lutCap.inside}`);
  }

  // =======================================================================
  if (run('sampling')) {
    console.log('\n=== 3. sampling picks the cell that CONTAINS the point ================\n');
    // Checked against the SOLVER's own cell centres, not against this file's idea
    // of them: gridOf()'s docstring is a claim about swe.mjs and geometry.mjs.
    const sim = sphereSim({ nx: 120, ny: 60 });
    const grid = gridOf(sim);
    let worstRow = 0;
    for (let j = 0; j < grid.ny; j++) {
      const mine = grid.lat0 + (j + 0.5) * grid.dlat;
      worstRow = Math.max(worstRow, Math.abs(sim.cellLonLat(0, j)[1] - mine));
    }
    assert('row centres agree with geometry.mjs phiC', worstRow < 1e-9,
      `worst ${fmt(worstRow)} deg over ${grid.ny} rows`);
    let worstLon = 0, worstLat = 0;
    for (let t = 0; t < 20000; t++) {
      const lon = -180 + 360 * ((t * 0.61803398875) % 1);
      const lat = grid.lat0 + (grid.lat1 - grid.lat0) * ((t * 0.31830988618) % 1);
      const i = colOfLon(lon, grid.nx), j = rowOfLat(lat, grid);
      const [cl, cp] = sim.cellLonLat(i, j);
      worstLon = Math.max(worstLon, Math.abs(wrapLon(lon - cl)));
      worstLat = Math.max(worstLat, Math.abs(lat - cp));
    }
    assert('sampled point is inside the chosen cell (longitude)',
      worstLon <= 0.5 * grid.dlon + 1e-9,
      `worst offset from the cell centre ${fmt(worstLon)} deg, half-cell ${0.5 * grid.dlon}`);
    assert('sampled point is inside the chosen cell (latitude)',
      worstLat <= 0.5 * grid.dlat + 1e-9,
      `worst ${fmt(worstLat)} deg, half-cell ${0.5 * grid.dlat}`);
    // The seam. -180 and +180 are the same meridian and must land in cells 0 and
    // nx-1 on the correct sides of it.
    assert('date line: -180 -> column 0', colOfLon(-180, grid.nx) === 0, `got ${colOfLon(-180, grid.nx)}`);
    assert('date line: +180 wraps to column 0', colOfLon(180, grid.nx) === 0, `got ${colOfLon(180, grid.nx)}`);
    assert('date line: -180 - eps wraps to the last column',
      colOfLon(-180 - 1e-9, grid.nx) === grid.nx - 1, `got ${colOfLon(-180 - 1e-9, grid.nx)}`);
    let wrapMismatch = 0;
    for (let t = -2000; t <= 2000; t++) {
      const l = t * 0.911;
      if (colOfLon(l, grid.nx) !== colOfLon(wrapLon(l), grid.nx)) wrapMismatch++;
    }
    assert('unwrapped longitude indexes the same column as the wrapped one',
      wrapMismatch === 0, `${wrapMismatch} mismatches over +-1822 degrees of accumulated rotation`);
    assert('a latitude outside a capped band is refused, not clamped',
      rowOfLat(85, gridOf(sphereSim({ ny: 80, lat0: -80, lat1: 80 }))) === -1
      && rowOfLat(-85, gridOf(sphereSim({ ny: 80, lat0: -80, lat1: 80 }))) === -1,
      'clamping would paint the unsimulated cap as if it were the last row');
  }

  // =======================================================================
  if (run('lut')) {
    console.log('\n=== 4. the baked table IS the live computation ========================\n');
    // Not "agrees to 1e-12". The same doubles, or the frame loop is a second
    // implementation of the projection.
    const size = 220;
    const grid = gridOf(sphereSim({ nx: 120, ny: 60 }));
    const cam0 = globeCamera({ size, tiltDeg: 22, rotDeg: 0 });
    const lut = buildGlobeLut(cam0, grid);
    // THE FRAME LOOP'S OWN EXPRESSION, called -- not restated. This check used to
    // write `lut.lonBase[p] + rot` here, which made it a comparison between the
    // CHECK's idea of the frame loop and orthoInversePixel(); the renderer was not
    // in it. Flipping `+ rotDeg` to `- rotDeg` inside renderGlobe left the suite
    // at ALL PASS. frameLon() is now the single copy, renderGlobe calls it, and
    // this line calls it, so the sign is inside the comparison.
    let worstLon = 0, colMismatch = 0, rowMismatch = 0, compared = 0;
    for (const rot of [0, 1, 23.5, 90, 137.508, 180, 274.3, 359.9]) {
      const cam = globeCamera({ size, tiltDeg: 22, rotDeg: rot });
      for (let p = 0; p < lut.count; p++) {
        const o = lut.px[p], pix = o >> 2, x = pix % size, y = (pix - x) / size;
        const live = orthoInversePixel(x, y, cam);
        const lonLut = frameLon(lut.lonBase[p], rot);
        compared++;
        if (Math.abs(live[0] - lonLut) > worstLon) worstLon = Math.abs(live[0] - lonLut);
        if (colOfLon(live[0], grid.nx) !== colOfLon(lonLut, grid.nx)) colMismatch++;
        if (rowOfLat(live[1], grid) !== lut.jRow[p]) rowMismatch++;
      }
    }
    assert('baked longitude equals the live longitude to the BIT', worstLon === 0,
      `worst |difference| ${fmt(worstLon)} deg over ${compared} pixel-rotations `
      + '(8 rotations x the whole disc)');
    assert('baked column index equals the live one', colMismatch === 0, `${colMismatch} of ${compared}`);
    assert('baked row index equals the live one', rowMismatch === 0, `${rowMismatch} of ${compared}`);
    // THE CONTROL. A check that cannot fail proves nothing, so break the table by
    // one unit in the last place and confirm the comparison notices.
    const nudged = Float64Array.from(lut.lonBase);
    const p0 = Math.floor(lut.count / 2);
    nudged[p0] = nextUp(nudged[p0]);
    let seen = 0;
    for (let p = 0; p < lut.count; p++) {
      const o = lut.px[p], pix = o >> 2, x = pix % size, y = (pix - x) / size;
      const live = orthoInversePixel(x, y, cam0);
      if (live[0] !== nudged[p]) seen++;
    }
    assert('the comparison detects a one-ULP corruption of the table', seen === 1,
      `${seen} pixel(s) flagged after nudging entry ${p0} by ${fmt(nudged[p0] - lut.lonBase[p0])} deg`);
    // And the table must be rebaked when the GRID changes, not silently reused.
    let threw = false;
    try {
      renderGlobe(new Uint8ClampedArray(4 * size * size), sphereSim({ nx: 60, ny: 30 }),
        { lut, rotDeg: 0, scale: 1 });
    } catch { threw = true; }
    assert('a stale table is refused when the grid changes', threw,
      'reusing it would sample the wrong rows and look plausible');
  }

  // =======================================================================
  if (run('colour')) {
    console.log('\n=== 5. one ramp: the byte table IS surfaceColour() ====================\n');
    // THE SWEEP HAS TO CONTAIN THE HALF-BINS OR IT CANNOT SEE THE BUG IT NAMES.
    // This check used to sweep 20001 evenly spaced values only -- and the control
    // below already explains, at length, why an even sweep of [-1, 1] provably
    // never lands on a half-bin. The lesson was written down and then applied to
    // the CONTROL alone: swapping colourOffset() for the naive formula left this
    // assertion at "worst byte difference 0" and only the control noticed, by
    // inverting. So the sweep is now the even one PLUS every half-bin on both
    // signs, which is exactly the set on which the two formulas can differ.
    // scale is a power of two, so t * scale / scale is exact and a half-bin
    // survives the round trip through v.
    const scale = 0.5;
    const ref = new Uint8ClampedArray(3);
    const probes = [];
    for (let i = 0; i <= 20000; i++) probes.push(-1.4 * scale + (2.8 * scale * i) / 20000);
    let half = 0;
    for (let k = 0; k < CMID; k++) {
      for (const sgn of [1, -1]) { probes.push(sgn * ((k + 0.5) / CMID) * scale); half++; }
    }
    let worst = 0, worstAt = 0, worstIsHalf = false;
    for (let i = 0; i < probes.length; i++) {
      const v = probes[i];
      const c = surfaceColour(v, scale);
      ref[0] = c[0]; ref[1] = c[1]; ref[2] = c[2];
      const o = colourOffset(v, scale);
      const d = Math.max(Math.abs(CBYTES[o] - ref[0]), Math.abs(CBYTES[o + 1] - ref[1]),
        Math.abs(CBYTES[o + 2] - ref[2]));
      if (d > worst) { worst = d; worstAt = v; worstIsHalf = i > 20000; }
    }
    assert('byte table matches surfaceColour() exactly, even sweep AND every half-bin',
      worst === 0, `worst byte difference ${worst}`
      + `${worst ? ` at v = ${fmt(worstAt)} m (${worstIsHalf ? 'a half-bin' : 'the even sweep'})` : ''}`
      + `, over 20001 even points + ${half} half-bin points, including both saturated tails`);
    // THE CONTROL: the naive index formula, which is what this table would have
    // used if render.mjs's note about Math.round breaking ties upward on both
    // signs had not been read.
    //
    // THE FIRST VERSION OF THIS CONTROL FOUND NOTHING, and the reason is worth
    // keeping. It swept 20001 evenly spaced values and reported 0 differences, so
    // the "control" was passing by never visiting the only place the two formulas
    // can disagree: an exact HALF-BIN, where Math.round breaks the tie upward on
    // both signs (round(-2.5) = -2, -round(2.5) = -3). An even sweep of [-1, 1]
    // provably never lands on one -- t = -1 + i/10000 and the half-bins are
    // (k + 1/2)/512, and 625(2k+1)/64 is never an integer -- so the check could
    // not fail. This is render.mjs's own lesson about a coarse sweep flattering
    // the ramp, arriving from the other direction. So probe the half-bins
    // DIRECTLY: every one of them, on both signs.
    let naiveBad = 0, naiveWorstByte = 0, halfBins = 0;
    for (let k = 0; k < CMID; k++) {
      for (const sgn of [1, -1]) {
        halfBins++;
        const t = sgn * (k + 0.5) / CMID, v = t * scale;
        const naive = 3 * Math.round(((t + 1) / 2) * (CN - 1));
        const mine = colourOffset(v, scale);
        if (naive !== mine) {
          naiveBad++;
          naiveWorstByte = Math.max(naiveWorstByte,
            Math.abs(CBYTES[naive] - CBYTES[mine]), Math.abs(CBYTES[naive + 1] - CBYTES[mine + 1]),
            Math.abs(CBYTES[naive + 2] - CBYTES[mine + 2]));
        }
      }
    }
    assert('the check can tell the naive index formula apart', naiveBad > 0,
      `${naiveBad} of ${halfBins} half-bin values pick a different entry, worst `
      + `${naiveWorstByte} byte(s) -- every one of them below mean sea level, which is the `
      + 'asymmetry render.mjs documents');
    // Mean sea level must be one entry, not a step: this is render.mjs's odd-N
    // argument, re-checked through this table.
    const up = colourOffset(1e-12, 1), dn = colourOffset(-1e-12, 1);
    assert('mean sea level is a single entry (no step at eta = 0)', up === dn,
      `offsets ${up} and ${dn}, colour rgb(${CBYTES[up]},${CBYTES[up + 1]},${CBYTES[up + 2]})`);
  }

  // =======================================================================
  if (run('shading')) {
    console.log('\n=== 6. A RESTING OCEAN DOES NOT PULSE ================================\n');
    // The gate this file exists for. A resting ocean is eta = 0 in every cell, so
    // every water pixel must be the mean-sea-level colour at every rotation. Any
    // Lambert term, vignette or rim shading breaks it, and breaks it exactly as a
    // wave that is not there.
    const sim = sphereSim({ nx: 120, ny: 60, bed: (lon, lat) => -4000 + 900 * Math.sin(3 * lat * D2R) });
    const size = 240;
    const cam = globeCamera({ size, tiltDeg: 22, rotDeg: 0 });
    const lut = buildGlobeLut(cam, gridOf(sim));
    const buf = new Uint8ClampedArray(4 * size * size);
    const msl = colourOffset(0, 0.5);
    const want = [CBYTES[msl], CBYTES[msl + 1], CBYTES[msl + 2]];
    let worstByte = 0, worstL = 0, pixels = 0;
    for (let rot = 0; rot < 360; rot += 15) {
      const st = renderGlobe(buf, sim, { lut, rotDeg: rot, scale: 0.5, msl: 0 });
      pixels += st.wet;
      for (let p = 0; p < lut.count; p++) {
        const o = lut.px[p];
        const d = Math.max(Math.abs(buf[o] - want[0]), Math.abs(buf[o + 1] - want[1]),
          Math.abs(buf[o + 2] - want[2]));
        if (d > worstByte) {
          worstByte = d;
          worstL = Math.abs(Lstar([buf[o], buf[o + 1], buf[o + 2]]) - Lstar(want));
        }
      }
    }
    assert('every water pixel is the msl colour, at all 24 rotations', worstByte === 0,
      `worst byte departure ${worstByte} (${fmt(worstL)} L*) over ${pixels} water pixels; `
      + `the bed has 900 m of relief and every cell still has eta = 0`);
    // WHAT THE REFUSAL IS WORTH. The same buffer, with the Lambert factor this
    // file rejects, measured in CIE L* -- the unit render.mjs's ramp is built in.
    let lamWorst = 0, lamSpread = 0, loL = Infinity, hiL = -Infinity;
    for (const rot of [0, 90, 180]) {
      renderGlobe(buf, sim, { lut, rotDeg: rot, scale: 0.5, msl: 0, __lambertControl: 1 });
      for (let p = 0; p < lut.count; p++) {
        const o = lut.px[p], L = Lstar([buf[o], buf[o + 1], buf[o + 2]]);
        lamWorst = Math.max(lamWorst, Math.abs(L - Lstar(want)));
        loL = Math.min(loL, L); hiL = Math.max(hiL, L);
      }
    }
    lamSpread = hiL - loL;
    assert('the check has the resolution to see a Lambert term', lamWorst > 5,
      `the rejected shading moves a resting ocean by up to ${lamWorst.toFixed(3)} L*, spread `
      + `${lamSpread.toFixed(3)} L* across the disc -- against ${fmt(worstL)} L* shipped. For `
      + 'scale, the whole signed-elevation ramp spans 66 L*, so the geometry would be louder '
      + 'than a full-scale wave');
    // THE SIGNAL INVERSION, as a number rather than as an argument. Find the
    // Lambert factor at which a FULL-SCALE CREST reads the same lightness as
    // perfectly calm water at the sub-solar point, then count how much of the
    // disc is at or below it. Everywhere in that region a full-scale wave would be
    // indistinguishable from no wave at all.
    const crest = colourOffset(0.5, 0.5);
    const Lmsl = Lstar(want);
    const dim = (s) => Lstar([CBYTES[crest] * s, CBYTES[crest + 1] * s, CBYTES[crest + 2] * s]);
    let a = 0, bb = 1;
    for (let it = 0; it < 60; it++) { const m = 0.5 * (a + bb); if (dim(m) > Lmsl) bb = m; else a = m; }
    const sCrit = 0.5 * (a + bb);
    let below = 0;
    for (let p = 0; p < lut.count; p++) if (lut.lit[p] <= sCrit) below++;
    assert('Lambert would make a full-scale crest read as calm water', below > 0.15 * lut.count,
      `a crest dimmed to cos(incidence) = ${sCrit.toFixed(4)} has the same L* as flat water `
      + `(${Lmsl.toFixed(3)}), and ${(100 * below / lut.count).toFixed(1)}% of the modelled disc is `
      + `at or below that -- cos(incidence) spans ${fmt(lut.lit[argMin(lut.lit)])} to `
      + `${fmt(lut.lit[argMax(lut.lit)])}`);
    // Land IS lit, and that has to be visible or the lighting claim is empty.
    const island = sphereSim({ nx: 120, ny: 60, bed: GLOBE_BEDS.seamount.bed });
    const lutI = buildGlobeLut(cam, gridOf(island));
    const stI = renderGlobe(buf, island, { lut: lutI, rotDeg: 0, scale: 0.5, landLight: true });
    assert('the piercing seamount produces dry land pixels', stI.dry > 20,
      `${stI.dry} land pixels of ${stI.wet + stI.dry} modelled`);
    {
      const a = new Uint8ClampedArray(4 * size * size), b = new Uint8ClampedArray(4 * size * size);
      renderGlobe(a, island, { lut: lutI, rotDeg: 0, scale: 0.5, landLight: true });
      renderGlobe(b, island, { lut: lutI, rotDeg: 0, scale: 0.5, landLight: false });
      let diffLand = 0, diffWater = 0;
      const nxI = gridOf(island).nx;
      for (let p = 0; p < lutI.count; p++) {
        const o = lutI.px[p];
        const d = Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]);
        const k = lutI.rowBase[p] + colOfLon(lutI.lonBase[p], nxI);
        if (island.h[k] <= island.minDepth) diffLand += d; else diffWater += d;
      }
      assert('the land light changes LAND and nothing else', diffLand > 0 && diffWater === 0,
        `land bytes moved ${diffLand}, water bytes moved ${diffWater} -- water must be 0`);
    }
  }

  // =======================================================================
  if (run('field')) {
    console.log('\n=== 7. THE PAINTED BYTES ARE THE RAMP\'S BYTES ========================\n');
    // WHY THIS SECTION EXISTS. Every check above section 6 measured the LUT, the
    // projection or the colour table; section 6 measured a RESTING ocean, where
    // eta is zero in every cell and the correct answer is one flat colour. A
    // renderer that always paints mean sea level scores a perfect zero on it. So
    // the suite had no check anywhere that read a painted water pixel off a field
    // with a wave in it, and four separate mutations of the one line that turns a
    // cell into a colour -- colourOffset(0, .), colourOffset(e, scale*4),
    // colourOffset(-e, .), and dropping the `- msl` -- all passed 60/60.
    //
    // The fix is structural: render a field with KNOWN values at KNOWN cells and
    // compare every painted byte against src/render.mjs's surfaceColour(), which
    // is the function this file claims to be a byte table of. That is a target
    // from ANOTHER MODULE, not a second copy of this one's arithmetic.
    const nx = 120, ny = 60, size = 240, scale = 0.5, msl = 0.125;
    const sim = sphereSim({ nx, ny });
    const grid = gridOf(sim);
    const cam0 = globeCamera({ size, tiltDeg: 22, rotDeg: 0 });
    const lut = buildGlobeLut(cam0, grid);
    const buf = new Uint8ClampedArray(4 * size * size);
    // e = b + h - msl is what the ramp is fed, so build h backwards from a target
    // e. msl is deliberately NOT zero: with msl = 0 the subtraction is invisible,
    // which is exactly how "e = b + h" survived.
    const setE = (i, j, e) => { sim.h[sim.idx(i, j)] = 4000 + msl + e; };
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        setE(i, j, 1.3 * scale * Math.sin((2 * Math.PI * i) / nx)
          * Math.cos((Math.PI * (j + 0.5)) / ny));
      }
    }
    // Five cells with values chosen to pin the ramp's ends, its middle and its
    // clamp, placed beside the sub-camera point (lon 0, lat 22 at rot 0) so they
    // are near the centre of the disc where one cell is several pixels across.
    const jK = rowOfLat(22, grid);
    const KNOWN = [
      ['full-scale crest', 58, +scale],
      ['full-scale trough', 59, -scale],
      ['half-scale crest', 60, +0.5 * scale],
      ['half-scale trough', 61, -0.5 * scale],
      ['twice full scale', 62, +2 * scale],
    ];
    for (const [, i, e] of KNOWN) setE(i, jK, e);

    // ---- every water pixel, at two rotations -----------------------------
    // The expected CELL comes from orthoInversePixel() on the rotated camera --
    // the live projection -- not from the LUT, so a wrong rotation lands the
    // comparison on a different cell and the bytes disagree.
    let worst = 0, worstNote = '', comparedPx = 0;
    for (const rot of [0, 137.508]) {
      const cam = globeCamera({ size, tiltDeg: 22, rotDeg: rot });
      renderGlobe(buf, sim, { lut, rotDeg: rot, scale, msl });
      for (let p = 0; p < lut.count; p++) {
        const o = lut.px[p], pix = o >> 2, x = pix % size, y = (pix - x) / size;
        const live = orthoInversePixel(x, y, cam);
        const k = sim.idx(colOfLon(live[0], nx), rowOfLat(live[1], grid));
        const want = bytes3(surfaceColour(sim.b[k] + sim.h[k] - msl, scale));
        const d = Math.max(Math.abs(buf[o] - want[0]), Math.abs(buf[o + 1] - want[1]),
          Math.abs(buf[o + 2] - want[2]));
        comparedPx++;
        if (d > worst) {
          worst = d;
          worstNote = `rot ${rot}, pixel (${x},${y}), e = ${fmt(sim.b[k] + sim.h[k] - msl)} m: `
            + `painted rgb(${buf[o]},${buf[o + 1]},${buf[o + 2]}) `
            + `want rgb(${want[0]},${want[1]},${want[2]})`;
        }
      }
    }
    assert('every water pixel is surfaceColour(b + h - msl, scale), at 2 rotations', worst === 0,
      `worst byte departure ${worst} over ${comparedPx} pixel-rotations on a field spanning `
      + `+-${(1.3 * scale).toFixed(2)} m at scale ${scale} m${worst ? '   ' + worstNote : ''}`);

    // ---- the SIGN, in the unit a reader reads ----------------------------
    renderGlobe(buf, sim, { lut, rotDeg: 0, scale, msl });
    const pixelOf = (s, i, j) => {
      const kWant = s.idx(i, j);
      for (let p = 0; p < lut.count; p++) {
        const o = lut.px[p], pix = o >> 2, x = pix % size, y = (pix - x) / size;
        const live = orthoInversePixel(x, y, cam0);
        if (s.idx(colOfLon(live[0], nx), rowOfLat(live[1], grid)) === kWant) return o;
      }
      return -1;
    };
    const offs = KNOWN.map(([, i]) => pixelOf(sim, i, jK));
    assert('all five known cells are visible and painted at rot 0', offs.every((o) => o >= 0),
      KNOWN.map(([n, i], q) => `${n} (i=${i}) -> ${offs[q] >= 0 ? 'px' : 'NOT VISIBLE'}`).join(', '));
    const Lat = (o) => Lstar([buf[o], buf[o + 1], buf[o + 2]]);
    const Lmsl = Lstar(bytes3(surfaceColour(0, scale)));
    const [Lc, Lt, Lhc, Lht] = [Lat(offs[0]), Lat(offs[1]), Lat(offs[2]), Lat(offs[3])];
    assert('a CREST is paler than mean sea level and a TROUGH is darker',
      Lc - Lmsl > 20 && Lmsl - Lt > 20,
      `crest ${Lc.toFixed(3)} L*, msl ${Lmsl.toFixed(3)} L*, trough ${Lt.toFixed(3)} L* `
      + `(+${(Lc - Lmsl).toFixed(3)} / -${(Lmsl - Lt).toFixed(3)}); colourOffset(-e, .) swaps `
      + 'these two and passed the whole suite');
    assert('crest and trough are symmetric about msl to better than 1 L*',
      Math.abs((Lc - Lmsl) - (Lmsl - Lt)) < 1,
      `|${(Lc - Lmsl).toFixed(4)} - ${(Lmsl - Lt).toFixed(4)}| = `
      + `${Math.abs((Lc - Lmsl) - (Lmsl - Lt)).toFixed(4)} L* -- render.mjs measures the ramp `
      + 'itself at 0.4410 L* worst case in 8-bit');
    assert('lightness is MONOTONE in elevation across the five known cells',
      Lt < Lht && Lht < Lmsl && Lmsl < Lhc && Lhc < Lc,
      `${Lt.toFixed(2)} < ${Lht.toFixed(2)} < ${Lmsl.toFixed(2)} < ${Lhc.toFixed(2)} < `
      + `${Lc.toFixed(2)} L* for e = ${-scale}, ${-0.5 * scale}, 0, ${0.5 * scale}, ${scale} m -- `
      + 'colourOffset(0, .) makes all five equal');

    // ---- full scale IS the number the label prints -----------------------
    const labF = globeLabel(sim, { bedName: 'x', scale, discR: cam0.r }).join('\n');
    const mScale = labF.match(/\+-(\d+\.\d+) m full scale/);
    assert('the label prints the scale the frame was rendered with',
      !!mScale && Number(mScale[1]) === scale,
      `label says "${mScale ? mScale[1] : '(no match)'}", renderGlobe was given ${scale}`);
    const top = bytes3(surfaceColour(1, 1));            // the ramp's extreme entry
    const rgbAt = (o) => [buf[o], buf[o + 1], buf[o + 2]];
    const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
    assert('a cell at exactly full scale paints the ramp\'s EXTREME entry',
      same(rgbAt(offs[0]), top),
      `painted rgb(${rgbAt(offs[0])}) vs the ramp's end rgb(${[...top]}) -- rendering at `
      + 'scale*4 puts this cell a quarter of the way up the ramp instead');
    assert('a cell at HALF full scale does not', !same(rgbAt(offs[2]), top),
      `painted rgb(${rgbAt(offs[2])}) -- if this matched, the label's full-scale figure would be `
      + 'meaningless');
    assert('a cell at TWICE full scale paints the same bytes as one at full scale',
      same(rgbAt(offs[4]), top), `rgb(${rgbAt(offs[4])}) -- this is the CLAMP, measured in `
      + 'section 9');

    // ---- the land ramp, at five bed elevations ---------------------------
    const isle = sphereSim({ nx, ny });
    const BEDS = [-50, 0, 1250, LAND_SAT_REF, 3500];
    BEDS.forEach((bedM, n) => {
      const k = isle.idx(58 + n, jK);
      isle.b[k] = bedM; isle.h[k] = 0;                  // dry, at a known elevation
    });
    const bufL = new Uint8ClampedArray(4 * size * size);
    const stL = renderGlobe(bufL, isle, { lut, rotDeg: 0, scale, msl, landLight: false });
    let landWorst = 0, landNote = '';
    const rows = [];
    BEDS.forEach((bedM, n) => {
      const o = pixelOf(isle, 58 + n, jK);
      if (o < 0) { landWorst = 999; landNote = `bed ${bedM} m not visible`; return; }
      const want = bytes3(refLandRaw(bedM));
      const got = [bufL[o], bufL[o + 1], bufL[o + 2]];
      const d = Math.max(Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]),
        Math.abs(got[2] - want[2]));
      rows.push(`${bedM}m rgb(${got})`);
      if (d > landWorst) { landWorst = d; landNote = `bed ${bedM} m: got rgb(${got}) want rgb(${[...want]})`; }
    });
    assert('unlit land is the declared ramp, at -50 / 0 / 1250 / 2500 / 3500 m',
      landWorst === 0 && rows.length === BEDS.length && stL.dry > 0,
      `${rows.join('  ')}; ${BEDS.length} dry cells -> ${stL.dry} land pixels`
      + `${landWorst ? '   ' + landNote : ''} -- 1250 m catches the /${LAND_SAT_REF} slope, `
      + '-50 and 3500 catch the two clamps (a dry cell CAN sit below sea level)');

    // ---- the night side is a FLOOR, not a mirror -------------------------
    // lit = max(0, dot) and not abs(dot). abs() lights the night side as brightly
    // as the day side, which reads as a second sun behind the planet.
    const allLand = sphereSim({ nx, ny, bed: () => 800 });
    const lutA = buildGlobeLut(cam0, gridOf(allLand));
    const stA = renderGlobe(buf, allLand, { lut: lutA, rotDeg: 0, scale, msl, landLight: true });
    assert('a globe whose bed is everywhere above sea level has no water pixels',
      stA.wet === 0 && stA.dry === lutA.count, `wet ${stA.wet}, dry ${stA.dry} of ${lutA.count}`);
    let sunOff = 0;
    for (let q = 0; q < 3; q++) sunOff = Math.max(sunOff, Math.abs(lutA.sun[q] - SUN_REF[q]));
    assert('the LUT\'s light is the documented default, normalised', sunOff === 0,
      `worst component difference ${fmt(sunOff)} against the locally declared `
      + `[${SUN_REF.map((v) => v.toFixed(6))}]`);
    let litWorst = 0, dark = 0, litLandWorst = 0, base = refLandRaw(800);
    for (let p = 0; p < lutA.count; p++) {
      const o = lutA.px[p], pix = o >> 2, x = pix % size, y = (pix - x) / size;
      const q = orthoInversePixel(x, y, cam0);
      const ax = (x + 0.5 - cam0.cx) / cam0.r, ay = (cam0.cy - y - 0.5) / cam0.r;
      // Float32Array storage, so the target has to be rounded the same way.
      const want = Math.fround(Math.max(0, ax * SUN_REF[0] + ay * SUN_REF[1] + q[2] * SUN_REF[2]));
      litWorst = Math.max(litWorst, Math.abs(lutA.lit[p] - want));
      if (want === 0) dark++;
      const s = 0.30 + 0.70 * want;
      const wb = bytes3([base[0] * s, base[1] * s, base[2] * s]);
      litLandWorst = Math.max(litLandWorst, Math.abs(buf[o] - wb[0]), Math.abs(buf[o + 1] - wb[1]),
        Math.abs(buf[o + 2] - wb[2]));
    }
    assert('cos(incidence) is max(0, dot) -- the night side is clamped, not mirrored',
      litWorst === 0, `worst |lit - max(0, dot)| = ${fmt(litWorst)} over ${lutA.count} pixels; `
      + `${dark} of them (${(100 * dark / lutA.count).toFixed(1)}%) are exactly 0, which is the `
      + 'night side that abs() would light up');
    assert('a real fraction of the disc IS in shadow, so the clamp has something to do',
      dark > 0.1 * lutA.count, `${(100 * dark / lutA.count).toFixed(1)}% of the disc is unlit`);
    assert('every land pixel is landColour(bed) x (0.30 + 0.70 cos i)', litLandWorst === 0,
      `worst byte departure ${litLandWorst} over ${lutA.count} land pixels at bed 800 m`);

    // ---- mean sea level is subtracted ------------------------------------
    const bufA = new Uint8ClampedArray(4 * size * size);
    const bufB = new Uint8ClampedArray(4 * size * size);
    renderGlobe(bufA, sim, { lut, rotDeg: 0, scale, msl: 0 });
    renderGlobe(bufB, sim, { lut, rotDeg: 0, scale, msl: 0.125 });
    let moved = 0;
    for (let p = 0; p < lut.count; p++) {
      const o = lut.px[p];
      if (bufA[o] !== bufB[o] || bufA[o + 1] !== bufB[o + 1] || bufA[o + 2] !== bufB[o + 2]) moved++;
    }
    assert('moving mean sea level repaints the water (the "- msl" is load-bearing)',
      moved > 0.5 * lut.count,
      `${moved} of ${lut.count} pixels (${(100 * moved / lut.count).toFixed(1)}%) changed when msl `
      + 'went 0 -> 0.125 m at scale 0.50 m. index.html always passes msl = 0, so nothing on the '
      + 'page can see this and nothing in the suite could either');
  }

  // =======================================================================
  if (run('marks')) {
    console.log('\n=== 8. GlobeView.draw(), and the marks it paints ======================\n');
    // NOTHING USED TO CALL draw(). Everything went through renderGlobe(), so the
    // whole of draw() -- the ImageData handoff, the graticule, the limb stroke,
    // the terminator, the label gutter -- was unmeasured, and a vignette applied
    // to the ImageData just before putImageData() passed the entire suite. It is
    // run here against a recording context; see stubCanvas().
    const nx = 120, ny = 60, scale = 0.5, msl = 0, rot = 41.25;
    // rot is deliberately NOT a multiple of 30: the meridians are drawn every 30
    // degrees, and at a multiple of 30 the far side of the central meridian
    // mirrors onto a meridian that IS drawn, which would let a missing visibility
    // test slip through the position check below.
    const sim = sphereSim({ nx, ny, bed: GLOBE_BEDS.seamount.bed });
    const grid = gridOf(sim);
    const LABEL = ['line one', 'line two', 'line three', 'line four'];
    const stub = stubCanvas(720, 900);
    const view = new GlobeView(stub.canvas);
    view.tiltDeg = 22; view.rotDeg = rot; view.scale = scale;
    view.graticule = true; view.terminator = true; view.landLight = true;
    view.label = LABEL.slice();
    view.draw(sim, { msl });

    const put = stub.calls.find((c) => c[0] === 'putImageData');
    assert('draw() reaches putImageData at all', !!put, put ? '' : 'no putImageData call recorded');
    const painted = put[1], sizeD = put[2], ox = put[3], oy = put[4];
    const camD = globeCamera({ size: sizeD, tiltDeg: view.tiltDeg, rotDeg: rot });
    const lutD = buildGlobeLut(camD, grid);
    const ref = new Uint8ClampedArray(4 * sizeD * sizeD);
    const stD = renderGlobe(ref, sim, { lut: lutD, rotDeg: rot, scale, msl, landLight: true });
    let diff = 0, firstAt = -1;
    for (let i = 0; i < ref.length; i++) {
      if (painted[i] !== ref[i]) { diff++; if (firstAt < 0) firstAt = i; }
    }
    assert('draw() hands the canvas EXACTLY what renderGlobe() produced', diff === 0,
      `${diff} of ${ref.length} bytes differ${diff ? ` (first at byte ${firstAt}: `
        + `${painted[firstAt]} vs ${ref[firstAt]})` : ''} on a ${sizeD} px disc -- any vignette, `
      + 'dimming or rim shading inserted after the frame loop lands here');
    // The one layout formula this check restates; everything else about the
    // layout is asserted as a PROPERTY rather than as a repeated expression.
    const lineH = Math.round(13 * view.dpr), pad = Math.round(10 * view.dpr);
    const gutter = LABEL.length * lineH + 2 * pad;
    assert('the disc is centred, starts at the top, and clears the label gutter',
      ox === Math.round(0.5 * (view.w - sizeD)) && oy === 0 && ox >= 0 && sizeD + gutter <= view.h,
      `disc ${sizeD} px at (${ox}, ${oy}); buffer ${view.w} x ${view.h}; gutter ${gutter} px -- `
      + 'the label gets a gutter, never an overlay, so nothing sits on top of the field');
    assert('the radius handed to the label is the radius the camera used',
      view.discR === camD.r && view.discPx === sizeD,
      `view.discR ${view.discR} vs cam.r ${camD.r}; discPx ${view.discPx} vs ${sizeD}. It used to `
      + 'default to 350 and the suite asserted a label string the page never produced');
    assert('draw() records the frame stats the saturation line needs',
      !!view.stats && view.stats.wet === stD.wet && view.stats.sat === stD.sat
      && view.stats.dry === stD.dry,
      view.stats ? `wet ${view.stats.wet}, dry ${view.stats.dry}, sat ${view.stats.sat}`
        : 'view.stats is null');
    assert('every label line is drawn into the gutter, none over the disc',
      stub.calls.filter((c) => c[0] === 'fillText').length === LABEL.length
      && stub.calls.filter((c) => c[0] === 'fillText').every((c) => c[3] >= view.h - gutter),
      `${stub.calls.filter((c) => c[0] === 'fillText').length} fillText calls for `
      + `${LABEL.length} lines, all at y >= ${view.h - gutter}`);

    // ---- the limb stroke -------------------------------------------------
    const arcs = stub.calls.filter((c) => c[0] === 'arc');
    assert('exactly one limb stroke, ON the edge of the disc',
      arcs.length === 1 && arcs[0][1] === camD.cx && arcs[0][2] === camD.cy && arcs[0][3] === camD.r,
      arcs.length ? `arc at (${arcs[0][1]}, ${arcs[0][2]}) r ${arcs[0][3]}; camera says `
        + `(${camD.cx}, ${camD.cy}) r ${camD.r}` : 'no arc drawn');
    // WHAT THE STROKE COVERS. The header claimed the pixels it covers "never
    // carried a readable value", and supported it with the single most extreme
    // pixel in the buffer. That is a claim about a DISTRIBUTION, so measure the
    // distribution.
    //
    // THE FOOTPRINT IS 2 px INWARD, NOT 0.55. The stroke is lineWidth 1.1 * dpr,
    // so the geometric half-width is 0.55 px -- but a canvas antialiases it, and
    // the antialiased tail is still a byte that is not the ramp's. Measured on the
    // live page (Chrome, dpr 1, 759 px disc, marks otherwise off) by comparing
    // every water pixel against surfaceColour(): 2,546 of 399,785 water pixels
    // differ, 0.64%, and EVERY ONE of them is within 2.0 px of the limb; at a 2 px
    // exclusion the canvas is byte-exact over all 395,297 remaining water pixels.
    // So 2 px is the number, and this check uses it rather than the nominal one.
    const FOOTPRINT = 2.0 * view.dpr;
    const arcDegAt = (r, z) => (180 / Math.PI) / (r * z);
    let covered = 0, minArc = Infinity, maxArc = 0;
    for (let p = 0; p < lutD.count; p++) {
      const pix = lutD.px[p] >> 2, x = pix % sizeD, y = (pix - x) / sizeD;
      const ax = (x + 0.5 - camD.cx) / camD.r, ay = (camD.cy - y - 0.5) / camD.r;
      const rho = Math.hypot(ax, ay);
      if (camD.r * (1 - rho) > FOOTPRINT) continue;
      covered++;
      const a = arcDegAt(camD.r, Math.sqrt(Math.max(0, 1 - rho * rho)));
      if (a < minArc) minArc = a;
      if (a > maxArc) maxArc = a;
    }
    assert('the limb stroke covers a small, named set of badly-foreshortened pixels',
      covered < 0.02 * lutD.count && minArc > 1.4,
      `${covered} of ${lutD.count} modelled pixels `
      + `(${(100 * covered / lutD.count).toFixed(2)}%) lie within the ${FOOTPRINT.toFixed(1)} px `
      + `the stroke and its antialiasing reach; each spans ${minArc.toFixed(2)} to `
      + `${maxArc.toFixed(2)} deg of arc radially, against `
      + `${arcDegAt(camD.r, 1).toFixed(4)} deg at the disc centre -- a factor `
      + `${(minArc / arcDegAt(camD.r, 1)).toFixed(0)} at the FLOOR, not the 465 the single `
      + 'outermost pixel gives');
    // The published 700 px figures, reproduced. The header used to quote only the
    // single most extreme pixel in the buffer and call it "the outermost pixel",
    // which is true and reads as typical; the floor above is the honest half.
    const c700 = globeCamera({ size: 700, tiltDeg: 22, rotDeg: 0 });
    let rhoMax = 0, zAt = 0;
    for (let y = 0; y < 700; y++) {
      for (let x = 0; x < 700; x++) {
        const q = orthoInversePixel(x, y, c700);
        if (q === null) continue;
        const ax = (x + 0.5 - c700.cx) / c700.r, ay = (c700.cy - y - 0.5) / c700.r;
        const s = ax * ax + ay * ay;
        if (s > rhoMax) { rhoMax = s; zAt = q[2]; }
      }
    }
    near('700 px buffer: z at the outermost modelled pixel', zAt, 2.1493e-3, 1e-3,
      `${(c700.r * (1 - Math.sqrt(rhoMax))).toFixed(5)} px inside a limb at r = ${c700.r} -- ONE `
      + 'pixel, the extreme of the distribution above, not a typical one');
    near('700 px buffer: its radial arc span', arcDegAt(c700.r, zAt), 81.03, 1e-3,
      `deg; the disc CENTRE pixel spans ${arcDegAt(c700.r, 1).toFixed(4)} deg, a factor `
      + `${(arcDegAt(c700.r, zAt) / arcDegAt(c700.r, 1)).toFixed(0)}`);

    // ---- the graticule is where it says it is ----------------------------
    const marksBetween = (calls) => {
      const out = [];
      let on = false;
      for (const c of calls) {
        if (c[0] === 'translate') { on = true; continue; }
        if (c[0] === 'arc') break;                      // the limb ends the marks
        if (on && (c[0] === 'moveTo' || c[0] === 'lineTo')) out.push([c[1], c[2]]);
      }
      return out;
    };
    stub.reset();
    view.terminator = false; view.graticule = true;
    view.draw(sim, { msl });
    const gverts = marksBetween(stub.calls);
    const MERIDIANS = [], PARALLELS = [-60, -30, 0, 30, 60];
    for (let lon = -180; lon < 180; lon += 30) MERIDIANS.push(lon);
    let visSamples = 0;
    for (const lon of MERIDIANS) {
      for (let lat = -90; lat <= 90; lat += 2) if (orthoProject(lon, lat, camD).vis) visSamples++;
    }
    for (const lat of [...PARALLELS]) {
      for (let lon = -180; lon <= 180; lon += 2) if (orthoProject(lon, lat, camD).vis) visSamples++;
    }
    assert('the graticule draws exactly the VISIBLE samples and no more',
      gverts.length === visSamples,
      `${gverts.length} vertices against ${visSamples} forward-projected samples with z >= 0 `
      + '(12 meridians every 2 deg, 5 parallels every 2 deg). Dropping the visibility test '
      + 'stencils the far side of the planet through the front');
    let offLine = 0, worstOff = 0;
    for (const [px, py] of gverts) {
      const q = orthoInverseXY((px - camD.cx) / camD.r, (camD.cy - py) / camD.r, camD);
      if (q === null) { offLine++; continue; }
      const lon = wrapLon(q[0]), lat = q[1];
      // ANGULAR distance to the line, not the difference in the coordinate: a
      // meridian's separation shrinks as cos(lat), and AT A POLE every meridian
      // passes through the same point, so a longitude difference there names
      // nothing. Twelve vertices -- one per meridian, all of them the north pole
      // -- read 11.25 deg of longitude offset and 0 deg of arc.
      let off = Infinity;
      const cl = Math.cos(lat * D2R);
      for (const m of MERIDIANS) off = Math.min(off, Math.abs(wrapLon(lon - m)) * cl);
      for (const m of PARALLELS) off = Math.min(off, Math.abs(lat - m));
      if (off > 1e-7) offLine++;
      if (off > worstOff) worstOff = off;
    }
    assert('every graticule vertex INVERTS to a graticule position', offLine === 0,
      `${offLine} of ${gverts.length} vertices off; worst ${fmt(worstOff)} deg of arc from the `
      + 'nearest meridian or parallel. This is the "marks at known positions" claim, measured: '
      + 'the pixel under the mark reports the coordinate the mark names');
    stub.reset();
    view.graticule = false;
    view.draw(sim, { msl });
    assert('graticule off draws no graticule', marksBetween(stub.calls).length === 0,
      `${marksBetween(stub.calls).length} vertices with the box unticked`);

    // ---- the terminator is a great circle perpendicular to the light -----
    stub.reset();
    view.graticule = false; view.terminator = true; view.landLight = true;
    view.draw(sim, { msl });
    const tverts = marksBetween(stub.calls);
    const dashes = stub.calls.filter((c) => c[0] === 'setLineDash' && c[1].length === 2);
    assert('the terminator is drawn DASHED, as a line and not a shading boundary',
      dashes.length === 1 && tverts.length > 20,
      `${dashes.length} dashed path(s), ${tverts.length} vertices, dash `
      + `[${dashes.length ? dashes[0][1] : '-'}]`);
    let offCircle = 0, worstDot = 0, behind = 0;
    for (const [px, py] of tverts) {
      const ax = (px - camD.cx) / camD.r, ay = (camD.cy - py) / camD.r;
      const s = ax * ax + ay * ay;
      if (s > 1 + 1e-12) { offCircle++; continue; }
      // z is RECONSTRUCTED as sqrt(1 - x^2 - y^2), and a terminator vertex near the
      // limb has s ~ 1, so this subtraction is where the precision goes: the worst
      // vertex reads 2e-8 rather than 0. The tolerance is that conditioning, and it
      // still leaves six orders of margin against a mark drawn on the wrong circle.
      const az = Math.sqrt(Math.max(0, 1 - s));
      const dot = ax * SUN_REF[0] + ay * SUN_REF[1] + az * SUN_REF[2];
      if (Math.abs(dot) > 1e-6) offCircle++;
      if (Math.abs(dot) > worstDot) worstDot = Math.abs(dot);
      if (az < 0) behind++;
    }
    assert('every terminator vertex lies on the great circle perpendicular to the light',
      offCircle === 0 && behind === 0,
      `${offCircle} of ${tverts.length} vertices off the circle; worst |n . sun| = `
      + `${fmt(worstDot)} against a 1e-6 tolerance set by the limb's sqrt; ${behind} on the far `
      + 'side. It marks where the LAND light grazes and shades nothing');
    stub.reset();
    view.landLight = false;
    view.draw(sim, { msl });
    assert('with the land light off there is no terminator to draw',
      stub.calls.filter((c) => c[0] === 'setLineDash' && c[1].length === 2).length === 0,
      'the line marks where the land lighting turns over; with no lighting it would mark nothing');
  }

  // =======================================================================
  if (run('saturation')) {
    console.log('\n=== 9. THE RAMP CLAMPS, and the label has to say by how much ==========\n');
    // THE DUAL OF THE LAMBERT ARGUMENT. Section 6 refuses a Lambert term because
    // it makes two elevations share one lightness over 49.7% of the disc. The
    // ramp's own clamp does exactly that above full scale, and it is two slider
    // drags away -- and until now nothing measured it and no label line mentioned
    // it. renderGlobe() already returned etaMin and etaMax and NOTHING IN THE TREE
    // READ THEM. This section reads them, and the count beside them.
    const nx = 120, ny = 60, size = 200, scale = 0.5;
    const cam = globeCamera({ size, tiltDeg: 22, rotDeg: 0 });
    const buf = new Uint8ClampedArray(4 * size * size);
    const build = (e) => {                              // e(latDeg) -> elevation [m]
      const s = sphereSim({ nx, ny });
      const g = gridOf(s);
      for (let j = 0; j < ny; j++) {
        const lat = g.lat0 + (j + 0.5) * g.dlat;
        for (let i = 0; i < nx; i++) s.h[s.idx(i, j)] = 4000 + e(lat);
      }
      return s;
    };
    // A field with KNOWN extremes at KNOWN cells: the northern half is at twice
    // full scale, the southern half is flat. The expected count is then a pure
    // property of the LUT's baked row index, computed here without rendering.
    const half = build((lat) => (lat >= 0 ? 2 * scale : 0));
    const lut = buildGlobeLut(cam, gridOf(half));
    const gh = gridOf(half);
    let wantSat = 0;
    for (let p = 0; p < lut.count; p++) {
      if (gh.lat0 + (lut.jRow[p] + 0.5) * gh.dlat >= 0) wantSat++;
    }
    const stH = renderGlobe(buf, half, { lut, rotDeg: 0, scale, msl: 0 });
    assert('renderGlobe counts exactly the water pixels at or past full scale',
      stH.sat === wantSat && stH.wet === lut.count,
      `${stH.sat} counted, ${wantSat} expected from the baked row index; `
      + `${stH.wet} wet of ${lut.count} modelled `
      + `(${(100 * stH.satFrac).toFixed(1)}%, eta ${stH.etaMin.toFixed(3)}..`
      + `${stH.etaMax.toFixed(3)} m)`);
    const stU = renderGlobe(buf, build(() => 0.99 * scale), { lut, rotDeg: 0, scale, msl: 0 });
    assert('a field just under full scale saturates nothing', stU.sat === 0,
      `${stU.sat} of ${stU.wet} at eta = ${(0.99 * scale).toFixed(4)} m, scale ${scale} m`);
    const stE = renderGlobe(buf, build(() => scale), { lut, rotDeg: 0, scale, msl: 0 });
    assert('a field at EXACTLY full scale is already saturated (|t| >= 1, not > 1)',
      stE.sat === stE.wet, `${stE.sat} of ${stE.wet} at eta = ${scale} m -- |t| = 1 is the ramp's `
      + 'last entry, so it already shares its byte with everything above it');
    // THE ARGUMENT ITSELF, on painted pixels rather than as a sentence.
    const two = sphereSim({ nx, ny });
    const jK = rowOfLat(22, gridOf(two));
    two.h[two.idx(58, jK)] = 4000 + scale;
    two.h[two.idx(59, jK)] = 4000 + 4 * scale;
    renderGlobe(buf, two, { lut, rotDeg: 0, scale, msl: 0 });
    const findPx = (s, i, j) => {
      const kW = s.idx(i, j);
      for (let p = 0; p < lut.count; p++) {
        const o = lut.px[p], pix = o >> 2, x = pix % size, y = (pix - x) / size;
        const q = orthoInversePixel(x, y, cam);
        if (s.idx(colOfLon(q[0], nx), rowOfLat(q[1], gridOf(s))) === kW) return o;
      }
      return -1;
    };
    const oA = findPx(two, 58, jK), oB = findPx(two, 59, jK);
    const LA = Lstar([buf[oA], buf[oA + 1], buf[oA + 2]]);
    const LB = Lstar([buf[oB], buf[oB + 1], buf[oB + 2]]);
    assert('a 0.50 m crest and a 2.00 m crest are ONE byte and 0 L* apart',
      oA >= 0 && oB >= 0 && buf[oA] === buf[oB] && buf[oA + 1] === buf[oB + 1]
      && buf[oA + 2] === buf[oB + 2] && LA === LB,
      `rgb(${buf[oA]},${buf[oA + 1]},${buf[oA + 2]}) and `
      + `rgb(${buf[oB]},${buf[oB + 1]},${buf[oB + 2]}), ${Math.abs(LA - LB).toFixed(4)} L* apart, `
      + 'for elevations 1.50 m apart. This is the same failure the Lambert term is refused for, '
      + 'reached from the other side');

    // THE PAGE'S OWN DEFAULTS, so the header's table is a measurement of the tree
    // as it stands and not a memory. NOTHING HERE IS A REMEMBERED NUMBER: the
    // slider positions and the arithmetic live in PAGE_REF, and the block at the
    // end of this section reads index.html and compares every one of them. See
    // PAGE_REF for the three one-line edits to index.html that used to leave this
    // suite and tools/verify-render.mjs fully green while making the claim below
    // false, and for why the disc size is the one figure that is NOT a default.
    const PAGE_DEG = PAGE_REF.DEG[PAGE_REF.GD];               // GD = 1     -> 4 deg
    const PAGE_CAP = PAGE_REF.CAP[PAGE_REF.GC];               // GC = 0     -> full sphere
    const PAGE_SCALE = PAGE_REF.GS / PAGE_REF.SCALE_DIV;      // GS = 5     -> 0.50 m
    const PAGE_AMP = PAGE_REF.GA / PAGE_REF.AMP_DIV;          // GA = 10    -> 0.50 m
    const PAGE_AMP_MAX = PAGE_REF.GA_MAX / PAGE_REF.AMP_DIV;  // GA max 40  -> 2.00 m
    // The disc is whatever the window gives; 658 px is one real measured case and
    // the header says so. It is a CONDITION of the percentages rather than a
    // setting, so the water-pixel count it implies is pinned below -- that count
    // is the only thing in the table that says WHICH disc it was measured on.
    const PAGE_SIZE = 658, PAGE_WET = 300436;
    const pn = Math.round(360 / PAGE_DEG), pm = Math.round(2 * PAGE_CAP / PAGE_DEG);
    const camP = globeCamera({ size: PAGE_SIZE, tiltDeg: PAGE_REF.GT, rotDeg: 0 });
    const bufP = new Uint8ClampedArray(4 * PAGE_SIZE * PAGE_SIZE);
    // The bed and the initial surface come through the page's own two selects:
    // GLOBE_BEDS's FIRST key, because index.html never assigns $('gbed').value and
    // the options are appended in key order, and GLOBE_INITS[PAGE_REF.INIT],
    // because it does assign $('ginit').value. Both are SUBJECTS here, not
    // targets -- what they have to BE is checked below against a flat 4000 m
    // ocean and P2(sin lat) written out in this file.
    const pageBedKey = Object.keys(GLOBE_BEDS)[0];
    let lutP = null;
    const pageRun = (amp, bump) => {
      const s = new ShallowWater({
        nx: pn, ny: pm, bed: GLOBE_BEDS[pageBedKey].bed, manning: 0, cfl: 0.45,
        eta0: GLOBE_INITS[PAGE_REF.INIT].eta(amp),
        sphere: { R: R_REF, lat0: -PAGE_CAP, lat1: PAGE_CAP, omega: 0 },
      });
      // One click, at 0 E 20 N: the position is this check's, the SIZE is the
      // page's -- index.html's pointerdown handler is what PAGE_REF.BUMP_* is
      // compared against below.
      if (bump) dropBump(s, 0, 20, { amp: PAGE_REF.BUMP_AMP, sigmaDeg: PAGE_REF.BUMP_SIGMA });
      if (!lutP) lutP = buildGlobeLut(camP, gridOf(s));
      return renderGlobe(bufP, s, { lut: lutP, rotDeg: 0, scale: PAGE_SCALE, msl: 0 });
    };
    const page = [
      [`amplitude ${PAGE_AMP.toFixed(2)} m (the default)`, pageRun(PAGE_AMP, false)],
      ['one dropBump click on top of it', pageRun(PAGE_AMP, true)],
      [`amplitude ${(PAGE_AMP_MAX / 2).toFixed(2)} m (mid slider)`, pageRun(PAGE_AMP_MAX / 2, false)],
      [`amplitude ${PAGE_AMP_MAX.toFixed(2)} m (slider max)`, pageRun(PAGE_AMP_MAX, false)],
    ];
    for (const [name, st] of page) {
      console.log(`        ${name.padEnd(34)} eta ${st.etaMin.toFixed(3)}..`
        + `${st.etaMax.toFixed(3)} m   ${String(st.sat).padStart(6)} of ${st.wet} px   `
        + `${(100 * st.satFrac).toFixed(1)}%`);
    }
    const pc = page.map(([, st]) => 100 * st.satFrac);
    assert('the header\'s saturation table is reproduced at the page\'s own defaults',
      Math.abs(pc[0] - 0.0) < 0.05 && Math.abs(pc[1] - 1.7) < 0.05
      && Math.abs(pc[2] - 18.1) < 0.05 && Math.abs(pc[3] - 72.0) < 0.05,
      `measured ${pc.map((v) => v.toFixed(1) + '%').join(' / ')} against the published `
      + `0.0% / 1.7% / 18.1% / 72.0% on a ${PAGE_SIZE} px disc at ${PAGE_DEG} deg`);
    assert('on the disc the header names, whose water-pixel count it also publishes',
      page.every(([, st]) => st.wet === PAGE_WET),
      `${page[0][1].wet} modelled water pixels at ${PAGE_SIZE} px against the published `
      + `${PAGE_WET}. The disc is whatever the window gives, so the percentages above are `
      + 'conditional on this one, and the count is what says which one it was');
    assert('the slider can reach a disc that is MOSTLY one byte', pc[3] > 50,
      `${pc[3].toFixed(1)}% of the disc at amplitude ${PAGE_AMP_MAX.toFixed(2)} m -- over half `
      + 'the picture, a 0.5 m crest and a 2.0 m crest are the same colour, and no fix to the ramp '
      + 'helps: auto-ranging is worse (render.mjs), so the answer is the number, not a new ramp');
    // The two SUBJECTS the rows were built from, against targets written out
    // here. legendreP is not called: it is in the module under test, and a target
    // built from it would move with it.
    let bedWorst = 0, etaWorst = 0;
    const pageEta = GLOBE_INITS[PAGE_REF.INIT].eta(PAGE_AMP);
    for (let lat = -87.5; lat <= 87.5; lat += 2.5) {
      for (let lon = -180; lon < 180; lon += 15) {
        bedWorst = Math.max(bedWorst,
          Math.abs(GLOBE_BEDS[pageBedKey].bed(lon, lat) + PAGE_REF.BED_DEPTH));
        const s = Math.sin(lat * D2R);
        etaWorst = Math.max(etaWorst, Math.abs(pageEta(lon, lat) - PAGE_AMP * 0.5 * (3 * s * s - 1)));
      }
    }
    assert('the page\'s default bed and initial surface are the ones the table assumes',
      bedWorst === 0 && etaWorst === 0,
      `bed "${pageBedKey}" is ${PAGE_REF.BED_DEPTH} m deep everywhere to within ${fmt(bedWorst)} m, `
      + `and "${PAGE_REF.INIT}" is ${PAGE_AMP.toFixed(2)} m x P2(sin lat) to within `
      + `${fmt(etaWorst)} m, over 5040 sampled cells. The percentages are properties of THIS `
      + 'field, so a quiet redefinition of either would move them with nothing to say so');

    // ---- AND THE PREMISE: those really are index.html's defaults ----------
    // Everything above measures a configuration. This is the only thing tying
    // that configuration to the page, and without it "at the page's own defaults"
    // is a restatement of PAGE_REF. The file is READ; nothing here is remembered.
    const pageFile = readPageSource();
    const absent = !pageFile || pageFile.src === null;
    let pd = null, parseErr = '';
    if (!absent) { try { pd = pageDefaults(pageFile.src); } catch (e) { parseErr = e.message; } }
    // ABSENT -> every one of these is a SKIP, by name, so the six that did not run
    // are six lines and not a silence. PRESENT -> they all run, and a page that is
    // here but cannot be read FAILS: the file exists, so the claim is checkable.
    // The two cases are never allowed to look alike.
    const gone = `no index.html at ${pageFile ? pageFile.file : '(no filesystem in this runtime)'}`
      + ' -- the page is not in this tree, which is what a tools/mutants.mjs scratch copy looks '
      + 'like (it clones src/ and tools/ only). The table above stands; this is its PREMISE, and '
      + 'it is unverified here rather than passed';
    const gate = (label, ok, note) => (absent ? skip(label, gone) : assert(label, ok, note));
    const eq = (k, want) => pd !== null && pd[k] === want;
    const eqArr = (k, want) => pd !== null && Array.isArray(pd[k]) && pd[k].length === want.length
      && pd[k].every((v, i) => v === want[i]);
    const say = (f) => (pd === null ? '(index.html did not parse)' : f());
    gate('index.html is still the page these defaults were read out of', pd !== null,
      pd ? `${pageFile.file}, ${pageFile.src.length} bytes`
        : `${parseErr}. The file is HERE, so the claim is checkable and something moved: that `
          + 'is a failure, not a skip');
    gate('its grid and cap sliders really select the 4 deg full sphere rendered above',
      eq('GD', PAGE_REF.GD) && eqArr('DEG', PAGE_REF.DEG)
      && eq('GC', PAGE_REF.GC) && eqArr('CAP', PAGE_REF.CAP),
      say(() => `GD value="${pd.GD}" into GLOBE_DEG [${pd.DEG}] -> ${pd.DEG[pd.GD]} deg `
        + `(this section rendered ${PAGE_DEG} deg, ${pn} x ${pm}); GC value="${pd.GC}" into `
        + `GLOBE_CAP [${pd.CAP}] -> +-${pd.CAP[pd.GC]} deg (rendered +-${PAGE_CAP})`));
    gate('its colour-scale slider really puts full colour at 0.50 m',
      eq('GS', PAGE_REF.GS) && eq('SCALE_DIV', PAGE_REF.SCALE_DIV),
      say(() => `GS value="${pd.GS}" / ${pd.SCALE_DIV} = ${(pd.GS / pd.SCALE_DIV).toFixed(2)} m `
        + `against the ${PAGE_SCALE.toFixed(2)} m the ramp above clamped at. The divisor is `
        + 'read from every place the page applies it, so the readout and the renderer are '
        + 'checked against each other too'));
    gate('its amplitude slider really starts at 0.50 m and tops out at 2.00 m',
      eq('GA', PAGE_REF.GA) && eq('GA_MAX', PAGE_REF.GA_MAX) && eq('AMP_DIV', PAGE_REF.AMP_DIV),
      say(() => `GA value="${pd.GA}" max="${pd.GA_MAX}" / ${pd.AMP_DIV} = `
        + `${(pd.GA / pd.AMP_DIV).toFixed(2)} m default, ${(pd.GA_MAX / pd.AMP_DIV).toFixed(2)} m `
        + `at the stop -- the first and last rows of the table (${PAGE_AMP.toFixed(2)} m, `
        + `${PAGE_AMP_MAX.toFixed(2)} m). The last row's 72% claim is a claim about the STOP`));
    gate('and the rest of the state the table was rendered in',
      eq('INIT', PAGE_REF.INIT) && eq('bedAssigned', false) && eq('omegaChecked', false)
      && eq('GT', PAGE_REF.GT),
      say(() => `$('ginit').value = '${pd.INIT}'; $('gbed').value is `
        + `${pd.bedAssigned ? 'ASSIGNED, so the first option is not the default any more'
          : `never assigned, so the default bed is the first GLOBE_BEDS key, "${pageBedKey}"`}; `
        + `gomega ${pd.omegaChecked ? 'CHECKED' : 'unchecked, Omega = 0'}; `
        + `GT value="${pd.GT}" deg, the camera latitude the disc was baked at`));
    gate('and one click on the globe really drops the 1 m, 8 deg bump of row two',
      eq('BUMP_AMP', PAGE_REF.BUMP_AMP) && eq('BUMP_SIGMA', PAGE_REF.BUMP_SIGMA),
      say(() => `pointerdown -> dropBump(amp ${pd.BUMP_AMP} m, sigma ${pd.BUMP_SIGMA} deg); `
        + `row two is dropBump(amp ${PAGE_REF.BUMP_AMP}, sigma ${PAGE_REF.BUMP_SIGMA}) and its `
        + '1.7% is a claim about what one click costs'));

    // ---- and the label carries it ----------------------------------------
    const lab = globeLabel(half, { bedName: 'x', scale, discR: cam.r, saturation: stH }).join('\n');
    assert('the label states that the ramp clamps and names the full-scale value',
      /RAMP CLAMPS AT \+-0\.50 m/.test(lab) && /ONE byte and one lightness/.test(lab),
      'the same sentence the file uses to refuse Lambert, applied to the ramp');
    assert('the label reports the MEASURED saturated fraction of the last frame',
      new RegExp(`MEASURED on the last frame: ${stH.sat} of ${stH.wet} water pixels `
        + `\\(${(100 * stH.satFrac).toFixed(1)}%\\)`).test(lab)
      && new RegExp(`eta ${stH.etaMin.toFixed(3)}\\.\\.${stH.etaMax.toFixed(3)} m`).test(lab),
      `${stH.sat} of ${stH.wet} (${(100 * stH.satFrac).toFixed(1)}%), eta `
      + `${stH.etaMin.toFixed(3)}..${stH.etaMax.toFixed(3)} m`);
    const labNo = globeLabel(half, { bedName: 'x', scale, discR: cam.r }).join('\n');
    assert('with no frame measured the label says so rather than remembering one',
      /NOT YET MEASURED on this frame/.test(labNo) && !/at or past full scale/.test(labNo),
      'an empty slot is honest, a stale fraction is not -- the same rule the mode period follows');
  }

  // =======================================================================
  if (run('label')) {
    console.log('\n=== 10. the label says what is actually switched on ===================\n');
    // A caption that has to be edited by hand is a caption that will be wrong. So
    // the label reads the sim, and this section proves it by changing the sim.
    const plain = sphereSim({ nx: 120, ny: 60 });
    const L0 = globeLabel(plain, { bedName: GLOBE_BEDS.flat.title, scale: 0.5 }).join('\n');
    assert('label declares AQUAPLANET and refuses the Earth', /AQUAPLANET/.test(L0)
      && /not the Earth/.test(L0), '');
    assert('label declares the sphere is NOT shaded', /THE SPHERE IS NOT SHADED/.test(L0), '');
    assert('label declares lightness = signed elevation', /LIGHTNESS = SIGNED SURFACE ELEVATION/.test(L0), '');
    assert('label declares Omega = 0 when omega is 0', /Omega = 0/.test(L0), '');
    // ---- THE COASTAL SCALE LINES, checked AS THE PAGE PRODUCES THEM ------
    // This used to assert /0\.140-0\.172 px at this disc's r = 350 px/. 350 was
    // globeLabel()'s own default; index.html passes globeView.discR, which is
    // cam.r, and the page's disc is 658 px, so cam.r is 309 and the label really
    // reads "0.124-0.151 px at this disc's r = 309 px". The check was verifying a
    // string that has never once appeared on screen. So build the label the way
    // the page builds it: from a camera.
    const camPage = globeCamera({ size: 658, tiltDeg: 22, rotDeg: 0 });
    const LPage = globeLabel(plain, { bedName: 'x', scale: 0.5, discR: camPage.r }).join('\n');
    assert('label declares the shorelines are not drawn, at the PAGE\'s disc radius',
      /NOT DRAWN/.test(LPage)
      && /0\.124-0\.151 px at this disc's r = 309 px/.test(LPage),
      `r px per radian at the disc centre, not diameter/180 and not half the buffer: a 658 px `
      + `buffer gives cam.r = ${camPage.r}`);
    assert('with no frame drawn the label refuses to quote a px figure at all',
      /NOT YET MEASURABLE in px/.test(L0) && !/px at this disc/.test(L0),
      'globeLabel used to default discR to 350, so an undrawn globe still printed a confident '
      + 'pixel size for a camera that did not exist');
    // THE FOUR SCALE FACTORS, against domains declared HERE rather than read from
    // shorelines.mjs -- which is what globeLabel does, so this is a target and not
    // an echo. If the coastal domains ever change, these have to be re-derived on
    // purpose; that is the point of writing them out.
    const REF_INLET = { Lx: 260 * 12, Ly: 220 * 12, depth: 14 };     // tidalInlet
    const REF_BAY = { Lx: 320 * 8, Ly: 320 * 8, depth: 20 };         // headlandBay
    const fLon = (d) => Math.round(2 * Math.PI * R_REF / d.Lx);
    const fLat = (d) => Math.round(Math.PI * R_REF / d.Ly);
    const crest = (d) => Math.sqrt(G_REF * d.depth) * (2 * Math.PI * R_REF / d.Lx);
    const cDeep = Math.sqrt(G_REF * 4000);
    assert('the four coastal scale factors are the ones this repo\'s domains give',
      fLon(REF_INLET) === 12830 && fLat(REF_INLET) === 7581
      && fLon(REF_BAY) === 15637 && fLat(REF_BAY) === 7818,
      `tidalInlet ${REF_INLET.Lx}x${REF_INLET.Ly} m -> x${fLon(REF_INLET)} lon, x${fLat(REF_INLET)} `
      + `lat; headlandBay ${REF_BAY.Lx}x${REF_BAY.Ly} m -> x${fLon(REF_BAY)} lon, x${fLat(REF_BAY)} `
      + 'lat. The label used to print x12,830 (tidalInlet, longitude) beside x15,637 '
      + '(headlandBay, LONGITUDE) and call the second one a latitude factor');
    assert('the label prints both scenarios with their own four numbers',
      new RegExp(`tidalInlet .* x12,830 in longitude and x7,581 in latitude`).test(LPage)
      && new RegExp(`headlandBay .* x15,637 in longitude and x7,818 in latitude`).test(LPage),
      'each figure named with the scenario it belongs to');
    assert('a SQUARE coastal patch is reported as shearing by exactly 2.00',
      REF_BAY.Lx === REF_BAY.Ly && /headlandBay .* SHEARS 2\.00x/.test(LPage)
      && /tidalInlet .* SHEARS 1\.69x/.test(LPage),
      'longitude spans 2piR and latitude piR, so a square patch stretches twice as far in one '
      + 'axis as the other whatever its size -- and a latitude factor printed as a longitude '
      + 'factor would report 1.00');
    assert('the crest speeds belong to the depths the scenarios actually have',
      Math.abs(crest(REF_INLET) / 1000 - 150.3) < 0.1
      && Math.abs(crest(REF_BAY) / 1000 - 219.0) < 0.1
      && new RegExp(`tidalInlet .* at 150 km/s .* ${Math.round(crest(REF_INLET) / cDeep)}x too fast`)
        .test(LPage)
      && new RegExp(`headlandBay .* at 219 km/s .* ${Math.round(crest(REF_BAY) / cDeep)}x too fast`)
        .test(LPage),
      `tidalInlet 14 m -> c ${Math.sqrt(G_REF * 14).toFixed(2)} m/s -> `
      + `${(crest(REF_INLET) / 1000).toFixed(1)} km/s = ${Math.round(crest(REF_INLET) / cDeep)}x; `
      + `headlandBay 20 m -> c ${Math.sqrt(G_REF * 20).toFixed(2)} m/s -> `
      + `${(crest(REF_BAY) / 1000).toFixed(1)} km/s = ${Math.round(crest(REF_BAY) / cDeep)}x; `
      + `deep ocean ${cDeep.toFixed(2)} m/s`);
    assert('the retired figures are gone',
      !/127 km\/s/.test(LPage) && !/642x/.test(LPage) && !/x15,637 in latitude/.test(LPage),
      '127 km/s implied a 9.99 m depth that no named scenario has, and 642x was 127/0.198 '
      + 'inheriting it');
    assert('label says the spin is a CAMERA, not planetary rotation',
      /THE SPIN IS A CAMERA/.test(L0), '');
    assert('label declares the closed form DERIVED, not cited',
      /DERIVED/.test(L0) && /no citation retrieved/.test(L0), '');
    assert('label admits the period is not yet measured', /NOT YET MEASURED/.test(L0), '');
    const rot = sphereSim({ nx: 120, ny: 60, omega: 7.292115e-5 });
    const L1 = globeLabel(rot, { bedName: 'x', scale: 0.5 }).join('\n');
    assert('turning Coriolis ON changes the label by itself',
      /Coriolis ON/.test(L1) && !/Omega = 0/.test(L1),
      'omega = 7.292115e-5 rad/s');
    const capd = globeLabel(sphereSim({ ny: 80, lat0: -80, lat1: 80 }), { bedName: 'x' }).join('\n');
    assert('a latitude cap is named as a MITIGATION, with its bounds',
      /latitude cap -80\.\.80/.test(capd) && /honest mitigation/.test(capd), '');
    assert('an uncapped run says so', /full sphere, pole to pole/.test(L0), '');
    const tax = polarTimestepTax(plain);
    assert('the polar timestep tax is measured off the metric, not quoted',
      tax.ratio > 5 && new RegExp(`factor ${tax.ratio.toFixed(1)}`).test(L0),
      `dt ${tax.pole.toFixed(2)} s at lat ${tax.poleLat.toFixed(1)} vs ${tax.eq.toFixed(2)} s at `
      + `lat ${tax.eqLat.toFixed(1)}, ratio ${tax.ratio.toFixed(1)}x at 3 deg`);
    assert('the UNVERIFIED bed shape is labelled UNVERIFIED',
      /UNVERIFIED/.test(GLOBE_BEDS.williamsonCone.title)
      && /NOT checked against the paper/.test(GLOBE_BEDS.williamsonCone.note), '');
    // THE LABEL MEASURES THE BED INSTEAD OF REPEATING ITS CAPTION. Hand it a bed
    // whose caption is a lie and it must contradict the caption.
    assert('a flat bed is reported as 0 m of relief and no dry cells',
      /relief 0 m \(4000 to 4000 m of water\)/.test(L0) && /no dry cells/.test(L0), '');
    const isl = sphereSim({ nx: 120, ny: 60, bed: GLOBE_BEDS.seamount.bed });
    const Li = globeLabel(isl, { bedName: 'a bed I will describe wrongly', bedNote: 'perfectly flat' }).join('\n');
    const sv = surveyBed(isl);
    assert('a piercing bed is reported with its relief, dry cells and crest',
      new RegExp(`relief ${sv.relief.toFixed(0)} m`).test(Li)
      && new RegExp(`${sv.dry} dry cells`).test(Li) && sv.dry > 0,
      `measured relief ${sv.relief.toFixed(0)} m, ${sv.dry} dry cells, crest `
      + `${sv.crest.toFixed(0)} m -- printed even though the caption says "perfectly flat"`);
    assert('the closed form disowns itself when the bed is not uniform',
      /derived for UNIFORM depth/.test(Li) && !/derived for UNIFORM depth/.test(L0),
      'the formula assumes uniform H; a label that quoted it over a seamount would be '
      + 'comparing against the wrong ocean');
  }

  // =======================================================================
  if (run('merian')) {
    console.log('\n=== 11. the number the label quotes: spherical mode period ============\n');
    // NOT a renderer check. It is here because the label quotes it, and a label
    // may not quote a figure nothing in the shipped tree can reproduce.
    assert('the solver\'s G equals the locally declared reference', SWE_G === G_REF,
      `swe.mjs ${SWE_G} vs G_REF ${G_REF} -- without this the closed form below rescales with any `
      + 'error in g and the comparison is empty');
    for (const deg of [6, 4]) {
      const r = measureModePeriod({ n: 2, deg, H: 4000, R: R_REF, gRef: G_REF, amp: 1, periods: 2 });
      near(`n = 2 period at ${deg} deg vs g H n(n+1)/R^2`, r.measured, r.closed, 0.01,
        `${(r.measured / 3600).toFixed(4)} h vs ${(r.closed / 3600).toFixed(4)} h, `
        + `${(100 * r.rel).toFixed(4)}%; ${r.note}`);
      assert(`n = 2 at ${deg} deg is LATE, not early`, r.rel < 0,
        `${(100 * r.rel).toFixed(4)}% -- the sign is coherent across modes and resolutions and is `
        + 'the discretisation, not a fit');
    }
    const r3 = measureModePeriod({ n: 3, deg: 6, H: 4000, R: R_REF, gRef: G_REF, amp: 1, periods: 2 });
    near('n = 3 period at 6 deg', r3.measured, r3.closed, 0.01,
      `${(r3.measured / 3600).toFixed(4)} h vs ${(r3.closed / 3600).toFixed(4)} h, `
      + `${(100 * r3.rel).toFixed(4)}%`);
    assert('n = 3 is faster than n = 2, by sqrt(n(n+1)) as the closed form requires',
      r3.closed < 0.72 * 2 * Math.PI * R_REF / Math.sqrt(G_REF * 4000 * 2 * 3),
      `ratio ${(r3.closed / (2 * Math.PI * R_REF / Math.sqrt(G_REF * 4000 * 6))).toFixed(6)} `
      + 'against sqrt(6/12) = 0.707107');
    let threw = false;
    try { measureModePeriod({ n: 2, deg: 12, R: R_REF }); } catch { threw = true; }
    assert('the measurement refuses to build its own target from the solver\'s G', threw,
      'gRef is required');
    let threwN = false;
    try { legendreP(1, 0.3); } catch { threwN = true; }
    assert('n = 1 is refused (rigid translation of the shell)', threwN, '');
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} -- ${checks - failures}/${checks} checks`
    + (skipped ? `, ${skipped} SKIPPED -- see the SKIP lines above; something the checks are `
      + 'about is not in this tree, and its absence is reported rather than passed' : '') + '\n');
  return { checks, failures, skipped };
}

/** CIE L* of an sRGB byte triple. A local copy of the standard transform, so the
 *  shading check measures in the unit render.mjs's ramp is defined in. */
function Lstar(c) {
  const lin = (u) => { u /= 255; return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); };
  const Y = 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
}
function argMax(a) { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i; return k; }
function argMin(a) { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] < a[k]) k = i; return k; }

/** Next double up. Used only by check 4's control. */
function nextUp(x) {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, x);
  const hi = b.getUint32(0), lo = b.getUint32(4);
  if (lo === 0xffffffff) { b.setUint32(0, hi + 1); b.setUint32(4, 0); }
  else b.setUint32(4, lo + 1);
  return b.getFloat64(0);
}

// ---------------------------------------------------------------------------
// Bench. Reported as a table because one number from one size is not a cost.
// ---------------------------------------------------------------------------

export function benchGlobe({ sizes = [500, 700, 900], deg = 2, reps = 30 } = {}) {
  const sim = new ShallowWater({
    nx: Math.round(360 / deg), ny: Math.round(180 / deg), bed: () => -4000, manning: 0,
    eta0: (lon, lat) => 0.4 * legendreP(2, Math.sin(lat * D2R)),
    sphere: { R: R_REF, lat0: -90, lat1: 90, omega: 0 },
  });
  const grid = gridOf(sim);
  const rows = [];
  for (const size of sizes) {
    const cam = globeCamera({ size, tiltDeg: 22, rotDeg: 0 });
    const t0 = performance.now();
    const lut = buildGlobeLut(cam, grid);
    const bake = performance.now() - t0;
    const buf = new Uint8ClampedArray(4 * size * size);
    renderGlobe(buf, sim, { lut, rotDeg: 0, scale: 0.5 });   // warm
    let best = Infinity, sum = 0;
    for (let r = 0; r < reps; r++) {
      const a = performance.now();
      renderGlobe(buf, sim, { lut, rotDeg: r * 3.7, scale: 0.5 });
      const d = performance.now() - a;
      sum += d; if (d < best) best = d;
    }
    rows.push({
      size, px: lut.count, bake, best, mean: sum / reps,
      bytes: 20 * lut.count + 4 * size * size,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Run directly? Compared by BASENAME, not by URL. `new URL('file://' + argv[1])`
// is wrong on Windows -- it reads the drive letter as a host -- and this
// repository's path has a space in it, which import.meta.url percent-encodes and
// argv[1] does not. A browser never has `process`, so the guard is also what
// keeps this block out of the page.
if (typeof process !== 'undefined' && process.argv && process.argv[1]
    && /(^|[\\/])globe\.mjs$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.includes('--bench')) {
    console.log('\n=== per-frame cost, 360x180 field (2 deg) ============================\n');
    console.log('  disc   pixels    bake ms   best ms   mean ms   LUT+frame bytes');
    for (const r of benchGlobe()) {
      console.log(`  ${String(r.size).padStart(4)}   ${String(r.px).padStart(7)}   `
        + `${r.bake.toFixed(2).padStart(7)}   ${r.best.toFixed(2).padStart(7)}   `
        + `${r.mean.toFixed(2).padStart(7)}   ${(r.bytes / 1048576).toFixed(1)} MB`);
    }
    console.log('');
    process.exit(0);
  }
  const filter = args.find((a) => !a.startsWith('-')) ?? null;
  const { failures } = globeChecks(filter);
  process.exit(failures ? 1 : 0);
}
