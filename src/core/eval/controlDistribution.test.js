import { describe, it, expect } from 'vitest'
import { controlDistribution, convexHull } from './controlDistribution.js'

// A 400 × 300 m site.
const area = [
  [
    [0, 0],
    [400, 0],
    [400, 300],
    [0, 300],
  ],
]
const cp = (id, x, y, role = 'control') => ({ id, role, x, y })
const codes = (r) => r.flags.map((f) => f.code)

describe('controlDistribution', () => {
  it('control at the corners and centre covers the site: no warnings', () => {
    const r = controlDistribution({
      points: [
        cp('A', 0, 0),
        cp('B', 400, 0),
        cp('C', 400, 300),
        cp('D', 0, 300),
        cp('E', 220, 170), // north-east of the centre
        cp('K1', 100, 100, 'check'),
        cp('K2', 300, 200, 'check'),
        cp('K3', 200, 50, 'check'),
      ],
      area,
    })
    expect(r.control).toBe(5)
    expect(r.coverage).toBeGreaterThan(0.99)
    expect(r.quadrants).toEqual({ NE: 2, NW: 1, SW: 1, SE: 1 })
    expect(codes(r)).toEqual(['check-sample'])
    // No spot is farther from control than a quarter's diagonal from its corner.
    expect(r.maxGap).toBeLessThan(Math.hypot(200, 150))
  })

  it('control bunched in one corner: clustered, empty quadrants, a large gap', () => {
    const r = controlDistribution({
      points: [
        cp('A', 10, 10),
        cp('B', 60, 10),
        cp('C', 60, 60),
        cp('D', 10, 60),
        cp('E', 35, 35),
        cp('K', 300, 200, 'check'),
      ],
      area,
    })
    expect(r.coverage).toBeLessThan(0.05)
    expect(codes(r)).toEqual(expect.arrayContaining(['clustered', 'empty-quadrant', 'few-check']))
    expect(r.maxGap).toBeGreaterThan(400)
  })

  it('without check points the independent accuracy cannot be stated', () => {
    const r = controlDistribution({ points: [cp('A', 0, 0), cp('B', 400, 0), cp('C', 200, 300)], area })
    expect(r.flags.find((f) => f.code === 'no-check')).toMatchObject({ level: 'error' })
    expect(codes(r)).toContain('few-control')
  })

  it('fewer than three control points cannot georeference', () => {
    expect(controlDistribution({ points: [cp('A', 0, 0), cp('B', 1, 1)], area }).flags[0]).toMatchObject({
      code: 'too-few-control',
      level: 'error',
    })
  })

  it('disabled points do not count', () => {
    const r = controlDistribution({ points: [{ ...cp('A', 0, 0), enabled: false }, cp('B', 400, 0)], area })
    expect(r.control).toBe(1)
  })
})

describe('convexHull', () => {
  it('drops interior points and returns the corners counter-clockwise', () => {
    const h = convexHull([
      [0, 0],
      [2, 0],
      [1, 1],
      [2, 2],
      [0, 2],
      [1, 0],
    ])
    expect(h).toEqual([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ])
  })
})
