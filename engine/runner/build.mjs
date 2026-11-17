// Builds the engine page (engine/vite.config.mjs) into a folder and stamps it, so every
// job records exactly which code produced it.
//
//   const { dir, stamp } = await buildEngine({ outDir })
//   stamp = { id, websfmVersion, gitSha, gitDirty, wasm, builtAt }
//     id    sha256 of the version, commit and WASM stamp: the checkpoint's `engineBuild`
//
// An existing build with a stamp is reused by passing it to runJob as `buildDir`.
import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from './checkpoint.mjs'

export const REPO = fileURLToPath(new URL('../../', import.meta.url))
export const STAMP_FILE = 'engine-build.json'

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

export async function buildEngine({ outDir, log = console.log } = {}) {
  const dir = resolve(outDir)
  const t0 = Date.now()
  await new Promise((ok, fail) => {
    const p = spawn(
      process.execPath,
      [
        join(REPO, 'node_modules/vite/bin/vite.js'),
        'build',
        '--config',
        'engine/vite.config.mjs',
        '--logLevel',
        'error',
      ],
      { cwd: REPO, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ENGINE_OUT_DIR: dir } },
    )
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`engine build failed (exit ${code})`))))
  })
  const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'))
  const wasm = sha256(await readFile(join(REPO, 'src/wasm/build-stamp.json'), 'utf8'))
  const gitSha = git(['rev-parse', 'HEAD'])
  const gitDirty = git(['status', '--porcelain', '--', 'src', 'engine', 'tests/bench'])
  const stamp = {
    websfmVersion: pkg.version,
    gitSha,
    // Uncommitted changes to the engine's code: a dirty build is never the same build
    // as another, so its id includes the time.
    gitDirty: gitDirty ? true : gitDirty === '' ? false : null,
    wasm,
    builtAt: new Date().toISOString(),
  }
  stamp.id = sha256(
    JSON.stringify([stamp.websfmVersion, stamp.gitSha, stamp.wasm, stamp.gitDirty ? stamp.builtAt : null]),
  )
  await writeFile(join(dir, STAMP_FILE), JSON.stringify(stamp, null, 2))
  log(
    `engine build ${stamp.id.slice(0, 12)} (WebSfM ${stamp.websfmVersion}, ${gitSha?.slice(0, 8) ?? 'no git'}${stamp.gitDirty ? ', uncommitted changes' : ''}) in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${dir}`,
  )
  return { dir, stamp }
}

export async function readStamp(buildDir) {
  try {
    return JSON.parse(await readFile(join(buildDir, STAMP_FILE), 'utf8'))
  } catch {
    return null
  }
}
