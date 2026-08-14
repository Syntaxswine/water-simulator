// ---------------------------------------------------------------------------
// Shorelines: the bathymetry is the wave model.
//
// A wave in deep water carries its shape from wherever the wind made it. Almost
// everything that makes a coastline's waves ITS waves happens in the last few
// hundred metres, and it is done by the bed:
//
//   shoaling      as depth falls the group speed falls, and since energy flux
//                 c_g * E is conserved the height must rise. In shallow water
//                 c_g = sqrt(gh), so H ~ h^(-1/4) -- Green's law.
//   refraction    the crest travels faster in deep water, so it swings round to
//                 face the contours: sin(theta)/c is invariant, Snell's law with
//                 c = sqrt(gh).
//   focusing      a headland or shoal bends rays TOGETHER and concentrates
//                 energy; a submarine canyon bends them apart and shelters the
//                 coast behind it. Same law, opposite sign of curvature.
//   breaking      when H/h reaches about 0.8 the crest outruns the trough and
//                 the wave collapses, dumping its energy over a surf zone whose
//                 width is set by the slope.
//   setup         the momentum lost by breaking waves pushes the mean water
//                 level UP against the shore, by ~10-20% of the breaker height.
//
// So each profile below is not decoration. Each one is chosen because it makes a
// DIFFERENT one of those effects dominant and therefore separately checkable.
// Every entry carries `expect`, a plain statement of what should happen, so that
// tools/waves.mjs is testing the physics that shoreline was built to exercise
// rather than whatever the simulation happened to produce.
//
// A SHORELINE HAS TO BE ABLE TO SHOW WHAT IT CLAIMS. Two of them could not, and
// both were found by plotting the bed rather than by running the model:
//
//   barredBeach     the bar crest sat in 4.358 m of water with its trough in
//                   4.716 m -- 0.36 m of relief on a 12 m shelf. A 1.1 m wave
//                   shoals to H/h = 0.33 there by Green's law, so nothing broke
//                   on the bar, nothing reformed behind it, and the case could
//                   not have produced its own `expect` at any resolution.
//   submarineCanyon the incision grew LANDWARD (the comment said it "narrows and
//                   shallows as it runs inshore"; the code did the opposite) and
//                   was never switched off, so the canyon ran straight off the
//                   landward edge of the domain. Measured on the axis: 44.99 m
//                   of water in the last cell, hard against the reflecting east
//                   wall, where the beach was supposed to be. There was no coast
//                   behind the canyon head to be sheltered.
//
// Both are rebuilt below with the measured numbers recorded.
//
// Depths are metres, positive DOWN in the descriptions and negative in `bed()`,
// which returns bed elevation relative to mean sea level (so -20 is 20 m deep
// and +3 is a dune three metres above the water).
//
// PARAMETERS LIVE IN `defaults` AND NOWHERE ELSE. They used to be written twice
// -- once as an entry field and once as a destructuring default inside build()
// -- and a consumer had no way to read them at all, so tools/waves.mjs hunted
// for the sandbar with a hard-coded window `x > 1200 && x < 1650` that did not
// contain the crest. shoreline() now returns the resolved parameters in
// meta.params, so a test can ask the bathymetry where its own bar is.
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (t) => { const s = clamp(t, 0, 1); return s * s * (3 - 2 * s); };

/**
 * Dean's equilibrium profile, h = A x^(2/3).
 *
 * Not an arbitrary curve: it is the shape a sandy beach relaxes to when the
 * energy dissipation per unit volume in the surf zone is uniform, and A is set
 * by the grain size (Dean 1977). A straight-line beach is easier to write and
 * gets the surf-zone width wrong, because the real profile is concave.
 */
export function deanProfile(x, A = 0.12) {
  return x <= 0 ? 0 : A * Math.pow(x, 2 / 3);
}

export const SHORELINES = {

  // -------------------------------------------------------------------------
  planeBeach: {
    title: 'plane beach',
    blurb: 'A uniform 1:40 slope. The clean case: shoaling and breaking with nothing else going on.',
    expect: 'Wave height grows as h^(-1/4) (Green) until H/h reaches ~0.8, then breaks and decays through a surf zone. No alongshore variation anywhere.',
    domain: { nx: 800, ny: 4, dx: 2.5, dy: 2.5 },
    defaults: { offshoreDepth: 12, slope: 1 / 40, shoreAt: 1600 },
    build({ offshoreDepth, slope, shoreAt }) {
      // Flat at offshoreDepth until the slope starts, then straight to the
      // shore and on up to a 4 m dune so run-up has somewhere to go.
      return (x) => -clamp(offshoreDepth - (x - (shoreAt - offshoreDepth / slope)) * slope, -4, offshoreDepth);
    },
  },

  // -------------------------------------------------------------------------
  barredBeach: {
    title: 'barred beach',
    blurb: 'A longshore sandbar 290 m out, with a trough behind it. What most sandy coasts actually look like.',
    expect: 'Waves break ON THE BAR, partly reform in the deeper trough, then break a second time at the shore. Two surf zones, separated by a band of larger waves. A single-break model cannot produce this.',
    domain: { nx: 800, ny: 4, dx: 2.5, dy: 2.5 },
    // deanA 0.16 -> 0.12 and barHeight 2.6 -> 3.8. WHY, measured on the bed
    // function alone (tools do not enter into it):
    //
    //   old (A = 0.16, barHeight = 2.6)   crest x = 1476.25 m, h = 4.358 m
    //                                     trough x = 1551.25 m, h = 4.716 m
    //                                     relief 0.358 m
    //   new (A = 0.12, barHeight = 3.8)   crest x = 1461.25 m, h = 1.501 m
    //                                     trough x = 1581.25 m, h = 3.211 m
    //                                     relief 1.710 m
    //
    // The old bar could not break a wave: 1.1 m offshore in 12 m shoals by
    // Green's law to 1.42 m at h = 4.358, i.e. H/h = 0.33 against a breaking
    // index of 0.78. The new crest gives H/h = 1.23 by the same arithmetic, so
    // the wave is forced to break there, and a wave leaving the crest
    // depth-limited (H = 0.78 * 1.50 = 1.17 m) enters the trough at H/h = 0.36
    // -- which is the "reform" the case is named for.
    //
    // The bar is 3.8 m of relief on a 5.3 m ambient depth, which is at the large
    // end of what nature builds (the Dutch outer bars are 2-3 m). It is that
    // tall on purpose: a smaller bar in this depth does not reach the breaking
    // point at any wave height the shallow-water equations can carry, and a case
    // that cannot break on its own bar is decoration.
    defaults: { offshoreDepth: 12, shoreAt: 1750, barAt: 1450, barHeight: 3.8, barWidth: 90, deanA: 0.12 },
    build({ offshoreDepth, shoreAt, barAt, barHeight, barWidth, deanA }) {
      return (x) => {
        const xs = clamp(shoreAt - x, 0, 1e9);
        let depth = Math.min(offshoreDepth, deanProfile(xs, deanA));
        depth -= barHeight * Math.exp(-(((x - barAt) / barWidth) ** 2));
        return -Math.max(depth, -3.5);
      };
    },
  },

  // -------------------------------------------------------------------------
  headlandBay: {
    title: 'headland and bay',
    blurb: 'A rocky headland between two embayments, with the contours wrapping the point.',
    expect: 'Refraction turns the crests to face the contours, which bends rays TOWARD the headland and away from the bay. Wave height at the point should exceed the offshore height; the bay should be sheltered. This is why headlands erode and bays fill with sand.',
    // ny * dy = 2560 m = exactly one alongshore `wavelength`, so the periodic
    // north/south boundaries see a continuous coast rather than a seam.
    domain: { nx: 320, ny: 320, dx: 8, dy: 8 },
    // WHICH END IS THE HEADLAND. sx = shoreAt - amp*cos(2*pi*y/wavelength), and
    // the waves arrive from x = 0, so SMALL x is seaward. cos = +1 at y = 0
    // gives the smallest sx: y = 0 is the point that sticks out into the sea,
    // i.e. the HEADLAND, and y = wavelength/2 is the bay. Measured on the bed:
    // the depth-0 contour sits at x = 963.2 m at j = 0 and x = 2203.2 m at
    // j = 160. tools/waves.mjs had these two labels exactly the wrong way round.
    defaults: { offshoreDepth: 20, shoreAt: 1900, amp: 620, wavelength: 2560, crossShore: 1400, dune: 3 },
    build({ offshoreDepth, shoreAt, amp, wavelength, crossShore, dune }) {
      // Shoreline position varies alongshore; contours are parallel to it, so
      // the depth is a function of the distance from that curved shoreline.
      return (x, y) => {
        const sx = shoreAt - amp * Math.cos(2 * Math.PI * y / wavelength);
        const s = clamp((sx - x) / crossShore, -0.06, 1);
        return -(offshoreDepth * smoothstep(s) - dune * (1 - smoothstep(s)));
      };
    },
  },

  // -------------------------------------------------------------------------
  submarineCanyon: {
    title: 'submarine canyon',
    blurb: 'A steep-sided canyon cutting across the shelf, of the kind that reaches almost to the beach at Scripps or Nazare.',
    expect: 'The OPPOSITE of the headland: deep water in the canyon means faster crests, so rays bend AWAY from its axis. The beach directly behind the canyon head is sheltered and the flanks are focused. Nazare works the other way round because the canyon focuses onto one shoulder -- shown here as the flank amplification.',
    // 2320 x 2560 m. nx is trimmed from 320 (the shoreline is at 2200 m, so the
    // last 240 m were dry beach) because the canyon floor sets the timestep --
    // 85 m of water, c = 28.9 m/s against 19.8 m/s on the shelf -- and this is
    // the most expensive case in the file per cell. ny is NOT trimmed: the
    // shadow behind the head is about 900 m wide and the focused flanks sit at
    // +/- 750 m from the axis, so at ny*dy = 1792 m the pattern ran into its own
    // periodic image and the flank maximum at h = 8 m landed on the domain edge.
    // Measured at 8 m resolution on the h = 12 m contour, the full 2560 m holds
    // the whole pattern: 0.46 m on the axis, 0.17-0.27 m at the shadow edges
    // (+/- 350 m), 2.74 and 2.67 m at the flank maxima (-756 and +804 m), and
    // 1.22-1.24 m at the secondary minima (+/- 1050 m).
    domain: { nx: 290, ny: 320, dx: 8, dy: 8 },
    // THE INCISION IS A BUMP IN x, NOT A RAMP. The old version was
    //     reach = smoothstep((x - 400) / 1500)
    // which is 0 offshore and 1 landward -- the canyon was deepest at the coast
    // and absent at the wavemaker, the exact reverse of what its own comment
    // claimed and of what a real canyon head does. Because nothing switched it
    // off, the axis never became land: measured, the last cell on the axis held
    // 44.99 m of water against the reflecting east wall, and the tool's search
    // for "the h = 8 m contour" returned that cell (i = 319 of 320).
    //
    // Now: zero at the offshore boundary, so the wavemaker sees the shelf depth
    // it was told about; full across the shelf; and dying out over
    // `headTaper` metres at `headAt`, so there is a continuous beach behind the
    // canyon head for the shelter to be measured ON.
    defaults: {
      offshoreDepth: 40, shoreAt: 2200, deanA: 0.35,
      canyonY: 1280, canyonWidth: 220, canyonDepth: 45,
      opensAt: 300, opensOver: 700, headAt: 1350, headTaper: 450,
    },
    build({ offshoreDepth, shoreAt, deanA, canyonY, canyonWidth, canyonDepth, opensAt, opensOver, headAt, headTaper }) {
      return (x, y) => {
        const xs = clamp(shoreAt - x, 0, 1e9);
        let depth = Math.min(offshoreDepth, deanProfile(xs, deanA));
        const open = smoothstep((x - opensAt) / opensOver);
        const head = 1 - smoothstep((x - headAt) / headTaper);
        depth += canyonDepth * open * head * Math.exp(-(((y - canyonY) / canyonWidth) ** 2));
        return -Math.max(depth, -3);
      };
    },
  },

  // -------------------------------------------------------------------------
  fringingReef: {
    title: 'fringing reef and lagoon',
    blurb: 'A shallow reef crest with a flat lagoon behind it and a steep fore-reef in front.',
    expect: 'Nearly all the incident energy breaks on the crest in a very short distance. The lagoon carries small, short waves riding on a raised mean level -- WAVE SETUP -- because the momentum lost at the crest has to go somewhere. Setup should be a visible fraction of the breaker height.',
    domain: { nx: 720, ny: 4, dx: 2.5, dy: 2.5 },
    defaults: { offshoreDepth: 25, reefAt: 1150, crestDepth: 0.6, lagoonDepth: 3.5, shoreAt: 1700 },
    build({ offshoreDepth, reefAt, crestDepth, lagoonDepth, shoreAt }) {
      return (x) => {
        if (x < reefAt - 180) {
          // steep fore-reef
          const t = smoothstep((x - (reefAt - 520)) / 340);
          return -(offshoreDepth - (offshoreDepth - 4) * t);
        }
        if (x < reefAt + 60) {
          const t = smoothstep((x - (reefAt - 180)) / 240);
          return -(4 - (4 - crestDepth) * t);
        }
        if (x < shoreAt - 120) {
          const t = smoothstep((x - (reefAt + 60)) / 200);
          return -(crestDepth + (lagoonDepth - crestDepth) * t);
        }
        const t = smoothstep((x - (shoreAt - 120)) / 160);
        return -(lagoonDepth - (lagoonDepth + 2.5) * t);
      };
    },
  },

  // -------------------------------------------------------------------------
  tidalInlet: {
    title: 'tidal inlet and back-barrier basin',
    blurb: 'A barrier island cut by a narrow inlet, with a shallow basin behind it. Built for the TIDE, not for swell.',
    expect: 'The basin fills and empties through the inlet. Expect a strong tidal jet in the throat, a phase lag and a damped range inside the basin, and flood/ebb asymmetry from the nonlinear c = sqrt(g(h+eta)). The basin should also dry over part of its area at low water.',
    domain: { nx: 260, ny: 220, dx: 12, dy: 12 },
    defaults: {
      offshoreDepth: 14, barrierAt: 1300, barrierWidth: 180,
      inletY: 1320, inletWidth: 260, basinDepth: 3.2,
    },
    build({ offshoreDepth, barrierAt, barrierWidth, inletY, inletWidth, basinDepth }) {
      return (x, y) => {
        // open sea, shoaling toward the barrier
        if (x < barrierAt - barrierWidth / 2) {
          const t = smoothstep((x - 200) / 900);
          return -(offshoreDepth - (offshoreDepth - 6) * t);
        }
        // barrier island, breached by the inlet
        if (x < barrierAt + barrierWidth / 2) {
          const inInlet = Math.exp(-(((y - inletY) / (inletWidth / 2)) ** 2));
          const dune = 3.0 * (1 - inInlet);
          const throat = -8.0 * inInlet;
          return dune + throat;
        }
        // back-barrier basin with intertidal flats around its edge
        const t = smoothstep((x - (barrierAt + barrierWidth / 2)) / 700);
        const edge = smoothstep((Math.abs(y - inletY) - 500) / 400);
        return -(basinDepth * (1 - t * 0.55) - 3.0 * edge);
      };
    },
  },

  // -------------------------------------------------------------------------
  shoal: {
    title: 'offshore shoal',
    blurb: 'An isolated bank in otherwise uniform depth. The cleanest possible focusing experiment.',
    expect: 'A converging lens: rays bend toward the shallow bank and cross behind it, producing a caustic with wave heights well above the incident value on the lee side. Berkhoff\'s elliptic-shoal experiment is the standard laboratory version of this.',
    // There is no beach here to absorb the wave, so the lee gauges sit two
    // wavelengths from the east boundary. tools/waves.mjs radiates there
    // (Flather) AND sponges; with a solid wall and a sponge alone the reference
    // row still carried a 30.8% standing ripple, and the lee gauge sat on an
    // antinode of it, so the "caustic" was measured inside a standing wave.
    domain: { nx: 300, ny: 240, dx: 6, dy: 6 },
    defaults: { offshoreDepth: 10, shoalX: 900, shoalY: 720, rx: 260, ry: 400, rise: 7.2 },
    build({ offshoreDepth, shoalX, shoalY, rx, ry, rise }) {
      return (x, y) => {
        const r = Math.hypot((x - shoalX) / rx, (y - shoalY) / ry);
        const bump = r < 1 ? rise * (1 - r * r) : 0;
        return -(offshoreDepth - bump);
      };
    },
  },
};

/**
 * Build a shoreline by name, returning { bed, meta }.
 *
 * `opts` overrides entries in the shoreline's `defaults` (and `opts.domain`
 * overrides the grid). The RESOLVED parameters come back in meta.params, which
 * is the supported way for a test to find out where the bar or the canyon axis
 * is instead of hard-coding a window and hoping.
 */
export function shoreline(name, opts = {}) {
  const s = SHORELINES[name];
  if (!s) throw new Error(`unknown shoreline "${name}". Known: ${Object.keys(SHORELINES).join(', ')}`);
  const params = { ...s.defaults, ...opts };
  delete params.domain;
  const unknown = Object.keys(opts).filter(k => k !== 'domain' && !(k in s.defaults));
  if (unknown.length) {
    // A misspelled parameter used to be silently ignored, which meant a test
    // could ask for a different bathymetry than the one it measured.
    throw new Error(`shoreline "${name}" has no parameter(s) ${unknown.join(', ')}. Known: ${Object.keys(s.defaults).join(', ')}`);
  }
  const bed = s.build(params);
  return {
    bed: (x, y) => bed(x, y ?? 0),
    meta: {
      name, title: s.title, blurb: s.blurb, expect: s.expect,
      domain: { ...s.domain, ...(opts.domain || {}) },
      offshoreDepth: params.offshoreDepth,
      params,
    },
  };
}

export function listShorelines() {
  return Object.entries(SHORELINES).map(([k, v]) => ({ key: k, title: v.title, blurb: v.blurb, expect: v.expect }));
}
