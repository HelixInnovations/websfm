// The engine job manifest: what one processing job asks the engine to do, version 1.
// Pure, no dependencies, so the runner (Node), the engine page (browser) and the
// platform's API all validate a manifest with the same code.
//
//   validateManifest(input) → { ok: true, manifest } | { ok: false, errors: [string] }
//
// `manifest` is the normalised form: defaults filled in, stage settings kept exactly as
// given (the engine page layers them over the app's own defaults, as the dialogs do).
// Validation refuses rather than guesses: an unknown key, a control point without a
// declared accuracy or a stage whose input stage is missing is an error, never a default.
//
// Shape (version 1):
// {
//   manifestVersion: 1,
//   job:       { id, siteId?, flightId?, label? }          opaque strings for the record
//   sceneType: 'aerial' | 'object'                          default 'aerial'
//   crs:       { horizontal: 'EPSG:<n>', vertical?: <VERTICAL_DATUM_IDS>, verticalName? }
//   images:    [{ name, url?, sha256? }]                    url defaults to the runner's input route
//   camera?:   { focal?, focalUnit?, cx?, cy?, k1?, k2?, k3?, k4?, k5?, k6?, p1?, p2?, distortionModel? }
//   control?:  { crs?, points: [{ id, name?, role, x, y, z, sigmaX, sigmaY, sigmaZ,
//                 enabled?, observations?: [{ image, px, py, sigmaPx? }] }] }
//   stages:    { detect?, match?, reconstruct?, depth?, dense?, dem?, ortho? }
//                each an object of setting overrides ({} = the app's defaults)
//   outputs?:  [ 'report' | 'dem:geotiff' | 'dem:cog' | 'ortho:geotiff' | 'ortho:cog'
//               | 'ortho:png' | 'cloud:las' | 'cloud:laz' | 'project' ]
//   limits?:   { timeoutMinutes?, workers? }
// }
//
// Units: control coordinates in `control.crs` (default crs.horizontal), heights in
// `crs.vertical`; sigmas are one standard deviation in metres. Observation px/py are the
// photo's own pixels in the app's mark convention (core/sfm/displayFrame.js): the
// image's top-left corner is (0, 0) and pixel i spans [i, i + 1], so its centre is
// i + ½ — Metashape's convention too. A detector that reports centres at integers adds ½.

export const MANIFEST_VERSION = 1

/** The engine's processing stages, in the only order they can run. */
export const STAGES = ['detect', 'match', 'reconstruct', 'depth', 'dense', 'dem', 'ortho']

// Each stage's input: running a stage needs the one before it in this map, in the same
// job or (with `resume`) in an earlier attempt of it.
export const STAGE_NEEDS = {
  detect: null,
  match: 'detect',
  reconstruct: 'match',
  depth: 'reconstruct',
  dense: 'depth',
  dem: 'dense',
  ortho: 'dem', // on its default surface, the DEM; on a plane, the depth maps alone
}

/** The stage `stage` needs, given its settings. */
export function stageNeeds(stage, settings = {}) {
  if (stage === 'ortho' && settings.surface === 'plane') return 'depth'
  return STAGE_NEEDS[stage]
}

export const OUTPUTS = {
  'report': 'detect', // the job record (result.json), written for every job
  'dem:geotiff': 'dem',
  'dem:cog': 'dem',
  'ortho:geotiff': 'ortho',
  'ortho:cog': 'ortho',
  'ortho:png': 'ortho',
  'cloud:las': 'dense',
  'cloud:laz': 'dense',
  'project': 'detect',
}

/** core/verticalDatum.js VERTICAL_DATUMS ids (kept in step by manifest.test.js). */
export const VERTICAL_DATUM_IDS = ['ellipsoidal', 'geoid:EGM2008', 'geoid:EGM96', 'orthometric', 'local', 'unknown']

const CAMERA_FIELDS = [
  'focal',
  'focalUnit',
  'cx',
  'cy',
  'k1',
  'k2',
  'k3',
  'k4',
  'k5',
  'k6',
  'p1',
  'p2',
  'distortionModel',
]
const TOP_KEYS = [
  'manifestVersion',
  'job',
  'sceneType',
  'crs',
  'images',
  'camera',
  'control',
  'stages',
  'outputs',
  'limits',
]
const EPSG = /^EPSG:\d{4,6}$/
// A file name, not a path: the runner serves images from one folder per job.
const SAFE_NAME = /^[^/\\\0]+$/

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isText = (v) => typeof v === 'string' && v.trim().length > 0
const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const positive = (v) => finite(v) && v > 0

function unknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown field "${k}"`)
}

/**
 * Check and normalise a job manifest.
 * @param {unknown} input
 * @returns {{ ok: true, manifest: object } | { ok: false, errors: string[] }}
 */
export function validateManifest(input) {
  const errors = []
  if (!isObject(input)) return { ok: false, errors: ['manifest: must be an object'] }
  unknownKeys(input, TOP_KEYS, 'manifest', errors)
  if (input.manifestVersion !== MANIFEST_VERSION)
    errors.push(`manifestVersion: must be ${MANIFEST_VERSION} (got ${JSON.stringify(input.manifestVersion)})`)

  // job
  const job = input.job
  if (!isObject(job) || !isText(job.id)) errors.push('job.id: required text')
  else {
    unknownKeys(job, ['id', 'siteId', 'flightId', 'label'], 'job', errors)
    for (const k of ['siteId', 'flightId', 'label'])
      if (job[k] != null && typeof job[k] !== 'string') errors.push(`job.${k}: must be text`)
  }

  const sceneType = input.sceneType ?? 'aerial'
  if (sceneType !== 'aerial' && sceneType !== 'object') errors.push('sceneType: "aerial" or "object"')

  // crs
  const crs = input.crs
  if (!isObject(crs) || !EPSG.test(crs.horizontal ?? ''))
    errors.push('crs.horizontal: an EPSG code such as "EPSG:2193"')
  else {
    unknownKeys(crs, ['horizontal', 'vertical', 'verticalName'], 'crs', errors)
    if (crs.vertical != null && !VERTICAL_DATUM_IDS.includes(crs.vertical))
      errors.push(`crs.vertical: one of ${VERTICAL_DATUM_IDS.join(', ')}`)
    if (crs.verticalName != null && !isText(crs.verticalName)) errors.push('crs.verticalName: text such as "NZVD2016"')
  }

  // images
  const images = input.images
  const imageNames = new Set()
  if (!Array.isArray(images) || images.length === 0) errors.push('images: at least one image')
  else
    images.forEach((im, i) => {
      if (!isObject(im) || !isText(im.name) || !SAFE_NAME.test(im.name)) {
        errors.push(`images[${i}].name: a file name without a path`)
        return
      }
      unknownKeys(im, ['name', 'url', 'sha256'], `images[${i}]`, errors)
      if (imageNames.has(im.name)) errors.push(`images[${i}].name: "${im.name}" is listed twice`)
      imageNames.add(im.name)
      if (im.url != null && !isText(im.url)) errors.push(`images[${i}].url: must be text`)
      if (im.sha256 != null && !/^[0-9a-f]{64}$/.test(im.sha256)) errors.push(`images[${i}].sha256: 64 hex digits`)
    })
  if (Array.isArray(images) && images.length > 0 && images.length < 2)
    errors.push('images: photogrammetry needs at least two images')

  // camera
  if (input.camera != null) {
    if (!isObject(input.camera)) errors.push('camera: must be an object')
    else unknownKeys(input.camera, CAMERA_FIELDS, 'camera', errors)
  }

  // control
  let control = null
  if (input.control != null) {
    control = validateControl(input.control, imageNames, crs, errors)
  }

  // stages
  const stages = {}
  if (!isObject(input.stages) || Object.keys(input.stages).length === 0) errors.push('stages: at least one stage')
  else {
    unknownKeys(input.stages, STAGES, 'stages', errors)
    for (const s of STAGES) {
      const v = input.stages[s]
      if (v == null || v === false) continue
      if (!isObject(v)) {
        errors.push(`stages.${s}: an object of settings ({} for the defaults)`)
        continue
      }
      stages[s] = { ...v }
    }
    // A stage needs its input stage in the same job. A resumed job declares the whole
    // pipeline again and skips the stages its checkpoint already holds.
    for (const s of Object.keys(stages)) {
      const need = stageNeeds(s, stages[s])
      if (need && !stages[need]) errors.push(`stages.${s}: needs stages.${need}`)
    }
  }

  // outputs
  const outputs = input.outputs ?? ['report']
  if (!Array.isArray(outputs)) errors.push('outputs: a list')
  else
    for (const o of outputs) {
      if (!(o in OUTPUTS)) errors.push(`outputs: unknown output "${o}"`)
      else if (!stages[OUTPUTS[o]]) errors.push(`outputs: "${o}" needs stages.${OUTPUTS[o]}`)
    }

  // limits
  const limits = { timeoutMinutes: 240, workers: 0 }
  if (input.limits != null) {
    if (!isObject(input.limits)) errors.push('limits: must be an object')
    else {
      unknownKeys(input.limits, ['timeoutMinutes', 'workers'], 'limits', errors)
      if (input.limits.timeoutMinutes != null) {
        if (!positive(input.limits.timeoutMinutes)) errors.push('limits.timeoutMinutes: a positive number')
        else limits.timeoutMinutes = input.limits.timeoutMinutes
      }
      if (input.limits.workers != null) {
        if (!Number.isInteger(input.limits.workers) || input.limits.workers < 0 || input.limits.workers > 64)
          errors.push('limits.workers: 0 (the app decides) to 64')
        else limits.workers = input.limits.workers
      }
    }
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    manifest: {
      manifestVersion: MANIFEST_VERSION,
      job: { id: job.id, siteId: job.siteId ?? null, flightId: job.flightId ?? null, label: job.label ?? null },
      sceneType,
      crs: { horizontal: crs.horizontal, vertical: crs.vertical ?? 'unknown', verticalName: crs.verticalName ?? null },
      images: images.map((im) => ({ name: im.name, url: im.url ?? null, sha256: im.sha256 ?? null })),
      camera: input.camera ? { ...input.camera } : null,
      control,
      stages,
      outputs: [...new Set(outputs)],
      limits,
    },
  }
}

function validateControl(c, imageNames, crs, errors) {
  if (!isObject(c) || !Array.isArray(c.points)) {
    errors.push('control.points: a list')
    return null
  }
  unknownKeys(c, ['crs', 'points'], 'control', errors)
  if (c.crs != null && !EPSG.test(c.crs)) errors.push('control.crs: an EPSG code')
  const ids = new Set()
  const points = c.points.map((p, i) => {
    const at = `control.points[${i}]`
    if (!isObject(p) || !isText(p.id)) {
      errors.push(`${at}.id: required text`)
      return null
    }
    unknownKeys(
      p,
      ['id', 'name', 'role', 'x', 'y', 'z', 'sigmaX', 'sigmaY', 'sigmaZ', 'enabled', 'observations'],
      at,
      errors,
    )
    if (ids.has(p.id)) errors.push(`${at}.id: "${p.id}" is listed twice`)
    ids.add(p.id)
    if (p.role !== 'control' && p.role !== 'check') errors.push(`${at}.role: "control" or "check"`)
    for (const k of ['x', 'y', 'z']) if (!finite(p[k])) errors.push(`${at}.${k}: a number`)
    // Ground accuracy has no implicit default (stores/useGcpsStore.js): a control point
    // pulls on the adjustment by its accuracy, so it must say what that is. A check point
    // is never in the adjustment; its sigma is reported with its residual when given.
    for (const k of ['sigmaX', 'sigmaY', 'sigmaZ']) {
      if (p[k] == null) {
        if (p.role === 'control') errors.push(`${at}.${k}: a control point needs its accuracy (1σ, metres)`)
      } else if (!positive(p[k])) errors.push(`${at}.${k}: a positive number of metres`)
    }
    if (p.enabled != null && typeof p.enabled !== 'boolean') errors.push(`${at}.enabled: true or false`)
    const observations = []
    if (p.observations != null) {
      if (!Array.isArray(p.observations)) errors.push(`${at}.observations: a list`)
      else
        p.observations.forEach((o, j) => {
          const ot = `${at}.observations[${j}]`
          if (!isObject(o)) return errors.push(`${ot}: must be an object`)
          unknownKeys(o, ['image', 'px', 'py', 'sigmaPx'], ot, errors)
          if (!imageNames.has(o.image)) errors.push(`${ot}.image: "${o.image}" is not in images`)
          if (!finite(o.px) || !finite(o.py)) errors.push(`${ot}: px and py must be numbers`)
          if (o.sigmaPx != null && !positive(o.sigmaPx)) errors.push(`${ot}.sigmaPx: a positive number of pixels`)
          observations.push({ image: o.image, px: o.px, py: o.py, sigmaPx: o.sigmaPx ?? null })
        })
    }
    return {
      id: p.id,
      name: p.name ?? p.id,
      role: p.role,
      x: p.x,
      y: p.y,
      z: p.z,
      sigmaX: p.sigmaX ?? null,
      sigmaY: p.sigmaY ?? null,
      sigmaZ: p.sigmaZ ?? null,
      enabled: p.enabled ?? true,
      observations,
    }
  })
  return { crs: c.crs ?? crs?.horizontal ?? null, points: points.filter(Boolean) }
}

/**
 * What each stage's result depends on, as plain data: equal inputs mean a saved result
 * of that stage is still valid. The runner hashes these (engine/runner/checkpoint.mjs).
 *
 * Detection and matching depend on the photos and their own settings only, so a
 * corrected control point, camera or CRS reruns the job from the reconstruction, not
 * from feature detection. Every later stage depends on everything before it.
 */
export function stageInputs(manifest) {
  const photos = { sceneType: manifest.sceneType, images: manifest.images.map((im) => [im.name, im.sha256]) }
  const out = {}
  let carried = photos
  for (const s of STAGES) {
    if (!manifest.stages[s]) continue
    if (s === 'reconstruct')
      carried = { ...carried, crs: manifest.crs, camera: manifest.camera, control: manifest.control }
    carried = { ...carried, [s]: manifest.stages[s] }
    out[s] = carried
  }
  return out
}

/** Plain data as a string with object keys sorted, so key order never changes it. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`
  return JSON.stringify(value ?? null)
}

/** The stages of `manifest` still to run after the checkpoint's completed ones. */
export function stagesToRun(manifest, completed = []) {
  const done = new Set(completed)
  const wanted = STAGES.filter((s) => manifest.stages[s])
  // A stage runs again when any stage before it runs again: its input changed.
  const out = []
  let rerun = false
  for (const s of wanted) {
    if (rerun || !done.has(s)) {
      rerun = true
      out.push(s)
    }
  }
  return out
}
