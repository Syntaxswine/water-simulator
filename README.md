# water-simulator

A two-dimensional shallow-water solver for coastal water: still water, tides, and waves
whose behaviour is set by the shape of the seabed.

JavaScript, no dependencies, runs in Node and in a browser.

```bash
node tools/verify.mjs          # 35 checks: the solver against closed-form water
node tools/verify-physics.mjs  # 43 checks: the subsystems that suite leaves uncovered
node tools/verify-tide.mjs     # 15 checks: constituents, resonance, a drying flat
node tools/waves.mjs [case]    # 8 cases: what the bed does to the waves
node tools/mutants.mjs         # 16 mutations of real physics; see what goes red
node serve.mjs                 # browser view on :8750
```

Every number in this file was reproduced from those commands on 2026-08-14, and is quoted
at the precision the tool prints it at. Where a tool declines to assert something, this
file says so rather than quoting the number as though it had passed.

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
                                  max |eta - 2 m|    max speed
lake at rest, smooth bump         4.4409e-16 m       2.3915e-14 m/s
lake at rest, sharp step          0                  1.5877e-14 m/s
lake at rest, random rough        8.8818e-16 m       3.2266e-14 m/s
lake at rest, island (pierces)    8.8818e-16 m       1.8395e-14 m/s
```

Four beds, 400 steps each on a 200x4 grid at dx = 5 m. Machine epsilon, not a tolerance:
8.8818e-16 m is exactly two floating-point ulp at η = 2 m, and 4.4409e-16 m is one. The
**worst** of the four beds is what gets quoted in the table below, not the best.

## What is verified, and against what

Most of what is checked here has a target that exists without the solver: an analytic
solution (Ritter, Thacker, Green, Merian, the inertial oscillation), an exact identity
(volume in a closed box, the Manning spin-down identity, 2D transpose symmetry), or a
constant from the literature. Two things are **not**, and both say so in the source and in
what they print at runtime: `tools/verify.mjs` section 7 is headed
`SELF-CONVERGENCE (not verification)` because its reference is the same solver on a finer
grid, and the damping table in `tools/waves.mjs` opens by calling itself a regression
instrument. `verify.mjs` and `verify-tide.mjs` each begin by asserting that the reference
gravity is a literal constant and not imported from the solver — importing it is what made
an earlier version of this suite circular, and that assert is the guard against it coming
back.

| claim | measured |
|---|---|
| lake at rest over four beds, incl. a piercing island | worst 8.8818e-16 m, 3.2266e-14 m/s |
| mass conservation, closed basin, 600 steps | 8.3047e-15 relative |
| Ritter dam break, contours at h ≥ 0.1 m | 0.402 – 0.670% |
| long-wave celerity `c = √(gh)`, three depths | 0.011 – 0.307% |
| Thacker parabolic-bowl oscillation period | **0.004%** |
| Merian seiche period `2L/√(gh)` | **0.000%** |
| Green shoaling exponent, small-amplitude limit | −0.243 vs −0.250 (2.81%) |
| quarter-wave tidal resonance `4L/√(gh)` | peak found at T/T_res = 1.00, gain 2.78x |
| Flather boundary reflection (wall control 98.2%) | **0.12%** |
| depth-limited breaking, peak `H/h` | 0.4660 against McCowan 0.78 — 60% of the index, **NOT ASSERTED** |

That last row is the one to read carefully. It has its own section below, because it is the
place where this model does not do what a coastal engineer will assume it does.

## What it is not

**The shallow-water equations have no frequency dispersion.** Every wave travels at
`√(gh)` regardless of wavelength, where the truth is `ω² = gk·tanh(kh)`. That is accurate
to a few percent for `kh < 0.5` — tides, surges, tsunamis, and swell once it is well inside
the surf zone — and increasingly wrong in deeper water. Each wave run prints its own error:
the plane-beach case runs at `kh = 0.52` and reports the SWE celerity 4.3% fast against
Airy; the headland case at `kh = 0.40` reports 2.6% fast.

**It never reaches the depth-limited breaking point, so it is not a breaking model.** This
is the visible consequence of that missing dispersion, and it is large.
`node tools/waves.mjs planeBeach` prints:

```
Green + McCowan predict breaking at h = 1.6492 m with H = 1.2864 m.
Measured peak H/h = 0.4660 at h = 0.6127 m -- 60% of the index, NOT ASSERTED.
```

and across the amplitude sweep the peak `H/h` tracks the offshore height instead of
saturating at a depth limit:

```
H0 = 0.8     peak H/h = 0.4775 at h = 0.6051 m
H0 = 0.2     peak H/h = 0.4276 at h = 0.5300 m
H0 = 0.05    peak H/h = 0.1852 at h = 0.4845 m
H0 = 0.012   peak H/h = 0.0501 at h = 0.4580 m
```

A genuinely depth-limited surf zone would cluster those four near 0.78 whatever `H0` was.
They span a factor of ten, so the peak is not a depth limit at all — it is whatever
amplitude survived the trip inshore. Nothing balances the nonlinear steepening, so a
finite-amplitude wave sharpens into a bore and dissipates *before* it can reach
`H = 0.78 h`: Green's law says the wave should shoal by 2.0970x between h = 11.8483 m and
h = 0.6127 m, and the model achieved 0.3646x.

The one check `waves.mjs` does assert here is deliberately one-sided — peak `H/h` must stay
*below* 0.78 — and its own message explains why: it catches a surf zone growing without
limit, and it is not agreement with McCowan. Do not read the breaker index as reproduced.

**Shoaling converges on Green's law only as amplitude falls.** The fitted exponent
`d(logH)/d(logh)` on a plane beach, against Green's −0.25:

```
H0 = 0.8     +0.151        H0 = 0.05    -0.243
H0 = 0.2     -0.210        H0 = 0.012   -0.243
```

Converging on the theory as amplitude falls is what identifies the cause as the nonlinear
steepening above. Bed friction is not it: at H0 = 0.8 m, Manning 0.022 gives 0.154 and 0
gives 0.152.

**So: use it for long waves. Do not quote it for deep-water wind sea, and do not quote it
for breaking.**

**There is a resolution floor.** Amplitude retained after fifteen wavelengths of travel,
measured on a periodic domain with no boundaries in it at all (`verify.mjs` section 8):

```
20 cells/wavelength   50.7%
40 cells/wavelength   85.7%
80 cells/wavelength   95.6%
```

`node tools/waves.mjs damping` sweeps the same quantity wider. It labels itself a
regression instrument rather than a check, because its reference is the solver:

```
cells/L   retained per L   over 15 L
     10           0.7329      0.9%
     15           0.9097     24.2%
     20           0.9532     48.7%
     25           0.9714     64.7%
     30           0.9802     74.0%
     40           0.9887     84.4%
     60           0.9944     91.9%
     80           0.9964     94.7%
```

The two tables disagree by about two points at 20 and 40 cells because they are different
measurements: `verify.mjs` runs the full fifteen wavelengths at CFL 0.4, while the
instrument raises a per-wavelength retention — measured over ten wavelengths at CFL 0.45 —
to the fifteenth power. Neither is the true figure. They agree on where the floor is.

Below 40 cells per wavelength a coastal result is measuring the grid. Cells-per-wavelength
gets *worse* as a wave shoals, because `L ∝ √h` — so the requirement is set by the shallow
end of the domain, not the deep end. Every wave run prints its own figure.

**The dry tip of a dam break lags.** Contours at h ≥ 0.1 m track Ritter to 0.402 – 0.670%
and the L1 error falls under refinement (1.52e-3 → 9.89e-4 → 7.56e-4, a measured order of
0.50; the suite notes that first order is the correct expectation at a shock). The h = 1 cm
contour lags −9.6% and does **not** converge: it is 10x the 0.001 m dry threshold, so this
is the model's floor rather than a bug. `verify.mjs` prints it as a KNOWN LIMIT instead of
hiding it.

## The shorelines

The bed is the wave model. Each bathymetry is built to make one process dominant so it can
be measured on its own.

| shoreline | what it is for | exercised by |
|---|---|---|
| `planeBeach` | shoaling against Green's law, and a surf zone that does *not* reach the breaking index | `waves.mjs planeBeach`, `waves.mjs snell` |
| `barredBeach` | break on the bar, reform in the trough, break again — two surf zones | `waves.mjs barredBeach` |
| `headlandBay` | refraction **focusing** energy on the point, sheltering the bay | `waves.mjs headlandBay` |
| `submarineCanyon` | refraction **defocusing** — the same law with the other sign | `waves.mjs submarineCanyon` |
| `shoal` | a caustic behind an isolated bank (Berkhoff's experiment) | `waves.mjs shoal` — measured and printed, **not asserted**, and it says so in its own output |
| `fringingReef` | wave setup in the lagoon, driven by breaking momentum flux | `waves.mjs fringingReef` |
| `tidalInlet` | a back-barrier basin filling and emptying through a throat | **nothing — UNVERIFIED** |

`tidalInlet` carries an `expect` string in `src/shorelines.mjs` as confident as the other
six — a strong tidal jet in the throat, a phase lag and damped range inside the basin,
flood/ebb asymmetry, partial drying at low water — and no tool measures any of it. It is
not in the `CASES` list in `tools/waves.mjs`. Read it as a bathymetry you can look at in
the browser view, not as a result.

`waves.mjs snell` is not a separate bed: it is the plane beach at oblique incidence, and it
measures the crest **angle** off the phase field rather than a height. Its own comment is
explicit that the alongshore wavenumber is conserved by construction, so that half is a
wavemaker regression check and only the cross-shore half carries physics.

### Refraction on the headland

Incident 1.2 m wave, T = 23 s, 320x320 at dx = 8 m, 40.3 cells/wavelength — just over the
floor:

```
contour     headland H   its 1D null   gain   |     bay H   its 1D null   gain   |  head/bay
h =  6 m       1.7209        1.3899  1.2382   |    0.9150        1.0797  0.8474   |    1.4611
h =  8 m       1.6381        1.4020  1.1684   |    0.9656        1.1006  0.8773   |    1.3318
h = 10 m       1.5599        1.3680  1.1403   |    1.0387        1.1243  0.9239   |    1.2343
```

**What the 1D null column is for.** Each row is re-run as a one-dimensional transect over
the bed read straight out of the 2D grid, with the same boundary treatment: same shoaling,
same friction, same numerical damping, no alongshore variation and therefore no refraction
available to it at all. Dividing by it removes everything that is not refraction. That
matters here because the bay gauge sits 1208 – 1248 m further from the wavemaker than the
headland gauge, and the grid eats amplitude with distance — differential damping alone
accounts for 1.043x, 1.046x and 1.041x of a head/bay ratio, with no physics in it.

An earlier version of this file published **2.36 / 2.23 / 2.11** for these three contours.
Those came from a run at 19.3 cells/wavelength — half the floor — with no control, and most
of the effect was the path difference rather than refraction. The honest figures are
**1.4611 / 1.3318 / 1.2343**, and they are a real and strong signal:

- at h = 6 m the headland is focused to 1.2382x its own no-refraction null while the bay is
  sheltered to 0.8474x its own — opposite signs, which a common-mode error cannot produce;
- focusing strengthens as the wave shoals onto the point (1.4611 > 1.3318 > 1.2343 at
  h = 6 < 8 < 10 m), which is what converging rays must do;
- every ratio clears the differential-damping confound by more than a factor two on the
  excess over 1.

The apparatus is itself mutation-tested. Straighten the shoreline and the whole measurement
chain must come back to exactly 1:

```
amp =    0 m: headland gain 1.0000, bay gain 1.0000, head/bay 1.0000
amp =  620 m: headland gain 1.1939, bay gain 0.8799, head/bay 1.3569
```

(run at half resolution, which is why the second row reads 1.3569 rather than 1.4611). The
zero row proves the chain invents no difference where there is none. It cannot catch an
error that scales both rows alike, and the tool says so.

This is why headlands erode and bays fill with sand.

## Tides

A tide is not generated inside a coastal domain — it arrives. The constituents are imposed
at the open boundary and the bathymetry does the rest: shoaling, resonance, distortion, and
a shoreline that moves kilometres.

Quarter-wave resonance is **emergent**: nothing in the solver knows `T = 4L/√(gh)`, and a
forced sweep of a 90 km bay 40 m deep, opening onto a 400 m shelf, finds the peak exactly
there:

```
T/T_res = 0.55   head amplitude / incident = 2.034
T/T_res = 0.80   head amplitude / incident = 2.609
T/T_res = 1.00   head amplitude / incident = 2.783
T/T_res = 1.25   head amplitude / incident = 2.679
T/T_res = 1.70   head amplitude / incident = 2.415
```

A resonator needs a partially reflecting mouth, which is worth stating because getting it
wrong is instructive. Here the depth step returns 52% of the outgoing wave, and the peak
gain of 2.78x is *above* the 2.0 a wave gets from simply doubling against a closed end —
that gap is the arithmetic separating resonance from reflection. `tools/verify-tide.mjs`
records in its own source that before the impedance step was added, a perfectly transparent
mouth produced that flat doubling at **every** forcing period. That is correct, and it is
not resonance: with nothing to send the wave back there is no standing mode to build. Real
bays ring because their mouth is an impedance step.

A real tide over a drying flat, four cycles: the wetted fraction of the domain swings from
86.7% to 100.0%, the range falls from 6.53 m at the mouth to 4.84 m in the inner basin
(ratio 0.74), and the tide arrives distorted — mean flood 2.83 h against mean ebb 9.47 h,
an asymmetry of 107.9% where a linear tide would be exactly symmetric.

## Honesty about the tests

A green suite is a claim about the tests, not about the code. `tools/mutants.mjs` breaks
load-bearing physics on purpose in a **copy** of `src/`, runs the shipped suites against
that copy byte for byte, and reports which suite noticed. It exists because an independent
hostile review broke seven load-bearing pieces — gravity, the positivity limiter, the
desingularised velocity, the Manning exponent, the friction splitting, the HLLC contact
wave, and Coriolis — and `tools/verify.mjs` printed **ALL PASS — 32/32 checks** for every
one of them. The test file imported `G` from the module under test, so every "closed-form"
reference rescaled with the bug.

`node tools/mutants.mjs --list` currently declares **16 mutants**, run against three
suites: `tools/verify-physics.mjs`, `tools/verify.mjs`, `tools/verify-tide.mjs`. Each
mutant names the suite aimed at what it breaks; if the declared suites all stay green the
harness escalates and runs every remaining suite before it will call anything a survivor. A
mutation whose patch text is not found exactly once in the source is an error, not a pass —
that is the failure mode which would otherwise look identical to full coverage.

**`tools/waves.mjs` is not one of the suites the harness runs.** The wave cases — shoaling,
refraction, wave setup, the surf zone, Snell's law — have no mutation coverage at all.
Nothing has established that they would go red if the physics beneath them were broken.
That is the largest remaining hole in what "green" means here.

Two things the harness prints but deliberately never asserts, because both are the code
under test producing its own reference: each mutant's `found` note (what this harness
measured on a stated date) and its `review` note (what the reviewer measured against the
older suite). They are there so a later reader can see the answer move. Comparing against
them automatically would be exactly the circular check this repository exists to stop
doing.

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
