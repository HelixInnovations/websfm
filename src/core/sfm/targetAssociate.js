// Coded GCP targets found in photos → image observations of a site's surveyed control
// points. Pure, no Vue/Pinia/OPFS/DOM.
//
// The detector (tagDetect.js, per photo through workers/ops/detect.js) reads each coded
// target's id and its centre from the homography of its four refined corners, the
// target's true geometric centre rather than the middle of a bounding box. This module
// decides which detections become observations of which control point, and which go to
// a person instead. It never guesses: anything doubtful is returned for review with the
// reason, and nothing is dropped silently.
//
//   associateTargets({ register, detections, predictions?, gateFor?, maxHamming? })
//   → { observations, review, perPoint, underObserved, registerProblems }
//
// register     [{ pointId, code, status? }]  code: the target's id in its family
//              (an AprilTag 36h11 or ArUco number). status: 'active' (default),
//              'damaged', 'missing' or 'retired'.
// detections   [{ image, width, height, tags: [{ id, hamming, score, center: { x, y } }] }]
//              as detectTagsInPhoto returns them: centres in pixel-CENTRE coordinates
//              (pixel i's centre at i). The detector keeps one detection per code per
//              photo (the fewest wrong bits), so the register must give every target its
//              own code; registerProblems says when it does not.
// predictions  optional Map image → Map pointId → { x, y } (pixel-centre), where the
//              current model or the photo's GNSS puts each point (targetPredict.js).
// gateFor      (detection) → the largest distance in pixels a detection may lie from its
//              prediction; default max(60 px, 2 % of the long side), as the app's
//              Detect targets uses (tuning.js TAG_DETECT_TUNING).
//
// observations [{ pointId, image, px, py, confidence, hamming, offPredictionPx }]
//              px/py in the app's MARK convention (top-left corner 0, 0: centre + ½),
//              ready for a manifest or the GCP store. confidence 0–1 ranks detections
//              (the decode's margin, lowered by distance from the prediction); it is not
//              a probability.
// review       [{ image, code, px, py, reason, pointId? }]
// perPoint     pointId → photos it was observed in
// underObserved  pointIds seen in fewer than two photos: they cannot be triangulated

const DEFAULT_GATE_MIN_PX = 60
const DEFAULT_GATE_FRAC = 0.02

/** Problems in a register that make automatic association unsafe. */
export function registerProblems(register) {
  const problems = []
  const byCode = new Map()
  for (const r of register) {
    if (r.status === 'retired') continue
    if (!Number.isInteger(r.code)) {
      problems.push({ pointId: r.pointId, reason: 'no target code' })
      continue
    }
    const list = byCode.get(r.code) ?? []
    list.push(r.pointId)
    byCode.set(r.code, list)
  }
  for (const [code, ids] of byCode)
    if (ids.length > 1) problems.push({ code, pointIds: ids, reason: `code ${code} is given to ${ids.join(', ')}` })
  return problems
}

export function associateTargets({ register, detections, predictions = null, gateFor = null, maxHamming = 2 }) {
  const problems = registerProblems(register)
  const ambiguous = new Set(problems.filter((p) => p.pointIds).map((p) => p.code))
  const byCode = new Map(
    register.filter((r) => r.status !== 'retired' && Number.isInteger(r.code)).map((r) => [r.code, r]),
  )
  const retired = new Map(register.filter((r) => r.status === 'retired').map((r) => [r.code, r]))
  const gate =
    gateFor ?? ((d) => Math.max(DEFAULT_GATE_MIN_PX, DEFAULT_GATE_FRAC * Math.max(d.width ?? 0, d.height ?? 0)))

  const observations = []
  const review = []
  for (const d of detections) {
    for (const t of d.tags ?? []) {
      const px = t.center.x + 0.5,
        py = t.center.y + 0.5
      const toReview = (reason, pointId = null) =>
        review.push({ image: d.image, code: t.id, px, py, reason, ...(pointId ? { pointId } : {}) })
      if (ambiguous.has(t.id)) {
        toReview('more than one control point has this code')
        continue
      }
      const entry = byCode.get(t.id)
      if (!entry) {
        toReview(retired.has(t.id) ? 'the register lists this target as retired' : 'no control point has this code')
        continue
      }
      if (entry.status === 'missing') {
        toReview('the register lists this target as missing', entry.pointId)
        continue
      }
      if (!(t.hamming <= maxHamming)) {
        toReview(`read with ${t.hamming} wrong bits`, entry.pointId)
        continue
      }
      const p = predictions?.get(d.image)?.get(entry.pointId) ?? null
      const off = p ? Math.hypot(t.center.x - p.x, t.center.y - p.y) : null
      const limit = gate(d)
      if (off != null && off > limit) {
        toReview(`${Math.round(off)} px from where the model puts it (limit ${Math.round(limit)} px)`, entry.pointId)
        continue
      }
      const decode = Number.isFinite(t.score) ? Math.max(0, Math.min(1, t.score)) : 1
      const confidence = off == null ? decode : decode * (1 - 0.5 * (off / limit))
      // A damaged target is still measured, but a person should look at it.
      if (entry.status === 'damaged') {
        toReview('the register lists this target as damaged', entry.pointId)
        continue
      }
      observations.push({
        pointId: entry.pointId,
        image: d.image,
        px,
        py,
        confidence: Math.round(confidence * 1000) / 1000,
        hamming: t.hamming,
        offPredictionPx: off == null ? null : Math.round(off * 10) / 10,
      })
    }
  }
  const perPoint = {}
  for (const o of observations) perPoint[o.pointId] = (perPoint[o.pointId] ?? 0) + 1
  const underObserved = register
    .filter((r) => r.status !== 'retired' && r.status !== 'missing' && (perPoint[r.pointId] ?? 0) < 2)
    .map((r) => r.pointId)
  return { observations, review, perPoint, underObserved, registerProblems: problems }
}
