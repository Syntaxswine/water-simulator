// ---------------------------------------------------------------------------
// Canvas-2D view of a shallow-water field.
//
// Two panels, because one is not enough to judge a coastal simulation:
//
//   MAP   surface elevation over the bathymetry, seen from above. This is where
//         refraction shows: crests bending to face the contours, energy piling
//         onto a headland, a shadow behind a canyon.
//   SECTION  a slice through the domain with the bed drawn underneath. This is
//         where shoaling and breaking show, and where you can see whether the
//         wave is actually growing or the colour map is flattering it.
//
// THE COLOUR MAP USED TO CLAIM A SYMMETRY IT DID NOT HAVE, and the claim was
// load-bearing: the whole argument for a diverging ramp is that the sign AND the
// size of a departure from mean sea level can be read off it. The old ramp was
// two independently chosen linear segments -- [30,90,120]->[230,240,230] above
// and [20,55,95]->[40,30,135] below -- and its docstring said "symmetric by
// construction, so a crest and a trough of equal size are equally bright".
// EVALUATED rather than eyeballed, at scale = 1 m, in CIE L* (the standard
// measure of exactly the thing the sentence claimed):
//
//   - a full-scale crest was +57.94 L* from mean sea level and a full-scale
//     trough only -15.32. Ratio 3.78. Worst asymmetry over the ramp 42.62 L*.
//     In plain RGB distance the crest travelled 273.13 units and the trough
//     51.23, a ratio of 5.33.
//   - the two segments did not even MEET. Crossing mean sea level by a
//     floating-point epsilon stepped the colour 44.16 RGB units -- a hard edge
//     at the one elevation the map exists to make legible, and larger than the
//     entire excursion a full-scale trough was given.
//
// So a trough whispered, a crest shouted, and the msl line itself was the
// loudest feature on a calm frame.
//
// The ramp is now defined in CIE L*a*b* with L* LINEAR in the signed elevation,
// so equal departures above and below mean sea level differ from it in lightness
// by equal amounts as an algebraic identity rather than as taste. rampSymmetry()
// below measures this from the EXPORTED colour function -- the one draw() calls
// -- not from a second copy of the construction, and it can come back with a bad
// number, which is the only reason to have it. Measured:
//
//   worst asymmetry, exact ramp     1.174e-4 L*   (257 samples)
//   worst asymmetry, 8-bit as the
//     canvas actually stores it     0.4410 L* on a 65.963 L* span, i.e. 0.67%
//                                   (1025 samples; at 257 it reads 0.4045, so
//                                   quote the denser sweep -- a coarse one finds
//                                   a smaller worst case and flatters the ramp)
//   discontinuity at msl            exactly 0, both exact and 8-bit
//   gamut                           nothing clips. Not a detail: clipping
//                                   silently flattens one end, and the first
//                                   endpoints tried (trough b* = -38) clipped
//                                   blue below t = -0.8 and cost 0.84 L*.
//
// Hue still carries the sign -- deep indigo below, pale warm sand above -- but
// hue is now the redundant channel and lightness is the measured one.
//
// Confirmed END TO END, off the pixels this file actually paints, rather than
// off the colour function alone: planeBeach in 12 m of water at scale = 1 m, one
// cell set to a +1.00 m crest and the cell beside it to a -1.00 m trough over the
// same bed, then the map buffer read back. The crest came out rgb(181,149,94) and
// the trough rgb(2,34,70) against an rgb(75,93,107) mean level, i.e. +24.921 L*
// and -25.302 L*, a ratio of 0.985. The old ramp scored on those same three cells
// with the same depth shading: +44.11 and -11.78, a ratio of 3.744.
//
// The scale is FIXED by the caller, not auto-ranged per frame. Auto-ranging looks
// better and lies: a calm frame gets stretched until numerical noise fills the
// colour range, and the viewer cannot tell a millimetre from a metre.
//
// THE DEPTH SHADING READS THE BED, NOT THE WATER. It used to darken each cell by
// its LIVE depth, which is the still depth PLUS the wave, so the wave modulated
// its own contrast: a crest sits in deeper water and was dimmed more than the
// trough beside it. Measured against the new ramp, that put the shading
// multiplier for a crest and for the trough beside it 0.5% apart in 40 m of
// water and 7.1% apart in 2 m, and dragged the crest/trough L* ratio from 0.990
// down to 0.947 as the water shallowed -- i.e. the error was worst exactly in
// the surf zone the picture is for. Shading on the STILL depth (msl - bed) makes
// the multiplier a property of the PLACE: a crest and the trough that follows it
// through the same cell now get the identical multiplier, and the ratio holds
// between 0.9936 (40 m) and 0.9994 (2 m). It does not reach exactly 1 because
// scaling sRGB-encoded bytes is not exactly a lightness scaling near black; that
// residual is the sRGB toe, not the shading.
// ---------------------------------------------------------------------------

// Endpoints of the ramp, in CIE L*a*b* (D65). L*(msl) is the exact mean of the
// two ends, which is what makes the lightness travel symmetric; the a*/b* path
// runs continuously through the msl colour, so there is no hue discontinuity to
// interpolate around and no excursion through green.
const LAB_TROUGH = [20, 8, -34];
const LAB_MSL = [53, -4, -14];
const LAB_CREST = [86, 6, 44];

// ODD, and that is load-bearing. With an even count there is no entry at t = 0:
// t = +1e-12 and t = -1e-12 round into adjacent bins, which reintroduces exactly
// the discontinuity at mean sea level this ramp exists to remove. Measured with
// 1024 entries: 0.304 RGB units of step at msl and 6.45e-2 L* of asymmetry, the
// width of one bin. With 1025 the mean level is entry (N-1)/2 exactly.
const RAMP_N = 1025;
const RAMP_MID = (RAMP_N - 1) >> 1;
const RAMP = buildRamp();

/** CIE L*a*b* (D65) -> sRGB bytes, unclamped so gamut escape is detectable. */
function labToSrgbRaw(L, a, bb) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
  const g = (f) => (f * f * f > 0.008856 ? f * f * f : (f - 16 / 116) / 7.787);
  const X = 0.95047 * g(fx), Y = g(fy), Z = 1.08883 * g(fz);
  const enc = (u) => 255 * (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(Math.max(u, 0), 1 / 2.4) - 0.055);
  return [
    enc(3.2406 * X - 1.5372 * Y - 0.4986 * Z),
    enc(-0.9689 * X + 1.8758 * Y + 0.0415 * Z),
    enc(0.0557 * X - 0.2040 * Y + 1.0570 * Z),
  ];
}

/**
 * Bake the ramp once, so the per-pixel cost is an index and three array reads.
 * Evaluating L*a*b* per pixel would be three pow() calls on every one of the
 * 102,400 cells of the largest grid here, every frame, and ms/frame is a number
 * this UI puts on screen.
 */
function buildRamp() {
  const out = new Float64Array(3 * RAMP_N);
  for (let i = 0; i < RAMP_N; i++) {
    const t = -1 + (2 * i) / (RAMP_N - 1);
    const end = t >= 0 ? LAB_CREST : LAB_TROUGH;
    const q = Math.abs(t);
    const c = labToSrgbRaw(
      LAB_MSL[0] + (end[0] - LAB_MSL[0]) * q,
      LAB_MSL[1] + (end[1] - LAB_MSL[1]) * q,
      LAB_MSL[2] + (end[2] - LAB_MSL[2]) * q,
    );
    out[3 * i] = c[0]; out[3 * i + 1] = c[1]; out[3 * i + 2] = c[2];
  }
  return out;
}

/**
 * Diverging ramp about mean sea level, symmetric in CIE lightness.
 *
 * Exported so the symmetry can be CHECKED against the code that draws, rather
 * than against a second copy of the construction. rampSymmetry() below does
 * exactly that and is the only thing that may quote a symmetry figure.
 */
export function surfaceColour(v, scale) {
  const t = Math.max(-1, Math.min(1, v / scale));
  // Index symmetrically about the middle entry rather than mapping t onto
  // [0, N-1] and rounding. Math.round breaks ties upward on both signs
  // (round(2.5) = 3, round(-2.5) = -2), so the naive form is off by a bin on
  // one side at every half-bin value of t.
  const q = Math.round(Math.abs(t) * RAMP_MID);
  const o = 3 * (t >= 0 ? RAMP_MID + q : RAMP_MID - q);
  return [RAMP[o], RAMP[o + 1], RAMP[o + 2]];
}

/**
 * Measure the ramp instead of asserting it: worst |L*| asymmetry about mean sea
 * level, the size of any discontinuity there, and the largest step between
 * neighbouring LUT entries (which is the resolution the LUT costs).
 *
 * Returns numbers. It has no opinion about whether they are good enough -- that
 * belongs to whatever calls it -- but it CAN come back with a large asymmetry,
 * which is the only reason to have it.
 */
export function rampSymmetry(samples = 257, round8 = false) {
  const q = (c) => (round8 ? c.map((x) => Math.max(0, Math.min(255, Math.round(x)))) : c);
  const lin = (u) => { u /= 255; return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); };
  const Lstar = (c) => {
    const Y = 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
  };
  const L0 = Lstar(q(surfaceColour(0, 1)));
  let worstAsym = 0, worstAt = 0, maxStep = 0;
  for (let n = 1; n <= samples; n++) {
    const t = n / samples;
    const up = Lstar(q(surfaceColour(t, 1))) - L0;
    const down = L0 - Lstar(q(surfaceColour(-t, 1)));
    if (Math.abs(up - down) > worstAsym) { worstAsym = Math.abs(up - down); worstAt = t; }
  }
  for (let i = 1; i < RAMP_N; i++) {
    const a = [RAMP[3 * i - 3], RAMP[3 * i - 2], RAMP[3 * i - 1]];
    const b = [RAMP[3 * i], RAMP[3 * i + 1], RAMP[3 * i + 2]];
    maxStep = Math.max(maxStep, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  }
  // The LUT is built UNCLAMPED so that gamut escape is still visible here. A
  // clamped ramp would look fine and be quietly asymmetric at the ends.
  let outOfGamut = 0;
  for (let i = 0; i < 3 * RAMP_N; i++) outOfGamut = Math.max(outOfGamut, -RAMP[i], RAMP[i] - 255);
  const zp = q(surfaceColour(1e-12, 1)), zn = q(surfaceColour(-1e-12, 1));
  return {
    worstAsym, worstAt, maxStep, L0, outOfGamut: Math.max(0, outOfGamut),
    jump: Math.hypot(zp[0] - zn[0], zp[1] - zn[1], zp[2] - zn[2]),
    span: Lstar(q(surfaceColour(1, 1))) - Lstar(q(surfaceColour(-1, 1))),
  };
}

/** Land, shaded by height so a dune reads differently from a reef flat. */
function landColour(bed) {
  const t = Math.max(0, Math.min(1, bed / 6));
  return [96 + 70 * t, 88 + 62 * t, 74 + 52 * t];
}

export class WaterView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.scale = 1.0;              // metres of elevation at full colour
    this.showBed = true;
    this.showSection = true;
    this.sectionRow = null;        // defaults to mid-domain
    this.exaggeration = null;      // last section's vertical exaggeration, read by the UI
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.w = this.canvas.width; this.h = this.canvas.height;
  }

  draw(sim, { msl = 0 } = {}) {
    this.resize();
    const ctx = this.ctx;
    const { nx, ny } = sim;
    const sectionH = this.showSection ? Math.round(this.h * 0.30) : 0;
    const mapH = this.h - sectionH;

    // ---- map --------------------------------------------------------------
    if (!this._img || this._img.width !== nx || this._img.height !== ny) {
      this._img = ctx.createImageData(nx, ny);
    }
    const img = this._img, d = img.data;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = sim.idx(i, j);
        const o = 4 * ((ny - 1 - j) * nx + i);      // flip so +y is up on screen
        const depth = sim.h[k];
        let c;
        if (depth <= sim.minDepth) {
          c = landColour(sim.b[k]);
        } else {
          c = surfaceColour(sim.b[k] + depth - msl, this.scale);
          if (this.showBed) {
            // Darken with depth so the bathymetry reads through the surface, the
            // way it does from the air. Without this a lagoon and a shelf edge
            // are the same flat colour and the topography -- the entire point --
            // is invisible.
            //
            // STILL depth, not live depth: see the header. A shading that reads
            // the instantaneous depth is modulated by the very wave it is
            // supposed to sit behind.
            const still = Math.max(0, msl - sim.b[k]);
            const shade = 0.55 + 0.45 * Math.exp(-still / 12);
            c = [c[0] * shade, c[1] * shade, c[2] * shade];
          }
        }
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
    }
    ctx.imageSmoothingEnabled = false;
    if (!this._buf || this._buf.width !== nx || this._buf.height !== ny) {
      this._buf = new OffscreenCanvas(nx, ny);
      this._bufCtx = this._buf.getContext('2d');
    }
    this._bufCtx.putImageData(img, 0, 0);
    ctx.drawImage(this._buf, 0, 0, nx, ny, 0, 0, this.w, mapH);

    // ---- section ----------------------------------------------------------
    // Cleared first: a stale exaggeration left over from the last time a section
    // WAS drawn would be read by the UI and printed as if it described this frame.
    this.exaggeration = null;
    if (sectionH > 8) {
      const j = this.sectionRow ?? (ny >> 1);
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, mapH, this.w, sectionH);
      // Vertical scale: fit the bed, but never let the surface signal vanish.
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < nx; i++) {
        const b = sim.b[sim.idx(i, j)];
        if (b < lo) lo = b; if (b > hi) hi = b;
      }
      hi = Math.max(hi, this.scale * 2.5);
      const pad = 0.06 * (hi - lo);
      lo -= pad; hi += pad;
      const Y = (z) => mapH + sectionH * (1 - (z - lo) / (hi - lo));
      const X = (i) => this.w * (i + 0.5) / nx;

      // bed
      ctx.beginPath();
      ctx.moveTo(0, mapH + sectionH);
      for (let i = 0; i < nx; i++) ctx.lineTo(X(i), Y(sim.b[sim.idx(i, j)]));
      ctx.lineTo(this.w, mapH + sectionH);
      ctx.closePath();
      ctx.fillStyle = '#3b352c';
      ctx.fill();

      // water
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < nx; i++) {
        const k = sim.idx(i, j);
        if (sim.h[k] <= sim.minDepth) { started = false; continue; }
        const y = Y(sim.b[k] + sim.h[k]);
        if (!started) { ctx.moveTo(X(i), y); started = true; } else ctx.lineTo(X(i), y);
      }
      ctx.strokeStyle = '#7fd4e8';
      ctx.lineWidth = 1.6;
      ctx.stroke();

      // mean sea level, for scale
      ctx.strokeStyle = 'rgba(160,180,200,0.35)';
      ctx.setLineDash([4, 5]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, Y(msl)); ctx.lineTo(this.w, Y(msl)); ctx.stroke();
      ctx.setLineDash([]);

      // THE EXAGGERATION, LABELLED. This panel printed its vertical span and not
      // its horizontal one, so the only number on it was the one that could not
      // be used to judge a slope. A plane beach is 2000 m wide and about 20 m
      // tall; drawn into a strip that is wider than it is high, the picture
      // stretches the vertical by around a hundred, and every wave in it looks
      // ten times too steep to a reader who takes the axes at face value.
      const spanX = nx * sim.dx, spanZ = hi - lo;
      const ex = (spanX / this.w) / (spanZ / sectionH);
      this.exaggeration = ex;
      ctx.fillStyle = 'rgba(160,180,200,0.75)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(
        `section at y = ${((j + 0.5) * sim.dy).toFixed(0)} m   `
        + `${spanX.toFixed(0)} m across x ${spanZ.toFixed(1)} m vertical   `
        + `vertical exaggeration ${ex >= 10 ? ex.toFixed(0) : ex.toFixed(1)}x`,
        8, mapH + 14);
    }
  }
}
