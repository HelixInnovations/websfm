import { describe, it, expect } from 'vitest'
import { associateTargets, registerProblems } from './targetAssociate.js'

const register = [
  { pointId: 'GCP01', code: 1 },
  { pointId: 'GCP02', code: 2 },
  { pointId: 'GCP03', code: 3, status: 'damaged' },
  { pointId: 'GCP04', code: 4, status: 'missing' },
  { pointId: 'OLD05', code: 5, status: 'retired' },
]
const tag = (id, x, y, hamming = 0, score = 1) => ({ id, hamming, score, center: { x, y } })
const photo = (image, tags) => ({ image, width: 4000, height: 3000, tags })

describe('associateTargets', () => {
  it('turns clean reads into observations in the mark convention (centre + ½)', () => {
    const r = associateTargets({
      register,
      detections: [photo('A.JPG', [tag(1, 100, 200)]), photo('B.JPG', [tag(1, 300, 400), tag(2, 10, 20)])],
    })
    expect(r.observations).toEqual([
      { pointId: 'GCP01', image: 'A.JPG', px: 100.5, py: 200.5, confidence: 1, hamming: 0, offPredictionPx: null },
      { pointId: 'GCP01', image: 'B.JPG', px: 300.5, py: 400.5, confidence: 1, hamming: 0, offPredictionPx: null },
      { pointId: 'GCP02', image: 'B.JPG', px: 10.5, py: 20.5, confidence: 1, hamming: 0, offPredictionPx: null },
    ])
    expect(r.perPoint).toEqual({ GCP01: 2, GCP02: 1 })
    expect(r.review).toEqual([])
  })

  it('sends unknown, retired, missing and damaged targets to review with the reason', () => {
    const r = associateTargets({
      register,
      detections: [photo('A.JPG', [tag(9, 1, 1), tag(5, 2, 2), tag(4, 3, 3), tag(3, 4, 4)])],
    })
    expect(r.observations).toEqual([])
    expect(r.review.map((x) => [x.code, x.reason])).toEqual([
      [9, 'no control point has this code'],
      [5, 'the register lists this target as retired'],
      [4, 'the register lists this target as missing'],
      [3, 'the register lists this target as damaged'],
    ])
  })

  it('a code given to two points is never assigned: both its detections go to review', () => {
    const reg = [...register, { pointId: 'GCP06', code: 2 }]
    expect(registerProblems(reg)).toEqual([
      { code: 2, pointIds: ['GCP02', 'GCP06'], reason: 'code 2 is given to GCP02, GCP06' },
    ])
    const r = associateTargets({ register: reg, detections: [photo('A.JPG', [tag(2, 5, 5)])] })
    expect(r.observations).toEqual([])
    expect(r.review[0].reason).toBe('more than one control point has this code')
  })

  it('a detection far from where the model predicts its point goes to review, a near one is kept', () => {
    const predictions = new Map([
      [
        'A.JPG',
        new Map([
          ['GCP01', { x: 1000, y: 1000 }],
          ['GCP02', { x: 50, y: 50 }],
        ]),
      ],
    ])
    // Gate: max(60, 2 % of 4000) = 80 px.
    const r = associateTargets({
      register,
      detections: [photo('A.JPG', [tag(1, 1040, 1000), tag(2, 500, 500)])],
      predictions,
    })
    expect(r.observations).toHaveLength(1)
    expect(r.observations[0]).toMatchObject({ pointId: 'GCP01', offPredictionPx: 40, confidence: 0.75 })
    expect(r.review).toEqual([
      {
        image: 'A.JPG',
        code: 2,
        px: 500.5,
        py: 500.5,
        reason: '636 px from where the model puts it (limit 80 px)',
        pointId: 'GCP02',
      },
    ])
  })

  it('too many wrong bits is a review, not an observation', () => {
    const r = associateTargets({ register, detections: [photo('A.JPG', [tag(1, 1, 1, 3, 0.45)])] })
    expect(r.review[0].reason).toBe('read with 3 wrong bits')
  })

  it('lists active points seen in fewer than two photos: they cannot be triangulated', () => {
    const r = associateTargets({
      register,
      detections: [photo('A.JPG', [tag(1, 1, 1)]), photo('B.JPG', [tag(1, 2, 2)])],
    })
    expect(r.underObserved).toEqual(['GCP02', 'GCP03'])
  })
})
