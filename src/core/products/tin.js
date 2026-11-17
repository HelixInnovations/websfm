// Triangulated irregular networks (TIN) — the surface CAD and survey software exchange
// (LandXML, DXF 3DFACE). Pure, no Vue/Pinia/OPFS/DOM.
//
// tin = { vertices: Float64Array [x, y, z, …], triangles: Uint32Array [a, b, c, …] }
// in the frame of its source (a projected CRS for a georeferenced DEM), every triangle
// counter-clockwise seen from above (+z), so its normal points up.
//
// Two ways to build one:
//   tinFromGrid    from a DEM grid: a vertex at each valid cell centre, two triangles
//                  per square of four valid centres, one where exactly three are valid.
//                  No triangle ever spans a cell without data, so holes stay holes.
//                  A grid's centres are cocircular in every square, so a Delaunay
//                  triangulation would split them arbitrarily; the split here is fixed
//                  (south-west to north-east) and the result is reproducible.
//   tinFromPoints  from scattered points (ground points of a cloud), by Delaunay
//                  (delaunator), dropping triangles with an edge longer than `maxEdge`,
//                  which would otherwise bridge gaps and the concave hull.
//
// The surface is exactly what a TIN reader shows: z is linear inside each triangle.
// Nothing here adds breaklines; a TIN from a grid has none, and its LandXML says so by
// writing none (landxml.js).
import Delaunator from 'delaunator'

const valid = (g, i) => (g.mask ? g.mask[i] === 1 : true) && Number.isFinite(g.data[i])

/** Twice the signed planimetric area of triangle (a, b, c) in `v`; > 0 when counter-clockwise. */
function cross2(v, a, b, c) {
  return (v[3 * b] - v[3 * a]) * (v[3 * c + 1] - v[3 * a + 1]) - (v[3 * c] - v[3 * a]) * (v[3 * b + 1] - v[3 * a + 1])
}

/**
 * A TIN from a DEM grid (dem.js layout: row 0 north, origin the top-left corner).
 * `step` takes every step-th row and column (a coarser TIN of a fine DEM).
 */
export function tinFromGrid(grid, { step = 1 } = {}) {
  const s = Math.max(1, Math.floor(step))
  const cols = Math.floor((grid.width - 1) / s) + 1
  const rows = Math.floor((grid.height - 1) / s) + 1
  const index = new Int32Array(cols * rows).fill(-1)
  const verts = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * s * grid.width + c * s
      if (!valid(grid, i)) continue
      index[r * cols + c] = verts.length / 3
      verts.push(grid.originX + (c * s + 0.5) * grid.gsd, grid.originY - (r * s + 0.5) * grid.gsd, grid.data[i])
    }
  const vertices = Float64Array.from(verts)
  const tris = []
  const push = (a, b, c) => {
    // Every triangle counter-clockwise from above.
    if (cross2(vertices, a, b, c) > 0) tris.push(a, b, c)
    else tris.push(a, c, b)
  }
  for (let r = 0; r + 1 < rows; r++)
    for (let c = 0; c + 1 < cols; c++) {
      const nw = index[r * cols + c],
        ne = index[r * cols + c + 1],
        sw = index[(r + 1) * cols + c],
        se = index[(r + 1) * cols + c + 1]
      const n = (nw >= 0) + (ne >= 0) + (sw >= 0) + (se >= 0)
      if (n === 4) {
        push(sw, se, ne)
        push(sw, ne, nw)
      } else if (n === 3) {
        const [a, b, c3] = [nw, ne, se, sw].filter((x) => x >= 0)
        push(a, b, c3)
      }
    }
  return { vertices, triangles: Uint32Array.from(tris) }
}

/**
 * A TIN from scattered points [x, y, z, …] by Delaunay triangulation. Triangles with a
 * planimetric edge longer than `maxEdge` are dropped (default: keep all).
 */
export function tinFromPoints(xyz, { maxEdge = Infinity } = {}) {
  const n = Math.floor(xyz.length / 3)
  const vertices = Float64Array.from(xyz.subarray ? xyz.subarray(0, 3 * n) : xyz.slice(0, 3 * n))
  if (n < 3) return { vertices, triangles: new Uint32Array(0) }
  const coords = new Float64Array(2 * n)
  for (let i = 0; i < n; i++) {
    coords[2 * i] = vertices[3 * i]
    coords[2 * i + 1] = vertices[3 * i + 1]
  }
  const d = new Delaunator(coords)
  const max2 = maxEdge * maxEdge
  const edge2 = (a, b) => (coords[2 * a] - coords[2 * b]) ** 2 + (coords[2 * a + 1] - coords[2 * b + 1]) ** 2
  const tris = []
  for (let t = 0; t < d.triangles.length; t += 3) {
    const a = d.triangles[t],
      b = d.triangles[t + 1],
      c = d.triangles[t + 2]
    if (edge2(a, b) > max2 || edge2(b, c) > max2 || edge2(c, a) > max2) continue
    const area = cross2(vertices, a, b, c)
    if (area === 0) continue
    if (area > 0) tris.push(a, b, c)
    else tris.push(a, c, b)
  }
  return { vertices, triangles: Uint32Array.from(tris) }
}

/**
 * A TIN's planimetric area, its 3D surface area and the signed volume between it and
 * the plane z = base (positive above). Both exact for a piecewise-linear surface:
 * each triangle's prism is its planimetric area times its mean height above the base.
 */
export function tinMeasures(tin, { base = 0 } = {}) {
  const v = tin.vertices,
    t = tin.triangles
  let plan = 0,
    surface = 0,
    volume = 0
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i],
      b = t[i + 1],
      c = t[i + 2]
    const area = cross2(v, a, b, c) / 2
    plan += area
    volume += area * ((v[3 * a + 2] + v[3 * b + 2] + v[3 * c + 2]) / 3 - base)
    const ux = v[3 * b] - v[3 * a],
      uy = v[3 * b + 1] - v[3 * a + 1],
      uz = v[3 * b + 2] - v[3 * a + 2]
    const wx = v[3 * c] - v[3 * a],
      wy = v[3 * c + 1] - v[3 * a + 1],
      wz = v[3 * c + 2] - v[3 * a + 2]
    surface += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2
  }
  return { triangles: t.length / 3, vertices: v.length / 3, planArea: plan, surfaceArea: surface, volume }
}

/** The TIN's triangles as DXF faces for dxf.js writeDxf({ faces }). */
export function tinDxfFaces(tin, layer = 'TIN') {
  const v = tin.vertices,
    t = tin.triangles
  const faces = new Array(t.length / 3)
  for (let i = 0; i < t.length; i += 3) {
    const p = (k) => [v[3 * k], v[3 * k + 1], v[3 * k + 2]]
    faces[i / 3] = { layer, points: [p(t[i]), p(t[i + 1]), p(t[i + 2])] }
  }
  return faces
}
