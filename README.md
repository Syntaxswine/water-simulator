# water-simulator

A two-dimensional shallow-water solver for coastal water: still water, tides, and waves
whose behaviour is set by the shape of the seabed.

JavaScript, no dependencies, runs in Node and in a browser.

```bash
node tools/verify.mjs          # the solver against closed-form water
node tools/verify-physics.mjs  # the subsystems each suite above leaves uncovered
node tools/verify-tide.mjs     # tides: constituents, resonance, a drying flat
node tools/waves.mjs           # what the bed does to the waves, per shoreline
node tools/mutants.mjs         # break the physics on purpose; see what goes red
node serve.mjs                 # browser view on :8750
```

---

## What it is

The nonlinear shallow-water equations, solved by a finite-volume Godunov scheme:

- MUSCL reconstruction of (η, u, v), monotonized-central limited, 2nd order
- HLLC approximate Riemann solver with Einfeldt speeds and explicit dry-state handling
- SSP-RK2 in time
- **Audusse hydrostatic reconstruction**, which is what makes still water actually still
- wetting and drying, so a shoreline can move
- a positivity-preserving flux limiter, so a cell cannot give away water it does not have
- Manning bed friction, semi-implicit
- Flather radiation boundaries, so a tide can come in and its reflection can leave
- Coriolis, for domains large enough to need it

## Why "well-balanced" is the whole design

Still water over an uneven bed is the state a coastal model spends most of its time in: a
harbour between waves, a lagoon behind a reef, a bay at slack tide. In that state the
pressure-gradient flux and the bed-slope source term are individually enormous and must
cancel **exactly**. Discretise them independently — the obvious thing — and they cancel
only to truncation error, so a flat lake over a sloping bed grows currents of a few cm/s
and never stops. Those currents look like physics. They are the scheme talking to itself,
and every wave you launch afterwards rides on them.

So the bed is not a source term bolted onto a flux. The flux is evaluated on
hydrostatically reconstructed depths, and lake-at-rest cancels algebraically:

```
lake at rest, smooth bump         max |eta - 2 m| = 8.9e-16 m over 400 steps
lake at rest, sharp step          max |eta - 2 m| = 0
lake at rest, random rough        max |eta - 2 m| = 8.9e-16 m
lake at rest, island (pierces)    max |eta - 2 m| = 4.4e-16 m
```

Machine epsilon, not a tolerance.

## What is verified, and against what

Nothing here checks that the simulator agrees with itself. Every target is a published
analytic solution or an exact identity.

| claim | measured |
|---|---|
| lake at rest over four beds, incl. a piercing island | 4.4e-16 m, 1.9e-14 m/s |
| mass conservation, closed basin, 600 steps | 3.8e-15 relative |
| Ritter dam break, contours at h ≥ 0.1 m | 0.2 – 1.1% |
| long-wave celerity `c = √(gh)`, three depths | 0.013 – 0.31% |
| Thacker parabolic-bowl oscillation period | **0.007%** |
| Merian seiche period `2L/√(gh)` | **0.000%** |
| Green shoaling exponent, small-amplitude limit | −0.238 vs −0.250 |
| breaker index `H/h` | 0.813 vs McCowan 0.78 |
| quarter-wave tidal resonance `4L/√(gh)` | peak found at T/T_res = 1.00 |
| Flather boundary reflection (wall control 98.2%) | **0.12%** |

## What it is not

**The shallow-water equations have no frequency dispersion.** Every wave travels at
`√(gh)` regardless of wavelength, where the truth is `ω² = gk·tanh(kh)`. That is accurate
to a few percent for `kh < 0.5` — tides, surges, tsunamis, and swell once it is well inside
the surf zone — and increasingly wrong in deeper water.

The visible consequence is that nothing balances nonlinear steepening, so a finite-amplitude
wave sharpens into a bore and dissipates *before* it reaches the depth-limited breaking
point. Measured on a plane beach, the fitted shoaling exponent against Green's −0.25:

```
H0 = 0.800 m   +0.152        H0 = 0.050 m   -0.236
H0 = 0.200 m   -0.179        H0 = 0.012 m   -0.238
```

Converging on the theory as amplitude falls is what identifies the cause. Bed friction is
not it: at H0 = 0.8 m, Manning 0.022 gives 0.154 and 0 gives 0.152.

**So: use it for long waves. Do not quote it for deep-water wind sea.**

**There is a resolution floor.** Amplitude retained after fifteen wavelengths of travel:

```
15 cells/wavelength   24.4%        40 cells/wavelength   85.7%
20 cells/wavelength   50.7%        80 cells/wavelength   95.6%
```

Below 40 cells per wavelength a coastal result is measuring the grid. Cells-per-wavelength
gets *worse* as a wave shoals, because `L ∝ √h` — so the requirement is set by the shallow
end of the domain, not the deep end. Every wave run prints its own figure.

**The dry tip of a dam break lags.** Contours at h ≥ 0.1 m track Ritter to about 1% and
converge under refinement; the h = 1 cm contour lags ~9% and converges to a floor set by
the dry threshold rather than to zero. That is the model's floor, and it is printed rather
than hidden.

## The shorelines

The bed is the wave model. Each bathymetry is built to make one process dominant so it can
be measured on its own.

| shoreline | what it is for |
|---|---|
| `planeBeach` | shoaling against Green's law, then depth-limited breaking |
| `barredBeach` | break on the bar, reform in the trough, break again — two surf zones |
| `headlandBay` | refraction **focusing** energy on the point, sheltering the bay |
| `submarineCanyon` | refraction **defocusing** — the same law with the other sign |
| `shoal` | a caustic behind an isolated bank (Berkhoff's experiment) |
| `fringingReef` | wave setup in the lagoon, driven by breaking momentum flux |
| `tidalInlet` | a back-barrier basin filling and emptying through a throat |

Refraction focusing on the headland, measured at three independent depth contours from an
incident 1.2 m wave:

```
h =  6 m    headland 1.110 m    bay 0.470 m    ratio 2.36
h =  8 m    headland 1.219 m    bay 0.548 m    ratio 2.23
h = 10 m    headland 1.263 m    bay 0.600 m    ratio 2.11
```

This is why headlands erode and bays fill with sand.

## Tides

A tide is not generated inside a coastal domain — it arrives. The constituents are imposed
at the open boundary and the bathymetry does the rest: shoaling, resonance, distortion, and
a shoreline that moves kilometres.

Quarter-wave resonance is **emergent**: nothing in the solver knows `T = 4L/√(gh)`, and a
forced sweep of a 90 km bay opening onto a deeper shelf finds the peak exactly there.

A resonator needs a partially reflecting mouth, which is worth stating because getting it
wrong is instructive: with a perfectly transparent boundary the gain came out 1.98 at
*every* forcing period. That is correct, and it is not resonance — a wave hitting the closed
end doubles, and with nothing to send it back there is no standing mode to build. Real bays
ring because their mouth is an impedance step.

## Honesty about the tests

A green suite is a claim about the tests, not about the code. `tools/mutants.mjs` breaks
load-bearing physics on purpose and reports which suite notices. It exists because an
independent hostile review found that the suite passed **32/32 with gravity scaled by 1.1**
— the test file imported `G` from the module under test, so every "closed-form" reference
rescaled with the bug. Seven separate mutations of real physics produced zero failures.

That is fixed, and the harness is the permanent answer to *what does a green suite mean*.

## Layout

```
src/swe.mjs          the solver
src/shorelines.mjs   seven bathymetries, each with a stated expectation
src/waves.mjs        wave theory and measurement, kept APART from the solver
src/tide.mjs         constituents and resonance arithmetic
src/render.mjs       canvas view: map + section
tools/               the instruments
```

`src/waves.mjs` holds the theory the solver is checked against and is never used to advance
the solution. If a check imports its expected answer from the code that produced the answer,
it has stopped being a check.

---

*Built by Claude Opus 5 for StonePhilosopher.*
