// Runs one engine job: a manifest and a folder of photos in, a job record and product
// files out. The engine is the WebSfM app itself, in headless Chrome, one browser profile
// per job so jobs never see each other's data (AUDIT.md ▸ "Can the engine run on a
// server?").
//
//   const record = await runJob({ manifest, inputDir, outputDir, buildDir })
//
// outputDir after a run:
//   result.json        the job record: status, engine build, stages, control, products
//   checkpoint.json    what finished, for `resume` (checkpoint.mjs)
//   engine.log         every app log line, in the dev console's export format
//   events.ndjson      every event the page sent, one JSON object per line
//   products/<output>/ each requested output's files, as the app's Export writes them
//   profile/           the browser profile; kept after a failure so the job can resume
//
// Options:
//   resume        continue from checkpoint.json if it still matches (default true)
//   timeoutMs     the whole job, default manifest.limits.timeoutMinutes
//   signal        an AbortSignal: aborting closes the browser and fails the job
//   onEvent(e)    every page event and app log line as it happens
//   headless, gpu, channel ('chrome' default: the installed Chrome; null: Playwright's)
//   keepProfile   keep the profile after a success too
//
// A failed job resolves with status 'failed' and the stage and reason; it throws only
// when it could not start at all (a bad manifest, missing photos, no browser).
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validateManifest } from '../manifest/manifest.js'
import { startJobServer, safeInputName } from './server.mjs'
import { readCheckpoint, writeCheckpoint, resumePlan, stageKeys } from './checkpoint.mjs'
import { readStamp } from './build.mjs'

export const RUNNER_VERSION = 1
const ENGINE_API_VERSION = 1

// Leading bytes of the photo formats the app reads. A truncated or mislabelled upload
// is caught here, before a browser starts; ingest then proves each one decodes.
const MAGIC = [
  { kind: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { kind: 'tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { kind: 'tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { kind: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
]

async function fileSha256(file) {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(file)) h.update(chunk)
  return h.digest('hex')
}

/**
 * Check every photo the manifest lists before any processing: present, not empty, a
 * photo format, and the declared checksum. → { images: [{ name, bytes, kind, sha256 }], errors }
 */
export async function verifyInputs(manifest, inputDir) {
  const errors = []
  const images = []
  for (const im of manifest.images) {
    if (im.url) {
      images.push({ name: im.name, url: im.url })
      continue
    }
    if (!safeInputName(im.name)) {
      errors.push(`${im.name}: not a plain file name`)
      continue
    }
    const file = join(inputDir, im.name)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) {
      errors.push(`${im.name}: missing from the input folder`)
      continue
    }
    if (info.size === 0) {
      errors.push(`${im.name}: empty file`)
      continue
    }
    const fh = await open(file, 'r')
    const head = Buffer.alloc(8)
    await fh.read(head, 0, 8, 0)
    await fh.close()
    const kind = MAGIC.find((m) => m.bytes.every((b, i) => head[i] === b))?.kind ?? null
    if (!kind) {
      errors.push(`${im.name}: not a JPEG, TIFF or PNG photo`)
      continue
    }
    const sha256 = await fileSha256(file)
    if (im.sha256 && im.sha256 !== sha256) {
      errors.push(`${im.name}: checksum differs from the manifest (corrupted or replaced)`)
      continue
    }
    images.push({ name: im.name, bytes: info.size, kind, sha256 })
  }
  return { images, errors }
}

async function filesUnder(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await filesUnder(p)))
    else out.push(p)
  }
  return out
}

const fmtLog = (e) => `${e.time}  ${String(e.source ?? '').padEnd(10)}  ${String(e.level).padEnd(7)}  ${e.message}`

export async function runJob({
  manifest: input,
  inputDir,
  outputDir,
  buildDir,
  resume = true,
  timeoutMs = null,
  signal = null,
  onEvent = () => {},
  headless = true,
  gpu = true,
  channel = 'chrome',
  keepProfile = false,
}) {
  const v = validateManifest(input)
  if (!v.ok) throw new Error(`invalid manifest:\n  ${v.errors.join('\n  ')}`)
  const manifest = v.manifest
  inputDir = resolve(inputDir)
  outputDir = resolve(outputDir)
  buildDir = resolve(buildDir)
  await mkdir(outputDir, { recursive: true })

  const stamp = await readStamp(buildDir)
  if (!stamp?.id) throw new Error(`${buildDir} is not a stamped engine build (engine/runner/build.mjs)`)

  const startedAt = new Date()
  const record = {
    runnerVersion: RUNNER_VERSION,
    status: 'running',
    job: manifest.job,
    engine: { build: stamp, info: null },
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    seconds: null,
    resumed: null,
    inputs: null,
    stages: {},
    control: null,
    georeference: null,
    products: [],
    error: null,
    manifest,
  }
  const writeRecord = () => writeFile(join(outputDir, 'result.json'), JSON.stringify(record, null, 2))

  const inputs = await verifyInputs(manifest, inputDir)
  record.inputs = { images: inputs.images.length, bytes: inputs.images.reduce((n, i) => n + (i.bytes ?? 0), 0) }
  if (inputs.errors.length) {
    record.status = 'failed'
    record.error = { stage: 'validation', message: `the photos failed validation:\n${inputs.errors.join('\n')}` }
    record.finishedAt = new Date().toISOString()
    await writeRecord()
    return record
  }
  // Record each photo's checksum: the job's lineage names exactly the bytes it processed.
  record.inputs.checksums = Object.fromEntries(inputs.images.filter((i) => i.sha256).map((i) => [i.name, i.sha256]))

  const { chromium } = await import('playwright')

  // Resume or start over. The project lives in the profile's storage for the page's
  // origin, which includes the server's port: a resumed job must be served on the port
  // its checkpoint recorded, or it would find an empty storage.
  const previous = resume ? await readCheckpoint(outputDir) : null
  let plan = resume ? resumePlan(previous, manifest, stamp.id) : { resume: false, reason: 'resume off' }
  let server = null
  if (plan.resume) {
    server = await startJobServer({ buildDir, inputDir, port: previous.port ?? -1 }).catch(() => null)
    if (!server) plan = { resume: false, reason: `port ${previous.port} of the checkpoint is in use or unknown` }
  }
  server ??= await startJobServer({ buildDir, inputDir })
  const profileDir = plan.resume ? plan.profileDir : join(outputDir, 'profile')
  if (!plan.resume) await rm(profileDir, { recursive: true, force: true })
  record.resumed = plan.resume ? { completed: plan.completed } : { completed: [], reason: plan.reason }
  const keys = stageKeys(manifest)
  const port = Number(new URL(server.url).port)
  const checkpoint = plan.resume
    ? { ...previous, completed: plan.completed.map((s) => ({ stage: s, key: keys[s] })) }
    : {
        jobId: manifest.job.id,
        engineBuild: stamp.id,
        profileDir,
        port,
        projectId: null,
        ingested: false,
        completed: [],
      }
  await writeCheckpoint(outputDir, checkpoint)

  const logOut = createWriteStream(join(outputDir, 'engine.log'), { flags: plan.resume ? 'a' : 'w' })
  const eventsOut = createWriteStream(join(outputDir, 'events.ndjson'), { flags: plan.resume ? 'a' : 'w' })
  const emit = (e) => {
    eventsOut.write(JSON.stringify(e) + '\n')
    try {
      onEvent(e)
    } catch {
      // a listener's error never stops the job
    }
  }

  let context = null
  let pageError = null
  const pending = []
  const deadline = timeoutMs ?? manifest.limits.timeoutMinutes * 60_000
  let timer = null
  const stopped = new Promise((_, fail) => {
    timer = setTimeout(
      () => fail(new Error(`the job ran past its ${Math.round(deadline / 60_000)} min limit`)),
      deadline,
    )
    signal?.addEventListener('abort', () => fail(new Error('the job was cancelled')), { once: true })
  })
  stopped.catch(() => {})

  let currentStage = 'start'
  try {
    // WebGPU in headless Chrome needs these flags; without a GPU the app's probe falls
    // back to the WASM paths and the record says which ran (engine.info().gpu).
    const args = gpu ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] : []
    context = await chromium.launchPersistentContext(profileDir, {
      ...(channel ? { channel } : {}),
      headless,
      args,
      acceptDownloads: true,
      viewport: { width: 1280, height: 800 },
    })
    const page = context.pages()[0] ?? (await context.newPage())
    page.on('console', (msg) => {
      const text = msg.text()
      if (text.startsWith('@@LOG ')) {
        try {
          const e = JSON.parse(text.slice(6))
          logOut.write(fmtLog(e) + '\n')
          if (e.level === 'error' || e.level === 'warn') emit({ type: 'log', ...e })
        } catch {
          /* a malformed line is not a reason to fail a job */
        }
        return
      }
      if (!text.startsWith('@@EVENT ')) return
      let e
      try {
        e = JSON.parse(text.slice(8))
      } catch {
        return
      }
      emit(e)
      if (e.type === 'stage' && e.status === 'running') currentStage = e.stage
      // Checkpoints are written as the page reports them, so a crash right after a stage
      // still keeps it.
      if (e.type === 'project') {
        checkpoint.projectId = e.projectId
        pending.push(writeCheckpoint(outputDir, checkpoint))
      } else if (e.type === 'checkpoint') {
        if (e.stage === 'ingest') checkpoint.ingested = true
        else if (keys[e.stage]) {
          checkpoint.completed = [
            ...checkpoint.completed.filter((c) => c.stage !== e.stage),
            { stage: e.stage, key: keys[e.stage] },
          ]
        }
        pending.push(writeCheckpoint(outputDir, checkpoint))
      }
    })
    page.on('pageerror', (err) => {
      logOut.write(`${new Date().toISOString()}  page        error    ${err.message}\n`)
      emit({ type: 'pageerror', message: err.message })
    })
    page.on('crash', () => {
      pageError = new Error('the browser page crashed (out of memory?)')
    })

    await Promise.race([page.goto(`${server.url}/engine/page/engine.html`), stopped])
    await Promise.race([page.waitForFunction(() => window.engineReady === true, null, { timeout: 120_000 }), stopped])
    const info = await page.evaluate(() => window.engine.info())
    if (info.apiVersion !== ENGINE_API_VERSION)
      throw new Error(`engine page API ${info.apiVersion}, this runner speaks ${ENGINE_API_VERSION}`)
    record.engine.info = info
    emit({ type: 'engine', info })
    await writeRecord()

    const resumeArg = plan.resume ? { projectId: plan.projectId, completed: plan.completed } : null
    const crashed = new Promise((_, fail) => page.once('crash', () => fail(pageError)))
    crashed.catch(() => {})
    const run = await Promise.race([
      page.evaluate(([m, r]) => window.engine.run(m, { resume: r }), [manifest, resumeArg]),
      stopped,
      crashed,
    ])
    await Promise.all(pending)
    record.stages = run.stages
    record.control = run.control
    record.georeference = run.georeference ?? run.control?.georeference ?? null
    record.projectId = run.projectId
    record.pool = run.pool ?? null

    // Products: each output through the app's Export; its files arrive as downloads.
    for (const output of manifest.outputs) {
      if (output === 'report') continue
      currentStage = `export ${output}`
      const dir = join(outputDir, 'products', output.replace(':', '-'))
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      const saves = []
      const onDownload = (d) => saves.push(d.saveAs(join(dir, d.suggestedFilename())))
      page.on('download', onDownload)
      try {
        await Promise.race([page.evaluate((o) => window.engine.export(o), output), stopped, crashed])
        // A download begins after the export's click; a large blob can take a while to
        // start. Wait for the first, then for a quiet spell for any more.
        for (let t = 0; t < 300 && !saves.length; t++) await page.waitForTimeout(1000)
        for (let n = -1; n !== saves.length;) {
          n = saves.length
          await page.waitForTimeout(2000)
        }
        await Promise.all(saves)
      } finally {
        page.off('download', onDownload)
      }
      const files = await filesUnder(dir)
      if (!files.length) throw Object.assign(new Error(`${output}: the export wrote no file`), { stage: currentStage })
      for (const f of files) {
        const info = await stat(f)
        record.products.push({
          output,
          file: f.slice(outputDir.length + 1),
          bytes: info.size,
          sha256: await fileSha256(f),
        })
      }
      emit({ type: 'product', output, files: files.length })
    }
    record.describe = await page.evaluate(() => window.engine.describe())
    record.status = 'succeeded'
  } catch (err) {
    record.status = signal?.aborted ? 'cancelled' : 'failed'
    const message = String(err?.message ?? err)
    // The page's StageError names its stage first ("dense: the dense cloud is empty").
    const stage = /^(\w+): /.exec(message.replace(/^.*?Error: /s, ''))?.[1] ?? err?.stage ?? currentStage
    record.error = { stage, message: message.replace(/^page\.evaluate: /, '').split('\n    at ')[0] }
    emit({ type: 'failed', ...record.error })
  } finally {
    clearTimeout(timer)
    await Promise.allSettled(pending)
    await context?.close().catch(() => {})
    await server.close()
    record.finishedAt = new Date().toISOString()
    record.seconds = (Date.now() - startedAt.getTime()) / 1000
    record.checkpoint = { completed: checkpoint.completed.map((c) => c.stage), ingested: checkpoint.ingested }
    await writeRecord()
    await new Promise((ok) => logOut.end(ok))
    await new Promise((ok) => eventsOut.end(ok))
    if (record.status === 'succeeded' && !keepProfile) await rm(profileDir, { recursive: true, force: true })
  }
  return record
}
