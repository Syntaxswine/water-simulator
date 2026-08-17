// ---------------------------------------------------------------------------
// Verification: the renderer.
//
// src/render.mjs had NO automated coverage at all until this file existed. It
// exported rampSymmetry() specifically so the colour ramp could be measured
// rather than asserted, and nothing in the tree called it -- three textual hits
// in the whole repository, all three inside render.mjs itself, two of them
// comments. Its header quotes eleven measured figures and every one of them was
// reproducible only by hand. This file reproduces them, and the interesting part
// is that reproducing them found a stale attribution (section 2).
//
//   node tools/verify-render.mjs                 all sections
//   node tools/verify-render.mjs shading         one section
//
// An unknown section name is exit 2, not "ALL PASS 0/0" -- same contract as
// tools/waves.mjs.
//
// IT TERMINATES. That sentence has to be here because for a while it was false:
// this file ended in process.exit() and about one run in twelve printed its
// whole output, printed ALL PASS, and then hung forever, which was already
// corrupting tools/mutants.mjs. It does not call process.exit() at the end any
// more, and the diagnosis -- what it was, what it was NOT, and the four
// measurements that separate those -- is written out at the foot of this file
// next to the fix rather than summarised here.
//
// ===========================================================================
// THE CANVAS PROBLEM, AND HOW IT IS SOLVED HONESTLY
// ===========================================================================
//
// Half of what this file needs to check is the BYTES draw() paints, not the
// colour function it paints them with. The header's central end-to-end claim is
// a triple of RGB values read back out of the map buffer, and a test that
// recomputes the colour instead of reading the pixel is not checking the
// renderer, it is checking a paraphrase of the renderer.
//
// node has no canvas and this project has no dependencies, so there is a
// stand-in 2D context below. A stand-in that quietly disagrees with a real
// canvas is worse than no test, so it is PINNED TO ONE. Section 0 runs a fixture
// of pure canvas calls -- createImageData, putImageData into an OffscreenCanvas,
// drawImage at seven magnifications, getImageData back -- and asserts an FNV-1a
// hash of every byte of the readback against hashes MEASURED IN A REAL BROWSER.
// Measured 2026-08-17 in Chrome 148.0.7778.280 (Electron 42.7.0), serving this
// tree from serve.mjs and running the identical fixture expression in the page:
//
//   magnification   sum of bytes   FNV-1a
//   1x1                  254040   3263356649
//   2x2                 1016160   2911487285
//   3x1                  762120    492835321
//   1x5                 1270200     52957881
//   4x3                 3048480   2700956229
//   7x2                 3556560   1688886293
//   5x9                11431800   2862032937
//
// All seven identical. Then the end-to-end case itself was run in that browser
// against a real <canvas>: crest rgb(181,149,94), trough rgb(2,34,70), mean
// rgb(75,93,107) -- byte for byte what section 5 asserts here -- and again at
// 4x3 magnification, where the crest colour appears at every one of the twelve
// destination pixels of its source cell.
//
// WHERE THE STAND-IN DOES NOT MATCH, measured the same way, and the reason this
// suite never reads a pixel at a non-integer ratio:
//
//   dest        factor        result
//   800x280     1x, 70x       identical
//   1600x8      2x, 2x        identical
//   3200x12     4x, 3x        identical
//   1200x8      1.5x, 2x      DIFFERS
//   2400x10     3x, 2.5x      DIFFERS
//   400x8       0.5x, 2x      DIFFERS
//   700x280     0.875x, 70x   DIFFERS -- 11 of the first 80 pixels of row 0,
//                             each a source column off by one at a seam
//                             (node 90,63,44,18,16,... vs Chrome
//                              90,63,44,28,16,...)
//
// So Chrome's nearest-neighbour sampling agrees with pixel-centre floor only
// when the magnification is an integer >= 1 in both axes. Every pixel this file
// reads is read at an integer magnification, and section 0 asserts that
// condition on the recorded drawImage call rather than trusting the caller to
// have arranged it. That is the whole extent of the fidelity claim: it is a
// claim about integer magnification and nothing wider.
//
// EXACTLY WHAT IS STUBBED. The stand-in rasterises createImageData,
// putImageData, drawImage (nearest-neighbour, 9-argument form only) and
// getImageData. It RECORDS but does not rasterise fillRect, beginPath, moveTo,
// lineTo, closePath, fill, stroke, setLineDash and fillText -- the whole vector
// path used by the SECTION panel. Consequences, stated rather than glossed:
//
//   - the map panel is checked at the level of individual bytes;
//   - the section panel is checked at the level of the CALLS draw() makes -- its
//     geometry, its op sequence, its label text and its exaggeration arithmetic
//     are all checked (section 8), the pixels it would produce are not;
//   - therefore section 5 and 6 draw with showSection = false, so sectionH is 0,
//     the section branch never runs, and no unrasterised call can have touched
//     the bytes they read. That is ASSERTED from the op log, not assumed.
//
// A missing method would be the dangerous failure -- draw() calling something
// the stand-in lacks would throw, but draw() SETTING a property the stand-in
// ignores (globalAlpha, filter, shadowBlur, globalCompositeOperation) would
// silently change the real picture and not this one. So the context, the canvas
// and the window stand-ins are all Proxies that THROW on any property they do
// not implement, read or written. The stand-in cannot be silently outgrown.
// ---------------------------------------------------------------------------

import { surfaceColour, rampSymmetry, WaterView } from '../src/render.mjs';
import { ShallowWater } from '../src/swe.mjs';
import { shoreline } from '../src/shorelines.mjs';

// ===========================================================================
// Reference constants and reference formulae. NOTHING here is imported from
// src/render.mjs -- the same rule tools/verify.mjs applies to gravity. The two
// private functions of render.mjs (the depth shading and the land ramp) are
// restated here as REF copies so that a change to either one turns section 6
// red instead of moving the prediction along with the code.
// ===========================================================================

// The depth shading, from the header: "STILL depth, not live depth".
const SHADE_REF = (still) => 0.55 + 0.45 * Math.exp(-still / 12);
// landColour(), for the dry branch.
const LAND_REF = (bed) => {
  const t = Math.max(0, Math.min(1, bed / 6));
  return [96 + 70 * t, 88 + 62 * t, 74 + 52 * t];
};
// The three L*a*b* endpoints, restated. Used ONLY by the counterfactual ramp in
// section 2, which is validated against the shipped LUT before it is believed.
const LAB_TROUGH_REF = [20, 8, -34];
const LAB_MSL_REF = [53, -4, -14];
const LAB_CREST_REF = [86, 6, 44];

// CIE L* of an sRGB byte triple, D65, the standard measure of the thing the
// ramp's docstring claims. Written out rather than imported because rampSymmetry
// computes L* internally and a check that borrowed that computation could not
// see an error in it.
const srgbToLinear = (u) => { u /= 255; return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); };
function Lstar(c) {
  const Y = 0.2126 * srgbToLinear(c[0]) + 0.7152 * srgbToLinear(c[1]) + 0.0722 * srgbToLinear(c[2]);
  return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
}

// Byte quantisation, done the way a canvas does it. NOT Math.round: an
// ImageData's backing store is a Uint8ClampedArray, whose conversion rounds
// half to EVEN, while Math.round rounds half UP. They differ on exactly the
// values a colour ramp lands on most often, and using the wrong one would put a
// one-byte error into every prediction in section 6 at half-integer values.
const CLAMP_BUF = new Uint8ClampedArray(3);
function q8(c) {
  CLAMP_BUF[0] = c[0]; CLAMP_BUF[1] = c[1]; CLAMP_BUF[2] = c[2];
  return [CLAMP_BUF[0], CLAMP_BUF[1], CLAMP_BUF[2]];
}

/** Euclidean distance between two RGB triples. */
const rgbDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * RAMP_MID, derived from the EXPORTED function rather than imported.
 *
 * RAMP_MID is private to src/render.mjs, and importing it would be borrowing
 * the constant under test. surfaceColour indexes with round(|t| * RAMP_MID), so
 * the colour first leaves the middle entry at |t| = 0.5 / RAMP_MID; bisecting
 * that boundary recovers the number. Section 2 does the same bisection inline
 * and CHECKS the answer against 512 -- this helper exists so section 1 can walk
 * the LUT entry by entry without depending on section 2 having run.
 */
function deriveRampMid() {
  const c0 = surfaceColour(0, 1);
  const sameAsMsl = (t) => {
    const c = surfaceColour(t, 1);
    return c[0] === c0[0] && c[1] === c0[1] && c[2] === c0[2];
  };
  let lo = 0, hi = 1;
  for (let k = 0; k < 200; k++) { const m = 0.5 * (lo + hi); if (sameAsMsl(m)) lo = m; else hi = m; }
  return Math.round(0.5 / hi);
}

// ===========================================================================
// Harness
// ===========================================================================

let checks = 0, failures = 0;
function check(label, got, want, tol, note = '') {
  checks++;
  const rel = Math.abs(want) > 1e-12 ? Math.abs(got - want) / Math.abs(want) : Math.abs(got - want);
  const ok = rel <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got ${fmt(got)}  want ${fmt(want)}  rel ${(100 * rel).toFixed(4)}%${note ? '   ' + note : ''}`);
}
function assert(label, ok, note = '') {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${note ? '   ' + note : ''}`);
}
function fmt(v) {
  if (v === 0) return '0';
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  return (a < 1e-3 || a >= 1e5) ? v.toExponential(4) : v.toFixed(6);
}
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

// ---------------------------------------------------------------------------
// Section selection. Exit 2 for a bad command line so a wrapper can tell "the
// renderer is broken" from "you misspelled the section". A typo must not run
// zero checks and print ALL PASS; want() throws if a block asks for a name that
// is not declared, so fixing the typo route cannot be defeated by a second typo
// one line lower down.
// ---------------------------------------------------------------------------
const SECTIONS = ['canvas', 'ramp', 'lut', 'oldramp', 'endtoend', 'frame', 'shading', 'section'];
const only = process.argv[2];
if (only !== undefined && !SECTIONS.includes(only)) {
  console.error('');
  console.error(`  ERROR: unknown section "${only}".`);
  console.error(`  Known sections: ${SECTIONS.join(', ')}`);
  console.error('  With no argument, every section runs.');
  console.error('');
  process.exit(2);
}
const ran = new Set();
const want = (k) => {
  if (!SECTIONS.includes(k)) {
    throw new Error(`verify-render.mjs: want("${k}") names a section that is not in SECTIONS.`
      + ` The list and the blocks have fallen out of step. Known: ${SECTIONS.join(', ')}`);
  }
  const yes = !only || only === k;
  if (yes) ran.add(k);
  return yes;
};

// ===========================================================================
// The stand-in canvas. See the file header for what it does and does not do.
// ===========================================================================

class FakeImageData {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(4 * w * h); }
}

class FakeCtx {
  constructor(canvas) {
    this.canvas = canvas;
    this.ops = [];
    // Real defaults, so that a draw() which FORGOT to switch smoothing off
    // fails in drawImage below instead of quietly producing a filtered picture.
    this.imageSmoothingEnabled = true;
    this.fillStyle = '#000000'; this.strokeStyle = '#000000';
    this.lineWidth = 1; this.font = '10px sans-serif';
  }

  createImageData(w, h) { this.ops.push(['createImageData', w, h]); return new FakeImageData(w, h); }

  putImageData(img, dx, dy) {
    this.ops.push(['putImageData', img.width, img.height, dx, dy]);
    const W = this.canvas.width, H = this.canvas.height, px = this.canvas._px;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const s = 4 * (y * img.width + x), d = 4 * (Y * W + X);
        px[d] = img.data[s]; px[d + 1] = img.data[s + 1];
        px[d + 2] = img.data[s + 2]; px[d + 3] = img.data[s + 3];
      }
    }
  }

  drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (arguments.length !== 9) {
      throw new Error(`stand-in drawImage: only the 9-argument form is implemented, got ${arguments.length}.`
        + ' Reading pixels through an unverified path is exactly what this file refuses to do.');
    }
    if (this.imageSmoothingEnabled) {
      throw new Error('stand-in drawImage: only nearest-neighbour is implemented and'
        + ' imageSmoothingEnabled is still true. A smoothed blit would interpolate the'
        + ' colour ramp and every byte read back would be a blend of two cells.');
    }
    this.ops.push(['drawImage', sw, sh, dx, dy, dw, dh]);
    const S = src._px, SW = src.width;
    const D = this.canvas._px, DW = this.canvas.width, DH = this.canvas.height;
    for (let y = 0; y < dh; y++) {
      const v = sy + ((y + 0.5) * sh) / dh;
      const jy = Math.min(sh - 1, Math.max(0, Math.floor(v)));
      const Y = dy + y;
      if (Y < 0 || Y >= DH) continue;
      for (let x = 0; x < dw; x++) {
        const u = sx + ((x + 0.5) * sw) / dw;
        const ix = Math.min(sw - 1, Math.max(0, Math.floor(u)));
        const X = dx + x;
        if (X < 0 || X >= DW) continue;
        const s = 4 * (jy * SW + ix), d = 4 * (Y * DW + X);
        D[d] = S[s]; D[d + 1] = S[s + 1]; D[d + 2] = S[s + 2]; D[d + 3] = S[s + 3];
      }
    }
  }

  getImageData(x, y, w, h) {
    const out = new FakeImageData(w, h), D = this.canvas._px, DW = this.canvas.width;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const s = 4 * ((y + j) * DW + (x + i)), d = 4 * (j * w + i);
        out.data[d] = D[s]; out.data[d + 1] = D[s + 1];
        out.data[d + 2] = D[s + 2]; out.data[d + 3] = D[s + 3];
      }
    }
    return out;
  }

  // Recorded, not rasterised. Style is captured WITH the call so the op log can
  // be checked for the right colour on the right shape.
  fillRect(x, y, w, h) { this.ops.push(['fillRect', x, y, w, h, this.fillStyle]); }
  beginPath() { this.ops.push(['beginPath']); }
  moveTo(x, y) { this.ops.push(['moveTo', x, y]); }
  lineTo(x, y) { this.ops.push(['lineTo', x, y]); }
  closePath() { this.ops.push(['closePath']); }
  fill() { this.ops.push(['fill', this.fillStyle]); }
  stroke() { this.ops.push(['stroke', this.strokeStyle, this.lineWidth]); }
  setLineDash(a) { this.ops.push(['setLineDash', Array.from(a).join(',')]); }
  fillText(s, x, y) { this.ops.push(['fillText', s, x, y]); }
}

const CTX_WRITABLE = new Set(['imageSmoothingEnabled', 'fillStyle', 'strokeStyle', 'lineWidth', 'font']);

// A Proxy, not a plain object, and this is the point of the whole stand-in
// being trustworthy: an unimplemented METHOD would throw on its own, but an
// unimplemented PROPERTY (globalAlpha = 0.5, filter = 'blur(2px)') would be
// swallowed by a plain object and would change the real picture and not this
// one. Every unknown read and every unknown write is a hard error naming the
// member, so the stand-in can never be silently outgrown by src/render.mjs.
function guard(target, label, writable) {
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (!(prop in t)) {
        throw new Error(`stand-in ${label}: read of unimplemented member "${String(prop)}".`
          + ' src/render.mjs has grown a canvas feature this suite does not model;'
          + ' implement it (and re-pin it against a real browser) rather than ignoring it.');
      }
      const v = t[prop];
      // Bound to the raw target: methods must see their own internals, not the
      // proxy, or every internal field access would have to be whitelisted too.
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, prop, v) {
      if (!writable.has(prop)) {
        throw new Error(`stand-in ${label}: write to unmodelled member "${String(prop)}" = ${String(v)}.`
          + ' A property the stand-in ignores changes the real picture and not this one.');
      }
      t[prop] = v; return true;
    },
  });
}

class FakeCanvas {
  constructor(w, h) {
    this.clientWidth = w; this.clientHeight = h;
    this._w = 0; this._h = 0; this._px = new Uint8ClampedArray(0);
  }
  get width() { return this._w; }
  set width(v) { this._w = v; this._realloc(); }
  get height() { return this._h; }
  set height(v) { this._h = v; this._realloc(); }
  _realloc() {
    const n = 4 * this._w * this._h;
    if (this._px.length !== n) this._px = new Uint8ClampedArray(n);
  }
  getContext() { return (this._ctxProxy ||= guard(new FakeCtx(this), 'context', CTX_WRITABLE)); }
}
const CANVAS_WRITABLE = new Set(['width', 'height']);
const newCanvas = (w, h) => guard(new FakeCanvas(w, h), 'canvas', CANVAS_WRITABLE);

// resize() reads window.devicePixelRatio. Guarded for the same reason: a future
// resize() that consulted window.innerWidth would throw here rather than pick
// up an undefined and silently draw a zero-sized map.
globalThis.window = guard({ devicePixelRatio: 1 }, 'window', new Set());
globalThis.OffscreenCanvas = class {
  constructor(w, h) {
    const c = new FakeCanvas(w, h);
    c.width = w; c.height = h;
    return guard(c, 'OffscreenCanvas', CANVAS_WRITABLE);
  }
};

/**
 * Build a view whose map panel is drawn at an INTEGER magnification, which is
 * the only regime section 0 pins against a real browser.
 *
 * mx = my = 1 gives a 1:1 blit and destination pixel (i, ny-1-j) IS cell (i, j).
 */
function viewFor(sim, { mx = 1, my = 1, scale = 1.0, showBed = true, showSection = false } = {}) {
  const cv = newCanvas(sim.nx * mx, sim.ny * my);
  const view = new WaterView(cv);
  view.scale = scale; view.showBed = showBed; view.showSection = showSection;
  return view;
}

/** Read one destination pixel of the map, as bytes. */
function pixel(view, x, y) {
  const d = view.ctx.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

/**
 * The map pixel belonging to cell (i, j) at 1:1. The +y flip is draw()'s, and
 * getting it wrong here would silently read the wrong row, so it is written
 * once and checked in section 5 against a frame whose rows differ.
 */
const cellPixel = (view, sim, i, j) => pixel(view, i, sim.ny - 1 - j);

/** FNV-1a over every byte, for the browser-pinned fixture. */
function fnv1a(bytes) {
  let hash = 2166136261 >>> 0, sum = 0;
  for (let n = 0; n < bytes.length; n++) { sum += bytes[n]; hash ^= bytes[n]; hash = Math.imul(hash, 16777619) >>> 0; }
  return { sum, hash };
}

// ===========================================================================
if (want('canvas')) {
console.log('');
console.log('=== 0. the stand-in canvas, pinned to a real browser =================');
console.log('');
// ===========================================================================
//
// The fixture is deliberately NOT the simulator: 37 x 11 is odd in both axes and
// coprime with every magnification below, and the pattern is generated from x
// and y alone. Nothing in src/ enters into it, so these seven hashes cannot go
// red because the solver changed -- only because the blit changed. The same
// expression was evaluated in Chrome 148.0.7778.280 on 2026-08-17 and produced
// the `want` column below; see the file header.
{
  const W = 37, H = 11;
  const main = newCanvas(1, 1);
  main.width = 1; main.height = 1;
  const mctx = main.getContext();
  const img = mctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = 4 * (y * W + x);
      img.data[o] = (x * 7 + y * 29) & 255;
      img.data[o + 1] = (x * x * 3 + y * 11) & 255;
      img.data[o + 2] = ((x * 13) ^ (y * 7)) & 255;
      img.data[o + 3] = 255;
    }
  }
  const off = new OffscreenCanvas(W, H);
  off.getContext().putImageData(img, 0, 0);

  const CHROME = {
    '1x1': { sum: 254040, hash: 3263356649 },
    '2x2': { sum: 1016160, hash: 2911487285 },
    '3x1': { sum: 762120, hash: 492835321 },
    '1x5': { sum: 1270200, hash: 52957881 },
    '4x3': { sum: 3048480, hash: 2700956229 },
    '7x2': { sum: 3556560, hash: 1688886293 },
    '5x9': { sum: 11431800, hash: 2862032937 },
  };
  for (const [mx, my] of [[1, 1], [2, 2], [3, 1], [1, 5], [4, 3], [7, 2], [5, 9]]) {
    const cv = newCanvas(W * mx, H * my);
    cv.width = W * mx; cv.height = H * my;
    const g = cv.getContext();
    g.imageSmoothingEnabled = false;
    g.drawImage(off, 0, 0, W, H, 0, 0, W * mx, H * my);
    const got = fnv1a(g.getImageData(0, 0, cv.width, cv.height).data);
    const wantH = CHROME[`${mx}x${my}`];
    assert(`blit ${String(mx + 'x' + my).padEnd(4)} matches Chrome 148 byte for byte`,
      got.sum === wantH.sum && got.hash === wantH.hash,
      `sum ${got.sum} vs ${wantH.sum}, FNV-1a ${got.hash} vs ${wantH.hash}`);
  }

  // The stand-in must REFUSE the cases it was never pinned on, rather than
  // returning something plausible. Chrome disagrees with pixel-centre floor at
  // every non-integer factor measured (700/800 differs on 11 of the first 80
  // pixels of row 0), so a suite that read pixels there would be quoting this
  // file's arithmetic as if it were a browser's.
  const cv = newCanvas(W, H); cv.width = W; cv.height = H;
  const g = cv.getContext();
  let threwSmooth = false;
  try { g.drawImage(off, 0, 0, W, H, 0, 0, W, H); } catch { threwSmooth = true; }
  assert('a smoothed blit is an error, not a silent interpolation', threwSmooth,
    'imageSmoothingEnabled defaults to true here exactly so a draw() that forgot to clear it fails');
  let threwArity = false;
  try { g.imageSmoothingEnabled = false; g.drawImage(off, 0, 0); } catch { threwArity = true; }
  assert('the 3-argument drawImage form is an error', threwArity,
    'only the 9-argument form was pinned against a browser');

  // The guard proxies. If these do not throw, every claim above about "the
  // stand-in cannot be silently outgrown" is decoration.
  let threwRead = false, threwWrite = false;
  try { void g.globalAlpha; } catch { threwRead = true; }
  try { g.filter = 'blur(2px)'; } catch { threwWrite = true; }
  assert('reading an unimplemented context member throws', threwRead, 'probed with ctx.globalAlpha');
  assert('writing an unmodelled context member throws', threwWrite, "probed with ctx.filter = 'blur(2px)'");
}
}

// ===========================================================================
if (want('ramp')) {
console.log('');
console.log('=== 1. the colour ramp, measured through the exported function =======');
console.log('');
// ===========================================================================
//
// Every figure here comes out of rampSymmetry(), which drives surfaceColour() --
// the function draw() calls. No second copy of the L*a*b* construction is
// involved, so a ramp that was rebuilt wrongly cannot agree with these numbers
// by having been rebuilt wrongly in two places.
//
// The `want` values are the header's own quoted figures, to the precision the
// header quotes them at; the tolerances are that quoting precision and nothing
// looser. Full precision measured here: exact 1.1737331092e-4, 8-bit at 1025
// 4.4095741913e-1 on a span of 65.963257786.
{
  const exact = rampSymmetry(257, false);
  check('worst |L*| asymmetry about msl, exact ramp', exact.worstAsym, 1.174e-4, 3e-3,
    `at |t| = ${exact.worstAt.toFixed(4)}, 257 samples; header quotes 1.174e-4`);
  // A ceiling as well as an agreement: the number above could match a stale
  // header. This says the ramp is symmetric to better than a thousandth of an
  // L* unit, which is the claim its docstring actually makes.
  assert('exact ramp symmetric to better than 1e-3 L*', exact.worstAsym < 1e-3,
    `${exact.worstAsym.toExponential(4)} L* on a ${exact.span.toFixed(3)} L* span`
    + ` = ${(100 * exact.worstAsym / exact.span).toExponential(2)}% of the span`);

  // THE DENSER SWEEP IS THE HONEST ONE. A coarse sweep finds a smaller worst
  // case and flatters the ramp: 0.4045 at 257 samples against 0.4410 at 1025,
  // 9% low, because the 8-bit worst case sits at |t| = 0.9463 and a 257-point
  // sweep steps straight over it. Both are asserted, and the DENSER one is the
  // figure this suite quotes.
  const bits8 = rampSymmetry(1025, true);
  const bits8coarse = rampSymmetry(257, true);
  check('worst |L*| asymmetry, 8-bit, 1025 samples', bits8.worstAsym, 0.4410, 3e-3,
    `at |t| = ${bits8.worstAt.toFixed(4)}; this is the figure to quote`);
  check('worst |L*| asymmetry, 8-bit, 257 samples', bits8coarse.worstAsym, 0.4045, 3e-3,
    'the coarse sweep, recorded because it FLATTERS the ramp by 9% and must not be the quoted one');
  assert('the coarse sweep understates the 8-bit worst case', bits8coarse.worstAsym < bits8.worstAsym,
    `${bits8coarse.worstAsym.toFixed(4)} < ${bits8.worstAsym.toFixed(4)} L* --`
    + ' if these ever tie or invert, the "quote the denser sweep" instruction has stopped'
    + ' discriminating and the header should stop giving it');
  check('full L* span, trough to crest, 8-bit', bits8.span, 65.963, 1e-4,
    `the denominator the asymmetry is a fraction of: ${(100 * bits8.worstAsym / bits8.span).toFixed(2)}%`);
  assert('8-bit asymmetry is under 1% of the span', bits8.worstAsym / bits8.span < 0.01,
    `${(100 * bits8.worstAsym / bits8.span).toFixed(3)}%, header quotes 0.67%`);

  // -----------------------------------------------------------------------
  // THE DISCONTINUITY AT MEAN SEA LEVEL, MEASURED IN THIS FILE.
  //
  // These two lines used to read rampSymmetry().jump, which is precisely what
  // this file's header promises not to do: they borrowed src/render.mjs's own
  // arithmetic wholesale and then reported the borrowed number as a verdict.
  // Measured on a copy of the tree: replacing that field with the literal
  // `jump: 0` left the suite at ALL PASS 104/104. They now step across mean sea
  // level with surfaceColour() -- the function draw() calls -- and do their own
  // hypot, so the property is measured whatever rampSymmetry() chooses to say.
  //
  // EXACT equality is the right comparison: the two halves of the ramp are
  // constructed to share the middle LUT entry, so any difference at all -- one
  // ulp -- means they no longer do. A tolerance here would hide the entire
  // failure mode the ramp exists to remove.
  const zPlus = surfaceColour(+1e-12, 1), zMinus = surfaceColour(-1e-12, 1);
  const mslStep = rgbDist(zPlus, zMinus);
  const mslStep8 = rgbDist(q8(zPlus), q8(zMinus));
  assert('discontinuity at msl, exact ramp: exactly zero', mslStep === 0,
    `|colour(+1e-12) - colour(-1e-12)| = ${mslStep} RGB units, stepped here with`
    + ' surfaceColour() rather than read off rampSymmetry().jump');
  assert('discontinuity at msl, 8-bit: exactly zero', mslStep8 === 0,
    `${mslStep8} RGB units: ${rgb(q8(zPlus))} above msl, ${rgb(q8(zMinus))} below --`
    + ' the bytes have to be identical, not merely close');

  // AND THE INSTRUMENT, PINNED TO THE MEASUREMENT. render.mjs publishes this
  // number itself; the two must not be allowed to drift apart unnoticed.
  //
  // WHAT THIS LINE CANNOT DO, stated rather than implied, because the house rule
  // is that a check must be able to fail. On a CORRECT ramp the true step is
  // zero, so a hard-coded `jump: 0` in rampSymmetry() is numerically identical
  // to the real computation and NOTHING here can tell them apart: it is an
  // equivalent mutant, established by measurement (the shipped suite and this
  // one both stay green on it) rather than assumed. What the repair buys is
  // real all the same, in two parts: the two lines above no longer DEPEND on
  // that field, so the msl property is still measured when it is hard-coded;
  // and this line catches the hard-code the moment the ramp actually steps.
  //
  // Measured on a copy of the tree carrying BOTH mutations at once -- a one-bin
  // msl step injected into surfaceColour's negative branch (RAMP_MID - q + 1)
  // AND `jump: 0` -- against this file with the borrow put back in:
  //
  //   borrowed  PASS  discontinuity at msl, exact ramp: exactly zero   0 RGB units
  //   measured  FAIL  discontinuity at msl, exact ramp: exactly zero   0.38089 RGB units
  //
  // and the borrowed line printed rgb(104,130,150) above msl and rgb(105,130,150)
  // below it in its own note while reporting the step between them as zero. That
  // is the whole disease in one line.
  assert('rampSymmetry() reports the step this file measured',
    exact.jump === mslStep && bits8.jump === mslStep8,
    `render.mjs reports ${exact.jump} exact / ${bits8.jump} 8-bit;`
    + ` measured here ${mslStep} / ${mslStep8}`);

  // -----------------------------------------------------------------------
  // THE RESOLUTION THE LUT COSTS. This was a console.log and nothing else -- a
  // number printed on every run with nothing able to disagree with it. Measured:
  // hard-coding `maxStep = 0` in rampSymmetry() left the suite at 104/104.
  //
  // The target is measured HERE, by walking the LUT entry by entry through
  // surfaceColour: entry i is reached exactly at t = (i - MID)/MID, with MID
  // derived by bisection rather than imported. So this compares render.mjs's
  // published resolution against an independent reading of the same quantity,
  // and separately holds it under a ceiling that a shorter LUT would break.
  const MID_REF = deriveRampMid();
  let stepRef = 0, stepAtRef = 0, prevEntry = surfaceColour(-1, 1);
  for (let i = 1; i <= 2 * MID_REF; i++) {
    const t = (i - MID_REF) / MID_REF;
    const c = surfaceColour(t, 1);
    const d = rgbDist(prevEntry, c);
    if (d > stepRef) { stepRef = d; stepAtRef = t; }
    prevEntry = c;
  }
  check('largest step between adjacent LUT entries', exact.maxStep, stepRef, 1e-12,
    `${stepRef.toFixed(6)} RGB units at t = ${stepAtRef.toFixed(6)}, walked here over the`
    + ` ${2 * MID_REF + 1} entries; render.mjs reports ${exact.maxStep.toFixed(6)}`);
  check('...and that step is the figure this suite quotes', stepRef, 0.452855, 1e-5,
    'the LUT resolution, measured in the tree as it stands');
  assert('the LUT resolves the ramp to better than 1 RGB unit per entry', stepRef < 1,
    `${stepRef.toFixed(6)} RGB units; a LUT short enough to show banding would break this,`
    + ' which is the only reason to put a ceiling on it');

  // The L* the LUT puts at mean sea level.
  console.log(`        L* at msl: exact ${exact.L0.toFixed(4)}, 8-bit ${bits8.L0.toFixed(4)}`
    + `  (LAB_MSL declares L* = ${LAB_MSL_REF[0]})`);
  check('L*(msl) is the L* the ramp was declared with', exact.L0, LAB_MSL_REF[0], 1e-4,
    'a round trip through L*a*b* -> sRGB -> L*; disagreement means labToSrgbRaw drifted');
  check('L*(msl) is the midpoint of the two endpoints', exact.L0,
    0.5 * (LAB_CREST_REF[0] + LAB_TROUGH_REF[0]), 1e-4,
    'this identity, not taste, is what makes equal excursions equally bright');
}

console.log('');
console.log('=== 1b. gamut: nothing clips ========================================');
console.log('');
//
// Not a detail. The LUT is built UNCLAMPED precisely so an escape is still
// visible: a clamped ramp looks fine and is quietly asymmetric at the end that
// clipped. The header records that the first endpoints tried (trough b* = -38)
// clipped blue below t = -0.8 and cost 0.84 L*, which is seven times the entire
// 8-bit asymmetry measured above -- so this check is worth more than the
// symmetry check it protects.
{
  const r = rampSymmetry(257, false);
  // REDUNDANT, NOT VACUOUS, and kept on purpose. This line reads render.mjs's
  // own outOfGamut field, so a hard-coded `outOfGamut = 0` there passes it --
  // measured, SURVIVED at 104/104, the same borrow the msl step used to make.
  // The difference is that the gamut PROPERTY is covered independently by the
  // sweep immediately below, which drives surfaceColour directly and owns its
  // own arithmetic. Measured on a copy of the tree at the header's own
  // documented failure -- trough b* = -34 -> -38, the endpoint it says clipped
  // blue below t = -0.8 -- BOTH lines fire, at 22.725 RGB units outside gamut.
  // So a real clip cannot hide, and this line is a second, cheaper reading of a
  // covered property rather than a check with nothing behind it. Deleting it
  // would remove the one place the LUT SCAN is exercised at all: the sweep below
  // samples 4097 values of t and cannot see an entry that no sampled t reaches.
  assert('no LUT entry escapes [0, 255]', r.outOfGamut === 0,
    `worst excursion outside gamut ${r.outOfGamut} RGB units`);
  // And separately, off the exported function rather than the LUT scan inside
  // rampSymmetry, so a bug in that scan cannot hide a clip. The number reported
  // is the SIGNED margin, so a passing line still says how much headroom is
  // left: a check whose printed value is 0 whether or not anything clipped is a
  // check that confirms itself.
  let worstOut = -Infinity, at = 0;
  for (let n = -2048; n <= 2048; n++) {
    const t = n / 2048;
    for (const v of surfaceColour(t, 1)) {
      const e = Math.max(-v, v - 255);
      if (e > worstOut) { worstOut = e; at = t; }
    }
  }
  assert('no colour returned by surfaceColour escapes [0, 255]', worstOut <= 0,
    `closest approach to a gamut wall ${(-worstOut).toFixed(3)} RGB units of headroom,`
    + ` at t = ${at.toFixed(4)}, swept at 4097 values of t`);
  // Clamping is still applied to the ARGUMENT: past full scale the colour must
  // stop moving, or a 3 m surge would be drawn a different colour from a 30 m
  // one and the fixed scale would stop meaning anything.
  const c1 = surfaceColour(1, 1), c9 = surfaceColour(9, 1);
  const cm1 = surfaceColour(-1, 1), cm9 = surfaceColour(-9, 1);
  assert('t is clamped past full scale, both signs',
    c1.join() === c9.join() && cm1.join() === cm9.join(),
    `crest ${rgb(q8(c1))} at t=1 and t=9; trough ${rgb(q8(cm1))} at t=-1 and t=-9`
    + ' (bytes shown; the LUT itself is unrounded)');
}
}

// ===========================================================================
if (want('lut')) {
console.log('');
console.log('=== 2. the LUT length, and what actually removes the msl step ========');
console.log('');
// ===========================================================================
//
// RAMP_N is private, so it is DERIVED from the exported function rather than
// read: surfaceColour indexes with round(|t| * RAMP_MID), so the colour first
// leaves the middle entry at |t| = 0.5 / RAMP_MID. Bisecting that boundary gives
// RAMP_MID = 512, RAMP_N = 1025, and a sweep of t over [-1, 1] returns exactly
// 1025 distinct triples -- two independent readings of the same number.
//
// THIS SECTION CORRECTS THE HEADER. The header attributes the 1024-entry failure
// -- "0.304 RGB units of step at msl and 6.45e-2 L* of asymmetry" -- to the even
// count alone. Both figures reproduce EXACTLY (0.3044 and 6.4517e-2), but only
// with the NAIVE index mapping t -> round((t+1)/2 * (N-1)), which is precisely
// the mapping surfaceColour's own comment says it does not use. Measured on a
// reference construction validated against the shipped LUT:
//
//   N      indexing    jump at msl (exact / 8-bit)   worst |L*| asymmetry
//   1024   naive       0.3044 / 1.0000              6.4517e-2   <- the header's numbers
//   1024   symmetric   0      / 0                   1.1713e-4
//   1025   naive       0      / 0                   1.1737e-4
//   1025   symmetric   0      / 0                   1.1737e-4   <- what ships
//
// So there are TWO independent defences and the header credits one of them. An
// even count on its own is harmless under symmetric indexing, because index
// RAMP_MID is then reached from both signs. What the odd count buys is that
// entry RAMP_MID is at t = 0 exactly rather than half a bin below it: L*(msl)
// reads 52.9687 at 1024 against 53.0009 at 1025, and 53 is the declared value.
//
// The symmetric indexing earns its own keep somewhere the existing instrument
// cannot see it: rampSymmetry sweeps t = n/samples, which never lands on a
// half-bin, and the naive mapping is wrong only AT half-bins (Math.round breaks
// ties upward on both signs, so the negative side lands one bin closer to msl
// than the positive side). Swept at t = (m + 0.5)/512 the shipped function
// measures 1.1737e-4 and the naive one 6.4572e-2 -- 550 times worse, and equal
// to one bin, which is the size of the effect the header attributes to N.
{
  // Derive RAMP_MID by bisection on the exported function.
  const c0 = surfaceColour(0, 1);
  const sameAsMsl = (t) => { const c = surfaceColour(t, 1); return c[0] === c0[0] && c[1] === c0[1] && c[2] === c0[2]; };
  let lo = 0, hi = 1;
  for (let k = 0; k < 200; k++) { const m = 0.5 * (lo + hi); if (sameAsMsl(m)) lo = m; else hi = m; }
  const mid = Math.round(0.5 / hi);
  const N = 2 * mid + 1;
  const distinct = new Set();
  for (let k = -400000; k <= 400000; k++) distinct.add(surfaceColour(k / 400000, 1).join(','));
  check('RAMP_MID, from the first |t| that leaves the msl entry', mid, 512, 0,
    `first change at |t| = ${hi.toExponential(4)} = 0.5/512`);
  check('distinct colours over t in [-1, 1]', distinct.size, N, 0,
    `${distinct.size} triples, independently confirming RAMP_N = ${N}`);
  assert('RAMP_N is ODD', N % 2 === 1,
    `${N}; an odd count puts entry (N-1)/2 at t = 0 exactly rather than half a bin below it`);

  // Half-bin sweep: the tie-breaking claim inside surfaceColour, which
  // rampSymmetry's uniform sweep structurally cannot reach.
  const L0 = Lstar(surfaceColour(0, 1));
  let worstHalfBin = 0, atHalfBin = 0;
  for (let m = 0; m < mid; m++) {
    const t = (m + 0.5) / mid;
    const d = Math.abs((Lstar(surfaceColour(t, 1)) - L0) - (L0 - Lstar(surfaceColour(-t, 1))));
    if (d > worstHalfBin) { worstHalfBin = d; atHalfBin = t; }
  }
  assert('symmetric indexing holds at EXACT half-bin |t|', worstHalfBin < 1e-3,
    `worst ${worstHalfBin.toExponential(4)} L* at |t| = ${atHalfBin.toFixed(6)};`
    + ' the naive mapping measures 6.4572e-2 here, 550x worse, and rampSymmetry cannot see it');

  // ---------------------------------------------------------------------
  // The counterfactual construction. A second copy of the L*a*b* build, which
  // is normally forbidden -- so it is VALIDATED FIRST: at N = 1025 with
  // symmetric indexing it must reproduce surfaceColour to zero absolute
  // difference, not to a tolerance. Only then is it believed about N = 1024.
  // Measured: 0 over 400001 samples, all three channels.
  // ---------------------------------------------------------------------
  const labToSrgbRef = (Lv, a, bb) => {
    const fy = (Lv + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
    const g = (f) => (f * f * f > 0.008856 ? f * f * f : (f - 16 / 116) / 7.787);
    const X = 0.95047 * g(fx), Y = g(fy), Z = 1.08883 * g(fz);
    const enc = (u) => 255 * (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(Math.max(u, 0), 1 / 2.4) - 0.055);
    return [enc(3.2406 * X - 1.5372 * Y - 0.4986 * Z),
      enc(-0.9689 * X + 1.8758 * Y + 0.0415 * Z),
      enc(0.0557 * X - 0.2040 * Y + 1.0570 * Z)];
  };
  const refRamp = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = -1 + (2 * i) / (n - 1);
      const end = t >= 0 ? LAB_CREST_REF : LAB_TROUGH_REF, a = Math.abs(t);
      out.push(labToSrgbRef(LAB_MSL_REF[0] + (end[0] - LAB_MSL_REF[0]) * a,
        LAB_MSL_REF[1] + (end[1] - LAB_MSL_REF[1]) * a,
        LAB_MSL_REF[2] + (end[2] - LAB_MSL_REF[2]) * a));
    }
    return out;
  };
  const pickSym = (ramp, n, t) => {
    const m = (n - 1) >> 1; t = Math.max(-1, Math.min(1, t));
    const q = Math.round(Math.abs(t) * m);
    return ramp[t >= 0 ? m + q : m - q];
  };
  const pickNaive = (ramp, n, t) => {
    t = Math.max(-1, Math.min(1, t));
    return ramp[Math.max(0, Math.min(n - 1, Math.round(((t + 1) / 2) * (n - 1))))];
  };

  const ref1025 = refRamp(1025);
  let worstCopy = 0;
  for (let k = -200000; k <= 200000; k++) {
    const t = k / 200000, a = pickSym(ref1025, 1025, t), b = surfaceColour(t, 1);
    worstCopy = Math.max(worstCopy, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  }
  assert('the counterfactual construction reproduces the shipped LUT exactly', worstCopy === 0,
    `worst absolute channel difference ${worstCopy} over 400001 samples`
    + ' -- validated before it is allowed to testify about N = 1024');

  const measureRamp = (ramp, n, pick) => {
    const l0 = Lstar(pick(ramp, n, 0));
    let w = 0;
    for (let m = 1; m <= 1025; m++) {
      const t = m / 1025;
      const d = Math.abs((Lstar(pick(ramp, n, t)) - l0) - (l0 - Lstar(pick(ramp, n, -t))));
      if (d > w) w = d;
    }
    const zp = pick(ramp, n, 1e-12), zn = pick(ramp, n, -1e-12);
    const zp8 = q8(zp), zn8 = q8(zn);
    return {
      L0: l0, worst: w,
      jump: Math.hypot(zp[0] - zn[0], zp[1] - zn[1], zp[2] - zn[2]),
      jump8: Math.hypot(zp8[0] - zn8[0], zp8[1] - zn8[1], zp8[2] - zn8[2]),
    };
  };
  const ref1024 = refRamp(1024);
  const evenNaive = measureRamp(ref1024, 1024, pickNaive);
  const evenSym = measureRamp(ref1024, 1024, pickSym);
  const oddSym = measureRamp(ref1025, 1025, pickSym);

  check("even count + naive indexing: the header's msl step", evenNaive.jump, 0.304, 2e-3,
    `${evenNaive.jump.toFixed(4)} RGB exact, ${evenNaive.jump8.toFixed(4)} after byte rounding`);
  check("even count + naive indexing: the header's asymmetry", evenNaive.worst, 6.45e-2, 2e-3,
    `${evenNaive.worst.toExponential(4)} L* = one bin; the header's 6.45e-2, reproduced`);
  assert('...but under the SHIPPED symmetric indexing an even count does NOT step',
    evenSym.jump === 0,
    `jump ${evenSym.jump}, asymmetry ${evenSym.worst.toExponential(4)} L* --`
    + " so the header's attribution of the step to the even count alone is stale;"
    + ' the step needs even N AND naive indexing');
  check('what the odd count actually buys: L*(msl) lands on 53', oddSym.L0, LAB_MSL_REF[0], 1e-4,
    `1025 gives ${oddSym.L0.toFixed(4)}, 1024 gives ${evenSym.L0.toFixed(4)},`
    + ` an offset of ${Math.abs(oddSym.L0 - evenSym.L0).toExponential(3)} L* = half a bin`);
  assert('the odd count is closer to the declared L*(msl) than the even one',
    Math.abs(oddSym.L0 - LAB_MSL_REF[0]) < Math.abs(evenSym.L0 - LAB_MSL_REF[0]),
    `|53 - 1025| = ${Math.abs(oddSym.L0 - LAB_MSL_REF[0]).toExponential(3)}`
    + ` vs |53 - 1024| = ${Math.abs(evenSym.L0 - LAB_MSL_REF[0]).toExponential(3)} L*`);
}
}

// ===========================================================================
if (want('oldramp')) {
console.log('');
console.log('=== 3. the check can fail: the OLD ramp, scored by this machinery ====');
console.log('');
// ===========================================================================
//
// A check that has never been seen to fail is a decoration. The header's whole
// argument rests on the ramp it replaced being measurably bad, so the same
// measurement is run on that ramp -- two linear RGB segments, [30,90,120] ->
// [230,240,230] above msl and [20,55,95] -> [40,30,135] below -- and asserted to
// come back BAD. If these lines ever pass by reading "good", the instrument in
// section 1 has stopped being able to see the disease it was built for.
//
// The header's five figures for the old ramp all reproduce here. One needed its
// definition pinned down: "the trough travelled 51.23 units" is the length of
// the trough SEGMENT ([20,55,95] -> [40,30,135], 51.23), not the distance from
// the msl colour to the trough end (62.65). The two differ precisely BECAUSE the
// segments do not meet -- which is the 44.16 jump -- so the segment-length
// reading is the one that means anything, and it is the one used.
{
  const old = (v, scale) => {
    const t = Math.max(-1, Math.min(1, v / scale));
    if (t >= 0) return [30 + 200 * t, 90 + 150 * t, 120 + 110 * t];
    const a = -t; return [20 + 20 * a, 55 - 25 * a, 95 + 40 * a];
  };
  const L0 = Lstar(old(0, 1));
  let worst = 0, at = 0;
  for (let n = 1; n <= 1025; n++) {
    const t = n / 1025;
    const d = Math.abs((Lstar(old(t, 1)) - L0) - (L0 - Lstar(old(-t, 1))));
    if (d > worst) { worst = d; at = t; }
  }
  const zp = old(1e-12, 1), zn = old(-1e-12, 1);
  const jump = Math.hypot(zp[0] - zn[0], zp[1] - zn[1], zp[2] - zn[2]);
  const up = Lstar(old(1, 1)) - L0, down = L0 - Lstar(old(-1, 1));
  const seg = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const segUp = seg(old(1, 1), old(0, 1));
  const segDown = seg(old(-1, 1), [20, 55, 95]);

  check("OLD ramp: full-scale crest excursion (header +57.94 L*)", up, 57.94, 3e-4);
  check("OLD ramp: full-scale trough excursion (header -15.32 L*)", down, 15.32, 3e-4);
  check('OLD ramp: crest/trough L* ratio (header 3.78)', up / down, 3.78, 1e-3,
    'a trough whispered and a crest shouted');
  check('OLD ramp: worst |L*| asymmetry (header 42.62)', worst, 42.62, 1e-4,
    `at |t| = ${at.toFixed(4)}`);
  check('OLD ramp: discontinuity at msl (header 44.16 RGB)', jump, 44.16, 3e-4,
    'larger than the entire excursion a full-scale trough was given');
  check('OLD ramp: crest segment length (header 273.13 RGB)', segUp, 273.13, 1e-4);
  check('OLD ramp: trough segment length (header 51.23 RGB)', segDown, 51.23, 1e-4,
    'measured along its own segment; msl-to-trough-end is 62.65 because the segments do not meet');
  check('OLD ramp: RGB travel ratio (header 5.33)', segUp / segDown, 5.33, 3e-4);

  // The verdict lines. These are what make section 1 a test.
  const shipped8 = rampSymmetry(1025, true);
  const shippedExact = rampSymmetry(257, false);
  assert('the instrument calls the old ramp asymmetric', worst > 1,
    `${worst.toFixed(2)} L* against ${shippedExact.worstAsym.toExponential(3)} L* shipped`
    + ` -- ${(worst / shippedExact.worstAsym).toExponential(2)}x`);
  assert('the instrument sees the old discontinuity', jump > 1,
    `${jump.toFixed(2)} RGB units against ${shipped8.jump} shipped`);
  // The shipped ramp's own worst crest/trough ratio, measured the same way, is
  // the number the old one has to be compared against -- 1.000 nominal would be
  // comparing the old ramp with an ideal rather than with what replaced it.
  let shippedWorstRatio = 1;
  for (let n = 1; n <= 1025; n++) {
    const t = n / 1025;
    const u = Lstar(surfaceColour(t, 1)) - Lstar(surfaceColour(0, 1));
    const w = Lstar(surfaceColour(0, 1)) - Lstar(surfaceColour(-t, 1));
    if (u > 1e-6 && w > 1e-6 && Math.abs(u / w - 1) > Math.abs(shippedWorstRatio - 1)) shippedWorstRatio = u / w;
  }
  assert('the instrument sees the old lopsided excursion', Math.abs(up / down - 1) > 0.5,
    `old ratio ${(up / down).toFixed(3)}; the shipped ramp's WORST ratio over the same sweep is`
    + ` ${shippedWorstRatio.toFixed(6)}, i.e. ${((up / down - 1) / (shippedWorstRatio - 1)).toExponential(2)}x`
    + ` further from unity`);
}
}

// ---------------------------------------------------------------------------
// The end-to-end fixture, shared by sections 5 and 6: planeBeach, 12 m of water,
// scale = 1 m, exactly as the header describes it. planeBeach is flat at
// -12 m until x = 1120 m, so cells i = 100..102 (x = 251.25, 253.75, 256.25 m)
// all sit over bed = -12 exactly, which is checked rather than assumed.
// ---------------------------------------------------------------------------
function planeBeachFixture() {
  const { bed, meta } = shoreline('planeBeach');
  const { nx, ny, dx, dy } = meta.domain;
  const sim = new ShallowWater({ nx, ny, dx, dy, bed, eta0: 0, manning: 0.024 });
  return { sim, meta, nx, ny, dx, dy };
}

// ===========================================================================
if (want('endtoend')) {
console.log('');
console.log('=== 4. end to end, off the pixels draw() paints ======================');
console.log('');
// ===========================================================================
//
// The header's central claim, reproduced through the real draw() at a 1:1 blit.
// One cell set to a +1.00 m crest, the cell beside it to a -1.00 m trough, a
// third left at mean level, all three over the SAME bed so the depth shading is
// common to them and cancels out of the comparison.
//
// Measured here and, independently, in Chrome 148 against a real <canvas>
// (see the file header): identical bytes in both.
//
//   crest   rgb(181,149,94)   +24.921 L*
//   mean    rgb(75,93,107)
//   trough  rgb(2,34,70)      -25.302 L*      ratio 0.9850
//
// The bytes are asserted EXACTLY. A tolerance on an integer byte would only be
// hiding a change of colour.
{
  const { sim, ny } = planeBeachFixture();
  const j = 1, iCrest = 100, iTrough = 101, iMean = 102;
  for (const i of [iCrest, iTrough, iMean]) {
    assert(`cell i=${i} sits over bed = -12 m exactly`, sim.b[sim.idx(i, j)] === -12,
      `bed ${sim.b[sim.idx(i, j)]} m; the three cells must share a bed or the shading does not cancel`);
  }
  sim.h[sim.idx(iCrest, j)] = 12 + 1.00;
  sim.h[sim.idx(iTrough, j)] = 12 - 1.00;
  sim.h[sim.idx(iMean, j)] = 12 + 0.00;

  const view = viewFor(sim, { scale: 1.0 });
  view.draw(sim, { msl: 0 });

  // Nothing unrasterised can have touched these bytes. Asserted from the op log
  // rather than inferred from showSection = false.
  const kinds = [...new Set(view.ctx.ops.map((o) => o[0]))].sort();
  assert('the map-only frame used ONLY rasterised calls',
    kinds.join(',') === 'createImageData,drawImage',
    `ops: ${kinds.join(', ')} -- no fill, stroke or text went anywhere near these pixels`);
  const blit = view.ctx.ops.find((o) => o[0] === 'drawImage');
  assert('the blit magnification is an integer >= 1 in both axes',
    Number.isInteger(blit[5] / blit[1]) && Number.isInteger(blit[6] / blit[2])
    && blit[5] >= blit[1] && blit[6] >= blit[2],
    `${blit[1]}x${blit[2]} -> ${blit[5]}x${blit[6]}, i.e. ${blit[5] / blit[1]}x by ${blit[6] / blit[2]}x;`
    + ' Chrome and this stand-in were only pinned to agree on integer factors');

  const crest = cellPixel(view, sim, iCrest, j);
  const trough = cellPixel(view, sim, iTrough, j);
  const mean = cellPixel(view, sim, iMean, j);
  assert('crest pixel is rgb(181,149,94)', crest.slice(0, 3).join() === '181,149,94', rgb(crest));
  assert('trough pixel is rgb(2,34,70)', trough.slice(0, 3).join() === '2,34,70', rgb(trough));
  assert('mean-level pixel is rgb(75,93,107)', mean.slice(0, 3).join() === '75,93,107', rgb(mean));
  assert('the map is written opaque', crest[3] === 255 && trough[3] === 255 && mean[3] === 255,
    `alpha ${crest[3]}/${trough[3]}/${mean[3]}; the context is created with { alpha: false }`);

  const dUp = Lstar(crest) - Lstar(mean), dDown = Lstar(mean) - Lstar(trough);
  check('crest excursion from mean level', dUp, 24.921, 1e-4, 'L*, from the painted bytes');
  check('trough excursion from mean level', dDown, 25.302, 1e-4, 'L*, from the painted bytes');
  check('crest/trough excursion ratio', dUp / dDown, 0.985, 1e-3,
    `${(dUp / dDown).toFixed(6)}; the old ramp scored 3.744 on these same three cells`);
  assert('the two excursions are within 2% of each other', Math.abs(dUp / dDown - 1) < 0.02,
    `${(100 * Math.abs(dUp / dDown - 1)).toFixed(2)}% apart -- the claim a reader of the map relies on`);

  // The +y flip. draw() writes row (ny-1-j), and a test that read the wrong row
  // would still have found plausible colours on a frame whose rows are equal --
  // so the rows are made unequal and the flip is checked, not assumed.
  const jOther = 0;
  sim.h[sim.idx(iCrest, jOther)] = 12 - 1.00;
  view.draw(sim, { msl: 0 });
  const flipTop = pixel(view, iCrest, ny - 1 - j);
  const flipBottom = pixel(view, iCrest, ny - 1 - jOther);
  assert('+y is up on screen: row j is painted at y = ny-1-j',
    flipTop.slice(0, 3).join() === '181,149,94' && flipBottom.slice(0, 3).join() === '2,34,70',
    `y=${ny - 1 - j} is ${rgb(flipTop)} (crest at j=${j}), y=${ny - 1 - jOther} is ${rgb(flipBottom)}`
    + ` (trough at j=${jOther})`);

  // 4x3 magnification: the crest colour must fill all twelve destination pixels
  // of its source cell. Confirmed in Chrome 148 at the same magnification.
  const mag = viewFor(sim, { scale: 1.0, mx: 4, my: 3 });
  sim.h[sim.idx(iCrest, jOther)] = 12 + 1.00;
  mag.draw(sim, { msl: 0 });
  let filled = 0;
  for (let oy = 0; oy < 3; oy++) {
    for (let ox = 0; ox < 4; ox++) {
      const p = pixel(mag, 4 * iCrest + ox, 3 * (ny - 1 - j) + oy);
      if (p.slice(0, 3).join() === '181,149,94') filled++;
    }
  }
  check('at 4x3, the crest cell fills all 12 destination pixels', filled, 12, 0,
    'nearest-neighbour replication, byte-identical to Chrome 148 at this magnification');
}
}

// ===========================================================================
if (want('frame')) {
console.log('');
console.log('=== 5. every pixel of a real frame, against the documented rules =====');
console.log('');
// ===========================================================================
//
// Three cells is a spot check. This is the whole map: a stepped planeBeach
// field, every cell's painted bytes against
//
//   wet  q8( surfaceColour(eta, scale) * SHADE_REF(max(0, msl - bed)) )
//   dry  q8( LAND_REF(bed) )
//
// with SHADE_REF and LAND_REF declared in this file, not imported. That is what
// makes it a test of the renderer rather than a paraphrase: if render.mjs
// changes its shading constants, its land ramp, its dry threshold or its index
// arithmetic, this goes red.
//
// The comparison is solver-independent -- the prediction is built from the same
// sim.h/sim.b that draw() reads, at draw time -- so a change to swe.mjs cannot
// turn it red. What the stepped field buys is COVERAGE: a real run-up front, a
// dry beach, and eta of both signs running past full scale.
//
// AN INSTRUMENT MUST REFUSE. A NaN field would clamp to zero on both sides of
// this comparison and pass perfectly, and a frame with no dry cells would leave
// the land branch untested while still printing PASS. So the frame is
// interrogated first and the coverage numbers are asserted, not just printed.
{
  // A hump and a hollow over planeBeach, run far enough to break up, throw
  // troughs and run up onto the dry beach. scale = 0.5 m so the field overruns
  // full scale at both ends and the clamp is covered too.
  {
    const { bed: bfn, meta } = shoreline('planeBeach');
    const { nx, ny, dx, dy } = meta.domain;
    const s2 = new ShallowWater({
      nx, ny, dx, dy, bed: bfn,
      eta0: (x) => 1.4 * Math.exp(-(((x - 700) / 70) ** 2)) - 1.2 * Math.exp(-(((x - 1050) / 70) ** 2)),
      manning: 0.024,
    });
    for (let n = 0; n < 500; n++) s2.step();
    const SCALE = 0.5;
    const view = viewFor(s2, { scale: SCALE });
    view.draw(s2, { msl: 0 });

    assert('the frame is finite', s2.finite(),
      `max speed ${s2.maxSpeed().toFixed(4)} m/s -- a NaN field would clamp to 0 on both`
      + ' sides of the comparison below and pass perfectly');

    const data = view.ctx.getImageData(0, 0, nx, ny).data;
    let wet = 0, dry = 0, badWet = 0, badDry = 0, worst = 0;
    let badLive = 0, worstLive = 0;
    let etaMin = Infinity, etaMax = -Infinity, clampedUp = 0, clampedDown = 0;
    let dryBedLo = Infinity, dryBedHi = -Infinity;
    const entriesHit = new Set();
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = s2.idx(i, j), o = 4 * ((ny - 1 - j) * nx + i);
        const got = [data[o], data[o + 1], data[o + 2]];
        const h = s2.h[k], b = s2.b[k];
        if (h <= s2.minDepth) {
          dry++;
          dryBedLo = Math.min(dryBedLo, b); dryBedHi = Math.max(dryBedHi, b);
          const wantC = q8(LAND_REF(b));
          const e = Math.max(Math.abs(got[0] - wantC[0]), Math.abs(got[1] - wantC[1]), Math.abs(got[2] - wantC[2]));
          if (e) badDry++;
          worst = Math.max(worst, e);
        } else {
          wet++;
          const eta = b + h;
          etaMin = Math.min(etaMin, eta); etaMax = Math.max(etaMax, eta);
          if (eta / SCALE >= 1) clampedUp++;
          if (eta / SCALE <= -1) clampedDown++;
          const c = surfaceColour(eta, SCALE);
          entriesHit.add(c.join(','));
          const still = SHADE_REF(Math.max(0, 0 - b));
          const wantC = q8([c[0] * still, c[1] * still, c[2] * still]);
          const e = Math.max(Math.abs(got[0] - wantC[0]), Math.abs(got[1] - wantC[1]), Math.abs(got[2] - wantC[2]));
          if (e) badWet++;
          worst = Math.max(worst, e);
          // The counterfactual, on the same bytes: the shading read from the
          // LIVE depth instead of the still bed.
          const live = SHADE_REF(h);
          const wantL = q8([c[0] * live, c[1] * live, c[2] * live]);
          const eL = Math.max(Math.abs(got[0] - wantL[0]), Math.abs(got[1] - wantL[1]), Math.abs(got[2] - wantL[2]));
          if (eL) badLive++;
          worstLive = Math.max(worstLive, eL);
        }
      }
    }
    console.log(`        frame: ${wet} wet cells, ${dry} dry, eta ${etaMin.toFixed(4)} to`
      + ` ${etaMax.toFixed(4)} m at scale ${SCALE} m`
      + ` (t = ${(etaMin / SCALE).toFixed(3)} to ${(etaMax / SCALE).toFixed(3)}),`
      + ` ${entriesHit.size} distinct LUT entries reached`);

    // Coverage, asserted. Each of these turns a silent hole into a red line.
    assert('the frame has dry cells, so the land branch is exercised', dry > 0, `${dry} dry cells`);
    assert('the frame has wet cells on both sides of msl', etaMin < 0 && etaMax > 0,
      `eta ${etaMin.toFixed(4)} .. ${etaMax.toFixed(4)} m`);
    assert('the frame drives |t| past full scale on both sides',
      clampedUp > 0 && clampedDown > 0,
      `${clampedUp} cells at or above t = +1, ${clampedDown} at or below t = -1;`
      + ' without these the clamp is untested');
    assert('the frame reaches at least 100 distinct LUT entries', entriesHit.size >= 100,
      `${entriesHit.size} of 1025`);

    check('wet cells painted as documented', badWet, 0, 0,
      `${wet} cells, worst byte error ${worst}; prediction uses SHADE_REF declared in this file`);
    check('dry cells painted as documented', badDry, 0, 0,
      `${dry} cells against LAND_REF declared in this file`);

    // AND THE CONTROL. If the live-depth prediction also matched, this whole
    // section would be insensitive to the bug the header says it fixed.
    assert('the same bytes REJECT the live-depth shading', badLive > 0.1 * wet,
      `${badLive} of ${wet} wet cells (${(100 * badLive / wet).toFixed(1)}%) disagree,`
      + ` worst byte error ${worstLive} -- so this check can tell the two shadings apart`);

    // The reason the block below exists, MEASURED here rather than asserted in a
    // comment: this frame's dry cells only ever reach part of the land ramp.
    console.log(`        this frame's ${dry} dry cells span bed ${dryBedLo.toFixed(5)} ..`
      + ` ${dryBedHi.toFixed(5)} m -- landColour clamps bed/6 to [0, 1], so neither end`
      + ' of that clamp is reached here');
  }

  // -------------------------------------------------------------------------
  // THE LAND RAMP OUTSIDE ITS CLAMP.
  //
  // landColour() clamps bed/6 to [0, 1] at BOTH ends and neither clamp was
  // exercised by anything in this file. Measured: the frame above has 640 dry
  // cells spanning bed 0.03125 .. 4 m, and the whole planeBeach bathymetry only
  // runs -12 .. 4 m, so no cell anywhere in that fixture even reaches the TOP of
  // the ramp, let alone past it. Removing either clamp from src/render.mjs left
  // the suite at ALL PASS 104/104.
  //
  // THE LOW END CANNOT COME FROM A PHYSICAL FRAME AT ALL, and that is worth
  // saying rather than quietly engineering around: a cell with bed < 0 sits
  // below mean sea level, so at msl = 0 the water fills it and it is WET by
  // definition. A DRY cell below datum only exists if it is built. So this frame
  // is built -- a bare bed with every cell dry -- and it is labelled synthetic
  // rather than dressed up as a run of the solver.
  //
  // Three things are asserted, and the third is what stops the other two being
  // satisfied by a landColour that returned a constant:
  //   - every cell matches LAND_REF, declared in this file, including outside
  //     the clamp at both ends;
  //   - the clamp BINDS: everything at or below bed = 0 paints one colour and
  //     everything at or above bed = 6 m paints another;
  //   - the ramp MOVES in between, so "identical beyond the clamp" is a
  //     statement about the clamp and not about a flat ramp.
  // and the coverage itself is asserted, so this cannot silently stop covering
  // the thing it was added for.
  {
    // Below datum, the two clamp corners exactly, mid-ramp, and far past the top.
    const BEDS = [-40, -3, 0, 1.5, 3, 6, 9, 60];
    const sim = new ShallowWater({ nx: BEDS.length, ny: 3, dx: 10, bed: () => 1, eta0: 0, manning: 0 });
    for (let j = 0; j < sim.ny; j++) {
      for (let i = 0; i < sim.nx; i++) { sim.b[sim.idx(i, j)] = BEDS[i]; sim.h[sim.idx(i, j)] = 0; }
    }
    const view = viewFor(sim, { scale: 1.0 });
    view.draw(sim, { msl: 0 });

    const j = 1;
    const paint = BEDS.map((_, i) => cellPixel(view, sim, i, j).slice(0, 3));

    // COVERAGE, ASSERTED. If the fixture ever drifts back inside [0, 6] this
    // goes red instead of going quiet.
    const dryBeds = BEDS.filter((_, i) => sim.h[sim.idx(i, j)] <= sim.minDepth);
    assert('every cell of the synthetic land frame is dry', dryBeds.length === BEDS.length,
      `${dryBeds.length} of ${BEDS.length}; a wet cell would take the surfaceColour branch`
      + ' and test nothing about the land ramp');
    assert('the fixture reaches a dry bed BELOW the low clamp', Math.min(...dryBeds) < 0,
      `lowest dry bed ${Math.min(...dryBeds)} m; landColour clamps bed/6 at 0`);
    assert('the fixture reaches a dry bed ABOVE the high clamp', Math.max(...dryBeds) > 6,
      `highest dry bed ${Math.max(...dryBeds)} m; landColour clamps bed/6 at 1, i.e. bed = 6 m`);

    // Every cell, against LAND_REF declared in this file.
    let bad = 0, worstByte = 0;
    for (let i = 0; i < BEDS.length; i++) {
      const wantC = q8(LAND_REF(BEDS[i]));
      const e = Math.max(Math.abs(paint[i][0] - wantC[0]), Math.abs(paint[i][1] - wantC[1]),
        Math.abs(paint[i][2] - wantC[2]));
      if (e) bad++;
      worstByte = Math.max(worstByte, e);
    }
    check('the land ramp is painted as documented across and past its clamp', bad, 0, 0,
      `${BEDS.length} beds ${BEDS[0]} .. ${BEDS[BEDS.length - 1]} m, worst byte error ${worstByte};`
      + ` bed -40 m paints ${rgb(paint[0])}, bed 60 m paints ${rgb(paint[BEDS.length - 1])}`);

    // The clamp BINDS at both ends.
    const iLo = BEDS.indexOf(0), iHi = BEDS.indexOf(6);
    assert('the low clamp binds: every bed at or below 0 m paints one colour',
      paint[0].join() === paint[iLo].join() && paint[1].join() === paint[iLo].join(),
      `bed -40 ${rgb(paint[0])}, bed -3 ${rgb(paint[1])}, bed 0 ${rgb(paint[iLo])};`
      + ' without Math.max(0, .) a bed below datum paints darker and darker until it clips to black');
    assert('the high clamp binds: every bed at or above 6 m paints one colour',
      paint[BEDS.length - 1].join() === paint[iHi].join() && paint[iHi + 1].join() === paint[iHi].join(),
      `bed 6 ${rgb(paint[iHi])}, bed 9 ${rgb(paint[iHi + 1])}, bed 60 ${rgb(paint[BEDS.length - 1])};`
      + ' without Math.min(1, .) a dune paints brighter and brighter until it clips to white');

    // ...AND THE CONTROL. A landColour that ignored its argument entirely would
    // satisfy both clamp assertions above and this is what refuses it.
    const inside = [iLo, BEDS.indexOf(1.5), BEDS.indexOf(3), iHi].map((i) => paint[i].join());
    assert('the ramp still MOVES between the clamps', new Set(inside).size === inside.length,
      `bed 0/1.5/3/6 m paint ${inside.map((s) => `rgb(${s})`).join(', ')} --`
      + ' four distinct colours, so the two clamp checks are about the clamp and not about a flat ramp');
  }
}
}

// ===========================================================================
if (want('shading')) {
console.log('');
console.log('=== 6. the depth shading reads the still bed, not the live depth =====');
console.log('');
// ===========================================================================
//
// The header's second bug, and its fix: shading each cell by its LIVE depth let
// the wave modulate its own contrast, dimming a crest more than the trough
// beside it, worst exactly in the surf zone the picture is for.
//
// THE INVARIANT, asserted EXACTLY on bytes. The ramp clamps at |t| >= 1, so a
// +1.0 m and a +2.0 m surface over the same bed at scale = 1 m get the IDENTICAL
// colour from surfaceColour while their live depths differ by a whole metre.
// Shading on the still bed therefore has to paint them the same bytes; shading
// on the live depth cannot. No tolerance, no L* arithmetic, no quantisation
// argument -- two integers either match or they do not. Confirmed in Chrome 148
// at all three depths.
//
// THE MEASURED RATIOS, which is what the header quotes. The crest/trough L*
// ratio at a common shading multiplier, i.e. how nearly equal excursions come
// out equally bright once the place has darkened them:
//
//   depth   multiplier   still-bed ratio   live-depth ratio   multipliers apart
//    40 m   0.566053     0.993568          0.989979           0.474%
//    12 m   0.715546     0.996694          0.967108           3.933%
//     2 m   0.930917     0.999388          0.946571           7.059%
//
// which is the header's "0.9936 (40 m) to 0.9994 (2 m)" and its "0.990 down to
// 0.947" for the bug, and its "0.5% apart in 40 m and 7.1% apart in 2 m". The
// residual below 1 is the sRGB toe -- scaling gamma-encoded bytes is not exactly
// a lightness scaling near black -- not the shading.
//
// These three ratios are computed at multiplier level, on unquantised colours,
// because that is how the header measured them and because BYTE ROUNDING IS THE
// LARGER EFFECT AT THIS SIZE: the same ratio taken from the painted bytes reads
// 1.0060 at 40 m and 0.9879 at 2 m, straddling 1, because one byte on a channel
// worth 74 units is a bigger wobble than the 0.6% being measured. The pixel-level
// claim in this section is the exact byte equality above; the ratios are a
// multiplier-level measurement and are labelled as such on their lines.
{
  for (const depth of [40, 12, 2]) {
    const sim = new ShallowWater({ nx: 8, ny: 4, dx: 10, bed: () => -depth, eta0: 0, manning: 0 });
    const j = 1;
    // Saturation pair: same colour, live depths a metre apart.
    sim.h[sim.idx(1, j)] = depth + 1.0;
    sim.h[sim.idx(2, j)] = depth + 2.0;
    // Crest / mean / trough over the same bed.
    sim.h[sim.idx(4, j)] = depth + 1.0;
    sim.h[sim.idx(5, j)] = depth;
    sim.h[sim.idx(6, j)] = depth - 1.0;
    const view = viewFor(sim, { scale: 1.0 });
    view.draw(sim, { msl: 0 });

    const sat1 = cellPixel(view, sim, 1, j).slice(0, 3);
    const sat2 = cellPixel(view, sim, 2, j).slice(0, 3);
    const crest = cellPixel(view, sim, 4, j).slice(0, 3);
    const mean = cellPixel(view, sim, 5, j).slice(0, 3);
    const trough = cellPixel(view, sim, 6, j).slice(0, 3);

    const shade = SHADE_REF(depth);
    // The two cells the equality is asserted on must genuinely differ in live
    // depth and genuinely agree in colour, or the assertion is vacuous.
    assert(`${String(depth).padStart(2)} m: the saturation pair is a real test`,
      surfaceColour(1.0, 1).join() === surfaceColour(2.0, 1).join()
      && sim.h[sim.idx(1, j)] !== sim.h[sim.idx(2, j)],
      `both clamp to t = 1 so the colour is common, live depths ${sim.h[sim.idx(1, j)]} vs`
      + ` ${sim.h[sim.idx(2, j)]} m differ by 1 m`);
    assert(`${String(depth).padStart(2)} m: identical multiplier, byte for byte`,
      sat1.join() === sat2.join(),
      `${rgb(sat1)} vs ${rgb(sat2)}; live-depth shading would use`
      + ` ${SHADE_REF(depth + 1).toFixed(6)} and ${SHADE_REF(depth + 2).toFixed(6)},`
      + ` ${(100 * (SHADE_REF(depth + 1) / SHADE_REF(depth + 2) - 1)).toFixed(2)}% apart`);

    // And that the multiplier is the documented one, from the painted bytes.
    const predict = (v) => q8(surfaceColour(v, 1).map((x) => x * shade));
    assert(`${String(depth).padStart(2)} m: bytes match shade = 0.55 + 0.45 exp(-still/12)`,
      crest.join() === predict(1).join() && mean.join() === predict(0).join()
      && trough.join() === predict(-1).join(),
      `crest ${rgb(crest)}, mean ${rgb(mean)}, trough ${rgb(trough)} at multiplier ${shade.toFixed(6)}`);

    // The multiplier-level ratio the header quotes.
    const mul = (c, k) => c.map((x) => x * k);
    const up = Lstar(mul(surfaceColour(1, 1), shade)) - Lstar(mul(surfaceColour(0, 1), shade));
    const down = Lstar(mul(surfaceColour(0, 1), shade)) - Lstar(mul(surfaceColour(-1, 1), shade));
    const liveUp = Lstar(mul(surfaceColour(1, 1), SHADE_REF(depth + 1))) - Lstar(mul(surfaceColour(0, 1), shade));
    const liveDown = Lstar(mul(surfaceColour(0, 1), shade)) - Lstar(mul(surfaceColour(-1, 1), SHADE_REF(depth - 1)));
    const target = { 40: 0.9936, 12: 0.9967, 2: 0.9994 }[depth];
    check(`${String(depth).padStart(2)} m: crest/trough L* ratio [multiplier level]`, up / down, target, 2e-4,
      `${(up / down).toFixed(6)}; live-depth shading gives ${(liveUp / liveDown).toFixed(6)},`
      + ` byte-level reads ${((Lstar(crest) - Lstar(mean)) / (Lstar(mean) - Lstar(trough))).toFixed(4)}`);
    assert(`${String(depth).padStart(2)} m: the still-bed ratio beats the live-depth ratio`,
      Math.abs(up / down - 1) < Math.abs(liveUp / liveDown - 1),
      `${Math.abs(up / down - 1).toExponential(3)} vs ${Math.abs(liveUp / liveDown - 1).toExponential(3)}`
      + ' from 1 -- if this inverts, the fix has been undone');
  }

  // The disease got WORSE as the water shallowed, which is the sentence in the
  // header that makes the bug matter. Two numbers agreeing is not that claim;
  // the ordering across depths is.
  const dev = (d) => {
    const mul = (c, k) => c.map((x) => x * k);
    const u = Lstar(mul(surfaceColour(1, 1), SHADE_REF(d + 1))) - Lstar(mul(surfaceColour(0, 1), SHADE_REF(d)));
    const w = Lstar(mul(surfaceColour(0, 1), SHADE_REF(d))) - Lstar(mul(surfaceColour(-1, 1), SHADE_REF(d - 1)));
    return Math.abs(u / w - 1);
  };
  const still = (d) => {
    const mul = (c, k) => c.map((x) => x * k), s = SHADE_REF(d);
    const u = Lstar(mul(surfaceColour(1, 1), s)) - Lstar(mul(surfaceColour(0, 1), s));
    const w = Lstar(mul(surfaceColour(0, 1), s)) - Lstar(mul(surfaceColour(-1, 1), s));
    return Math.abs(u / w - 1);
  };
  assert('the live-depth error GROWS into shallow water', dev(2) > dev(12) && dev(12) > dev(40),
    `${(100 * dev(40)).toFixed(2)}% at 40 m -> ${(100 * dev(12)).toFixed(2)}% at 12 m ->`
    + ` ${(100 * dev(2)).toFixed(2)}% at 2 m: worst exactly in the surf zone the picture is for`);
  assert('the still-bed error SHRINKS into shallow water', still(2) < still(12) && still(12) < still(40),
    `${(100 * still(40)).toFixed(2)}% -> ${(100 * still(12)).toFixed(2)}% ->`
    + ` ${(100 * still(2)).toFixed(2)}%: the opposite sense, because what is left is the sRGB toe`);
}
}

// ===========================================================================
if (want('section')) {
console.log('');
console.log('=== 7. the section panel, checked at the level of its calls ==========');
console.log('');
// ===========================================================================
//
// The stand-in does not rasterise paths, so this section checks the CALLS: the
// exaggeration arithmetic, the label that has to carry the horizontal span, the
// dashed msl line and its reset, and -- the one real correctness check available
// here -- that no vertex of the water polyline sits over a dry cell.
//
// What is NOT covered: the pixels. Nothing here would catch a fill colour that
// is legal but wrong-looking, a z-order mistake, or a line drawn off-canvas.
// Stated so the coverage is not overclaimed.
{
  const { sim, nx, ny, dx } = planeBeachFixture();
  const W = 700, H = 400;
  const cv = newCanvas(W, H);
  const view = new WaterView(cv);
  view.scale = 1.0; view.showSection = true; view.sectionRow = ny >> 1;
  view.draw(sim, { msl: 0 });

  // The exaggeration target, computed here from the bed and the documented
  // layout arithmetic -- not read back from view.exaggeration and compared with
  // itself.
  const j = ny >> 1;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < nx; i++) { const b = sim.b[sim.idx(i, j)]; if (b < lo) lo = b; if (b > hi) hi = b; }
  hi = Math.max(hi, view.scale * 2.5);
  const pad = 0.06 * (hi - lo);
  const spanZ = (hi + pad) - (lo - pad);
  const sectionH = Math.round(H * 0.30), mapH = H - sectionH;
  const exWant = ((nx * dx) / W) / (spanZ / sectionH);
  check('vertical exaggeration', view.exaggeration, exWant, 1e-12,
    `bed ${lo} to ${hi} m, span ${spanZ.toFixed(4)} m into ${sectionH} px,`
    + ` ${(nx * dx).toFixed(0)} m into ${W} px`);
  check('vertical exaggeration, as a number a reader sees', view.exaggeration, 19.132653, 1e-6,
    'planeBeach at 700x400: a wave in this panel looks 19x steeper than it is');

  // The label must carry the HORIZONTAL span. It used to print only the vertical
  // one, which is the half a reader cannot judge a slope from.
  const label = view.ctx.ops.find((o) => o[0] === 'fillText');
  assert('the section is labelled at all', !!label, label ? JSON.stringify(label[1]) : 'no fillText call');
  const text = label ? String(label[1]) : '';
  assert('the label carries the horizontal span', text.includes(`${(nx * dx).toFixed(0)} m across`),
    JSON.stringify(text));
  assert('the label carries the vertical span', text.includes(`${spanZ.toFixed(1)} m vertical`));
  assert('the label carries the exaggeration', text.includes('vertical exaggeration 19x'));
  assert('the label sits inside the section band', label && label[3] > mapH && label[3] < H,
    `y = ${label ? label[3] : 'n/a'}, band ${mapH}..${H}`);

  // The dash must be reset. A setLineDash that is never cleared leaks into every
  // stroke drawn after it, including the next frame's water line.
  const dashes = view.ctx.ops.filter((o) => o[0] === 'setLineDash').map((o) => o[1]);
  assert('the msl line is dashed', dashes.includes('4,5'), `setLineDash calls: [${dashes.join('] [')}]`);
  assert('the dash is reset afterwards', dashes[dashes.length - 1] === '',
    `last setLineDash was "${dashes[dashes.length - 1]}"`);

  // The stale-readout fix: exaggeration describes THIS frame or nothing.
  view.showSection = false;
  view.draw(sim, { msl: 0 });
  assert('exaggeration is cleared when no section is drawn', view.exaggeration === null,
    `${view.exaggeration} -- a leftover value would be printed by the UI as if it described this frame`);
  // And the same when the band exists but is too thin to draw into.
  const tiny = newCanvas(200, 20);
  const tinyView = new WaterView(tiny);
  tinyView.scale = 1.0; tinyView.showSection = true;
  tinyView.draw(sim, { msl: 0 });
  assert('exaggeration is cleared when the band is under 8 px', tinyView.exaggeration === null,
    `sectionH = ${Math.round(20 * 0.30)} px, exaggeration ${tinyView.exaggeration}`);

  // ---------------------------------------------------------------------
  // The water polyline must not cross land. A bed that pierces the surface in
  // mid-domain splits the row into two wet runs; the polyline has to break, and
  // every vertex has to sit over a wet cell. An off-by-one in the run logic, or
  // a `started` flag left set, puts the water line straight across an island.
  // ---------------------------------------------------------------------
  const island = new ShallowWater({
    nx: 40, ny: 3, dx: 25,
    bed: (x) => (x > 440 && x < 560 ? 1.0 : -8), eta0: 0, manning: 0,
  });
  const iv = newCanvas(400, 300);
  const iview = new WaterView(iv);
  iview.scale = 1.0; iview.showSection = true; iview.sectionRow = 1;
  iview.draw(island, { msl: 0 });

  // Segment the op log on beginPath: bed path, water path, msl line.
  const segs = [];
  for (const op of iview.ctx.ops) {
    if (op[0] === 'beginPath') segs.push([]);
    else if (segs.length) segs[segs.length - 1].push(op);
  }
  assert('the section draws three paths (bed, water, msl)', segs.length === 3,
    `${segs.length} beginPath calls`);
  const water = segs[1] || [];
  const verts = water.filter((o) => o[0] === 'moveTo' || o[0] === 'lineTo');
  const runs = water.filter((o) => o[0] === 'moveTo').length;
  let wetRow = 0, dryRow = 0;
  for (let i = 0; i < island.nx; i++) {
    if (island.h[island.idx(i, 1)] > island.minDepth) wetRow++; else dryRow++;
  }
  assert('the island row really has a dry gap in it', dryRow > 0 && wetRow > 0,
    `${wetRow} wet cells, ${dryRow} dry`);
  check('the water polyline has one vertex per wet cell', verts.length, wetRow, 0);
  check('the water polyline breaks into two runs', runs, 2, 0,
    'a stale `started` flag would draw one run straight across the island');
  // X(i) = w (i + 0.5) / nx, inverted.
  let onLand = 0;
  for (const v of verts) {
    const i = Math.round((v[1] * island.nx) / 400 - 0.5);
    if (!(i >= 0 && i < island.nx) || island.h[island.idx(i, 1)] <= island.minDepth) onLand++;
  }
  check('no water vertex sits over a dry cell', onLand, 0, 0,
    `${verts.length} vertices checked by inverting X(i) = w (i + 0.5) / nx`);

  // The bed path is a closed filled polygon spanning the row plus its two
  // baseline corners; a missing corner leaves the fill open and the bed bleeds.
  const bedSeg = segs[0] || [];
  check('the bed polygon has nx + 2 boundary points', bedSeg.filter((o) => o[0] === 'moveTo' || o[0] === 'lineTo').length,
    island.nx + 2, 0, 'nx bed samples plus the two baseline corners');
  assert('the bed polygon is closed and filled',
    bedSeg.some((o) => o[0] === 'closePath') && bedSeg.some((o) => o[0] === 'fill'),
    `ops: ${[...new Set(bedSeg.map((o) => o[0]))].join(', ')}`);
}
}

// ===========================================================================
// Summary. Zero checks is a FAILURE, and so is a run with no filter that did
// not reach every declared section -- that catches a block stranded behind a
// condition that is never true, which neither the argument check nor want()
// can see.
// ===========================================================================
console.log('');
if (checks === 0) {
  failures++;
  console.log('  FAIL  zero checks ran');
}
if (!only) {
  const missed = SECTIONS.filter((s) => !ran.has(s));
  if (missed.length) {
    failures++;
    console.log(`  FAIL  sections declared but not run: ${missed.join(', ')}`);
  }
}
console.log(`${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} -- ${checks - failures}/${checks} checks`);
console.log('');

// ===========================================================================
// TERMINATION, AND WHY THIS FILE NO LONGER CALLS process.exit() HERE
// ===========================================================================
//
// This line used to read `process.exit(failures ? 1 : 0)` and roughly one run
// in twelve NEVER EXITED. Measured on node v24.15.0, Windows 11 build 26200:
// 11 of 140 runs of the file as it shipped (7.9%) were still alive when killed,
// every one of them with all 137 lines of its output and its summary line
// already written. tools/mutants.mjs had already been forced to work around it
// -- see the TIMEOUT paragraph in that file, which records a spurious CAUGHT
// caused by exactly this -- so a suite that could not be relied on to terminate
// was already corrupting the harness that depends on it.
//
// WHAT IT IS NOT. Each of these was eliminated by measurement, not by argument:
//
//   stdout backpressure, the classic explanation, in which process.exit()
//     abandons a pending asynchronous write. It is not this. A variant with
//     console.log replaced by a no-op -- identical work, ZERO bytes written --
//     hung 7 of 60 runs, a higher rate than the talkative original; and the
//     original hangs redirected to /dev/null as readily as to a file.
//   a lingering handle or request. It is not this. process._getActiveHandles()
//     and process._getActiveRequests() are both EMPTY at the moment exit is
//     called, and an explicit process.exit() would not have cared anyway.
//   a long synchronous loop after the last print. It is not this. A hung process
//     sampled five times across six seconds held TotalProcessorTime frozen at
//     1.234375 s with all eight of its threads in a Wait state. Nothing was
//     running; the process was blocked, not busy.
//
// WHAT IT IS. process.exit() does not let the loop drain -- it tears the runtime
// down from inside JS, and that teardown has to join V8's background threads.
// It deadlocks against an optimizing-compile job that is still in flight. Which
// thread was narrowed by flag rather than by reading node's source, and the
// three readings are what the claim rests on:
//
//   process.exit(), as shipped                        11 of 140 hung
//   process.exitCode instead, i.e. this file now        0 of  60
//   process.exit() kept, --no-concurrent-recompilation  0 of  60
//   process.exit() kept, --single-threaded-gc           4 of  60   <- still hangs
//
// so it is the concurrent optimizing compiler and not the concurrent collector.
// It is a race, which is why a section filter -- a tenth of the work, a tenth of
// the compile jobs -- never reproduced it in 8 runs, and why the same trick
// hides the bug rather than fixing it.
//
// THE FIX IS TO STOP FORCING THE TEARDOWN. Setting process.exitCode and letting
// the loop drain is what node's own documentation asks for, and it costs
// nothing measurable: the mean run went 1117 ms -> 1122 ms over 60 runs each.
// The exit CODE contract is unchanged -- 0 green, 1 red, and the exit(2) on an
// unknown section name is left exactly as it was, since it fires about 7 ms into
// the process with no compiled code behind it and exited promptly in 30 of 30
// runs.
process.exitCode = failures ? 1 : 0;

// THE WATCHDOG. Draining the loop instead of forcing the exit means that if
// anything ever DOES hold the loop open, this suite would hang again for a new
// reason -- and a suite that cannot be relied on to terminate cannot gate
// anything, which is the whole point of the paragraph above. So the failure is
// made loud instead of silent.
//
// An unref'd timer cannot keep the process alive by itself, so on a healthy run
// this never fires and never delays anything: the process leaves as soon as the
// summary is printed. It fires only in the world where something else is already
// holding the loop, and in that world it says so and leaves with a distinct
// code. Forcing the exit is safe HERE for the same reason it is unsafe above:
// ten seconds after the last check, nothing is still being compiled.
const watchdog = setTimeout(() => {
  console.error('');
  console.error('  ERROR: the event loop was still alive 10 s after the summary was printed.');
  console.error('  Something in src/ or in this file has opened a handle it does not close;'
    + ' the checks above still stand, but the suite is no longer able to gate anything.');
  console.error('');
  process.exit(3);
}, 10000);
watchdog.unref();
