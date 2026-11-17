# Platform audit: the WebSfM engine

Part 1 of the autonomous surveying platform build. Established by reading the source at
v0.8.0 (`61022796`) and by running parts of it in Node. Nothing in the engine was
changed to write this.

## Summary

WebSfM is a static Vue 3 app with no server. Photogrammetry runs in a pool of up to eight
web workers, using Rust compiled to WebAssembly (6 crates), WGSL kernels on WebGPU, and
about 86,000 lines of pure JavaScript in `src/core/`. The engine already does much more
of what the brief asks for than the brief assumes:

- **Coded and checkerboard GCP targets are already detected.** AprilTag 36h11 and ArUco
  are detected with ID decoding and sub-pixel corners (`core/sfm/tagDetect.js`).
  Checkerboard centres are found as saddle points refined like OpenCV's `cornerSubPix`
  (`core/sfm/targetDetect.js`). Where to look in each photo is predicted from the model
  (`core/sfm/targetPredict.js`).
- **The bundle adjustment already weights GCPs.** Per-axis ground accuracy and per-mark
  image accuracy become a precision matrix in the BA (`core/sfm/surveyConstraints.js`).
  Confidence conventions (1σ, 95%, CE90 …) are converted in `core/gcpAccuracy.js`.
- **Check points are already kept separate from control.** Each GCP has a role:
  control, check or marker (`stores/useGcpsStore.js`). Check points are measured but not
  used in the fit (`core/eval/positionCheck.js` `gcpCheck`, `core/eval/health.js`).
- **Most of the survey analytics exist.** Cut/fill volume inside a polygon against a
  plane, a fixed height or **another surface** (`core/products/measure.js`
  `polygonVolume`, with the projection scale factor applied by `groundVolume`). DEM
  minus reference DEM with robust statistics and a difference map
  (`core/eval/demCompare.js`). Nuth & Kääb horizontal co-registration
  (`core/eval/demCoregister.js`). Contours (`core/products/contours.js`). A DXF R12
  writer (`core/products/dxf.js`). Ground classification for a DTM
  (`core/products/groundFilter.js`).
- **Unattended runs are partly designed for already.** The Workflow Builder chains
  stages with quality gates on Quality Report metrics such as median reprojection error
  (`core/workflow.js`, `core/workflowGate.js`). A run journal lets a run that died carry
  on from where it stopped (`core/runJournal.js`). Saved depth maps are reused
  (`core/dense/depthReuse.js`).
- **A headless runner already exists.** `scripts/bench/run-bench.mjs` runs the real app
  (stores, worker pool, WebGPU, OPFS) in headless Chromium or Firefox through Playwright,
  driven through `window.bench.*` in `tests/bench/bench.js`, and scores results against
  Metashape, ODM, ETH3D and lidar references.

What is genuinely missing: TIN and LandXML, a site-wide DEM of Difference with
uncertainty thresholds, NZVD2016 heights (NZGeoid2016), PDF and XLSX output, linking a
coded target's ID to a surveyed control point automatically, and everything outside the
engine (server, database, queue, accounts, DJI, email).

## The 23 audit points

| # | Area | What exists | Where |
| --- | --- | --- | --- |
| 1 | Architecture | Static SPA. `components → stores → workers/computeClient → compute.worker → core (pure) → wasm` | `ARCHITECTURE.md` |
| 2 | Front end | Vue 3 `<script setup>`, Pinia 3, Vite 6, PWA. OpenLayers 10 (2D map), Three.js 0.171 (3D). No router: one project workbench with a ribbon, dialogs and a console | `src/components/`, `src/stores/` |
| 3 | Pipeline | Detect → Match → Sparse → Depth maps → Dense cloud → DEM / Ortho / Mesh. Run orchestration sits in stores and composables, not in core | `stores/reconstruction/*`, `composables/usePipeline.js`, `composables/useDialogRuns.js`, `core/workflow.js` |
| 4 | Ingestion | EXIF/XMP through exifr, including DJI XMP (RTK flags, gimbal, relative altitude); image quality and blur; duplicates; masks; video frames | `core/sfm/ingest.js`, `core/io/metadata.js`, `core/features/imageQuality.js`, `core/io/imageDuplicates.js` |
| 5 | Features | SIFT (Rust). ALIKED, DISK, SuperPoint via ONNX Runtime Web. Brute-force ratio-test matching (WASM or WebGPU), LightGlue, RANSAC fundamental verification. Pair preselection by position or capture order | `core/features/`, `crates/sift`, `crates/matching`, `workers/gpu/match.wgsl` |
| 6 | Cameras | Brown–Conrady, rational (k4–k6) and Kannala–Brandt fisheye. Lens removed once at ingest; everything after is pinhole. Self-calibration with guards, rigs, rolling shutter, film fiducials | `core/sfm/distortion.js`, `core/sfm/selfCal*.js`, `core/sfm/rigModel.js`, `core/sfm/rollingShutter.js` |
| 7 | Sparse | Incremental SfM: initial pair, P3P + robust PnP registration, track building, guided extension, multi-model merge | `core/sfm/sfm.js` `reconstruct()`, `register.js`, `tracks.js`, `trackStore.js` |
| 8 | Bundle adjustment | Levenberg–Marquardt in Rust; threaded build on rayon (`reconstruction-mt`); a wasm64 build for large problems. Camera-position and GCP priors weighted by their accuracy | `crates/reconstruction`, `core/sfm/bundleSession.js`, `baAcceptance.js`, `surveyConstraints.js`, `cameraPriors.js` |
| 9 | Dense | PatchMatch in Rust and in WGSL (held to the same accuracy by `tests/bench/patchmatchCases.js`), cross-view filter, voxel fusion, memory budgeting, split over the pool | `core/dense/`, `workers/gpu/patchmatch.wgsl` |
| 10 | Georeferencing | Similarity fit to GCPs or camera priors; GCPs constraining the BA directly; any proj4 CRS (all EPSG codes from epsg-index); reference rasters (Find GCPs from Sentinel-2 / Copernicus DEM) | `core/products/georef.js`, `core/crs.js`, `core/crsRegistry.js`, `core/sfm/referenceGcps.js` |
| 11 | GCPs | Per GCP: role, x/y/z, per-axis accuracy and convention, vertical datum, image marks with their own accuracy, enabled flag. CSV import. Triangulation from marks. Target prediction, AprilTag/ArUco and checkerboard detection (Tools ▸ Images ▸ Detect targets) | `stores/useGcpsStore.js`, `core/io/gcp.js`, `core/sfm/gcpTriangulation.js`, `core/sfm/tagDetect.js`, `targetDetect.js`, `targetPredict.js`, `composables/useDetectTargets.js` |
| 12 | Point cloud | Fused dense cloud in typed arrays (`core/bigArray.js` past 2 GiB); LOD octree and COPC read/write; filter, classify, crop, ICP | `core/dense/fusion.js`, `core/lod/`, `core/products/cloud*.js` |
| 13 | DEM / DTM | Cloud rasterised to a grid with mask; ground classification gives a DTM; tiled DEM blocks for large sites | `core/products/dem.js`, `groundFilter.js`, `demWindow.js` |
| 14 | TIN | **Missing.** `delaunator` is a dependency but used only in the planar prior | `core/dense/planarPrior.js` |
| 15 | Orthophoto | True ortho onto DEM, mesh or plane; mosaic with seam cutting; colour balancing; bands | `core/products/ortho.js`, `orthoMosaic.js`, `seamCut.js` |
| 16 | Volumes | Polygon cut/fill/net against plane, height or another surface, with coverage reported and a sampling note; scale-factor correction; DEM-vs-DEM statistics and difference raster; Nuth & Kääb co-registration. **No site-wide DoD product or level-of-detection threshold** | `core/products/measure.js`, `core/eval/demCompare.js`, `core/eval/demCoregister.js` |
| 17 | Exporters | DEM/ortho GeoTIFF and COG, ASCII grid, world file; LAS 1.2/1.4, LAZ, COPC; PLY, OBJ, STL, GLB; 3D Tiles; DXF R12; COLMAP, transforms.json; quality report as self-contained HTML (printed to PDF by the user). **No LandXML, XLSX or server-made PDF** | `core/products/exporters.js`, `core/io/las.js`, `core/io/laz.js`, `core/products/dxf.js`, `core/products/report.js` |
| 18 | WebGPU | Matching, PatchMatch, texture depth. All three have a CPU/WASM fallback chosen by a probe | `workers/gpu/`, `core/dense/gpuProbe.js` |
| 19 | Rust / WASM | `sift`, `matching`, `reconstruction` (+ `-mt` threaded, needs SharedArrayBuffer), `mesh` (+ `-64`), `imagecodec` (TIFF), `lazcodec`. wasm-pack `--target web`; bindings committed | `crates/`, `src/wasm/` |
| 20 | Browser APIs | OPFS and the File System Access API (projects), module Workers, SharedArrayBuffer under COOP/COEP, OffscreenCanvas / createImageBitmap (image decode), `navigator.gpu`, Cache API (model weights), Vite `?url` and `import.meta.glob` | `utils/opfs*.js`, `workers/*`, `core/crsRegistry.js`, `core/help/*.js` |
| 21 | Workers | `computeClient.js`: typed async calls over a pool of up to 8 (`POOL_SIZE`), `worker:` pinning, background jobs, `cancelRun`. Op handlers per domain in `workers/ops/`. Separate thumbnail, COLMAP-db and COPC-node workers | `src/workers/` |
| 22 | Tests | 451 Vitest files in Node (property tests with fast-check, golden SfM output gate, COLMAP and Metashape reference fixtures); Playwright suite in Chromium, Firefox, WebKit; `cargo test`; Stryker mutation runs; interop checks with GDAL, PDAL, COLMAP; the headless bench with reference scoring | `vitest.config.js`, `tests/browser/`, `scripts/bench/`, `scripts/interop/` |
| 23 | Project I/O | The OPFS directory is the format; `.websfm` is a streamed zip of it; versioned with forward migrations and fixtures. Imports COLMAP, Metashape XML and projects, LAS/LAZ/PLY, GeoTIFF, GCP and pose CSV, GeoJSON, KML | `docs/project-format.md`, `core/projectFormat.js`, `core/formatMigrations.js`, `core/io/projectArchive.js` |

## Can the engine run on a server?

Measured on this machine (Node 26.11, macOS, 8 cores, 8 GB):

1. **The pure core loads in plain Node with one small resolve hook.** All 21 modules
   probed import and expose their exports, including `core/sfm/sfm.js`
   (`reconstruct()`), `core/dense/mvs.js`, `core/products/dem.js`, `exporters.js`,
   `measure.js`, `tagDetect.js` and `surveyConstraints.js`. The hook only does what Vite
   does: add `.js` to three `ol/…` imports and stub one `?url` import (the EPSG
   registry, which on a server is read from disk instead).
2. **The WASM kernels load in Node.** The unit tests already initialise them from bytes
   (`initRecon({ module_or_path: readFileSync(...) })`), and
   `core/sfm/sfmGolden.test.js` runs the real `reconstruct()` with the real WASM,
   deterministically, in Node.
3. **The orchestration does not run in Node.** Running a whole project means the Pinia
   stores, OPFS, module Workers, OffscreenCanvas image decoding and (optionally)
   WebGPU. Porting those to Node would mean a JPEG decoder that matches Chrome's
   (colour handling and EXIF orientation affect SIFT), a worker shim, a storage shim and
   no GPU. Each one risks changing numbers.

So there are two routes, and the platform should use both:

- **Photogrammetry stages run in headless Chromium**, the way the bench already does:
  a frozen build of an engine page, one browser profile per job (so each job has its
  own OPFS and cannot touch another's), images streamed in over HTTP, outputs streamed
  out. Numbers are identical to the app's because it *is* the app's code, WebGPU works
  on a GPU host, and WASM threads work under COOP/COEP.
- **Survey analytics run directly in Node**: surface comparison, volumes, contours,
  DXF, and the new TIN, LandXML and QA code are pure functions of rasters and
  coordinates. They can import `src/core/` through the hook, without a browser.

A Node-only photogrammetry path stays possible later, once a parity test shows that
Node decoding and the single-threaded WASM give the same model as Chromium on the
regression datasets.

## Reuse map

**Reuse as is** (pure, loads in Node): `core/products/measure.js`, `contours.js`,
`dxf.js`, `dem.js`, `georef.js`, `exporters.js`, `geotiff.js`, `terrain.js`,
`groundFilter.js`; `core/eval/demCompare.js`, `demCoregister.js`, `positionCheck.js`,
`health.js`; `core/io/gcp.js`, `las.js`, `laz.js`; `core/sfm/tagDetect.js`,
`targetDetect.js`, `targetPredict.js`, `gcpTriangulation.js`, `surveyConstraints.js`;
`core/gcpAccuracy.js`; `core/crs.js` (with the registry read from disk);
`core/workflowGate.js`.

**Reuse through headless Chromium** (needs stores, workers, OPFS): ingest, detection,
matching, sparse SfM and BA, depth maps, fusion, DEM and ortho runs, project
save and `.websfm` export. The engine page generalises `tests/bench/bench.js`.

**Adapt**:

| What | Why | Change |
| --- | --- | --- |
| `tests/bench/bench.js` → an engine page | The bench API is a test harness: names, chunked base64 transfer of outputs, settings layered for experiments | A stable, versioned `window.engine` API with a job manifest in and a result manifest out; outputs written straight to storage through signed URLs rather than base64 through `page.evaluate` |
| Target detection | Runs in an interactive tool and writes marks for a person to accept | Called per photo in a run; a site's register maps each tag ID to its control point; ambiguous detections go to review instead of being written |
| `core/crsRegistry.js` | Fetches the EPSG registry from a Vite `?url` asset | A loader injected on the server (read `epsg-index/all.json` from disk) |
| `core/verticalDatum.js` | Converts only ellipsoidal ↔ EGM96 / EGM2008 | Add NZGeoid2016 (NZVD2016) as a grid, with its licence entry; keep national datums that have no grid as declared-only |
| Volume and DoD | Volumes are per polygon; no site-wide DoD; no detection threshold | A comparison module on top of `measure.js` and `demCompare.js`: common grid, overlap mask, level of detection from both surveys' uncertainty, cut/fill per polygon and site-wide |

**New**: TIN (Delaunay over the DEM or ground points, with `delaunator`, already a
dependency), LandXML 1.2 surface writer, PDF and XLSX reports, the whole server side.

## Risks and constraints found

1. **Licence.** WebSfM is MIT (upstream `fdahle/websfm`). Commercial use is allowed; the
   copyright and licence notice must ship with the platform, and the third-party
   notices (`THIRD_PARTY_NOTICES.txt`) come along with the engine build.
2. **Push deploys.** CI deploys `main` to dev.websfm.app and `v*` tags to websfm.app
   (`.github/workflows/verify.yml` ▸ deploy). Platform code on `main` would trigger an
   engine deploy, and the engine's rules (in-app guide, CHANGELOG, `npm test` on every
   change) apply to anything under `src/`.
3. **Memory.** A Chromium worker's V8 heap is about 4 GB; large arrays already live in
   WASM memory (`core/bigArray.js`). A processing host needs about 2 GB of RAM per
   pool worker for aerial sets; this 8 GB machine is enough for development on small
   sets, not for production jobs.
4. **WebGPU on servers.** Headless Chromium reaches the GPU on Linux with a GPU and
   current drivers (Vulkan). Without one, the WASM paths run, more slowly. The probe
   already falls back, and each run should log which path it used.
5. **Determinism.** The golden SfM gate shows the solver is deterministic for one
   input. The worker pool can schedule in any order; the regression suite must compare
   with tolerances where the app does, not byte for byte.
6. **NZVD2016.** Without NZGeoid2016 the engine cannot turn GNSS ellipsoidal heights
   into NZVD2016. Until it is added, a site must give its control in the datum the
   reconstruction is in, and the platform must refuse to compare surfaces whose
   vertical datums differ.
7. **Install scripts.** npm in this environment blocks package install scripts
   (esbuild, protobufjs, fsevents warned). The unit tests ran regardless; CI images
   should approve them explicitly.
8. **No local services.** This machine has no Docker, PostgreSQL or Redis.

## Test baseline

`npm test` at v0.8.0 on this machine (8 cores, 8 GB), two full runs: 448 of 452 files
and 4,185–4,187 of 4,200 tests pass, 8 skipped. The 5–7 failures are all **timeouts**
(30 s or 60 s), never a wrong value, in three heavy files: PatchMatch quality on
synthetic scenes (`core/dense/patchmatchQuality.test.js`), tiled Poisson meshing
(`core/products/meshTiles.test.js`) and the track store's random-churn check
(`core/sfm/trackStore.test.js`). Run on their own, all three files pass (18 of 18
tests; `meshTiles.test.js` needed a second run alone, then passed 5 of 5). They are
CPU-bound tests that run out of time when every file runs in parallel on 8 cores. CI
or the regression host should run them with enough cores, or with a longer timeout.
