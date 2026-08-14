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
// The colour map is DIVERGING about mean sea level and symmetric by construction,
// so a crest and a trough of equal size are equally bright. A sequential map --
// the obvious choice -- makes the mean level look like a boundary and hides
// whether the water is above or below it, which is the single most important
// thing about a tide.
//
// The scale is FIXED by the caller, not auto-ranged per frame. Auto-ranging looks
// better and lies: a calm frame gets stretched until numerical noise fills the
// colour range, and the viewer cannot tell a millimetre from a metre.
// ---------------------------------------------------------------------------

/** Diverging blue-white-amber ramp, symmetric about zero. */
function surfaceColour(v, scale) {
  const t = Math.max(-1, Math.min(1, v / scale));
  if (t >= 0) {
    // above mean level: deep teal -> pale crest
    const a = t;
    return [30 + 200 * a, 90 + 150 * a, 120 + 110 * a];
  }
  const a = -t;
  return [20 + 20 * a, 55 - 25 * a, 95 + 40 * a];
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
            const shade = 0.55 + 0.45 * Math.exp(-depth / 12);
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
      ctx.fillStyle = 'rgba(160,180,200,0.75)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(`section at y = ${((j + 0.5) * sim.dy).toFixed(0)} m   vertical ${(hi - lo).toFixed(1)} m`, 8, mapH + 14);
    }
  }
}
