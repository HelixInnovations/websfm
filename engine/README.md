# The engine as a service

`engine/` runs WebSfM's photogrammetry unattended, one job at a time per browser, for
the autonomous surveying platform ([docs/platform/](../docs/platform/)). It adds no
algorithm: a job runs the app's own stores, worker pool, WASM and WebGPU in headless
Chrome, and the platform's Node services import the pure core (`src/core/`) directly.
[docs/platform/AUDIT.md](../docs/platform/AUDIT.md) explains why it is split this way.

```
manifest.json + photos ─► runner (Node) ─► job server (127.0.0.1) ─► headless Chrome
                                │                                    engine page
                                │                                    = the app's stores,
                                ▼                                      workers, WASM, GPU
                         result.json, checkpoint.json, engine.log, products/
```

| Folder | What it holds |
| --- | --- |
| `manifest/` | The job manifest (version 1): validation, stage order, what each stage's result depends on. Pure; the runner, the page and the platform API share it |
| `page/` | The engine page: `window.engine.info()`, `.run(manifest, { resume })`, `.export(output)`, `.describe()` |
| `runner/` | `runJob()`, the per-job server, checkpoints, the stamped build, the CLI |
| `node/` | `register.mjs`: lets plain Node import `src/core/` (two resolve rules, `file:` fetch) |
| `qa/` | Accuracy statistics shared by the page and the platform (check and control residuals) |
| `regression/` | The example dataset's manifest, its expectations, and the checker |

## Running a job

```bash
npm run fetch:examples            # once: the Aukerman example (42 photos, CC0)
npm run engine:regression         # build, run the example end to end, check it
```

```bash
node engine/runner/cli.mjs --manifest job.json --input <photo folder> --output <job folder>
```

`--build <dir>` reuses a stamped build; `--no-resume` starts over; `--headed` shows the
browser; `--no-gpu` runs the WASM paths only; `--chromium` uses Playwright's Chromium
instead of the installed Chrome.

From code:

```js
import { buildEngine } from './engine/runner/build.mjs'
import { runJob } from './engine/runner/runJob.mjs'
const { dir } = await buildEngine({ outDir: 'build/engine' })
const record = await runJob({ manifest, inputDir, outputDir, buildDir: dir, onEvent, signal })
```

`record.status` is `succeeded`, `failed` (with `error.stage` and `error.message`) or
`cancelled`. A failed job keeps its browser profile and checkpoint; running it again
with the same output folder continues after the last stage whose inputs are unchanged.

## The manifest

[`manifest/manifest.js`](manifest/manifest.js) documents every field. In short:

```json
{
  "manifestVersion": 1,
  "job": { "id": "site-a-2026-11-17", "siteId": "site-a", "flightId": "F-0193" },
  "sceneType": "aerial",
  "crs": { "horizontal": "EPSG:2193", "vertical": "orthometric", "verticalName": "NZVD2016" },
  "images": [{ "name": "DJI_0001.JPG", "sha256": "…" }],
  "control": {
    "points": [
      { "id": "GCP01", "role": "control", "x": 1756123.412, "y": 5912345.118, "z": 12.304,
        "sigmaX": 0.015, "sigmaY": 0.015, "sigmaZ": 0.025,
        "observations": [{ "image": "DJI_0001.JPG", "px": 2011.5, "py": 1504.25 }] },
      { "id": "CHK01", "role": "check", "x": 1756201.0, "y": 5912390.5, "z": 13.1 }
    ]
  },
  "stages": { "detect": {}, "match": {}, "reconstruct": {}, "depth": {}, "dense": {}, "dem": {}, "ortho": {} },
  "outputs": ["report", "dem:geotiff", "ortho:cog", "cloud:laz"],
  "limits": { "timeoutMinutes": 240 }
}
```

- Stage settings are layered over the app's own defaults exactly as each dialog does it
  (a `preset` first if named). `{}` is the app's defaults.
- Control coordinates are in `control.crs` (default the job CRS); sigmas are 1σ in
  metres. A control point must declare its accuracy; a check point is never in the
  adjustment and is reported apart.
- Image marks use the app's pixel convention: the top-left corner is (0, 0), so the
  centre of pixel *i* is *i* + ½.
- DEM and orthophoto are in the project CRS, as the dialogs preselect with a
  georeference. Without one the stage fails rather than writing a local-frame product;
  `"crs": "local"` asks for the model frame on purpose.

## What a job records

`result.json`: status, the engine build stamp (version, commit, WASM stamp, uncommitted
changes), what the browser offered (cross-origin isolation, workers, GPU), each photo's
SHA-256, every stage's numbers (and the stage digests the bench uses to spot a changed
computation), control and check residuals apart (`control.control`, `control.check`:
RMSE H/V, mean, max, n of how many), and each product file with its size and SHA-256.
`events.ndjson` has every page event with a timestamp; `engine.log` every app log line.

A stage that ran but produced nothing its next stage can use (no keypoints, fewer than
two cameras, an empty cloud) fails the job: no stage is recorded as done without its
output.

## Restarting a failed job

`checkpoint.json` lists each finished stage with the SHA-256 of its inputs
(`stageInputs` in the manifest module). On a rerun, a stage is kept while its key
matches: a corrected control point reruns from the reconstruction, a new DEM cell size
reruns the DEM and orthophoto only, new detection settings rerun everything. A checkpoint
from another engine build is never resumed. The browser storage is tied to the job
server's origin, so a resumed job is served on the port its checkpoint recorded.

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `ENGINE_OUT_DIR` | `engine/vite.config.mjs` | where the engine build goes (set by `buildEngine`) |

The runner needs Chrome (or `--chromium` and `npx playwright install chromium`). WebGPU
is used when the browser offers it; on Linux servers that needs a GPU, Vulkan drivers and
the flags `runJob` passes. Without it the app's WASM paths run, and `engine.info().gpu`
says so.

## Measured

The Aukerman example (42 photos at 2,400 px), on an 8-core, 8 GB Mac with Chrome 157 and
WebGPU: every photo registered, 1.52 million dense points, a 0.23 m DEM and 0.12 m
orthophoto, exported as GeoTIFF and LAZ with their EPSG keys, in 408 s.
[regression/aukerman.expect.json](regression/aukerman.expect.json) holds the numbers and
their bounds.

## Debt

- The page drives the stores through `tests/bench/bench.js`, the bench's driver, so the
  two can never resolve settings differently. It should move under `src/` as the shared
  headless driver, with the bench and the engine importing it.
- A job's photos are read from a local folder. The platform downloads them from object
  storage into that folder first; streaming straight from signed URLs (`images[].url`) is
  supported by the page but not yet by the runner's checks.
