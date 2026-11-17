// A job's checkpoint: which stages finished, on which inputs, in which browser profile.
// Written to <outputDir>/checkpoint.json after every stage, so a job that failed (a
// crash, a timeout, a lost worker) can continue from its last good stage.
//
// checkpoint = {
//   jobId, engineBuild,                 the build must match to resume: other code, other results
//   profileDir, projectId,              where the project lives (OPFS of that profile)
//   port,                               the job server's port: OPFS is per origin, so a
//                                       resumed job is served on the same one
//   ingested,                           photos and control are in the project
//   completed: [{ stage, key }],        key = sha256 of stageInputs(manifest)[stage]
// }
//
// A stage's saved result is reused only while its key still matches the manifest's
// (engine/manifest/manifest.js stageInputs): a corrected control point reruns the job
// from the reconstruction; a new detection setting reruns all of it.
import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stageInputs, stableStringify, STAGES } from '../manifest/manifest.js'

export const CHECKPOINT_FILE = 'checkpoint.json'

export const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** stage → key of its inputs, for the stages the manifest runs. */
export function stageKeys(manifest) {
  return Object.fromEntries(Object.entries(stageInputs(manifest)).map(([s, v]) => [s, sha256(stableStringify(v))]))
}

export async function readCheckpoint(outputDir) {
  try {
    return JSON.parse(await readFile(join(outputDir, CHECKPOINT_FILE), 'utf8'))
  } catch {
    return null
  }
}

/** Written whole to a temporary file, then renamed: never half a checkpoint. */
export async function writeCheckpoint(outputDir, checkpoint) {
  const file = join(outputDir, CHECKPOINT_FILE)
  await writeFile(`${file}.tmp`, JSON.stringify(checkpoint, null, 2))
  await rename(`${file}.tmp`, file)
}

/**
 * Whether `checkpoint` can continue `manifest` on `engineBuild`, and from where.
 * → { resume: false, reason } | { resume: true, projectId, profileDir, completed: [stage] }
 * `completed` is the leading run of stages whose keys still match; a later stage is
 * stale once one before it must run again.
 */
export function resumePlan(checkpoint, manifest, engineBuild) {
  if (!checkpoint) return { resume: false, reason: 'no checkpoint' }
  if (checkpoint.jobId !== manifest.job.id) return { resume: false, reason: 'the checkpoint is of another job' }
  if (checkpoint.engineBuild !== engineBuild)
    return { resume: false, reason: 'the engine build changed since the checkpoint' }
  if (!checkpoint.ingested || !checkpoint.projectId || !checkpoint.profileDir)
    return { resume: false, reason: 'the photos were never fully ingested' }
  const keys = stageKeys(manifest)
  const saved = new Map((checkpoint.completed ?? []).map((c) => [c.stage, c.key]))
  const completed = []
  for (const s of STAGES) {
    if (!manifest.stages[s]) continue
    if (saved.get(s) !== keys[s]) break
    completed.push(s)
  }
  return { resume: true, projectId: checkpoint.projectId, profileDir: checkpoint.profileDir, completed }
}
