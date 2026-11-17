// The engine page: WebSfM's own stores, worker pool, WASM and WebGPU, driven by a job
// manifest instead of the UI. engine/runner/ loads a frozen build of this page in
// headless Chromium, one browser profile per job, and calls window.engine.*.
//
// It runs the app's code, not a copy: every stage goes through the store driver the
// headless bench uses (tests/bench/bench.js), which resolves settings exactly as the
// dialogs do (the user-facing defaults, a preset if named, then the job's overrides) and
// calls the same store actions as the ribbon. Exports go through the app's own export
// dispatch, so a GeoTIFF or LAS from a job is byte for byte what Export writes.
//
// Events reach the runner as console lines: `@@EVENT {json}` from here, `@@LOG {json}`
// for every app log line (mirrored by the driver).
//
// The driver lives under tests/ because it began as the bench; it is imported, not
// duplicated, so the two cannot drift. Moving it under src/ is engine/README.md ▸ Debt.
import '../../tests/bench/bench.js'
import { storeToRefs } from 'pinia'
import { validateManifest, stagesToRun, MANIFEST_VERSION } from '../manifest/manifest.js'
import { residualSummary, flagResiduals } from '../qa/residuals.js'
import { EXPORT_DEFAULTS } from '/src/core/defaults.user.js'
import { useProjectsStore } from '/src/stores/useProjectsStore.js'
import { useReconstructionStore } from '/src/stores/useReconstructionStore.js'
import { useGcpsStore } from '/src/stores/useGcpsStore.js'
import { useImagesStore } from '/src/stores/useImagesStore.js'
import { flushPersistence } from '/src/utils/persistence.js'
import * as compute from '/src/workers/computeClient.js'
import pkg from '/package.json'

/** The page API's version: the runner refuses a build whose API it does not know. */
export const ENGINE_API_VERSION = 1

const bench = window.bench
const emit = (type, data = {}) =>
  console.log('@@EVENT ' + JSON.stringify({ type, time: new Date().toISOString(), ...data }))

// A stage that ran but did not produce what the next stage needs is a failure, whatever
// the store reported: the job must never record a stage as done without its output.
const STAGE_CHECKS = {
  detect: (r) => (r.images > 0 && r.keypoints > 0 ? null : 'no image has keypoints'),
  match: (r) => (r.accepted > 0 ? null : 'no image pair was matched'),
  reconstruct: (r) => (r.cameras >= 2 ? null : `only ${r.cameras} camera(s) registered`),
  depth: (r) => (r.depthMaps > 0 ? null : 'no depth map was computed'),
  dense: (r) => (r.points > 0 ? null : 'the dense cloud is empty'),
  dem: (r) => (r.width > 0 && r.height > 0 ? null : 'no DEM was built'),
  ortho: (r) => (r.width > 0 && r.height > 0 ? null : 'no orthophoto was built'),
}

// Per-pair and per-image detail the bench keeps for its diffs: large on a real flight
// and not part of a job record. Their digests stay.
const DROP_FIELDS = ['perPair', 'gateScores', 'kpPerImage', 'featureDigest', 'pointsEnu', 'model']

const slim = (r) => Object.fromEntries(Object.entries(r ?? {}).filter(([k]) => !DROP_FIELDS.includes(k)))

class StageError extends Error {
  constructor(stage, message) {
    super(`${stage}: ${message}`)
    this.stage = stage
  }
}

async function gpuInfo() {
  try {
    const adapter = await navigator.gpu?.requestAdapter()
    if (!adapter) return { available: false }
    const info = adapter.info ?? {}
    return {
      available: true,
      vendor: info.vendor ?? '',
      architecture: info.architecture ?? '',
      device: info.device ?? '',
    }
  } catch (err) {
    return { available: false, error: String(err?.message ?? err) }
  }
}

// The manifest's control points into the GCP store, as Import ▸ GCPs adds a CSV: in the
// control CRS, converted to the project CRS; sigmas 1σ in metres; heights in the job's
// vertical datum. Replaces whatever control the project held, so a resumed job with a
// corrected control set runs on exactly the manifest's points.
async function loadControl(manifest) {
  const gcpsStore = useGcpsStore()
  for (const g of [...gcpsStore.gcps]) gcpsStore.removeGcp(g.id)
  if (!manifest.control) return null
  const raw = manifest.control.points.map((p) => ({
    name: p.name,
    role: p.role,
    x: p.x,
    y: p.y,
    z: p.z,
    accuracyX: p.sigmaX,
    accuracyY: p.sigmaY,
    accuracyZ: p.sigmaZ,
    verticalDatum: manifest.crs.vertical,
    observations: p.observations.map((o) => ({
      imageName: o.image,
      px: o.px,
      py: o.py,
      accuracyX: o.sigmaPx ?? undefined,
      accuracyY: o.sigmaPx ?? undefined,
    })),
  }))
  const added = await gcpsStore.addGcps(
    raw,
    manifest.control.crs,
    {},
    { convention: '1sigma', unit: 'metres', rememberDefaults: false, verticalDatum: manifest.crs.vertical },
    { x: 1, y: 1 },
  )
  if (added !== raw.length) throw new StageError('control', `${added} of ${raw.length} control points were added`)
  for (const p of manifest.control.points)
    if (!p.enabled) {
      const g = gcpsStore.gcps.find((x) => x.name === p.name)
      if (g) gcpsStore.setGcpEnabled(g.id, false)
    }
  return {
    control: manifest.control.points.filter((p) => p.role === 'control' && p.enabled).length,
    check: manifest.control.points.filter((p) => p.role === 'check' && p.enabled).length,
    disabled: manifest.control.points.filter((p) => !p.enabled).length,
    observations: manifest.control.points.reduce((n, p) => n + p.observations.length, 0),
  }
}

// Residuals per control and check point after the reconstruction, in project units,
// apart by role: control residuals say how well the model fits what it was held to;
// check residuals are the independent accuracy (AUDIT.md ▸ 11).
async function controlReport() {
  const recon = useReconstructionStore()
  if (!recon.validGeoref) await recon.georeference()
  const g = recon.validGeoref
  const rows = await recon.gcpAccuracyReport()
  const points = rows.map((r) => ({
    name: r.name,
    role: r.role,
    views: r.viewCount,
    dE: r.dx,
    dN: r.dy,
    dU: r.dz,
    dH: r.dx == null ? null : Math.hypot(r.dx, r.dy),
    d3: r.dTotal,
    normalized: r.normalized ?? null,
    chi2: r.chi2 ?? null,
  }))
  return {
    georeference: g ? { method: g.method, count: g.count, rms: g.rms ?? null, crs: g.crs ?? null } : null,
    points,
    control: residualSummary(points.filter((p) => p.role === 'control')),
    check: residualSummary(points.filter((p) => p.role === 'check')),
    flags: flagResiduals(points),
  }
}

const STAGE_RUN = {
  detect: (s) => bench.detect(s),
  match: (s) => bench.match(s),
  reconstruct: (s, m) => bench.reconstruct({ ...s, sensor: m.camera ?? s.sensor ?? null }),
  depth: (s) => bench.depth(s),
  dense: (s) => bench.dense(s),
  dem: async (s) => bench.dem({ ...s, crs: await surveyFrame('dem', s.crs) }),
  ortho: async (s) => bench.ortho(s.surface === 'plane' ? { ...s, crs: await surveyFrame('ortho', s.crs) } : s),
}

// A survey product is in the project CRS, as the DEM dialog preselects once there is a
// georeference (guide ▸ DEM ▸ Coordinate frame). A job may ask for the model's own
// frame with crs: 'local'; otherwise a product without a georeference is a failure,
// never a silent local-frame file that no comparison could use. The ortho on the DEM
// takes the DEM's frame.
async function surveyFrame(stage, requested) {
  if (requested === 'local') return 'local'
  const recon = useReconstructionStore()
  if (!recon.validGeoref) await recon.georeference()
  if (!recon.validGeoref)
    throw new StageError(
      stage,
      'no georeference: give the photos GPS positions or the job at least three control points in a projected CRS',
    )
  return 'project'
}

// Each file output through the app's export dispatch (bench.exportRun ▸ useExports).
const EXPORTS = {
  'dem:geotiff': { kind: 'dem', settings: { format: 'geotiff' } },
  'dem:cog': { kind: 'dem', settings: { format: 'cog' } },
  'ortho:geotiff': { kind: 'ortho', settings: { format: 'geotiff' } },
  'ortho:cog': { kind: 'ortho', settings: { format: 'cog' } },
  'ortho:png': { kind: 'ortho', settings: { format: 'png' } },
  'cloud:las': { kind: 'cloud', cloud: 'dense', settings: { format: 'las' } },
  'cloud:laz': { kind: 'cloud', cloud: 'dense', settings: { format: 'laz' } },
  'project': { kind: 'project', settings: { includeDerived: true } },
}

window.engine = {
  apiVersion: ENGINE_API_VERSION,
  manifestVersion: MANIFEST_VERSION,

  /** What this build is and what it can use: recorded with every job. */
  async info() {
    return {
      apiVersion: ENGINE_API_VERSION,
      manifestVersion: MANIFEST_VERSION,
      websfmVersion: pkg.version,
      userAgent: navigator.userAgent,
      crossOriginIsolated: self.crossOriginIsolated === true,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemoryGB: navigator.deviceMemory ?? null,
      pool: { size: compute.POOL_SIZE, max: compute.MAX_POOL_SIZE },
      gpu: await gpuInfo(),
    }
  },

  /**
   * Run a job's stages. `resume` = { projectId, completed: [stage] } from the runner's
   * checkpoint continues a job in the same browser profile after its last good stage.
   * Resolves with the job record; rejects with the failing stage's error.
   */
  async run(input, { resume = null, inputBase = '/job/input/' } = {}) {
    const v = validateManifest(input)
    if (!v.ok) throw new Error(`invalid manifest:\n${v.errors.join('\n')}`)
    const m = v.manifest
    const result = { job: m.job, projectId: null, resumedFrom: resume?.completed ?? null, stages: {}, control: null }

    if (resume?.projectId) {
      emit('stage', { stage: 'reopen', status: 'running' })
      const r = await bench.reopen(resume.projectId)
      result.projectId = resume.projectId
      // The reconstruction reruns (its inputs changed, or it never finished): give it the
      // manifest's CRS and control, which may be corrected since the first attempt.
      if (stagesToRun(m, resume.completed ?? []).includes('reconstruct')) {
        await bench.setCrs(m.crs.horizontal)
        result.control = { loaded: await loadControl(m) }
      }
      emit('stage', { stage: 'reopen', status: 'done', seconds: r.seconds })
    } else {
      emit('stage', { stage: 'ingest', status: 'running', total: m.images.length })
      result.projectId = await bench.start({ name: m.job.id, sceneType: m.sceneType, crs: m.crs.horizontal })
      emit('project', { projectId: result.projectId })
      if (m.limits.workers > 0) result.pool = await bench.setPoolSize(m.limits.workers)
      const t0 = performance.now()
      for (let i = 0; i < m.images.length; i += 32) {
        const batch = m.images.slice(i, i + 32).map((im) => ({
          name: im.name,
          url: im.url ?? `${inputBase}${encodeURIComponent(im.name)}`,
        }))
        await bench.addImages(batch)
        emit('progress', { stage: 'ingest', done: Math.min(i + 32, m.images.length), total: m.images.length })
      }
      const images = useImagesStore().images
      const failed = images.filter((im) => im.previewFailed).map((im) => im.name)
      if (images.length !== m.images.length || failed.length)
        throw new StageError(
          'ingest',
          `${images.length} of ${m.images.length} images were read${failed.length ? `; unreadable: ${failed.join(', ')}` : ''}`,
        )
      result.stages.ingest = { images: images.length, seconds: (performance.now() - t0) / 1000 }
      if (m.control) result.control = { loaded: await loadControl(m) }
      await flushPersistence()
      emit('stage', { stage: 'ingest', status: 'done', seconds: result.stages.ingest.seconds })
      emit('checkpoint', { stage: 'ingest' })
    }
    result.pool ??= { size: compute.POOL_SIZE, max: compute.MAX_POOL_SIZE }
    emit('pool', result.pool)

    for (const stage of stagesToRun(m, resume?.completed ?? [])) {
      emit('stage', { stage, status: 'running' })
      const r = slim(await STAGE_RUN[stage](m.stages[stage], m))
      const problem = STAGE_CHECKS[stage](r)
      if (problem) throw new StageError(stage, problem)
      result.stages[stage] = r
      if (stage === 'reconstruct' && useGcpsStore().gcps.length)
        result.control = { ...result.control, ...(await controlReport()) }
      await flushPersistence()
      emit('stage', { stage, status: 'done', seconds: r.seconds ?? null })
      emit('checkpoint', { stage })
    }
    // A resumed job that did not rerun the reconstruction still reports its control.
    if (!result.control?.points && useGcpsStore().gcps.length && useReconstructionStore().mainSparseCloud)
      result.control = { ...result.control, ...(await controlReport()) }
    // How the survey is georeferenced, with or without control points: GCPs, the photos'
    // own GNSS ('poses'), or none. A record without it would read as "no georeference".
    const recon = useReconstructionStore()
    if (recon.mainSparseCloud) {
      if (!recon.validGeoref) await recon.georeference()
      const g = recon.validGeoref
      result.georeference = g ? { method: g.method, count: g.count, rms: g.rms ?? null, crs: g.crs ?? null } : null
    }
    return result
  },

  /** Export one output through the app's export dispatch; its files arrive as downloads. */
  async export(output) {
    const spec = EXPORTS[output]
    if (!spec) throw new Error(`export: unknown output "${output}"`)
    const settings = { ...EXPORT_DEFAULTS, ...spec.settings }
    emit('export', { output, status: 'running' })
    const r = await bench.exportRun({ ...spec, settings })
    emit('export', { output, status: 'done', seconds: r.seconds })
    return r
  },

  /** The project's CRS and its products' frames, for the job record. */
  describe() {
    const { currentCrs } = storeToRefs(useProjectsStore())
    const recon = useReconstructionStore()
    return {
      crs: currentCrs.value ?? null,
      dem: recon.dem
        ? {
            width: recon.dem.fullWidth ?? recon.dem.width,
            height: recon.dem.fullHeight ?? recon.dem.height,
            gsd: recon.dem.fullGsd ?? recon.dem.gsd,
            crs: recon.dem.crs ?? null,
          }
        : null,
      ortho: recon.ortho
        ? { width: recon.ortho.width, height: recon.ortho.height, gsd: recon.ortho.gsd, crs: recon.ortho.crs ?? null }
        : null,
      denseCloud: recon.mainDenseCloud ? { points: recon.mainDenseCloud.count } : null,
    }
  },
}

window.engineReady = true
emit('ready', { apiVersion: ENGINE_API_VERSION })
