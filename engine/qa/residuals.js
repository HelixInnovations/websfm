// Accuracy statistics of control and check point residuals. Pure.
//
// A residual is surveyed coordinate subtracted from where the model puts the point,
// in project units: dE, dN, dU. The same summary serves both roles, and the job record
// always keeps them apart: control residuals say how closely the model fits the points
// it was held to, check residuals are its independent accuracy. Never merge the two.
//
//   residualSummary(points) → { n, of, rmseH, rmseV, meanE, meanN, meanU, maxH, maxV }
//     n   points with all three residuals (triangulated in at least two photos)
//     of  points given, so a missing point is visible rather than silently dropped
//
// RMSE_H = √(Σ(dE² + dN²) / n), RMSE_V = √(Σ dU² / n) (ASPRS 2014 positional accuracy).
// max is the largest absolute value. With no usable point only { n: 0, of } is returned:
// an absent statistic is never reported as zero.

export function residualSummary(points) {
  const ok = points.filter((p) => isNum(p.dE) && isNum(p.dN) && isNum(p.dU))
  if (!ok.length) return { n: 0, of: points.length }
  const rms = (f) => Math.sqrt(ok.reduce((a, p) => a + f(p) ** 2, 0) / ok.length)
  const mean = (f) => ok.reduce((a, p) => a + f(p), 0) / ok.length
  const max = (f) => Math.max(...ok.map((p) => Math.abs(f(p))))
  const h = (p) => Math.hypot(p.dE, p.dN)
  return {
    n: ok.length,
    of: points.length,
    rmseH: rms(h),
    rmseV: rms((p) => p.dU),
    meanE: mean((p) => p.dE),
    meanN: mean((p) => p.dN),
    meanU: mean((p) => p.dU),
    maxH: max(h),
    maxV: max((p) => p.dU),
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * Points whose residual is suspect, with the reason, for a person to review. Nothing is
 * removed or down-weighted here: a flagged point stays in the record and in the
 * adjustment until someone decides (Part 3.5 of the platform brief).
 *
 * normalizedMax  a residual over this many of its own σ (the store's `normalized`, which
 *                accounts for the point's accuracy and the fit's) is suspect; 3 by default
 * maxH, maxV     optional absolute limits in project units (a site's tolerance)
 * minViews       a point seen in fewer photos is too weak to judge (default 2)
 * → [{ name, role, reasons: [text] }]
 */
export function flagResiduals(points, { normalizedMax = 3, maxH = null, maxV = null, minViews = 2 } = {}) {
  const out = []
  for (const p of points) {
    const reasons = []
    if (!isNum(p.dE) || !isNum(p.dN) || !isNum(p.dU)) reasons.push('not triangulated: no residual')
    else {
      if (isNum(p.normalized) && p.normalized > normalizedMax)
        reasons.push(`residual is ${p.normalized.toFixed(1)}σ (limit ${normalizedMax}σ)`)
      const h = Math.hypot(p.dE, p.dN)
      if (maxH != null && h > maxH) reasons.push(`horizontal residual ${h.toFixed(3)} over ${maxH}`)
      if (maxV != null && Math.abs(p.dU) > maxV) reasons.push(`vertical residual ${p.dU.toFixed(3)} over ${maxV}`)
    }
    if (isNum(p.views) && p.views < minViews) reasons.push(`seen in ${p.views} photo(s)`)
    if (reasons.length) out.push({ name: p.name, role: p.role, reasons })
  }
  return out
}
