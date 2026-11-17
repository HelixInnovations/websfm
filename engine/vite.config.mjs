// Build config for the engine page: the app's own Vite config with engine/page/engine.html
// as the only entry, so a processing host runs a frozen build of exactly this commit's
// code. Unlike the bench build it may be deployed, so the restricted-model exclusion in
// vite.config.js stays on (it keys off BENCH_OUT_DIR, which this build never sets).
//
//   ENGINE_OUT_DIR=build/engine npx vite build --config engine/vite.config.mjs
//
// engine/runner/build.mjs runs this and stamps the result.
import baseConfig from '../vite.config.js'

export default (env) => {
  const cfg = baseConfig(env)
  if (!process.env.ENGINE_OUT_DIR) throw new Error('engine build: set ENGINE_OUT_DIR')
  return {
    ...cfg,
    build: {
      ...cfg.build,
      outDir: process.env.ENGINE_OUT_DIR,
      emptyOutDir: true,
      rollupOptions: { input: 'engine/page/engine.html' },
    },
  }
}
