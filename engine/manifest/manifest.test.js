import { describe, it, expect } from 'vitest'
import {
  validateManifest,
  stagesToRun,
  stageInputs,
  stableStringify,
  STAGES,
  VERTICAL_DATUM_IDS,
  OUTPUTS,
  stageNeeds,
} from './manifest.js'
import { VERTICAL_DATUMS } from '../../src/core/verticalDatum.js'

const base = () => ({
  manifestVersion: 1,
  job: { id: 'job-1', siteId: 'site-a', flightId: 'flight-7' },
  crs: { horizontal: 'EPSG:2193', vertical: 'orthometric', verticalName: 'NZVD2016' },
  images: [{ name: 'DJI_0001.JPG' }, { name: 'DJI_0002.JPG' }],
  stages: { detect: {}, match: {}, reconstruct: {} },
})

const errorsOf = (m) => {
  const r = validateManifest(m)
  return r.ok ? [] : r.errors
}

describe('validateManifest', () => {
  it('accepts a minimal job and fills the defaults', () => {
    const r = validateManifest(base())
    expect(r.ok).toBe(true)
    expect(r.manifest.sceneType).toBe('aerial')
    expect(r.manifest.outputs).toEqual(['report'])
    expect(r.manifest.limits).toEqual({ timeoutMinutes: 240, workers: 0 })
    expect(r.manifest.control).toBeNull()
    expect(r.manifest.crs).toEqual({ horizontal: 'EPSG:2193', vertical: 'orthometric', verticalName: 'NZVD2016' })
  })

  it('keeps stage settings exactly as given, for the page to layer over the app defaults', () => {
    const m = base()
    m.stages.detect = { maxDim: 3200, preset: 'high' }
    expect(validateManifest(m).manifest.stages.detect).toEqual({ maxDim: 3200, preset: 'high' })
  })

  it('refuses unknown fields instead of ignoring them', () => {
    const m = base()
    m.colour = 'red'
    m.job.owner = 'x'
    expect(errorsOf(m)).toEqual(['manifest: unknown field "colour"', 'job: unknown field "owner"'])
  })

  it('refuses another manifest version', () => {
    expect(errorsOf({ ...base(), manifestVersion: 2 })[0]).toMatch(/manifestVersion/)
  })

  it('needs an EPSG horizontal CRS and a known vertical datum id', () => {
    expect(errorsOf({ ...base(), crs: { horizontal: 'NZTM' } })[0]).toMatch(/crs.horizontal/)
    expect(errorsOf({ ...base(), crs: { horizontal: 'EPSG:2193', vertical: 'NZVD2016' } })[0]).toMatch(/crs.vertical/)
  })

  it("uses the engine's own vertical datum ids", () => {
    expect(VERTICAL_DATUM_IDS).toEqual(VERTICAL_DATUMS.map((d) => d.id))
  })

  it('needs at least two images, each a plain file name listed once', () => {
    expect(errorsOf({ ...base(), images: [{ name: 'a.jpg' }] })).toEqual([
      'images: photogrammetry needs at least two images',
    ])
    expect(errorsOf({ ...base(), images: [{ name: 'a.jpg' }, { name: 'a.jpg' }] })[0]).toMatch(/listed twice/)
    expect(errorsOf({ ...base(), images: [{ name: '../etc/passwd' }, { name: 'b.jpg' }] })[0]).toMatch(/without a path/)
  })

  it('refuses a stage whose input stage is missing', () => {
    const m = base()
    m.stages = { detect: {}, reconstruct: {} }
    expect(errorsOf(m)).toEqual(['stages.reconstruct: needs stages.match'])
  })

  it('an ortho needs the DEM on its default surface, the depth maps alone on a plane', () => {
    const m = base()
    m.stages = { ...m.stages, depth: {}, ortho: {} }
    expect(errorsOf(m)).toEqual(['stages.ortho: needs stages.dem'])
    m.stages.ortho = { surface: 'plane' }
    expect(errorsOf(m)).toEqual([])
    expect(stageNeeds('ortho', {})).toBe('dem')
  })

  it('refuses an output whose stage does not run', () => {
    expect(errorsOf({ ...base(), outputs: ['dem:geotiff'] })).toEqual(['outputs: "dem:geotiff" needs stages.dem'])
    expect(errorsOf({ ...base(), outputs: ['dxf'] })).toEqual(['outputs: unknown output "dxf"'])
  })

  it('every output names a real stage', () => {
    for (const stage of Object.values(OUTPUTS)) expect(STAGES).toContain(stage)
  })

  describe('control', () => {
    const withControl = (points) => ({ ...base(), control: { points } })
    const cp = (over = {}) => ({
      id: 'GCP1',
      role: 'control',
      x: 1_750_000.123,
      y: 5_900_000.456,
      z: 12.5,
      sigmaX: 0.02,
      sigmaY: 0.02,
      sigmaZ: 0.03,
      observations: [{ image: 'DJI_0001.JPG', px: 1024.5, py: 768.25 }],
      ...over,
    })

    it('accepts control and check points and defaults their CRS to the job CRS', () => {
      const r = validateManifest(withControl([cp(), cp({ id: 'CHK1', role: 'check', sigmaX: undefined })]))
      expect(r.ok).toBe(true)
      expect(r.manifest.control.crs).toBe('EPSG:2193')
      expect(r.manifest.control.points[1]).toMatchObject({ role: 'check', sigmaX: null, enabled: true })
      expect(r.manifest.control.points[0].observations[0]).toEqual({
        image: 'DJI_0001.JPG',
        px: 1024.5,
        py: 768.25,
        sigmaPx: null,
      })
    })

    it('a control point must declare its accuracy: no implicit sigma', () => {
      expect(errorsOf(withControl([cp({ sigmaZ: undefined })]))).toEqual([
        'control.points[0].sigmaZ: a control point needs its accuracy (1σ, metres)',
      ])
      expect(errorsOf(withControl([cp({ sigmaX: 0 })]))[0]).toMatch(/positive/)
    })

    it('a height of zero is a height, not a missing value', () => {
      expect(validateManifest(withControl([cp({ z: 0 })])).ok).toBe(true)
      expect(errorsOf(withControl([cp({ z: null })]))).toEqual(['control.points[0].z: a number'])
    })

    it('refuses observations in photos the job does not have, and duplicate ids', () => {
      expect(errorsOf(withControl([cp({ observations: [{ image: 'X.JPG', px: 1, py: 2 }] })]))[0]).toMatch(
        /not in images/,
      )
      expect(errorsOf(withControl([cp(), cp()]))[0]).toMatch(/listed twice/)
    })

    it('only control and check roles: a marker has no place in a job', () => {
      expect(errorsOf(withControl([cp({ role: 'marker' })]))[0]).toMatch(/role/)
    })
  })
})

describe('stageInputs', () => {
  const full = () => ({
    ...base(),
    control: {
      points: [{ id: 'G1', role: 'control', x: 1, y: 2, z: 3, sigmaX: 0.02, sigmaY: 0.02, sigmaZ: 0.03 }],
    },
    stages: { detect: {}, match: {}, reconstruct: {}, depth: {}, dense: {}, dem: {} },
  })
  const keys = (m) =>
    Object.fromEntries(
      Object.entries(stageInputs(validateManifest(m).manifest)).map(([k, v]) => [k, stableStringify(v)]),
    )

  it('a corrected control point invalidates the reconstruction onward, not detection or matching', () => {
    const a = keys(full())
    const m = full()
    m.control.points[0].sigmaZ = 0.05
    const b = keys(m)
    expect(b.detect).toBe(a.detect)
    expect(b.match).toBe(a.match)
    for (const s of ['reconstruct', 'depth', 'dense', 'dem']) expect(b[s]).not.toBe(a[s])
  })

  it('new detection settings invalidate every stage', () => {
    const a = keys(full())
    const m = full()
    m.stages.detect = { maxDim: 2000 }
    const b = keys(m)
    for (const s of Object.keys(a)) expect(b[s]).not.toBe(a[s])
  })

  it('a DEM setting leaves the stages before it valid', () => {
    const a = keys(full())
    const m = full()
    m.stages.dem = { gsd: 0.05 }
    const b = keys(m)
    for (const s of ['detect', 'match', 'reconstruct', 'depth', 'dense']) expect(b[s]).toBe(a[s])
    expect(b.dem).not.toBe(a.dem)
  })

  it('stableStringify ignores key order', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      stableStringify({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    )
  })
})

describe('stagesToRun', () => {
  const m = validateManifest({
    ...base(),
    stages: { detect: {}, match: {}, reconstruct: {}, depth: {}, dense: {}, dem: {} },
  }).manifest

  it('runs everything on a fresh job', () => {
    expect(stagesToRun(m, [])).toEqual(['detect', 'match', 'reconstruct', 'depth', 'dense', 'dem'])
  })

  it('resumes after the last completed stage', () => {
    expect(stagesToRun(m, ['detect', 'match', 'reconstruct', 'depth'])).toEqual(['dense', 'dem'])
  })

  it('reruns every stage after one that has to run again: its input changed', () => {
    // `match` is missing from the checkpoint (it failed); `reconstruct` saved earlier is stale.
    expect(stagesToRun(m, ['detect', 'reconstruct', 'depth'])).toEqual([
      'match',
      'reconstruct',
      'depth',
      'dense',
      'dem',
    ])
  })

  it('has nothing to do when every stage is done', () => {
    expect(stagesToRun(m, ['detect', 'match', 'reconstruct', 'depth', 'dense', 'dem'])).toEqual([])
  })
})
