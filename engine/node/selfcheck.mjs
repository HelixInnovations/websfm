// Loads the engine core in plain Node and checks it works there: every module the
// platform's Node-side analytics use imports, the WASM kernels start, and a CRS
// resolves from the bundled EPSG catalog. Prints one JSON line.
//
//   node --import ./engine/node/register.mjs engine/node/selfcheck.mjs
//
// engine/node/register.test.js runs it in a child process.
import { readFile } from 'node:fs/promises'

const root = new URL('../../src/', import.meta.url)

// The modules the Node side relies on (AUDIT.md ▸ Reuse map ▸ Reuse as is), and the
// SfM and dense entry points, which load here although the platform runs them in
// Chromium.
export const CORE_MODULES = [
  'core/products/measure.js',
  'core/products/contours.js',
  'core/products/dxf.js',
  'core/products/dem.js',
  'core/products/georef.js',
  'core/products/exporters.js',
  'core/products/geotiff.js',
  'core/products/terrain.js',
  'core/products/groundFilter.js',
  'core/eval/demCompare.js',
  'core/eval/demCoregister.js',
  'core/eval/positionCheck.js',
  'core/io/gcp.js',
  'core/io/las.js',
  'core/sfm/tagDetect.js',
  'core/sfm/targetDetect.js',
  'core/sfm/targetPredict.js',
  'core/sfm/gcpTriangulation.js',
  'core/sfm/surveyConstraints.js',
  'core/gcpAccuracy.js',
  'core/crs.js',
  'core/crsRegistry.js',
  'core/verticalDatum.js',
  'core/workflowGate.js',
  'core/sfm/sfm.js',
  'core/dense/mvs.js',
]

const out = { modules: {}, wasm: {}, crs: null }
for (const m of CORE_MODULES) {
  try {
    const mod = await import(new URL(m, root).href)
    out.modules[m] = Object.keys(mod).length
  } catch (err) {
    out.modules[m] = `error: ${String(err?.message ?? err).split('\n')[0]}`
  }
}

for (const [name, file] of [
  ['reconstruction', 'wasm/reconstruction/reconstruction'],
  ['detection', 'wasm/detection/sift'],
  ['matching', 'wasm/matching/matching'],
]) {
  try {
    const glue = await import(new URL(`${file}.js`, root).href)
    const bytes = await readFile(new URL(`${file}_bg.wasm`, root))
    await glue.default({ module_or_path: bytes })
    out.wasm[name] = 'ok'
  } catch (err) {
    out.wasm[name] = `error: ${String(err?.message ?? err).split('\n')[0]}`
  }
}

// NZTM2000 from the catalog: its natural origin (173° E, 0°) maps to the false origin,
// E 1,600,000 m and N 10,000,000 m, by the projection's definition (LINZ).
try {
  const crs = await import(new URL('core/crs.js', root).href)
  await crs.ensureProjection('EPSG:2193')
  const [e, n] = crs.transform([173, 0], 'EPSG:4326', 'EPSG:2193')
  out.crs = { code: 'EPSG:2193', e, n }
} catch (err) {
  out.crs = `error: ${String(err?.message ?? err).split('\n')[0]}`
}

console.log(JSON.stringify(out))
