// Module resolve hooks that let plain Node import `src/core/` (engine/node/register.mjs
// installs them). They do exactly what Vite does for the core and nothing more:
//
// 1. `X?url` — a static asset URL. Resolves to a module whose default export is the
//    file's own `file:` URL. Only `core/crsRegistry.js` uses one (the EPSG catalog);
//    register.mjs lets `fetch` read `file:` URLs so that fetch works unchanged.
// 2. A bare `ol/<path>` without an extension — OpenLayers is published as ES modules
//    without an `exports` map, so a bundler adds `.js` and Node must be told to.
//
// Nothing here changes what a module computes. AUDIT.md ▸ "Can the engine run on a
// server?" records the probe these hooks came from.
//
// `resolve` works with both of Node's hook APIs: `module.registerHooks` (synchronous
// `nextResolve`, Node ≥ 22.15) and `module.register` (asynchronous, older Node).

const OL_BARE = /^ol\/[^?]+$/

const then = (value, f) => (value && typeof value.then === 'function' ? value.then(f) : f(value))

export function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('?url')) {
    return then(nextResolve(specifier.slice(0, -'?url'.length), context), (target) => {
      const source = `export default ${JSON.stringify(target.url)}`
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    })
  }
  if (OL_BARE.test(specifier) && !specifier.endsWith('.js')) return nextResolve(`${specifier}.js`, context)
  return nextResolve(specifier, context)
}
