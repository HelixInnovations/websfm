// Comparing two surveys' surfaces: a DEM of Difference (DoD), cut and fill, and which
// change is larger than the surveys' own error. Pure, no Vue/Pinia/OPFS/DOM.
//
// Surfaces are DEM grids as dem.js builds them: { width, height, gsd, originX, originY,
// data: Float32Array (row 0 = north; NaN = no data), mask?: Uint8Array (1 = valid),
// crs, verticalDatum }, originX/originY the top-left CORNER of cell (0, 0).
//
// Rules this module keeps, because a volume report is only as honest as these:
//   1. Never compare surfaces whose horizontal CRS or vertical datum differ or are
//      unknown (surfaceCompatibility); demOfDifference refuses them. A transformation
//      belongs before this module, validated, never inside it.
//   2. A cell that either survey did not measure is "not compared", never "no change":
//      it counts in `areaNoData` and lowers `coverage`, and contributes no volume.
//   3. Sign: Δz = after − before. Fill (Δz > 0) is material added, cut (Δz < 0) material
//      removed; both are reported as positive volumes, net = fill − cut.
//   4. Change smaller than the level of detection, LoD = t·√(σ_before² + σ_after²)
//      (Brasington et al. 2003; Wheaton et al. 2010; t = 1.96 for 95 %), is within the
//      surveys' error. `detected` volumes leave it out; `raw` volumes keep every cell, so
//      a report can show both and say which it uses.
//   5. Volume uncertainty is given as two bounds of the DoD's height error σ_DoD over n
//      cells of area A (Lane et al. 2003): random, σ_DoD·A·√n, if cell errors were
//      independent; systematic, σ_DoD·A·n, if they all moved together (a datum or
//      georeference shift). The truth lies between; a report quotes the systematic one
//      unless it has evidence of independence.
//
// Volumes are in horizontal² × vertical units of the grids. In a projected CRS, grid
// distances are ground distances times the scale factor k (measure.js groundVolume):
// pass `k` and areas and volumes are divided by k².
//
// References (not yet in src/core/help/references.js: this module has no place in the
// app's UI yet; the platform calls it from Node. Add them there with the first dialog):
//   Brasington, Langham & Rumsby (2003), Methodological sensitivity of morphometric
//     estimates of coarse fluvial sediment transport. Geomorphology 53, 299–316.
//   Lane, Westaway & Hicks (2003), Estimation of erosion and deposition volumes in a
//     large, gravel-bed, braided river using synoptic remote sensing. ESPL 28, 249–271.
//   Wheaton, Brasington, Darby & Sear (2010), Accounting for uncertainty in DEMs from
//     repeat topographic surveys: improved sediment budgets. ESPL 35, 136–156.

import { polygonSpans } from './polygonSpans.js'
import { summarizeDifferences } from '../eval/demCompare.js'

/** The 95 % two-sided normal quantile, the usual LoD multiplier. */
export const LOD_T95 = 1.96

const valid = (g, i) => (g.mask ? g.mask[i] === 1 : true) && Number.isFinite(g.data[i])

/**
 * Whether two surfaces can be differenced as they are.
 * → { ok, problems: [{ code, message }] }
 *   codes: 'crs-unknown' | 'crs-differ' | 'datum-unknown' | 'datum-differ' | 'no-overlap'
 */
export function surfaceCompatibility(before, after) {
  const problems = []
  if (!before.crs || !after.crs)
    problems.push({ code: 'crs-unknown', message: 'A surface has no coordinate reference system.' })
  else if (before.crs !== after.crs)
    problems.push({
      code: 'crs-differ',
      message: `The surfaces are in different coordinate systems (${before.crs}, ${after.crs}).`,
    })
  const da = before.verticalDatum ?? 'unknown',
    db = after.verticalDatum ?? 'unknown'
  if (da === 'unknown' || db === 'unknown')
    problems.push({ code: 'datum-unknown', message: 'A surface has no declared vertical datum.' })
  else if (da !== db)
    problems.push({
      code: 'datum-differ',
      message: `The surfaces' heights are in different vertical datums (${da}, ${db}).`,
    })
  if (!alignedGrid(before, after)) problems.push({ code: 'no-overlap', message: 'The surfaces do not overlap.' })
  return { ok: problems.length === 0, problems }
}

/**
 * The common grid over both surfaces' overlap: cell `cell` (default the coarser of the
 * two GSDs), anchored at the overlap's top-left corner. Null when they do not overlap
 * by at least one cell.
 */
export function alignedGrid(a, b, { cell = null } = {}) {
  const gsd = cell ?? Math.max(a.gsd, b.gsd)
  if (!(gsd > 0)) return null
  const x0 = Math.max(a.originX, b.originX)
  const x1 = Math.min(a.originX + a.width * a.gsd, b.originX + b.width * b.gsd)
  const y1 = Math.min(a.originY, b.originY)
  const y0 = Math.max(a.originY - a.height * a.gsd, b.originY - b.height * b.gsd)
  // A small tolerance, so grids that share an edge exactly are not cut by a rounding.
  const eps = gsd * 1e-9
  const width = Math.floor((x1 - x0 + eps) / gsd)
  const height = Math.floor((y1 - y0 + eps) / gsd)
  if (width < 1 || height < 1) return null
  return { width, height, gsd, originX: x0, originY: y1 }
}

/**
 * The surface's height at (x, y): bilinear between the four nearest cell centres, NaN if
 * any of them that carries weight has no data (no height is invented across a hole).
 * Within half a cell of the edge the edge cells are used.
 */
export function sampleSurface(g, x, y) {
  let fx = (x - g.originX) / g.gsd - 0.5
  let fy = (g.originY - y) / g.gsd - 0.5
  if (fx < -0.5 || fy < -0.5 || fx > g.width - 0.5 || fy > g.height - 0.5) return NaN
  fx = Math.min(Math.max(fx, 0), g.width - 1)
  fy = Math.min(Math.max(fy, 0), g.height - 1)
  const c0 = Math.min(Math.floor(fx), g.width - 1),
    r0 = Math.min(Math.floor(fy), g.height - 1)
  const tx = fx - c0,
    ty = fy - r0
  const c1 = tx > 0 ? c0 + 1 : c0,
    r1 = ty > 0 ? r0 + 1 : r0
  const i00 = r0 * g.width + c0,
    i01 = r0 * g.width + c1,
    i10 = r1 * g.width + c0,
    i11 = r1 * g.width + c1
  if (!valid(g, i00) || !valid(g, i01) || !valid(g, i10) || !valid(g, i11)) return NaN
  const top = g.data[i00] * (1 - tx) + g.data[i01] * tx
  const bottom = g.data[i10] * (1 - tx) + g.data[i11] * tx
  return top * (1 - ty) + bottom * ty
}

/**
 * The DEM of Difference of two compatible surfaces on their common grid.
 *
 * opts:
 *   cell          the DoD's cell size (default the coarser GSD)
 *   sigmaBefore   each surface's vertical error, 1σ, in height units (both or neither)
 *   sigmaAfter
 *   t             LoD multiplier (default 1.96, 95 %); LoD = t·√(σb² + σa²)
 *   minChange     a fixed threshold instead of (or above) the σ-based LoD
 *   k             projection scale factor (areas and volumes ÷ k²)
 *
 * → { grid, diff: Float32Array (NaN = not compared), lod, sigmaDod, k, stats }
 * Throws when the surfaces are not compatible (surfaceCompatibility).
 */
export function demOfDifference(before, after, opts = {}) {
  const compat = surfaceCompatibility(before, after)
  if (!compat.ok) throw new Error(`Cannot compare these surfaces: ${compat.problems.map((p) => p.message).join(' ')}`)
  const { sigmaBefore = null, sigmaAfter = null, t = LOD_T95, minChange = 0, k = 1 } = opts
  if ((sigmaBefore == null) !== (sigmaAfter == null))
    throw new Error('Give both surfaces a vertical uncertainty, or neither.')
  for (const s of [sigmaBefore, sigmaAfter])
    if (s != null && !(Number.isFinite(s) && s >= 0)) throw new Error(`Invalid vertical uncertainty: ${s}`)
  const grid = alignedGrid(before, after, { cell: opts.cell ?? null })
  const diff = new Float32Array(grid.width * grid.height).fill(NaN)
  for (let r = 0; r < grid.height; r++) {
    const y = grid.originY - (r + 0.5) * grid.gsd
    for (let c = 0; c < grid.width; c++) {
      const x = grid.originX + (c + 0.5) * grid.gsd
      const zb = sampleSurface(before, x, y)
      if (Number.isNaN(zb)) continue
      const za = sampleSurface(after, x, y)
      if (Number.isNaN(za)) continue
      diff[r * grid.width + c] = za - zb
    }
  }
  const sigmaDod = sigmaBefore == null ? null : Math.hypot(sigmaBefore, sigmaAfter)
  const lod = Math.max(minChange, sigmaDod == null ? 0 : t * sigmaDod)
  const values = Array.from(diff).filter((v) => !Number.isNaN(v))
  return {
    grid: { ...grid, crs: before.crs, verticalDatum: before.verticalDatum },
    diff,
    lod,
    sigmaDod,
    t,
    k,
    stats: summarizeDifferences(values),
  }
}

/** World polygon rings [[[x, y], …], …] → the DoD grid's pixel rings. */
function toPixelRings(grid, rings) {
  return rings.map((ring) => ring.map(([x, y]) => [(x - grid.originX) / grid.gsd, (grid.originY - y) / grid.gsd]))
}

/**
 * Cut, fill and net of a DoD, over the whole grid or inside a polygon.
 *
 * rings: null for the whole compared area, or a polygon's rings in world coordinates
 *   (outer ring and holes, even-odd); a cell is inside when its centre is
 *   (polygonSpans.js, the rule the volume measurement uses).
 *
 * → {
 *   cellArea, cellsInside, cellsCompared, coverage (compared / inside),
 *   areaInside, areaCompared, areaNoData,
 *   raw:      { cut, fill, net, uncertainty: { random, systematic } }
 *   detected: { cut, fill, net, cutArea, fillArea, areaBelowLod, uncertainty }
 *   lod, minDz, maxDz, meanDz (over compared cells; null when none)
 * }
 */
export function changeVolumes(dod, { rings = null } = {}) {
  const { grid, diff, lod, sigmaDod } = dod
  const k = dod.k ?? 1
  const cellArea = (grid.gsd * grid.gsd) / (k * k)
  let inside = 0,
    compared = 0,
    cut = 0,
    fill = 0,
    dCut = 0,
    dFill = 0,
    nCut = 0,
    nFill = 0,
    nDetected = 0,
    sum = 0,
    minDz = Infinity,
    maxDz = -Infinity
  const visit = (i) => {
    inside++
    const dz = diff[i]
    if (Number.isNaN(dz)) return
    compared++
    sum += dz
    if (dz < minDz) minDz = dz
    if (dz > maxDz) maxDz = dz
    if (dz > 0) fill += dz
    else cut -= dz
    if (Math.abs(dz) >= lod && dz !== 0) {
      nDetected++
      if (dz > 0) {
        dFill += dz
        nFill++
      } else {
        dCut -= dz
        nCut++
      }
    }
  }
  if (rings) {
    polygonSpans(
      toPixelRings(grid, rings),
      (r, c0, c1) => {
        for (let c = c0; c <= c1; c++) visit(r * grid.width + c)
      },
      grid,
    )
    // Cells of the polygon beyond the DoD's grid were not compared either.
    inside += cellsOutsideGrid(grid, rings)
  } else for (let i = 0; i < diff.length; i++) visit(i)

  const bound = (n) =>
    sigmaDod == null ? null : { random: sigmaDod * cellArea * Math.sqrt(n), systematic: sigmaDod * cellArea * n }
  return {
    cellArea,
    cellsInside: inside,
    cellsCompared: compared,
    coverage: inside ? compared / inside : 0,
    areaInside: inside * cellArea,
    areaCompared: compared * cellArea,
    areaNoData: (inside - compared) * cellArea,
    raw: { cut: cut * cellArea, fill: fill * cellArea, net: (fill - cut) * cellArea, uncertainty: bound(compared) },
    detected: {
      cut: dCut * cellArea,
      fill: dFill * cellArea,
      net: (dFill - dCut) * cellArea,
      cutArea: nCut * cellArea,
      fillArea: nFill * cellArea,
      areaBelowLod: (compared - nDetected) * cellArea,
      uncertainty: bound(nDetected),
    },
    lod,
    minDz: compared ? minDz : null,
    maxDz: compared ? maxDz : null,
    meanDz: compared ? sum / compared : null,
  }
}

// How many cells of a polygon lie beyond the grid: the same centre rule on an
// unbounded lattice, minus those on the grid.
function cellsOutsideGrid(grid, rings) {
  let all = 0,
    on = 0
  polygonSpans(toPixelRings(grid, rings), (r, c0, c1) => {
    all += c1 - c0 + 1
    if (r < 0 || r >= grid.height) return
    const a = Math.max(0, c0),
      b = Math.min(grid.width - 1, c1)
    if (b >= a) on += b - a + 1
  })
  return all - on
}

/**
 * Height differences inside areas that should not have changed (bedrock, slabs, buildings):
 * a systematic offset between the surveys shows as a median far from zero.
 * → summarizeDifferences(...) of the compared cells inside, or null with none.
 */
export function stableAreaOffset(dod, ringsList) {
  const values = []
  for (const rings of ringsList)
    polygonSpans(
      toPixelRings(dod.grid, rings),
      (r, c0, c1) => {
        for (let c = c0; c <= c1; c++) {
          const v = dod.diff[r * dod.grid.width + c]
          if (!Number.isNaN(v)) values.push(v)
        }
      },
      dod.grid,
    )
  return summarizeDifferences(values)
}

/** Change classes per cell: 1 fill, −1 cut (both beyond the LoD), 0 within it, −128 not compared. */
export function changeClasses(dod) {
  const out = new Int8Array(dod.diff.length)
  for (let i = 0; i < out.length; i++) {
    const dz = dod.diff[i]
    out[i] = Number.isNaN(dz) ? -128 : Math.abs(dz) >= dod.lod && dz !== 0 ? Math.sign(dz) : 0
  }
  return out
}
