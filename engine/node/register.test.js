// The engine core in plain Node, through engine/node/register.mjs: what the platform's
// Node-side analytics rely on. Runs selfcheck.mjs in a child process, since Vitest's
// own module loader would hide whether the hooks are needed or enough.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const repo = fileURLToPath(new URL('../../', import.meta.url))

describe('engine core in plain Node', () => {
  const stdout = execFileSync(
    process.execPath,
    ['--import', './engine/node/register.mjs', 'engine/node/selfcheck.mjs'],
    { cwd: repo, encoding: 'utf8', timeout: 60_000 },
  )
  const result = JSON.parse(stdout.trim().split('\n').at(-1))

  it('imports every core module the Node side uses', () => {
    const failed = Object.entries(result.modules).filter(([, v]) => typeof v !== 'number' || v === 0)
    expect(failed).toEqual([])
  })

  it('starts the WASM kernels from bytes', () => {
    expect(result.wasm).toEqual({ reconstruction: 'ok', detection: 'ok', matching: 'ok' })
  })

  it('resolves NZTM2000 from the bundled catalog: the natural origin maps to the false origin', () => {
    // EPSG:2193 is not built in; it comes from epsg-index through the `?url` hook and the
    // file: fetch. 173° E on the equator is E 1,600,000 m, N 10,000,000 m by definition.
    expect(result.crs.code).toBe('EPSG:2193')
    expect(result.crs.e).toBeCloseTo(1_600_000, 3)
    expect(result.crs.n).toBeCloseTo(10_000_000, 3)
  })
}, 90_000)
