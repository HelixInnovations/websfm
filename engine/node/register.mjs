// Lets plain Node import the engine's pure core (`src/core/`):
//
//   node --import ./engine/node/register.mjs my-script.mjs
//   import './engine/node/register.mjs'   // first, before any src/core import
//
// It installs the resolve hooks in hooks.mjs and makes `fetch` able to read `file:`
// URLs, which is how a `?url` asset (the EPSG catalog) arrives in Node. Every other
// URL scheme goes to Node's own fetch untouched.
import * as nodeModule from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from './hooks.mjs'

if (typeof nodeModule.registerHooks === 'function') nodeModule.registerHooks({ resolve })
else nodeModule.register(new URL('./hooks.mjs', import.meta.url))

const nodeFetch = globalThis.fetch
if (!globalThis.fetch.__engineFileUrls) {
  const fileFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
    if (typeof url === 'string' && url.startsWith('file:')) {
      try {
        const body = await readFile(fileURLToPath(url))
        return new Response(body, { status: 200 })
      } catch (err) {
        if (err?.code === 'ENOENT') return new Response(null, { status: 404, statusText: 'Not Found' })
        throw err
      }
    }
    return nodeFetch(input, init)
  }
  fileFetch.__engineFileUrls = true
  globalThis.fetch = fileFetch
}
