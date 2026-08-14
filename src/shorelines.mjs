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
// Depths are metres, positive DOWN in the descriptions and negative in `bed()`,
// which returns bed elevation relative to mean sea level (so -20 is 20 m deep
// and +3 is a dune three metres above the water).
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
    domain: { nx: 400, ny: 60, dx: 5, dy: 5 },
    offshoreDepth: 12,
    build({ slope = 1 / 40, offshoreDepth = 12, shoreAt = 1600 } = {}) {
      return (x) => {
        const d = offshoreDepth - (shoreAt - x) * 0 - 0;
        const depth = clamp(offshoreDepth - (x - (shoreAt - offshoreDepth / slope)) * slope, -4, offshoreDepth);
        return -depth;
      };
    },
  },

  // -------------------------------------------------------------------------
  barredBeach: {
    title: 'barred beach',
    blurb: 'A longshore sandbar 250 m out, with a trough behind it. What most sandy coasts actually look like.',
    expect: 'Waves break ON THE BAR, partly reform in the deeper trough, then break a second time at the shore. Two surf zones, separated by a band of larger waves. A single-break model cannot produce this.',
    domain: { nx: 400, ny: 60, dx: 5, dy: 5 },
    offshoreDepth: 12,
    build({ offshoreDepth = 12, shoreAt = 1750, barAt = 1450, barHeight = 2.6, barWidth = 90 } = {}) {
      return (x) => {
        const xs = clamp(shoreAt - x, 0, 1e9);
        let depth = Math.min(offshoreDepth, deanProfile(xs, 0.16));
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
    domain: { nx: 320, ny: 320, dx: 8, dy: 8 },
    offshoreDepth: 20,
    build({ offshoreDepth = 20, shoreAt = 1900, amp = 620, wavelength = 2560 } = {}) {
      // Shoreline position varies alongshore; contours are parallel to it, so
      // the depth is a function of the distance from that curved shoreline.
      return (x, y) => {
        const sx = shoreAt - amp * Math.cos(2 * Math.PI * y / wavelength);
        const s = clamp((sx - x) / 1400, -0.06, 1);
        const depth = offshoreDepth * smoothstep(s) - 3 * (1 - smoothstep(s));
        return -depth;
      };
    },
  },

  // -------------------------------------------------------------------------
  submarineCanyon: {
    title: 'submarine canyon',
    blurb: 'A steep-sided canyon cutting across the shelf, of the kind that reaches almost to the beach at Scripps or Nazare.',
    expect: 'The OPPOSITE of the headland: deep water in the canyon means faster crests, so rays bend AWAY from its axis. The beach directly behind the canyon head is sheltered and the flanks are focused. Nazare works the other way round because the canyon focuses onto one shoulder -- shown here as the flank amplification.',
    domain: { nx: 320, ny: 320, dx: 8, dy: 8 },
    offshoreDepth: 40,
    build({ offshoreDepth = 40, shoreAt = 2200, canyonY = 1280, canyonWidth = 220, canyonDepth = 45 } = {}) {
      return (x, y) => {
        const xs = clamp(shoreAt - x, 0, 1e9);
        let depth = Math.min(offshoreDepth, deanProfile(xs, 0.55));
        // The canyon narrows and shallows as it runs inshore, as real ones do.
        const reach = smoothstep((x - 400) / 1500);
        depth += canyonDepth * reach * Math.exp(-(((y - canyonY) / canyonWidth) ** 2));
        return -Math.max(depth, -3);
      };
    },
  },

  // -------------------------------------------------------------------------
  fringingReef: {
    title: 'fringing reef and lagoon',
    blurb: 'A shallow reef crest with a flat lagoon behind it and a steep fore-reef in front.',
    expect: 'Nearly all the incident energy breaks on the crest in a very short distance. The lagoon carries small, short waves riding on a raised mean level -- WAVE SETUP -- because the momentum lost at the crest has to go somewhere. Setup should be a visible fraction of the breaker height.',
    domain: { nx: 360, ny: 60, dx: 5, dy: 5 },
    offshoreDepth: 25,
    build({ offshoreDepth = 25, reefAt = 1150, crestDepth = 0.6, lagoonDepth = 3.5, shoreAt = 1700 } = {}) {
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
    offshoreDepth: 14,
    build({ offshoreDepth = 14, barrierAt = 1300, barrierWidth = 180, inletY = 1320, inletWidth = 260, basinDepth = 3.2 } = {}) {
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
    domain: { nx: 300, ny: 240, dx: 6, dy: 6 },
    offshoreDepth: 10,
    build({ offshoreDepth = 10, shoalX = 900, shoalY = 720, rx = 260, ry = 400, rise = 7.2 } = {}) {
      return (x, y) => {
        const r = Math.hypot((x - shoalX) / rx, (y - shoalY) / ry);
        const bump = r < 1 ? rise * (1 - r * r) : 0;
        return -(offshoreDepth - bump);
      };
    },
  },
};

/** Build a shoreline by name, returning { bed, meta }. */
export function shoreline(name, opts = {}) {
  const s = SHORELINES[name];
  if (!s) throw new Error(`unknown shoreline "${name}". Known: ${Object.keys(SHORELINES).join(', ')}`);
  const bed = s.build(opts);
  return {
    bed: (x, y) => bed(x, y ?? 0),
    meta: {
      name, title: s.title, blurb: s.blurb, expect: s.expect,
      domain: { ...s.domain, ...(opts.domain || {}) },
      offshoreDepth: opts.offshoreDepth ?? s.offshoreDepth,
    },
  };
}

export function listShorelines() {
  return Object.entries(SHORELINES).map(([k, v]) => ({ key: k, title: v.title, blurb: v.blurb, expect: v.expect }));
}
