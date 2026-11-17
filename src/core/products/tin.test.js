// TIN, its LandXML and DXF: checked against geometry with one right answer, and by
// reading the written files back.
import { describe, it, expect } from 'vitest'
import { tinFromGrid, tinFromPoints, tinMeasures, tinDxfFaces } from './tin.js'
import { tinToLandXml, tinToLandXmlParts } from './landxml.js'
import { writeDxf } from './dxf.js'
import { parseXml, child, childrenOf } from '../io/xmlLite.js'

function grid(f, { w = 11, h = 11, gsd = 1, x0 = 1_750_000, yTop = 5_900_011 } = {}) {
  const data = new Float32Array(w * h)
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) data[r * w + c] = f(x0 + (c + 0.5) * gsd, yTop - (r + 0.5) * gsd, c, r)
  return { width: w, height: h, gsd, originX: x0, originY: yTop, data }
}

describe('tinFromGrid', () => {
  it('triangulates every square of valid centres into two triangles', () => {
    const tin = tinFromGrid(grid(() => 5))
    expect(tin.vertices.length / 3).toBe(121)
    expect(tin.triangles.length / 3).toBe(2 * 10 * 10)
  })

  it('a plane: exact planimetric area of the centre lattice and exact volume above a base', () => {
    // Centres span 10 × 10 m. z = 100 + 0.1·(x − x0) is linear, so the TIN is the plane
    // itself and its volume above z = 100 is ∫∫ 0.1·x' over x' ∈ [0.5, 10.5] × 10 m.
    const tin = tinFromGrid(grid((x) => 100 + 0.1 * (x - 1_750_000)))
    const m = tinMeasures(tin, { base: 100 })
    expect(m.planArea).toBeCloseTo(100, 9)
    expect(m.volume).toBeCloseTo(10 * 0.1 * ((10.5 ** 2 - 0.5 ** 2) / 2), 6)
    // A tilted plane's surface area is the planimetric area / cos(slope).
    expect(m.surfaceArea).toBeCloseTo(100 * Math.hypot(1, 0.1), 6)
  })

  it('every triangle faces up (counter-clockwise from above)', () => {
    const tin = tinFromGrid(grid((x, y) => Math.sin(x / 3) + Math.cos(y / 2)))
    const v = tin.vertices,
      t = tin.triangles
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [t[i], t[i + 1], t[i + 2]]
      const cr =
        (v[3 * b] - v[3 * a]) * (v[3 * c + 1] - v[3 * a + 1]) - (v[3 * c] - v[3 * a]) * (v[3 * b + 1] - v[3 * a + 1])
      expect(cr).toBeGreaterThan(0)
    }
  })

  it('never spans a hole: no triangle uses a cell without data, and the area drops accordingly', () => {
    const g = grid(() => 1)
    g.data[5 * 11 + 5] = NaN // the centre cell
    const tin = tinFromGrid(g)
    // The 4 squares around the hole each lose one corner and keep one triangle.
    expect(tin.triangles.length / 3).toBe(200 - 8 + 4)
    expect(tinMeasures(tin).planArea).toBeCloseTo(100 - 4 * 0.5, 9)
  })

  it('step thins the TIN', () => {
    expect(
      tinFromGrid(
        grid(() => 0),
        { step: 2 },
      ).triangles.length / 3,
    ).toBe(2 * 5 * 5)
  })
})

describe('tinFromPoints', () => {
  it('a Delaunay TIN of a square of points covers the square', () => {
    const pts = []
    // Interior points jittered (so the triangulation is not a cocircular lattice), the
    // boundary on the square's edges: the hull, and so the TIN, is exactly 10 × 10 m.
    const jitter = (i, j) => (i > 0 && i < 10 && j > 0 && j < 10 ? 0.01 * ((i * 7 + j * 3) % 5) : 0)
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) pts.push(i + jitter(i, j), j + jitter(j, i), 0)
    const m = tinMeasures(tinFromPoints(Float64Array.from(pts)))
    expect(m.planArea).toBeCloseTo(100, 9)
  })

  it('maxEdge keeps a long edge from bridging a gap', () => {
    // Two clusters 50 m apart: all triangles joining them have edges ≥ 49 m.
    const pts = [0, 0, 0, 1, 0, 0, 0, 1, 0, 50, 0, 0, 51, 0, 0, 50, 1, 0]
    expect(tinFromPoints(Float64Array.from(pts), { maxEdge: 5 }).triangles.length / 3).toBe(2)
    expect(tinFromPoints(Float64Array.from(pts)).triangles.length / 3).toBe(4)
  })
})

describe('LandXML', () => {
  const tin = tinFromGrid(grid((x, y, c, r) => 10 + c + 0.5 * r, { w: 3, h: 3 }))
  const meta = {
    name: 'Survey 2026-11-17 & baseline',
    epsg: 2193,
    crsName: 'NZGD2000 / New Zealand Transverse Mercator 2000',
    verticalDatum: 'NZVD2016',
    application: { name: 'WebSfM', version: '0.8.0' },
    date: new Date('2026-11-17T08:09:10Z'),
  }

  it('reads back as LandXML 1.2 with the declared units, CRS and surface', () => {
    const doc = parseXml(tinToLandXml(tin, meta))
    expect(doc.name).toBe('LandXML')
    expect(doc.attrs).toMatchObject({ version: '1.2', date: '2026-11-17', time: '08:09:10' })
    expect(child(child(doc, 'Units'), 'Metric').attrs.linearUnit).toBe('meter')
    expect(child(doc, 'CoordinateSystem').attrs).toMatchObject({ epsgCode: '2193', verticalDatum: 'NZVD2016' })
    const surface = child(child(doc, 'Surfaces'), 'Surface')
    expect(surface.attrs.name).toBe('Survey 2026-11-17 & baseline')
    expect(child(surface, 'Definition').attrs.surfType).toBe('TIN')
  })

  it('points are northing easting elevation, faces 1-based ids, and the surface is unchanged', () => {
    const doc = parseXml(tinToLandXml(tin, meta))
    const def = child(child(child(doc, 'Surfaces'), 'Surface'), 'Definition')
    const pts = new Map(
      childrenOf(child(def, 'Pnts'), 'P').map((p) => [Number(p.attrs.id), p.text.split(' ').map(Number)]),
    )
    const faces = childrenOf(child(def, 'Faces'), 'F').map((f) => f.text.split(' ').map(Number))
    expect(pts.size).toBe(9)
    expect(faces.length).toBe(8)
    // Rebuild the TIN from the file (E = 2nd value, N = 1st) and compare its measures.
    const ids = [...pts.keys()].sort((a, b) => a - b)
    expect(ids[0]).toBe(1)
    const vertices = Float64Array.from(ids.flatMap((id) => [pts.get(id)[1], pts.get(id)[0], pts.get(id)[2]]))
    const triangles = Uint32Array.from(faces.flat().map((id) => id - 1))
    const back = tinMeasures({ vertices, triangles }, { base: 10 })
    const orig = tinMeasures(tin, { base: 10 })
    expect(back.planArea).toBeCloseTo(orig.planArea, 6)
    expect(back.volume).toBeCloseTo(orig.volume, 4)
    expect(back.planArea).toBeGreaterThan(0) // the order survived: faces still counter-clockwise in E/N
  })

  it('declares no breaklines or boundaries: the file holds only what the TIN has', () => {
    const text = tinToLandXml(tin, meta)
    expect(text).not.toMatch(/Breakline|Boundary|Watershed/)
  })

  it('escapes text, keeps survey coordinates in fixed point, refuses empty and non-metric', () => {
    const text = tinToLandXml(tin, meta)
    expect(text).toContain('&amp; baseline')
    expect(text).not.toMatch(/e\+|e-\d/)
    expect(() => tinToLandXml({ vertices: new Float64Array(0), triangles: new Uint32Array(0) })).toThrow(/no triangles/)
    expect(() => tinToLandXml(tin, { unit: 'usft' })).toThrow(/metric/)
  })

  it('the parts join to the whole document', () => {
    expect([...tinToLandXmlParts(tin, meta)].join('')).toBe(tinToLandXml(tin, meta))
  })
})

describe('DXF 3DFACE', () => {
  it('writes each triangle as a 3DFACE with the third corner repeated', () => {
    const tin = tinFromGrid(grid(() => 7, { w: 2, h: 2 }))
    const text = writeDxf({ layers: [{ name: 'TIN', color: 3 }], faces: tinDxfFaces(tin) })
    const lines = text.split('\n').map((l) => l.trim())
    const at = lines.indexOf('3DFACE')
    expect(lines.filter((l) => l === '3DFACE').length).toBe(2)
    const pairs = {}
    for (let i = at + 1; i < at + 1 + 2 * 13; i += 2) pairs[lines[i]] = lines[i + 1]
    expect(pairs['8']).toBe('TIN')
    expect([pairs['12'], pairs['22'], pairs['32']]).toEqual([pairs['13'], pairs['23'], pairs['33']])
    expect(pairs['30']).toBe('7.0')
  })

  it('refuses a face that is not a triangle', () => {
    expect(() =>
      writeDxf({
        faces: [
          {
            layer: 'X',
            points: [
              [0, 0, 0],
              [1, 0, 0],
            ],
          },
        ],
      }),
    ).toThrow(/3 corners/)
  })
})
