// How well a survey's control and check points cover the area it maps. Pure.
//
// Control far from part of a site leaves that part held only by the photos' own geometry
// (doming, tilt); control bunched in one corner fits that corner. Neither shows in the
// control residuals, which are small exactly where the control is. This measures the
// layout itself, before and after a flight, and says what is wrong in the user's terms.
//
//   controlDistribution({ points, area, minControl?, minCheck? })
//   → { control, check, coverage, maxGap, quadrants, flags }
//
// points   [{ id, role: 'control' | 'check', x, y, enabled? }] in a projected CRS
// area     the mapped area's polygon rings [[[x, y], …], …] (the site boundary, or the
//          photos' footprint), outer ring first; even-odd for holes
// coverage share of the area inside the convex hull of the enabled control points (0–1)
// maxGap   the largest distance from any part of the area to its nearest control point,
//          in CRS units, on a sampling grid of about 4,000 points
// quadrants  control points in each quarter of the area around its centroid: NE, NW, SW, SE
// flags    [{ code, level: 'error' | 'warning' | 'info', message }]
//
// Thresholds are defaults a site can change (minControl, minCheck, minCoverage); they
// are what common drone-survey practice asks for, not a guarantee of accuracy.

export const DISTRIBUTION_DEFAULTS = { minControl: 5, minCheck: 3, minCoverage: 0.5, samples: 4096 }

function insideRings(x, y, rings) {
  let inside = false
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i],
        [xj, yj] = ring[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  return inside
}

/** Convex hull (Andrew's monotone chain), counter-clockwise, of [[x, y], …]. */
export function convexHull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = [],
    upper = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop()
    lower.push(q)
  }
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop()
    upper.push(q)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

export function controlDistribution({ points, area, ...opts }) {
  const o = { ...DISTRIBUTION_DEFAULTS, ...opts }
  const enabled = points.filter((p) => p.enabled !== false && Number.isFinite(p.x) && Number.isFinite(p.y))
  const control = enabled.filter((p) => p.role === 'control')
  const check = enabled.filter((p) => p.role === 'check')
  const flags = []

  // Sample the area on a regular grid.
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity
  for (const [x, y] of area[0]) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const step = Math.sqrt(((x1 - x0) * (y1 - y0)) / o.samples) || 1
  const samples = []
  for (let y = y0 + step / 2; y < y1; y += step)
    for (let x = x0 + step / 2; x < x1; x += step) if (insideRings(x, y, area)) samples.push([x, y])
  let cx = 0,
    cy = 0
  for (const [x, y] of samples) {
    cx += x
    cy += y
  }
  cx /= samples.length || 1
  cy /= samples.length || 1

  const hull = convexHull(control.map((p) => [p.x, p.y]))
  const inHull = hull.length >= 3 ? samples.filter(([x, y]) => insideRings(x, y, [hull])).length : 0
  const coverage = samples.length ? inHull / samples.length : 0
  let maxGap = null
  if (control.length)
    for (const [x, y] of samples) {
      let best = Infinity
      for (const p of control) best = Math.min(best, Math.hypot(p.x - x, p.y - y))
      if (maxGap == null || best > maxGap) maxGap = best
    }
  const quadrants = { NE: 0, NW: 0, SW: 0, SE: 0 }
  for (const p of control) quadrants[(p.y >= cy ? 'N' : 'S') + (p.x >= cx ? 'E' : 'W')]++

  if (control.length < 3)
    flags.push({
      code: 'too-few-control',
      level: 'error',
      message: `${control.length} control point(s): at least three are needed to georeference`,
    })
  else if (control.length < o.minControl)
    flags.push({
      code: 'few-control',
      level: 'warning',
      message: `${control.length} control points; this site asks for at least ${o.minControl}`,
    })
  if (control.length >= 3 && coverage < o.minCoverage)
    flags.push({
      code: 'clustered',
      level: 'warning',
      message: `The control surrounds ${Math.round(coverage * 100)} % of the area: the rest is held by the photos alone`,
    })
  const empty = Object.entries(quadrants)
    .filter(([, n]) => n === 0)
    .map(([q]) => q)
  if (control.length >= 4 && empty.length)
    flags.push({
      code: 'empty-quadrant',
      level: 'warning',
      message: `No control in the ${empty.join(', ')} of the area`,
    })
  if (!check.length)
    flags.push({
      code: 'no-check',
      level: 'error',
      message: 'No check points: the survey’s independent accuracy cannot be stated',
    })
  else if (check.length < o.minCheck)
    flags.push({
      code: 'few-check',
      level: 'warning',
      message: `${check.length} check point(s); this site asks for at least ${o.minCheck}`,
    })
  if (check.length && check.length < 20)
    flags.push({
      code: 'check-sample',
      level: 'info',
      message: `${check.length} check points: ASPRS (2014) asks for at least 20 for a formal accuracy statement`,
    })
  return { control: control.length, check: check.length, coverage, maxGap, quadrants, flags }
}
