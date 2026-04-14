/**
 * VBAP (Vector Base Amplitude Panning) Renderer
 *
 * Calculates speaker gain weights for a given 3D object position
 * across a 7.1.4 speaker array using vector base amplitude panning.
 *
 * For each object position, finds the enclosing speaker triangle
 * and calculates gain weights via matrix inversion.
 *
 * Reference: Pulkki, V. (1997). "Virtual sound source positioning
 * using vector base amplitude panning."
 */

import { SPEAKERS, speakerToCartesian, ROOM } from '../utils/constants'

export class VBAPRenderer {
  constructor() {
    // Pre-compute speaker positions in Cartesian (unit vectors)
    this.speakerPositions = SPEAKERS.map(s => {
      const pos = speakerToCartesian(s, 1) // unit sphere
      return { ...s, pos, vec: [pos.x, pos.y, pos.z] }
    })

    // Pre-compute speaker triangulations
    this.triangles = this.computeTriangulation()

    // Pre-invert matrices for each triangle
    this.invertedMatrices = this.triangles.map(tri => {
      const [i, j, k] = tri
      const L1 = this.speakerPositions[i].vec
      const L2 = this.speakerPositions[j].vec
      const L3 = this.speakerPositions[k].vec
      return {
        indices: tri,
        invMatrix: this.invertMatrix3x3([
          [L1[0], L2[0], L3[0]],
          [L1[1], L2[1], L3[1]],
          [L1[2], L2[2], L3[2]]
        ])
      }
    })

    // Pre-allocated output map to avoid GC churn at 60fps
    this.outputGains = new Map()
    SPEAKERS.forEach(s => this.outputGains.set(s.id, 0))
  }

  /**
   * Compute speaker triangulation for the 7.1.4 layout
   * Returns arrays of speaker index triplets
   */
  computeTriangulation() {
    // Manual triangulation for 7.1.4 based on speaker geometry
    // Speaker indices: FL=0, FR=1, C=2, LFE=3, SL=4, SR=5, SBL=6, SBR=7,
    //                  TFL=8, TFR=9, TRL=10, TRR=11

    return [
      // Floor layer triangles
      [0, 2, 1],   // FL-C-FR (front)
      [0, 4, 2],   // FL-SL-C (front-left)
      [1, 2, 5],   // FR-C-SR (front-right)
      [4, 6, 0],   // SL-SBL-FL (left)
      [5, 1, 7],   // SR-FR-SBR (right)
      [6, 4, 7],   // SBL-SL-SBR (rear, through sides)
      [4, 5, 7],   // SL-SR-SBR (mid)
      [4, 7, 6],   // SL-SBR-SBL (rear)

      // Floor-to-ceiling triangles (connecting bed to height)
      [0, 8, 2],   // FL-TFL-C
      [1, 2, 9],   // FR-C-TFR
      [8, 9, 2],   // TFL-TFR-C (top front)
      [0, 8, 4],   // FL-TFL-SL
      [1, 9, 5],   // FR-TFR-SR
      [4, 10, 8],  // SL-TRL-TFL (left wall)
      [5, 9, 11],  // SR-TFR-TRR (right wall)
      [6, 10, 4],  // SBL-TRL-SL
      [7, 5, 11],  // SBR-SR-TRR
      [6, 7, 10],  // SBL-SBR-TRL
      [7, 11, 10], // SBR-TRR-TRL

      // Ceiling layer
      [8, 9, 10],  // TFL-TFR-TRL
      [9, 11, 10], // TFR-TRR-TRL
    ]
  }

  /**
   * Calculate speaker gains for a given 3D position
   * @param {number} x - Left(0) to Right(1)
   * @param {number} y - Front(0) to Back(1)
   * @param {number} z - Floor(0) to Ceiling(1)
   * @returns {Map<string, number>} Speaker ID → gain weight
   */
  calculateGains(x, y, z) {
    const gains = new Map()
    SPEAKERS.forEach(s => gains.set(s.id, 0))

    // Convert Atmos coordinates to unit vector
    // Map from normalized 0-1 to 3D space
    const azimuth = (x - 0.5) * Math.PI  // -π/2 to π/2
    const elevation = z * (Math.PI / 2)    // 0 to π/2
    const frontBack = (y - 0.5) * Math.PI  // -π/2 to π/2

    // Create source direction vector
    const srcVec = [
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      -Math.cos(elevation) * Math.cos(frontBack)
    ]

    // Normalize
    const len = Math.sqrt(srcVec[0] ** 2 + srcVec[1] ** 2 + srcVec[2] ** 2)
    if (len > 0) {
      srcVec[0] /= len
      srcVec[1] /= len
      srcVec[2] /= len
    }

    // Find the best triangle
    let bestGains = null
    let bestMinGain = -Infinity

    for (const { indices, invMatrix } of this.invertedMatrices) {
      if (!invMatrix) continue

      // Calculate gains: g = inv(L) * p
      const g = [
        invMatrix[0][0] * srcVec[0] + invMatrix[0][1] * srcVec[1] + invMatrix[0][2] * srcVec[2],
        invMatrix[1][0] * srcVec[0] + invMatrix[1][1] * srcVec[1] + invMatrix[1][2] * srcVec[2],
        invMatrix[2][0] * srcVec[0] + invMatrix[2][1] * srcVec[1] + invMatrix[2][2] * srcVec[2]
      ]

      // Valid if all gains are non-negative
      const minGain = Math.min(g[0], g[1], g[2])
      if (minGain >= -0.01) { // small tolerance
        // Normalize gains (power normalization)
        const sumSq = Math.sqrt(g[0] ** 2 + g[1] ** 2 + g[2] ** 2)
        if (sumSq > 0) {
          const normG = g.map(v => Math.max(0, v) / sumSq)

          if (minGain > bestMinGain) {
            bestMinGain = minGain
            bestGains = { indices, gains: normG }
          }
        }
      }
    }

    if (bestGains) {
      const { indices: [i, j, k], gains: [g1, g2, g3] } = bestGains
      gains.set(SPEAKERS[i].id, g1)
      gains.set(SPEAKERS[j].id, g2)
      gains.set(SPEAKERS[k].id, g3)
    } else {
      // Fallback: nearest speaker gets full weight
      const nearest = this.findNearestSpeaker(x, y, z)
      if (nearest) gains.set(nearest, 1.0)
    }

    // Add LFE based on object position (low-frequency content gets some LFE)
    const lfeGain = z < 0.3 ? 0.3 * (1 - z / 0.3) : 0
    gains.set('LFE', lfeGain)

    return gains
  }

  /**
   * Find the nearest speaker to a position
   */
  findNearestSpeaker(x, y, z) {
    let minDist = Infinity
    let nearest = null

    for (const sp of this.speakerPositions) {
      if (sp.id === 'LFE') continue
      const dx = sp.pos.x - (x - 0.5) * ROOM.width
      const dy = sp.pos.y - z * ROOM.height
      const dz = sp.pos.z - (y - 0.5) * ROOM.depth
      const dist = dx * dx + dy * dy + dz * dz

      if (dist < minDist) {
        minDist = dist
        nearest = sp.id
      }
    }

    return nearest
  }

  /**
   * Invert a 3×3 matrix
   */
  invertMatrix3x3(m) {
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
  calculateSceneGains(objects) {
    // Zero out the existing map instead of making a new one
    SPEAKERS.forEach(s => this.outputGains.set(s.id, 0))

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
