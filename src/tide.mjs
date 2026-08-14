// ---------------------------------------------------------------------------
// Tides.
//
// A tide is not generated inside a domain this size. The astronomical forcing
// acts over an ocean basin; what arrives at a coastline is a long wave, and the
// honest way to model a stretch of coast is to impose the constituents at the
// open boundary and let the local bathymetry do the rest. That is what
// src/swe.mjs's flather() boundary is for.
//
// WHAT THE COAST DOES TO THE TIDE, and why it is worth simulating rather than
// just plotting a sine wave:
//
//   * Resonance. A basin open at one end and closed at the other amplifies a
//     tide whose period is near 4L/sqrt(gh) -- the quarter-wave mode. That is
//     the whole explanation of the Bay of Fundy, and tools/verify-tide.mjs
//     checks the simulator reproduces the amplification curve rather than
//     assuming it.
//   * Distortion. Shallow water makes the crest travel faster than the trough
//     (c = sqrt(g(h+eta))), so the flood becomes shorter and stronger than the
//     ebb. That asymmetry is the reason estuaries import sediment, and it falls
//     out of the nonlinear terms for free.
//   * Drying. Over a tidal flat the shoreline moves kilometres. The wet/dry
//     scheme is what makes that possible.
//
// CONSTITUENTS. Periods are the standard astronomical ones (Doodson); amplitudes
// and phases are per-site and belong to the scenario, not here. The defaults
// below are a plausible meso-tidal Atlantic coast, labelled as such -- they are
// not measurements of anywhere real, and a sidecar that claims otherwise would
// be a fabrication.
// ---------------------------------------------------------------------------

/** Period in hours for each constituent. */
export const CONSTITUENTS = {
  M2: { period: 12.4206012, name: 'principal lunar semidiurnal' },
  S2: { period: 12.0, name: 'principal solar semidiurnal' },
  N2: { period: 12.65834751, name: 'larger lunar elliptic semidiurnal' },
  K2: { period: 11.96723606, name: 'lunisolar semidiurnal' },
  K1: { period: 23.93447213, name: 'lunisolar diurnal' },
  O1: { period: 25.81933871, name: 'principal lunar diurnal' },
  P1: { period: 24.06588766, name: 'principal solar diurnal' },
  Q1: { period: 26.868350, name: 'larger lunar elliptic diurnal' },
  Mf: { period: 327.8599387, name: 'lunar fortnightly' },
};

/** A plausible meso-tidal Atlantic coast. Amplitudes in metres, phases in degrees. */
export const ATLANTIC_MESO = {
  M2: [1.35, 0], S2: [0.45, 42], N2: [0.28, -18], K2: [0.12, 40],
  K1: [0.09, 190], O1: [0.07, 175], P1: [0.03, 188],
};

/** A diurnal-dominated coast, where one tide a day is much larger than the other. */
export const DIURNAL_COAST = {
  K1: [0.55, 20], O1: [0.38, 5], P1: [0.18, 18], M2: [0.16, 250], S2: [0.05, 280],
};

export class Tide {
  /**
   * @param constituents  { NAME: [amplitude m, phase deg] }
   * @param mslp          mean sea level [m]
   */
  constructor(constituents = ATLANTIC_MESO, msl = 0) {
    this.msl = msl;
    this.terms = [];
    for (const [name, [amp, phase]] of Object.entries(constituents)) {
      const c = CONSTITUENTS[name];
      if (!c) throw new Error(`Tide: unknown constituent ${name}`);
      this.terms.push({
        name, amp, phase,
        omega: 2 * Math.PI / (c.period * 3600),
        period: c.period * 3600,
      });
    }
    this.terms.sort((a, b) => b.amp - a.amp);
  }

  /** Elevation at time t [s]. */
  eta(t) {
    let e = this.msl;
    for (const k of this.terms) e += k.amp * Math.cos(k.omega * t - k.phase * Math.PI / 180);
    return e;
  }

  /** d(eta)/dt [m/s] -- the rate of rise, which sets the current in a channel. */
  rate(t) {
    let d = 0;
    for (const k of this.terms) d -= k.amp * k.omega * Math.sin(k.omega * t - k.phase * Math.PI / 180);
    return d;
  }

  /**
   * Spring-neap beat period: the interval between successive springs is set by
   * the M2/S2 difference frequency, 2*pi/|w_M2 - w_S2| -- 14.765 days, half the
   * 29.53-day synodic month, because there is a spring at both new and full moon.
   */
  springNeapPeriod() {
    const m2 = this.terms.find(k => k.name === 'M2');
    const s2 = this.terms.find(k => k.name === 'S2');
    if (!m2 || !s2) return null;
    return 2 * Math.PI / Math.abs(m2.omega - s2.omega);
  }

  /** Highest and lowest astronomical tide, by scanning a full spring-neap cycle. */
  range(days = 30, dt = 300) {
    let lo = Infinity, hi = -Infinity;
    for (let t = 0; t < days * 86400; t += dt) {
      const e = this.eta(t);
      if (e < lo) lo = e;
      if (e > hi) hi = e;
    }
    return { lowest: lo, highest: hi, range: hi - lo };
  }

  /**
   * Quarter-wave resonant period of a basin open at one end [s].
   *
   * T = 4L/sqrt(g h). A tide near this period is amplified; this is the Bay of
   * Fundy in one line, and it is why a simulator that only imposes a boundary
   * elevation is still worth running -- the amplification is emergent, not
   * prescribed.
   */
  static resonantPeriod(length, depth, g = 9.80665) {
    return 4 * length / Math.sqrt(g * depth);
  }

  /** Which constituent is closest to resonance in this basin, and by how much. */
  resonanceReport(length, depth) {
    const Tr = Tide.resonantPeriod(length, depth);
    return this.terms.map(k => ({
      name: k.name,
      periodHours: k.period / 3600,
      amp: k.amp,
      detuning: k.period / Tr,
      // Amplification of a frictionless quarter-wave resonator, |sec(w L / c)|.
      // Real basins are damped, so treat this as an upper bound and a diagnosis,
      // never as a prediction of the range.
      idealGain: Math.abs(1 / Math.cos(Math.PI / 2 * (Tr / k.period))),
    })).sort((a, b) => b.idealGain - a.idealGain);
  }
}
