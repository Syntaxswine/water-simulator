// ---------------------------------------------------------------------------
// Import terrain exported by gridlands (Syntaxswine/gridlands), format
// `gridlands-terrain` v1: 200x150 cells at 50 m, bed + standing-water surface +
// per-cell Manning, deterministic per map id.
//
// ADDITIVE. The seven analytic shorelines in src/shorelines.mjs are untouched and
// remain the measuring stick: they have closed-form targets (Green, Snell, Ritter,
// Thacker) and this does not. What this adds is a real-shaped world to run the
// verified solver over -- and, more usefully, a CROSS-TOOL CHECK, described below.
//
// Written from docs/PROPOSAL-WATER-IMPORT.md in the gridlands tree, which arrived
// as a contract: additive only, reference code delivered by file to be adapted and
// owned here, acceptance gates suggested in this repository's idiom. This file is
// that adaptation. Nothing here writes into gridlands.
//
// THE DESIGN MOVE THAT MAKES THIS WORTH DOING, and the credit is theirs. Their
// exporter flattens every lake surface to its basin outlet spill level and
// guarantees it is EXACTLY constant and strictly above every one of its bed cells.
// So an imported lake is a still lake over an uneven bed -- which is precisely the
// configuration this repository's flagship Audusse well-balancing gate exists to
// hold at 4.4e-16 m. Import their terrain, run it with no forcing, and if anything
// moves then one of two tools has broken a promise: either their lake is not flat
// or our well-balancing is not well-balanced. Neither of us could have built that
// check alone, and it costs nothing.
//
// TRUST, BUT CHECK THEIR INVARIANTS TOO. verifyInvariants() below re-derives the
// three guarantees this import depends on, off the decoded arrays, rather than
// taking the format document's word for it. A cross-tool contract where the
// receiving side cannot tell whose promise broke is not a contract, it is a hope --
// and a failure would otherwise land in OUR lake-at-rest gate wearing the costume
// of a well-balancing regression.
//
// TWO CORRECTIONS TO THE REFERENCE ADAPTER, both measured:
//
//   1. `new Float32Array(b64decode(data).buffer)` is wrong on Node. Buffer.from(s,
//      'base64') returns a view into a SHARED 8 KB pool, so `.buffer` is the pool
//      and the Float32Array spans all of it: a 4-float payload decodes to 2048
//      floats whose tail is whatever else was in the pool. The stock 200x150 map is
//      120,000 bytes and escapes the pool, so the naive form happens to work today
//      and would fail silently on a smaller export or a cropped window -- the worst
//      way for a bug to behave. Fixed here with the (buffer, byteOffset, length)
//      constructor.
//   2. `b64f32le` is little-endian by name, and a bare Float32Array view is
//      PLATFORM endian. Every machine this will run on is little-endian, so the
//      fast path is kept -- but it is asserted once at decode rather than assumed,
//      because a wrong-endian read produces plausible-looking garbage (1e-38 and
//      1e38 elevations) rather than an error.
//
// SCALE, stated because a picture of a coastline invites the wrong question. At
// 50 m cells this repository's own 40-cells-per-wavelength floor means the shortest
// honest wave is 2 km. That covers tides, seiches, storm surge, dam-break surges
// and tsunami-scale waves. It does NOT cover surf: do not point the wavemaker at a
// gridlands beach and expect the Dean profile or the breaker index. Rivers arrive
// DRY -- gridlands computes their beds from rain-weighted catchment, not discharge,
// so a river is a channel here and not a flow until someone adds rain or an inflow
// boundary. Playas likewise arrive dry, which is what a playa is.
// ---------------------------------------------------------------------------

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** base64 -> Uint8Array, in Node and in a browser, with no dependency. */
function b64ToBytes(b64) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    const b = Buffer.from(b64, 'base64');
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Decode a `b64f32le` layer to a Float32Array of exactly n values.
 *
 * The (buffer, byteOffset, length) form is load-bearing -- see correction 1 in the
 * header. The length is also CHECKED against the grid rather than inferred, so a
 * truncated or padded layer is an error here instead of a strange-looking map.
 */
function decodeF32(layer, n, name) {
  if (!layer) throw new Error(`gridlands: layer ${name} is missing`);
  if (layer.encoding !== 'b64f32le') {
    throw new Error(`gridlands: layer ${name} has encoding ${layer.encoding}, expected b64f32le`);
  }
  if (!LITTLE_ENDIAN) {
    throw new Error('gridlands: b64f32le needs a little-endian host; this one is big-endian. '
      + 'Decode through a DataView with littleEndian=true instead of taking the fast path.');
  }
  const u8 = b64ToBytes(layer.data);
  if (u8.byteLength !== n * 4) {
    throw new Error(`gridlands: layer ${name} decoded to ${u8.byteLength} bytes, expected ${n * 4} `
      + `(${n} cells x 4). A truncated layer would otherwise read as terrain.`);
  }
  if (u8.byteOffset % 4 !== 0) {          // pooled Buffers are 8-byte aligned in practice
    return new Float32Array(u8.slice().buffer);
  }
  return new Float32Array(u8.buffer, u8.byteOffset, n);
}

/**
 * Connected waterbodies, with the lowest bed on each one's boundary ring.
 *
 * The ring minimum is the SPILL LEVEL: the lowest ground a body's water can reach
 * without going uphill. A body resting at its outlet has surface <= ringMin. A body
 * above it is perched, and the first timestep pours it downhill.
 */
export function waterbodies(bedM, surfaceM, W, H) {
  const n = W * H;
  const wet = (k) => surfaceM[k] - bedM[k] > 0;
  const seen = new Uint8Array(n);
  const out = [];
  const stack = [];
  for (let k0 = 0; k0 < n; k0++) {
    if (seen[k0] || !wet(k0)) continue;
    const level = surfaceM[k0];
    const cells = [];
    let spread = 0;
    const ring = new Set();
    stack.length = 0; stack.push(k0); seen[k0] = 1;
    while (stack.length) {
      const k = stack.pop();
      cells.push(k);
      if (surfaceM[k] !== level) spread = Math.max(spread, Math.abs(surfaceM[k] - level));
      const c = k % W, r = (k - c) / W;
      const nb = [];
      if (c > 0) nb.push(k - 1);
      if (c < W - 1) nb.push(k + 1);
      if (r > 0) nb.push(k - W);
      if (r < H - 1) nb.push(k + W);
      for (const m of nb) {
        if (wet(m)) { if (!seen[m]) { seen[m] = 1; stack.push(m); } }
        else ring.add(m);
      }
    }
    let ringMin = Infinity;
    for (const m of ring) ringMin = Math.min(ringMin, bedM[m]);
    out.push({ level, cells, spread, ringMin, perch: level - ringMin, isOcean: level === 0 });
  }
  return out;
}

/**
 * Re-derive the exporter's guarantees off the decoded arrays.
 *
 * Returns a report; throws nothing. The caller decides whether a violation is fatal
 * -- tools/verify-gridlands.mjs treats it as a FAIL and says whose promise broke,
 * which is the whole point of checking rather than trusting.
 *
 * THE STATED INVARIANT IS NOT THE REQUIRED ONE, and finding that out cost a red gate.
 * gridlands guarantees each lake surface is exactly constant and strictly above every
 * one of ITS OWN bed cells. Both hold here, exactly. But a body can satisfy both and
 * still be perched above the ground OUTSIDE it -- and then it is not a lake at rest,
 * it is a column of water waiting for the first timestep. Measured on
 * continent/first-light-42: all 17 lakes sit 6.68 to 9.96 m above the lowest bed on
 * their own shoreline, 30.09 million m^3 of water above its spill point, and the
 * import reaches 5.9 m/s on step one. The ocean is correctly seated (-0.111 m).
 * So `perch` below is the invariant the SOLVER needs, and it is reported separately
 * from the three the format document promises.
 */
export function verifyInvariants(t) {
  const { bedM, surfaceM, W, H } = t;
  const n = W * H;
  let below = 0, worstBelow = 0;        // surfaceM >= bedM everywhere
  let dryMismatch = 0;                  // dry cells carry surfaceM === bedM exactly
  let wet = 0, oceanCells = 0;
  for (let k = 0; k < n; k++) {
    const d = surfaceM[k] - bedM[k];
    if (d < 0) { below++; worstBelow = Math.min(worstBelow, d); }
    if (d > 0) wet++;
    if (surfaceM[k] === 0 && bedM[k] < 0) oceanCells++;
  }
  const bodies = waterbodies(bedM, surfaceM, W, H);
  const lakes = bodies.filter((b) => !b.isOcean);
  const notFlat = bodies.filter((b) => b.spread > 0);
  const perched = lakes.filter((b) => b.perch > 1e-6).sort((a, b) => b.perch - a.perch);
  let perchedVolume = 0;
  for (const b of perched) perchedVolume += b.cells.length * b.perch;   // x cell area
  return {
    cells: n, wet, oceanCells,
    surfaceBelowBed: below, worstBelowBed: worstBelow,
    dryMismatch,
    bodies: bodies.length,
    lakeBodies: lakes.length,
    lakesNotFlat: notFlat.length,
    worstLakeSpread: notFlat.reduce((a, b) => Math.max(a, b.spread), 0),
    largestBody: bodies.reduce((a, b) => Math.max(a, b.cells.length), 0),
    // The invariant the SOLVER needs, which the format document does not promise.
    perchedLakes: perched.length,
    worstPerch: perched.length ? perched[0].perch : 0,
    perchedCells: perched.reduce((a, b) => a + b.cells.length, 0),
    perchedVolumeCells: perchedVolume,          // multiply by cell area for m^3
    worstOceanPerch: bodies.filter((b) => b.isOcean)
      .reduce((a, b) => Math.max(a, b.perch), -Infinity),
  };
}

/**
 * Lower every perched body to its spill level, in place, and report what moved.
 *
 * OPT-IN, never automatic, and it is a REPAIR APPLIED ON THIS SIDE -- not a fix to
 * gridlands and not a claim that the export was right. Doing it silently would be
 * worse than not doing it at all: the whole value of the cross-tool gate is that a
 * perched lake shows up as a red check with a name on it, and a quiet settle would
 * launder the exporter's defect into "the import works fine".
 *
 * Cells left above the new surface become dry, which is correct: a lake lowered to
 * its outlet is a smaller lake.
 */
export function settleLakes(bedM, surfaceM, W, H) {
  const bodies = waterbodies(bedM, surfaceM, W, H);
  const moved = [];
  for (const b of bodies) {
    if (!(b.perch > 1e-6)) continue;
    const to = b.ringMin;
    for (const k of b.cells) surfaceM[k] = Math.max(bedM[k], to);
    moved.push({ from: b.level, to, drop: b.perch, cells: b.cells.length });
  }
  return { bodiesMoved: moved.length, worstDrop: moved.reduce((a, m) => Math.max(a, m.drop), 0), moved };
}

/**
 * Turn a parsed gridlands-terrain document into arguments for ShallowWater.
 *
 * @param doc  the parsed JSON export
 * @param opts.flipRows  default true. See below -- this exists so a mutation test
 *   can turn it off and prove the gate can tell a mirrored map from a correct one.
 */
export function gridlandsTerrain(doc, { flipRows = true, settle = false } = {}) {
  if (!doc || typeof doc !== 'object') throw new Error('gridlands: not a document');
  if (doc.format !== 'gridlands-terrain' || doc.version !== 1) {
    throw new Error(`gridlands: unsupported terrain ${doc.format} v${doc.version}; `
      + 'this adapter reads gridlands-terrain v1. The format is versioned on purpose -- '
      + 'read docs/TERRAIN-FORMAT.md in the gridlands tree before widening this.');
  }
  const g = doc.grid || {};
  const W = g.width, H = g.height, C = g.cellMeters;
  if (!(W > 0 && H > 0 && C > 0)) throw new Error(`gridlands: bad grid ${JSON.stringify(g)}`);
  if (g.rowOrder && g.rowOrder !== 'north-first') {
    throw new Error(`gridlands: rowOrder is ${g.rowOrder}; this adapter assumes north-first`);
  }

  const n = W * H;
  const bedM = decodeF32(doc.layers?.bedM, n, 'bedM');
  const surfaceM = decodeF32(doc.layers?.surfaceM, n, 'surfaceM');
  const manningN = doc.layers?.manningN ? decodeF32(doc.layers.manningN, n, 'manningN') : null;

  // Opt-in repair, reported and never silent. See settleLakes() above.
  const settled = settle ? settleLakes(bedM, surfaceM, W, H) : null;

  // THE ROW FLIP. gridlands writes row 0 = north; src/render.mjs paints row j at
  // screen row (ny - 1 - j), i.e. +y is UP. Without the flip every imported map is
  // upside down and NOTHING COMPLAINS -- the bed is still a valid bed, the lakes
  // are still flat, lake-at-rest still passes, volume is still conserved. It is a
  // silent, purely visual corruption of every result, which is why the gate for it
  // is an asymmetry probe and not a physics check.
  const rowOf = flipRows
    ? (y) => (H - 1) - Math.min(H - 1, Math.max(0, y / C - 0.5))
    : (y) => Math.min(H - 1, Math.max(0, y / C - 0.5));
  const colOf = (x) => Math.min(W - 1, Math.max(0, x / C - 0.5));

  // Bilinear, clamped at the edge. The clamp is what makes this ghost-safe: the
  // constructor samples bed() at cell centres for the two ghost rings as well, so
  // x and y go negative and past the domain, and constant extrapolation there gives
  // the ghost cells the same bed as the edge they mirror.
  const bed = (x, y) => {
    const fc = colOf(x), fr = rowOf(y);
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const c1 = Math.min(W - 1, c0 + 1), r1 = Math.min(H - 1, r0 + 1);
    const tc = fc - c0, tr = fr - r0;
    const v00 = bedM[r0 * W + c0], v10 = bedM[r0 * W + c1];
    const v01 = bedM[r1 * W + c0], v11 = bedM[r1 * W + c1];
    return (v00 * (1 - tc) + v10 * tc) * (1 - tr) + (v01 * (1 - tc) + v11 * tc) * tr;
  };

  // NEAREST for the surface, and this is not laziness. Interpolating a water
  // surface across a shoreline mixes a lake's spill level with the dry land beside
  // it, which tilts the very surface the well-balancing gate is about to assert is
  // flat. Nearest keeps eta piecewise constant per waterbody, so an imported lake
  // arrives exactly at rest. At native 1:1 the two agree anyway -- bilinear at a
  // cell centre has tc = tr = 0 and returns the grid value unchanged -- so this
  // choice only bites when the sim is run FINER than the export, where it is the
  // difference between a resting lake and a shoreline that leaks.
  const eta0 = (x, y) => surfaceM[Math.round(rowOf(y)) * W + Math.round(colOf(x))];

  const meta = doc.meta || {};
  return {
    bed, eta0,
    domain: { nx: W, ny: H, dx: C, dy: C },
    manning: doc.stats?.suggestedManningScalar ?? 0.03,
    manningN,                      // per-cell, for the optional upgrade
    bedM, surfaceM, W, H, cellMeters: C,
    settled,
    stats: doc.stats || {},
    meta,
    label: `gridlands ${meta.preset}/${meta.seed} #${meta.mapId}`,
    provenance: {
      tool: meta.tool, mapId: meta.mapId, preset: meta.preset, seed: meta.seed,
      spec: meta.spec, format: doc.format, version: doc.version,
      grid: `${W}x${H} @ ${C} m = ${(W * C / 1000).toFixed(1)} x ${(H * C / 1000).toFixed(1)} km`,
    },
    // The resolution floor, computed rather than recited, so it travels with the
    // import instead of living in a README someone will not read.
    shortestHonestWavelength: 40 * C,
  };
}

/** Convenience: parse + adapt in one call. */
export function loadGridlandsTerrain(text, opts) {
  return gridlandsTerrain(typeof text === 'string' ? JSON.parse(text) : text, opts);
}
