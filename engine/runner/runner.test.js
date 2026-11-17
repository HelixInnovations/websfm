// The runner's pieces that need no browser: the job server's isolation and path rules,
// the checkpoint's resume decision, and photo validation before a job starts.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { startJobServer, safeInputName, insideRoot } from './server.mjs'
import { resumePlan, stageKeys, writeCheckpoint, readCheckpoint } from './checkpoint.mjs'
import { verifyInputs } from './runJob.mjs'
import { validateManifest } from '../manifest/manifest.js'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
const sha = (b) => createHash('sha256').update(b).digest('hex')

let dir
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engine-runner-'))
  await mkdir(join(dir, 'build/engine/page'), { recursive: true })
  await mkdir(join(dir, 'input'))
  await writeFile(join(dir, 'build/engine/page/engine.html'), '<p>engine</p>')
  await writeFile(join(dir, 'secret.txt'), 'outside')
  await writeFile(join(dir, 'input/A.JPG'), JPEG)
  await writeFile(join(dir, 'input/B.JPG'), JPEG)
  await writeFile(join(dir, 'input/notes.txt'), 'not a photo')
  await writeFile(join(dir, 'input/empty.jpg'), '')
})
afterAll(() => rm(dir, { recursive: true, force: true }))

describe('job server', () => {
  it('names and paths: a photo is a plain name, and nothing outside the build is served', () => {
    expect(safeInputName('DJI_0001.JPG')).toBe(true)
    for (const bad of ['../x.jpg', 'a/b.jpg', 'a\\b.jpg', '..', '', 'a\0.jpg']) expect(safeInputName(bad)).toBe(false)
    expect(insideRoot('/srv/build', '/engine/page/engine.html')).toBe('/srv/build/engine/page/engine.html')
    expect(insideRoot('/srv/build', '/../secret')).toBeNull()
    expect(insideRoot('/srv/build', '/../build-other/x')).toBeNull()
  })

  it('serves the build cross-origin isolated, photos from the input folder, and refuses the rest', async () => {
    const srv = await startJobServer({ buildDir: join(dir, 'build'), inputDir: join(dir, 'input') })
    try {
      const page = await fetch(`${srv.url}/engine/page/engine.html`)
      expect(page.status).toBe(200)
      expect(page.headers.get('cross-origin-opener-policy')).toBe('same-origin')
      expect(page.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
      const photo = await fetch(`${srv.url}/job/input/A.JPG`)
      expect(photo.status).toBe(200)
      expect(photo.headers.get('content-type')).toBe('image/jpeg')
      expect(Buffer.from(await photo.arrayBuffer())).toEqual(JPEG)
      expect((await fetch(`${srv.url}/job/input/missing.JPG`)).status).toBe(404)
      expect((await fetch(`${srv.url}/job/input/..%2Fsecret.txt`)).status).toBe(404)
      expect((await fetch(`${srv.url}/..%2Fsecret.txt`)).status).toBe(404)
      expect((await fetch(`${srv.url}/job/input/A.JPG`, { method: 'POST' })).status).toBe(405)
    } finally {
      await srv.close()
    }
  })
})

describe('verifyInputs', () => {
  const manifestWith = (images) =>
    validateManifest({
      manifestVersion: 1,
      job: { id: 'j' },
      crs: { horizontal: 'EPSG:2193' },
      images,
      stages: { detect: {} },
    }).manifest

  it('accepts photos and records their checksums', async () => {
    const r = await verifyInputs(
      manifestWith([{ name: 'A.JPG' }, { name: 'B.JPG', sha256: sha(JPEG) }]),
      join(dir, 'input'),
    )
    expect(r.errors).toEqual([])
    expect(r.images.map((i) => [i.name, i.kind, i.sha256])).toEqual([
      ['A.JPG', 'jpeg', sha(JPEG)],
      ['B.JPG', 'jpeg', sha(JPEG)],
    ])
  })

  it('refuses missing, empty, non-photo and altered files before any processing', async () => {
    const r = await verifyInputs(
      manifestWith([
        { name: 'A.JPG', sha256: '0'.repeat(64) },
        { name: 'gone.JPG' },
        { name: 'empty.jpg' },
        { name: 'notes.txt' },
      ]),
      join(dir, 'input'),
    )
    expect(r.errors).toEqual([
      'A.JPG: checksum differs from the manifest (corrupted or replaced)',
      'gone.JPG: missing from the input folder',
      'empty.jpg: empty file',
      'notes.txt: not a JPEG, TIFF or PNG photo',
    ])
  })
})

describe('checkpoint', () => {
  const m = validateManifest({
    manifestVersion: 1,
    job: { id: 'job-9' },
    crs: { horizontal: 'EPSG:2193' },
    images: [{ name: 'A.JPG' }, { name: 'B.JPG' }],
    control: { points: [{ id: 'G1', role: 'control', x: 1, y: 2, z: 3, sigmaX: 0.02, sigmaY: 0.02, sigmaZ: 0.03 }] },
    stages: { detect: {}, match: {}, reconstruct: {}, depth: {}, dense: {} },
  }).manifest
  const keys = stageKeys(m)
  const cp = (done) => ({
    jobId: 'job-9',
    engineBuild: 'build-1',
    profileDir: '/p',
    projectId: 'proj',
    ingested: true,
    completed: done.map((s) => ({ stage: s, key: keys[s] })),
  })

  it('resumes after the last stage whose inputs still match', () => {
    expect(resumePlan(cp(['detect', 'match', 'reconstruct']), m, 'build-1')).toEqual({
      resume: true,
      projectId: 'proj',
      profileDir: '/p',
      completed: ['detect', 'match', 'reconstruct'],
    })
  })

  it('a corrected control point keeps detection and matching, reruns the reconstruction', () => {
    const corrected = structuredClone(m)
    corrected.control.points[0].z = 3.1
    expect(resumePlan(cp(['detect', 'match', 'reconstruct', 'depth']), corrected, 'build-1').completed).toEqual([
      'detect',
      'match',
    ])
  })

  it('never resumes on another engine build, another job, or a half-ingested project', () => {
    expect(resumePlan(cp(['detect']), m, 'build-2')).toMatchObject({ resume: false })
    expect(resumePlan({ ...cp(['detect']), jobId: 'other' }, m, 'build-1')).toMatchObject({ resume: false })
    expect(resumePlan({ ...cp([]), ingested: false }, m, 'build-1')).toMatchObject({ resume: false })
    expect(resumePlan(null, m, 'build-1')).toMatchObject({ resume: false, reason: 'no checkpoint' })
  })

  it('round-trips through the file', async () => {
    await writeCheckpoint(dir, cp(['detect']))
    expect(await readCheckpoint(dir)).toEqual(cp(['detect']))
  })
})
