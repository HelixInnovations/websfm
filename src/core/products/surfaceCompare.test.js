// Surface comparison against volumes known in closed form: every expected number below
// comes from geometry, not from running the code.
import { describe, it, expect } from 'vitest'
import {
  surfaceCompatibility,
  alignedGrid,
  sampleSurface,
  demOfDifference,
  changeVolumes,
  stableAreaOffset,
  changeClasses,
  LOD_T95,
} from './surfaceCompare.js'

// A surface on [x0, x0 + w·gsd] × [y0, y0 + h·gsd] (y0 = south edge) with z = f(x, y)
// sampled at cell centres, as dem.js lays out a DEM.
function surface(
  f,
  { w = 100, h = 100, gsd = 1, x0 = 1_750_000, y0 = 5_900_000, crs = 'EPSG:2193', datum = 'orthometric' } = {},
) {
  const data = new Float32Array(w * h)
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const x = x0 + (c + 0.5) * gsd
      const y = y0 + h * gsd - (r + 0.5) * gsd
      data[r * w + c] = f(x - x0, y - y0)
    }
  return { width: w, height: h, gsd, originX: x0, originY: y0 + h * gsd, data, crs, verticalDatum: datum }
}
const square = (x0, y0, x1, y1, ox = 1_750_000, oy = 5_900_000) => [
  [
    [ox + x0, oy + y0],
    [ox + x1, oy + y0],
    [ox + x1, oy + y1],
    [ox + x0, oy + y1],
  ],
]

describe('surfaceCompatibility', () => {
  const a = surface(() => 0)
  it('accepts two surfaces in one CRS and one declared datum', () => {
    expect(
      surfaceCompatibility(
        a,
        surface(() => 1),
      ),
    ).toEqual({ ok: true, problems: [] })
  })
  it('refuses another CRS, another datum, an unknown datum and no overlap', () => {
    const codes = (b) => surfaceCompatibility(a, b).problems.map((p) => p.code)
    expect(codes(surface(() => 0, { crs: 'EPSG:32760' }))).toEqual(['crs-differ'])
    expect(codes(surface(() => 0, { datum: 'ellipsoidal' }))).toEqual(['datum-differ'])
    expect(codes(surface(() => 0, { datum: 'unknown' }))).toEqual(['datum-unknown'])
    expect(codes(surface(() => 0, { x0: 1_760_000 }))).toEqual(['no-overlap'])
  })
  it('demOfDifference refuses incompatible surfaces rather than comparing them', () => {
    expect(() =>
      demOfDifference(
        a,
        surface(() => 0, { datum: 'ellipsoidal' }),
      ),
    ).toThrow(/vertical datums/)
  })
})

describe('alignedGrid and sampleSurface', () => {
  it('the common grid is the overlap at the coarser cell', () => {
    const a = surface(() => 0, { w: 100, h: 100, gsd: 1 })
    const b = surface(() => 0, { w: 40, h: 40, gsd: 2, x0: 1_750_010, y0: 5_900_020 })
    expect(alignedGrid(a, b)).toEqual({ width: 40, height: 40, gsd: 2, originX: 1_750_010, originY: 5_900_100 })
  })
  it('bilinear sampling reproduces a plane exactly and refuses to bridge a hole', () => {
    const g = surface((x, y) => 2 + 0.1 * x - 0.05 * y, { w: 10, h: 10 })
    expect(sampleSurface(g, 1_750_003.2, 5_900_006.7)).toBeCloseTo(2 + 0.32 - 0.335, 5)
    g.data[5 * 10 + 5] = NaN
    expect(sampleSurface(g, 1_750_005.0, 5_900_004.0)).toBeNaN()
  })
})

describe('changeVolumes on known geometry', () => {
  it('two identical flat surfaces: no change at all', () => {
    const v = changeVolumes(
      demOfDifference(
        surface(() => 10),
        surface(() => 10),
      ),
    )
    expect(v.raw).toMatchObject({ cut: 0, fill: 0, net: 0 })
    expect(v.coverage).toBe(1)
  })

  it('a rectangular fill of 2 m over 20 × 30 m is 1,200 m³', () => {
    const before = surface(() => 0)
    const after = surface((x, y) => (x > 10 && x < 30 && y > 40 && y < 70 ? 2 : 0))
    const v = changeVolumes(demOfDifference(before, after))
    expect(v.raw.fill).toBeCloseTo(1200, 6)
    expect(v.raw.cut).toBe(0)
    expect(v.raw.net).toBeCloseTo(1200, 6)
  })

  it('a rectangular cut of 1.5 m over 10 × 10 m is 150 m³ of cut and a net loss', () => {
    const before = surface(() => 5)
    const after = surface((x, y) => (x > 50 && x < 60 && y > 50 && y < 60 ? 3.5 : 5))
    const v = changeVolumes(demOfDifference(before, after))
    expect(v.raw.cut).toBeCloseTo(150, 6)
    expect(v.raw.fill).toBe(0)
    expect(v.raw.net).toBeCloseTo(-150, 6)
  })

  it('a sloping surface raised by 0.25 m everywhere: 0.25 × area, whatever the slope', () => {
    const slope = (x, y) => 100 + 0.3 * x + 0.12 * y
    const v = changeVolumes(
      demOfDifference(
        surface(slope),
        surface((x, y) => slope(x, y) + 0.25),
      ),
    )
    expect(v.raw.net).toBeCloseTo(0.25 * 100 * 100, 2)
    expect(v.raw.cut).toBe(0)
  })

  it('a square pyramid stockpile, side 40 m, 12 m high: L²H/3 = 6,400 m³', () => {
    const pyr = (x, y) => Math.max(0, 12 * (1 - Math.max(Math.abs(x - 50), Math.abs(y - 50)) / 20))
    const v = changeVolumes(
      demOfDifference(
        surface(() => 0, { w: 400, h: 400, gsd: 0.25 }),
        surface(pyr, { w: 400, h: 400, gsd: 0.25 }),
      ),
    )
    expect(v.raw.fill / 6400).toBeCloseTo(1, 3)
  })

  it('a conical stockpile, radius 15 m, 8 m high: πr²h/3', () => {
    const cone = (x, y) => Math.max(0, 8 * (1 - Math.hypot(x - 50, y - 50) / 15))
    const v = changeVolumes(
      demOfDifference(
        surface(() => 0, { w: 400, h: 400, gsd: 0.25 }),
        surface(cone, { w: 400, h: 400, gsd: 0.25 }),
      ),
    )
    expect(v.raw.fill / ((Math.PI * 15 * 15 * 8) / 3)).toBeCloseTo(1, 2)
  })

  it('two adjacent stockpile polygons add up to the whole, no cell counted twice', () => {
    const before = surface(() => 0)
    const after = surface((x, y) => (y > 20 && y < 80 ? (x < 50 ? 1 : 2) : 0))
    const dod = demOfDifference(before, after)
    const left = changeVolumes(dod, { rings: square(0, 0, 50, 100) })
    const right = changeVolumes(dod, { rings: square(50, 0, 100, 100) })
    expect(left.raw.fill).toBeCloseTo(50 * 60 * 1, 6)
    expect(right.raw.fill).toBeCloseTo(50 * 60 * 2, 6)
    expect(left.cellsInside + right.cellsInside).toBe(100 * 100)
    expect(left.raw.fill + right.raw.fill).toBeCloseTo(changeVolumes(dod).raw.fill, 6)
  })

  it('overlapping polygons each count the shared cells: overlap is for the caller to flag, never hidden', () => {
    const dod = demOfDifference(
      surface(() => 0),
      surface(() => 1),
    )
    const a = changeVolumes(dod, { rings: square(0, 0, 60, 100) })
    const b = changeVolumes(dod, { rings: square(40, 0, 100, 100) })
    expect(a.raw.fill + b.raw.fill).toBeCloseTo(100 * 100 + 20 * 100, 6)
  })

  it('a polygon with a hole leaves the hole out (even-odd rings)', () => {
    const dod = demOfDifference(
      surface(() => 0),
      surface(() => 1),
    )
    const ring = square(10, 10, 90, 90)[0]
    const hole = square(40, 40, 60, 60)[0]
    expect(changeVolumes(dod, { rings: [ring, hole] }).raw.fill).toBeCloseTo(80 * 80 - 20 * 20, 6)
  })

  it('missing coverage is reported as not compared, never as zero change', () => {
    const before = surface(() => 0)
    const after = surface(() => 1)
    for (let r = 0; r < 100; r++) for (let c = 0; c < 25; c++) after.data[r * 100 + c] = NaN
    const v = changeVolumes(demOfDifference(before, after))
    expect(v.coverage).toBeCloseTo(0.75, 2)
    expect(v.areaNoData).toBeGreaterThan(2400)
    expect(v.raw.fill).toBeCloseTo(v.areaCompared * 1, 6)
  })

  it('a polygon reaching beyond the surveys counts its outside part as not compared', () => {
    const dod = demOfDifference(
      surface(() => 0),
      surface(() => 1),
    )
    const v = changeVolumes(dod, { rings: square(80, 0, 120, 100) })
    expect(v.cellsInside).toBe(40 * 100)
    expect(v.coverage).toBeCloseTo(0.5, 6)
  })

  it('the projection scale factor divides areas and volumes by k²', () => {
    const k = 0.9996
    const v = changeVolumes(
      demOfDifference(
        surface(() => 0),
        surface(() => 1),
        { k },
      ),
    )
    expect(v.raw.fill).toBeCloseTo((100 * 100) / (k * k), 4)
  })
})

describe('level of detection', () => {
  it('LoD = 1.96·√(σ₁² + σ₂²)', () => {
    const dod = demOfDifference(
      surface(() => 0),
      surface(() => 0),
      { sigmaBefore: 0.03, sigmaAfter: 0.04 },
    )
    expect(dod.sigmaDod).toBeCloseTo(0.05, 12)
    expect(dod.lod).toBeCloseTo(LOD_T95 * 0.05, 12)
  })

  it('change within the surveys’ error is left out of the detected volume, kept in the raw one', () => {
    // ±2 cm of alternating noise everywhere, and a real 0.5 m fill over 10 × 10 m.
    const noise = (x, y) => ((Math.floor(x) + Math.floor(y)) % 2 ? 0.02 : -0.02)
    const after = surface((x, y) => noise(x, y) + (x > 20 && x < 30 && y > 20 && y < 30 ? 0.5 : 0))
    const dod = demOfDifference(
      surface(() => 0),
      after,
      { sigmaBefore: 0.03, sigmaAfter: 0.03 },
    )
    const v = changeVolumes(dod)
    expect(v.detected.fill).toBeCloseTo(100 * 0.5, 0)
    expect(v.detected.cut).toBe(0)
    expect(v.detected.areaBelowLod).toBeCloseTo(100 * 100 - 100, 6)
    expect(v.raw.cut).toBeGreaterThan(90) // the noise is still there in the raw totals
  })

  it('volume uncertainty bounds: random σA√n, systematic σAn', () => {
    const dod = demOfDifference(
      surface(() => 0),
      surface(() => 1),
      { sigmaBefore: 0.03, sigmaAfter: 0.04 },
    )
    const v = changeVolumes(dod)
    expect(v.detected.uncertainty.systematic).toBeCloseTo(0.05 * 1 * 10000, 6)
    expect(v.detected.uncertainty.random).toBeCloseTo(0.05 * 1 * 100, 6)
  })

  it('no σ, no uncertainty: never a made-up number', () => {
    expect(
      changeVolumes(
        demOfDifference(
          surface(() => 0),
          surface(() => 1),
        ),
      ).raw.uncertainty,
    ).toBeNull()
  })

  it('needs both surfaces’ σ or neither', () => {
    expect(() =>
      demOfDifference(
        surface(() => 0),
        surface(() => 1),
        { sigmaBefore: 0.03 },
      ),
    ).toThrow(/both/)
  })

  it('change classes: fill, cut, within error, not compared', () => {
    const after = surface((x) => (x < 25 ? 1 : x < 50 ? -1 : x < 75 ? 0.01 : 0))
    after.data[99] = NaN
    const dod = demOfDifference(
      surface(() => 0),
      after,
      { sigmaBefore: 0.02, sigmaAfter: 0.02 },
    )
    const cls = changeClasses(dod)
    expect([cls[0], cls[30], cls[60], cls[99]]).toEqual([1, -1, 0, -128])
  })
})

describe('stableAreaOffset', () => {
  it('finds a systematic 4 cm shift between the surveys in an area that did not change', () => {
    const dod = demOfDifference(
      surface(() => 0),
      surface(() => 0.04),
    )
    const s = stableAreaOffset(dod, [square(0, 0, 20, 20)])
    expect(s.n).toBe(400)
    expect(s.median).toBeCloseTo(0.04, 6)
    expect(s.nmad).toBeCloseTo(0, 6)
  })
})
