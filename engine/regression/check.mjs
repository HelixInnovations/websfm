#!/usr/bin/env node
// Regression check of an engine job against its expectations: the job record's numbers,
// and the product files read back independently in Node.
//
//   node engine/regression/check.mjs <job output dir> [expectations.json]
//
// Default expectations: engine/regression/<job id minus "regression-">.expect.json.
// Exit 0 when every check passes, 1 otherwise. Digest changes are reported, not failed:
// they say the computation changed, which a deliberate improvement also does.
//
// Product checks (independent of the engine's own report):
//   GeoTIFF   opens with geotiff.js; size equals the record's; the CRS GeoKey is the
//             manifest's EPSG code
//   LAS/LAZ   header signature, point count equals the dense cloud's, and a
//             GeoKeyDirectory VLR naming the manifest's EPSG code
//   every     size and sha256 equal what the record lists
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromArrayBuffer } from 'geotiff'
import { readLasHeader } from '../../src/core/io/las.js'

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)

export async function checkJob(outputDir, expect) {
  const record = JSON.parse(await readFile(join(outputDir, 'result.json'), 'utf8'))
  const results = []
  const check = (name, ok, value, expected) => results.push({ name, ok: !!ok, value, expected })
  const epsg = Number(record.manifest.crs.horizontal.split(':')[1])

  check('status', record.status === 'succeeded', record.status, 'succeeded')
  const images = record.manifest.images.length
  if (expect.registered === 'all')
    check(
      'every photo registered',
      record.stages.reconstruct?.cameras === images,
      record.stages.reconstruct?.cameras,
      images,
    )
  for (const [path, rule] of Object.entries(expect.limits ?? {})) {
    const v = get(record.stages, path)
    const ok = typeof v === 'number' && (rule.min == null || v >= rule.min) && (rule.max == null || v <= rule.max)
    check(path, ok, v, `${rule.min ?? '−∞'} … ${rule.max ?? '∞'} (measured ${rule.measured})`)
  }
  for (const out of expect.outputs ?? [])
    check(
      `output ${out}`,
      record.products.some((p) => p.output === out),
      null,
      'present',
    )

  for (const p of record.products) {
    const bytes = await readFile(join(outputDir, p.file))
    const sha = createHash('sha256').update(bytes).digest('hex')
    check(`${p.output}: checksum`, sha === p.sha256 && bytes.length === p.bytes, bytes.length, p.bytes)
    if (p.file.endsWith('.tif')) {
      const tiff = await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      const img = await tiff.getImage()
      const kind = p.output.split(':')[0]
      const want = record.describe?.[kind]
      check(
        `${p.output}: size`,
        img.getWidth() === want?.width && img.getHeight() === want?.height,
        `${img.getWidth()}×${img.getHeight()}`,
        want && `${want.width}×${want.height}`,
      )
      const keys = img.getGeoKeys() ?? {}
      check(`${p.output}: CRS GeoKey`, keys.ProjectedCSTypeGeoKey === epsg, keys.ProjectedCSTypeGeoKey, epsg)
    } else if (/\.la[sz]$/.test(p.file)) {
      const h = readLasHeader(new Uint8Array(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 1 << 20)))
      const want = record.describe?.denseCloud?.points
      check(`${p.output}: point count`, h.count === want, h.count, want)
      const geo = h.vlrs.find((v) => v.userId === 'LASF_Projection' && v.recordId === 34735)
      const shorts = geo
        ? new Uint16Array(geo.data.buffer.slice(geo.data.byteOffset, geo.data.byteOffset + geo.data.byteLength))
        : null
      check(
        `${p.output}: CRS GeoKey VLR`,
        !!shorts && Array.from(shorts).includes(epsg),
        geo ? 'present' : 'missing',
        epsg,
      )
    }
  }

  const digests = Object.entries(expect.digests ?? {}).map(([path, want]) => ({
    path,
    want,
    got: get(record.stages, path),
  }))
  return { record, results, digests, ok: results.every((r) => r.ok) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: check.mjs <job output dir> [expectations.json]')
    process.exit(2)
  }
  const record = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'))
  const file = process.argv[3] ?? new URL(`./${record.job.id.replace(/^regression-/, '')}.expect.json`, import.meta.url)
  const expect = JSON.parse(await readFile(file, 'utf8'))
  const { results, digests, ok } = await checkJob(dir, expect)
  for (const r of results)
    console.log(
      `${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}: ${JSON.stringify(r.value)}${r.ok ? '' : `  (expected ${r.expected})`}`,
    )
  for (const d of digests)
    console.log(
      `${d.got === d.want ? 'same' : 'CHANGED'}  digest ${d.path}: ${d.got}${d.got === d.want ? '' : ` (was ${d.want})`}`,
    )
  console.log(ok ? 'regression check passed' : 'regression check FAILED')
  process.exit(ok ? 0 : 1)
}
