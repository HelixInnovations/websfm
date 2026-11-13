import { describe, expect, it } from 'vitest'
import { MATERIALS, materialById, materialGroups, parseDensity, tonnage } from './materials.js'

describe('stockpile materials', () => {
  it('has unique ids and plausible loose densities', () => {
    expect(new Set(MATERIALS.map((m) => m.id)).size).toBe(MATERIALS.length)
    for (const m of MATERIALS) {
      expect(m.density).toBeGreaterThan(0.1)
      expect(m.density).toBeLessThan(3)
      // The typical value sits inside its stated range.
      const [lo, hi] = m.range.split('–').map(Number)
      expect(m.density).toBeGreaterThanOrEqual(lo)
      expect(m.density).toBeLessThanOrEqual(hi)
    }
    expect(materialById('crushed-rock').density).toBe(1.6)
    expect(materialById('nope')).toBeNull()
    expect(materialGroups().flatMap((g) => g.items)).toHaveLength(MATERIALS.length)
  })

  it('reads typed densities in t/m³ or kg/m³ and refuses impossible ones', () => {
    expect(parseDensity('1.6')).toEqual({ tm3: 1.6, fromKg: false })
    expect(parseDensity('1,65')).toEqual({ tm3: 1.65, fromKg: false })
    expect(parseDensity('1600')).toEqual({ tm3: 1.6, fromKg: true })
    expect(parseDensity('')).toBeNull()
    expect(parseDensity('0')).toBeNull()
    expect(parseDensity('5')).toBeNull()
    expect(parseDensity('abc')).toBeNull()
  })

  it('converts a volume to tonnes only in known length units', () => {
    expect(tonnage(100, 1.6, { horizontal: 'm', vertical: 'm' })).toBeCloseTo(160)
    // 1 ft³ = 0.0283168 m³.
    expect(tonnage(1000, 1, { horizontal: 'ft', vertical: 'ft' })).toBeCloseTo(28.3168, 3)
    // m² × ft: a DEM with metric cells and heights in feet.
    expect(tonnage(10, 2, { horizontal: 'm', vertical: 'ft' })).toBeCloseTo(10 * 0.3048 * 2, 9)
    expect(tonnage(100, 1.6, { horizontal: 'model units', vertical: 'model units' })).toBeNull()
    expect(tonnage(100, 0, { horizontal: 'm', vertical: 'm' })).toBeNull()
  })
})
