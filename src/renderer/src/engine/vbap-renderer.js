/**
 * VBAP (Vector Base Amplitude Panning) Renderer
 *
 * Calculates speaker gain weights for a given 3D object position across the
 * currently selected speaker layout.
 *
 * The panning triangulation is generated automatically from the layout:
 * virtual nadir/zenith points close the convex hull, then any triangle that
 * receives gain from a virtual point is renormalised onto the real speakers.
 * Sparse layouts (notably 5.1.2, which has no rear speakers) fall back to a
 * two-nearest angular blend when no real triangle encloses the source.
 *
 * Reference: Pulkki, V. (1997). "Virtual sound source positioning
 * using vector base amplitude panning."
 */

import { Vector3 } from 'three'
import { ConvexHull } from 'three/addons/math/ConvexHull.js'
import { speakerToCartesian } from '../utils/constants'
import { DEFAULT_LAYOUT, getLayout } from '../utils/layouts'

const VIRTUAL_NADIR = '__NADIR__'
const VIRTUAL_ZENITH = '__ZENITH__'

function pointKey (point) {
  return `${point.x.toFixed(6)},${point.y.toFixed(6)},${point.z.toFixed(6)}`
}

function isSubwoofer (speaker) {
  return speaker.role === 'LFE' || speaker.group === 'lfe'
}

export class VBAPRenderer {
  constructor (layout = DEFAULT_LAYOUT) {
    this.outputGains = new Map()
    this.setLayout(layout)
  }

  /**
   * Swap the active layout and rebuild its panning geometry.
   * Safe to call while audio is playing; object gains are recalculated by App.
   */
  setLayout (layout) {
    this.layout = layout || getLayout(DEFAULT_LAYOUT.id)

    this.panningSpeakers = this.layout.speakers.filter(s => !isSubwoofer(s))
    this.subwoofers = this.layout.speakers.filter(isSubwoofer)
    this.speakerIds = new Set(this.layout.speakers.map(s => s.id))

    this.speakerPositions = this.panningSpeakers.map(speaker => {
      const pos = speakerToCartesian(speaker)
      const len = Math.hypot(pos.x, pos.y, pos.z) || 1
      return {
        ...speaker,
        pos,
        vec: [pos.x / len, pos.y / len, pos.z / len]
      }
    })

    this.triangles = this.computeTriangulation()
    this.invertedMatrices = this.triangles.map(({ ids, vectors }) => {
      const [L1, L2, L3] = vectors
      return {
        ids,
        invMatrix: this.invertMatrix3x3([
          [L1[0], L2[0], L3[0]],
          [L1[1], L2[1], L3[1]],
          [L1[2], L2[2], L3[2]]
        ])
      }
    }).filter(triangle => triangle.invMatrix)

    this.outputGains = new Map()
    this.speakerIds.forEach(id => this.outputGains.set(id, 0))
  }

  /**
   * Build a closed triangulation from the real speaker directions using the
   * convex hull plus virtual nadir/zenith points.
   */
  computeTriangulation () {
    if (this.panningSpeakers.length < 3) return []

    const points = []
    const idByKey = new Map()

    const addPoint = (id, x, y, z) => {
      const len = Math.hypot(x, y, z) || 1
      const point = new Vector3(x / len, y / len, z / len)
      points.push(point)
      idByKey.set(pointKey(point), id)
    }

    for (const speaker of this.speakerPositions) {
      addPoint(speaker.id, speaker.vec[0], speaker.vec[1], speaker.vec[2])
    }
    addPoint(VIRTUAL_NADIR, 0, -1, 0)
    addPoint(VIRTUAL_ZENITH, 0, 1, 0)

    const hull = new ConvexHull().setFromPoints(points)
    const triangles = []

    for (const face of hull.faces) {
      const edge = face.edge
      const facePoints = [
        edge.tail().point,
        edge.head().point,
        edge.next.head().point
      ]
      const ids = facePoints.map(point => idByKey.get(pointKey(point)))

      if (ids.some(id => id === undefined)) continue
      if (new Set(ids).size < 3) continue

      const vectors = facePoints.map(point => [point.x, point.y, point.z])
      triangles.push({ ids, vectors })
    }

    return triangles
  }

  /**
   * Map normalized Atmos coordinates to a unit direction vector.
   * Azimuth spans the full circle so rear speakers are reachable.
   */
  sourceVector (x, y, z) {
    const azimuth = Math.atan2(x - 0.5, 0.5 - y)
    const elevation = z * (Math.PI / 2)

    const vec = [
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      -Math.cos(elevation) * Math.cos(azimuth)
    ]

    const len = Math.hypot(vec[0], vec[1], vec[2])
    if (len > 0) {
      vec[0] /= len
      vec[1] /= len
      vec[2] /= len
    }
    return vec
  }

  /**
   * Calculate speaker gains for a given 3D position
   * @param {number} x - Left(0) to Right(1)
   * @param {number} y - Front(0) to Back(1)
   * @param {number} z - Floor(0) to Ceiling(1)
   * @returns {Map<string, number>} Speaker ID → gain weight
   */
  calculateGains (x, y, z) {
    const gains = new Map()
    this.speakerIds.forEach(id => gains.set(id, 0))

    const srcVec = this.sourceVector(x, y, z)

    let bestGains = null
    let bestMinGain = -Infinity

    for (const { ids, invMatrix } of this.invertedMatrices) {
      // Calculate gains: g = inv(L) * p
      const g = [
        invMatrix[0][0] * srcVec[0] + invMatrix[0][1] * srcVec[1] + invMatrix[0][2] * srcVec[2],
        invMatrix[1][0] * srcVec[0] + invMatrix[1][1] * srcVec[1] + invMatrix[1][2] * srcVec[2],
        invMatrix[2][0] * srcVec[0] + invMatrix[2][1] * srcVec[1] + invMatrix[2][2] * srcVec[2]
      ]

      const minGain = Math.min(g[0], g[1], g[2])
      if (minGain < -0.01) continue

      let realPower = 0
      for (let i = 0; i < 3; i++) {
        if (this.speakerIds.has(ids[i])) realPower += g[i] * g[i]
      }
      if (realPower < 1e-10) continue

      if (minGain > bestMinGain) {
        bestMinGain = minGain
        bestGains = { ids, gains: g }
      }
    }

    if (bestGains) {
      const realGains = []
      let sumSq = 0
      for (let i = 0; i < 3; i++) {
        if (!this.speakerIds.has(bestGains.ids[i])) continue
        const value = Math.max(0, bestGains.gains[i])
        realGains.push([bestGains.ids[i], value])
        sumSq += value * value
      }

      if (sumSq > 1e-12) {
        const norm = Math.sqrt(sumSq)
        for (const [id, value] of realGains) {
          gains.set(id, value / norm)
        }
      } else {
        this.applyFallback(gains, srcVec)
      }
    } else {
      this.applyFallback(gains, srcVec)
    }

    // Low-frequency content is sent to the subwoofer(s). Equal-power split
    // keeps the total sub energy constant across single/dual-sub layouts.
    const lfeGain = z < 0.3 ? 0.3 * (1 - z / 0.3) : 0
    const subGain = lfeGain / Math.sqrt(Math.max(1, this.subwoofers.length))
    for (const subwoofer of this.subwoofers) {
      gains.set(subwoofer.id, subGain)
    }

    return gains
  }

  /**
   * Blend the two nearest panning speakers. Used when no real triangle
   * encloses the source (e.g. the rear hemisphere of a 5.1.2 layout).
   */
  applyFallback (gains, srcVec) {
    if (this.speakerPositions.length === 0) return

    const ranked = this.speakerPositions
      .map(speaker => ({
        id: speaker.id,
        dot: speaker.vec[0] * srcVec[0] +
             speaker.vec[1] * srcVec[1] +
             speaker.vec[2] * srcVec[2]
      }))
      .sort((a, b) => b.dot - a.dot)
      .slice(0, 2)

    const weights = ranked.map(({ dot }) => 1 / (1.001 - Math.max(-1, Math.min(1, dot))))
    const norm = Math.sqrt(weights.reduce((sum, weight) => sum + weight * weight, 0))

    if (norm > 0) {
      ranked.forEach((speaker, index) => {
        gains.set(speaker.id, weights[index] / norm)
      })
    } else {
      gains.set(ranked[0].id, 1)
    }
  }

  /**
   * Invert a 3×3 matrix
   */
  invertMatrix3x3 (m) {
    const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])

    if (Math.abs(det) < 1e-10) return null

    const invDet = 1 / det
    return [
      [
        (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * invDet,
        (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * invDet,
        (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * invDet
      ],
      [
        (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * invDet,
        (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * invDet,
        (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * invDet
      ],
      [
        (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * invDet,
        (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * invDet,
        (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * invDet
      ]
    ]
  }

  /**
   * Calculate speaker contributions for multiple objects
   * Returns aggregated gains per speaker
   */
  calculateSceneGains (objects) {
    this.speakerIds.forEach(id => this.outputGains.set(id, 0))

    for (const obj of objects) {
      const objGains = this.calculateGains(obj.x, obj.y, obj.z)
      const objWeight = obj.gain ?? 1.0

      for (const [spkId, gain] of objGains) {
        const current = this.outputGains.get(spkId) || 0
        this.outputGains.set(spkId, Math.min(1, current + gain * objWeight))
      }
    }

    return this.outputGains
  }
}
