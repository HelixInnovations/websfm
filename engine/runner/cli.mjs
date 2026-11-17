#!/usr/bin/env node
// Run one engine job from the command line.
//
//   node engine/runner/cli.mjs --manifest job.json --input <photos> --output <dir>
//        [--build <stamped engine build>] [--no-resume] [--headed] [--no-gpu]
//        [--keep-profile] [--chromium]
//
// Without --build it builds the engine page first (into <output>/../engine-build).
// Exit code: 0 succeeded, 1 failed, 2 could not start.
import { readFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { runJob } from './runJob.mjs'
import { buildEngine, readStamp } from './build.mjs'

const { values: a } = parseArgs({
  options: {
    'manifest': { type: 'string' },
    'input': { type: 'string' },
    'output': { type: 'string' },
    'build': { type: 'string' },
    'no-resume': { type: 'boolean' },
    'headed': { type: 'boolean' },
    'no-gpu': { type: 'boolean' },
    'keep-profile': { type: 'boolean' },
    'chromium': { type: 'boolean' },
  },
})

if (!a.manifest || !a.input || !a.output) {
  console.error('usage: cli.mjs --manifest job.json --input <photos> --output <dir> [--build <dir>]')
  process.exit(2)
}

try {
  const manifest = JSON.parse(await readFile(a.manifest, 'utf8'))
  let buildDir = a.build ? resolve(a.build) : join(dirname(resolve(a.output)), 'engine-build')
  if (!a.build || !(await readStamp(buildDir))) buildDir = (await buildEngine({ outDir: buildDir })).dir
  const t0 = Date.now()
  const record = await runJob({
    manifest,
    inputDir: a.input,
    outputDir: a.output,
    buildDir,
    resume: !a['no-resume'],
    headless: !a.headed,
    gpu: !a['no-gpu'],
    channel: a.chromium ? null : 'chrome',
    keepProfile: !!a['keep-profile'],
    onEvent: (e) => {
      const t = ((Date.now() - t0) / 1000).toFixed(0).padStart(5)
      if (e.type === 'stage')
        console.log(`${t}s  ${e.stage} ${e.status}${e.seconds != null ? ` (${e.seconds.toFixed(1)} s)` : ''}`)
      else if (e.type === 'engine')
        console.log(
          `${t}s  engine: WebSfM ${e.info.websfmVersion}, ${e.info.pool.size} workers, GPU ${e.info.gpu.available ? `${e.info.gpu.vendor} ${e.info.gpu.architecture}`.trim() : 'none'}, isolated ${e.info.crossOriginIsolated}`,
        )
      else if (e.type === 'failed') console.log(`${t}s  FAILED at ${e.stage}: ${e.message}`)
      else if (e.type === 'product') console.log(`${t}s  product ${e.output}: ${e.files} file(s)`)
      else if (e.type === 'log' && e.level === 'error') console.log(`${t}s  error: ${e.message}`)
    },
  })
  console.log(`${record.status} in ${record.seconds.toFixed(0)} s → ${resolve(a.output)}/result.json`)
  process.exit(record.status === 'succeeded' ? 0 : 1)
} catch (err) {
  console.error(String(err?.stack ?? err))
  process.exit(2)
}
