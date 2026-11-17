import { describe, it, expect } from 'vitest'
import { residualSummary, flagResiduals } from './residuals.js'

describe('residualSummary', () => {
  it('computes RMSE from the definition, on a hand-checked set', () => {
    // Horizontal residuals 3-4-5 and 0-0: RMSE_H = √((25 + 0) / 2) = √12.5.
    // Vertical 0.1 and −0.3: RMSE_V = √((0.01 + 0.09) / 2) = √0.05; mean −0.1.
    const s = residualSummary([
      { dE: 3, dN: 4, dU: 0.1 },
      { dE: 0, dN: 0, dU: -0.3 },
    ])
    expect(s.n).toBe(2)
    expect(s.rmseH).toBeCloseTo(Math.sqrt(12.5), 12)
    expect(s.rmseV).toBeCloseTo(Math.sqrt(0.05), 12)
    expect(s.meanU).toBeCloseTo(-0.1, 12)
    expect(s.maxH).toBe(5)
    expect(s.maxV).toBeCloseTo(0.3, 12)
  })

  it('a systematic shift shows in the mean, not only in the RMSE', () => {
    const s = residualSummary([
      { dE: 0.05, dN: 0, dU: 0 },
      { dE: 0.05, dN: 0, dU: 0 },
    ])
    expect(s.meanE).toBeCloseTo(0.05, 12)
    expect(s.rmseH).toBeCloseTo(0.05, 12)
  })

  it('counts untriangulated points in `of`, never as zero residuals', () => {
    const s = residualSummary([
      { dE: 1, dN: 0, dU: 0 },
      { dE: null, dN: null, dU: null },
    ])
    expect(s).toMatchObject({ n: 1, of: 2, rmseH: 1 })
  })

  it('returns no statistics, not zeros, when nothing is measurable', () => {
    expect(residualSummary([])).toEqual({ n: 0, of: 0 })
    expect(residualSummary([{ dE: null, dN: 1, dU: 1 }])).toEqual({ n: 0, of: 1 })
  })

  it('is unchanged by the order of the points', () => {
    const pts = [
      { dE: 0.01, dN: -0.02, dU: 0.04 },
      { dE: -0.03, dN: 0.01, dU: -0.01 },
      { dE: 0.02, dN: 0.02, dU: 0.02 },
    ]
    // Equal up to the rounding a different summation order brings.
    const a = residualSummary(pts),
      b = residualSummary([...pts].reverse())
    for (const k of Object.keys(a)) expect(b[k]).toBeCloseTo(a[k], 12)
  })
})

describe('flagResiduals', () => {
  it('flags a residual beyond 3σ, absolute limits and weak points, and keeps every point', () => {
    const pts = [
      { name: 'G1', role: 'control', dE: 0.01, dN: 0, dU: 0.02, normalized: 1.2, views: 8 },
      { name: 'G2', role: 'control', dE: 0.2, dN: 0, dU: 0, normalized: 6.5, views: 9 },
      { name: 'C1', role: 'check', dE: 0, dN: 0, dU: -0.09, normalized: null, views: 1 },
      { name: 'C2', role: 'check', dE: null, dN: null, dU: null, views: 0 },
    ]
    expect(flagResiduals(pts, { maxV: 0.05 })).toEqual([
      { name: 'G2', role: 'control', reasons: ['residual is 6.5σ (limit 3σ)'] },
      { name: 'C1', role: 'check', reasons: ['vertical residual -0.090 over 0.05', 'seen in 1 photo(s)'] },
      { name: 'C2', role: 'check', reasons: ['not triangulated: no residual', 'seen in 0 photo(s)'] },
    ])
    expect(pts).toHaveLength(4)
  })
})
