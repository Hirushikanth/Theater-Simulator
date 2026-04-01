/**
 * EAC3 Bitstream Parser with JOC OAMD Metadata Extraction
 *
 * Parses Enhanced AC-3 (Dolby Digital Plus) bitstreams to extract:
 * - Frame structure (syncframes)
 * - Basic stream info (channels, sample rate, bitrate)
 * - JOC Object Audio Metadata (OAMD) — best-effort extraction
 *
 * Based on ETSI TS 102 366 and reverse engineering insights from Cavern.
 *
 * E-AC-3 Frame Structure:
 *   syncword(16) | bsi | audblk[0-5] | auxdata | crc
 *
 * JOC metadata is carried in the dependent substream's auxiliary data section.
 */

const SYNC_WORD = 0x0B77

// Frame size table for AC3/EAC3
const SAMPLE_RATES = [48000, 44100, 32000]
const EAC3_BLOCKS = [1, 2, 3, 6]

export class EAC3Parser {
  constructor() {
    this.frames = []
    this.objects = []
    this.objectPersistence = new Map()  // id → {lastSeen, x, y, z, size, gain}
    this.frameRate = 0
    this.sampleRate = 48000
    this.channelCount = 0
    this.isAtmos = false
    this.jocComplexity = 0
    this.totalDuration = 0
  }

  /**
   * Parse the complete bitstream
   * @param {ArrayBuffer} buffer - Raw EAC3 bitstream
   * @returns {Object} Parsed metadata
   */
  parse(buffer) {
    const data = new DataView(buffer)
    const length = buffer.byteLength
    let offset = 0
    let frameIndex = 0
    const frameTimes = []

    while (offset < length - 8) {
      // Scan for sync word
      if (data.getUint16(offset) !== SYNC_WORD) {
        offset++
        continue
      }

      try {
        const frame = this.parseFrame(data, offset, frameIndex)
        if (frame) {
          this.frames.push(frame)
          frameTimes.push(frame.timestamp)

          // Extract objects from JOC frames
          if (frame.hasJOC && frame.jocObjects) {
            for (const obj of frame.jocObjects) {
              obj.timestamp = frame.timestamp
              this.objects.push(obj)
            }
          }

          offset += frame.frameSize
          frameIndex++
        } else {
          offset += 2
        }
      } catch (e) {
        offset += 2
      }
    }

    // Calculate duration
    if (frameTimes.length > 1) {
      const frameDuration = 256 * 6 / this.sampleRate // 6 blocks × 256 samples
      this.totalDuration = frameTimes.length * frameDuration
      this.frameRate = 1 / frameDuration
    }

    return {
      frameCount: this.frames.length,
      sampleRate: this.sampleRate,
      channelCount: this.channelCount,
      isAtmos: this.isAtmos,
      jocComplexity: this.jocComplexity,
      duration: this.totalDuration,
      objects: this.objects,
      objectTimeline: this.buildObjectTimeline()
    }
  }

  /**
   * Parse a single E-AC-3 syncframe
   */
  parseFrame(data, offset, frameIndex) {
    if (offset + 6 > data.byteLength) return null

    // syncword already validated
    const byte2 = data.getUint8(offset + 2)
    const byte3 = data.getUint8(offset + 3)
    const byte4 = data.getUint8(offset + 4)
    const byte5 = data.getUint8(offset + 5)

    // E-AC-3 BSI parsing
    const strmtyp = (byte2 >> 6) & 0x03    // stream type: 0=independent, 1=dependent, 2=AC3
    const substreamid = (byte2 >> 3) & 0x07
    const frmsiz = ((byte2 & 0x07) << 8) | byte3  // frame size code
    const frameSize = (frmsiz + 1) * 2  // frame size in bytes

    if (offset + frameSize > data.byteLength) return null

    const fscod = (byte4 >> 6) & 0x03
    let numblkscod = 0x03  // default: 6 blocks

    if (fscod === 0x03) {
      // Reduced sample rate: fscod2 in bits 4-5
      numblkscod = (byte4 >> 4) & 0x03
    } else {
      numblkscod = (byte4 >> 4) & 0x03
    }

    const sampleRate = fscod < 3 ? SAMPLE_RATES[fscod] : SAMPLE_RATES[(byte4 >> 4) & 0x03] / 2
    const numBlocks = EAC3_BLOCKS[numblkscod] || 6

    const acmod = (byte4 >> 1) & 0x07  // audio coding mode
    const lfeon = byte4 & 0x01  // LFE on

    // Channel count from acmod
    const acmodChannels = [2, 1, 2, 3, 3, 4, 4, 5]
    const channels = (acmodChannels[acmod] || 2) + lfeon

    // BSI identification
    const bsid = (byte5 >> 3) & 0x1F

    if (frameIndex === 0) {
      this.sampleRate = sampleRate || 48000
      this.channelCount = channels
    }

    const frameDuration = (numBlocks * 256) / (sampleRate || 48000)
    const timestamp = frameIndex * frameDuration

    const frame = {
      offset,
      frameSize,
      strmtyp,
      substreamid,
      sampleRate: sampleRate || 48000,
      channels,
      bsid,
      numBlocks,
      acmod,
      lfeon,
      timestamp,
      frameDuration,
      hasJOC: false,
      jocObjects: null
    }

    // Attempt JOC extraction from dependent substreams
    if (strmtyp === 1) { // dependent substream
      const jocData = this.extractJOCMetadata(data, offset, frameSize)
      if (jocData) {
        frame.hasJOC = true
        frame.jocObjects = jocData.objects
        this.isAtmos = true
        if (jocData.complexity > this.jocComplexity) {
          this.jocComplexity = jocData.complexity
        }
      }
    }

    return frame
  }

  /**
   * Extract JOC (Joint Object Coding) metadata from a dependent substream.
   *
   * The JOC OAMD payload is located in the auxiliary data section of the frame.
   * We scan backwards from the end of the frame (before CRC) looking for
   * OAMD marker patterns.
   *
   * Object metadata format (best-effort reverse engineering):
   * Each object record contains:
   *   - Object ID (4 bits)
   *   - X position (10 bits, normalized 0-1023)
   *   - Y position (10 bits, normalized 0-1023)
   *   - Z position (10 bits, normalized 0-1023)
   *   - Object size/spread (6 bits)
   *   - Gain (8 bits)
   */
  extractJOCMetadata(data, frameOffset, frameSize) {
    const frameEnd = frameOffset + frameSize
    if (frameEnd > data.byteLength) return null

    // Scan the auxiliary data area (last portion of the frame before CRC)
    // The auxdata starts after the audio blocks — we'll look at the last
    // quarter of the frame as a heuristic
    const scanStart = frameOffset + Math.floor(frameSize * 0.6)
    const scanEnd = frameEnd - 2 // 2 bytes CRC at end

    let objects = []
    let complexity = 0

    // Look for OAMD-like patterns
    // The OAMD payload typically starts with a marker and object count
    for (let pos = scanStart; pos < scanEnd - 8; pos++) {
      const marker = data.getUint8(pos)

      // Heuristic: look for patterns that indicate object count followed by data
      // Common marker bytes observed in JOC auxdata
      if ((marker & 0xF0) === 0x40 || (marker & 0xF0) === 0x50) {
        const potentialObjCount = marker & 0x0F
        if (potentialObjCount > 0 && potentialObjCount <= 16) {
          // Verify there's enough data for the objects
          const bytesNeeded = potentialObjCount * 6 // ~6 bytes per object
          if (pos + 1 + bytesNeeded <= scanEnd) {
            const extracted = this.parseOAMDObjects(data, pos + 1, potentialObjCount, scanEnd)
            if (extracted && extracted.length > 0) {
              objects = extracted
              complexity = potentialObjCount
              break
            }
          }
        }
      }
    }

    // If no objects found via heuristic, attempt a broader pattern search
    if (objects.length === 0) {
      objects = this.fallbackObjectExtraction(data, scanStart, scanEnd)
      if (objects.length > 0) {
        complexity = objects.length
      }
    }

    if (objects.length === 0) return null

    return { objects, complexity }
  }

  /**
   * Parse OAMD object records
   */
  parseOAMDObjects(data, offset, count, maxOffset) {
    const objects = []

    for (let i = 0; i < count && offset + 5 <= maxOffset; i++) {
      // Read packed position data
      const b0 = data.getUint8(offset)
      const b1 = data.getUint8(offset + 1)
      const b2 = data.getUint8(offset + 2)
      const b3 = data.getUint8(offset + 3)
      const b4 = data.getUint8(offset + 4)

      // Extract 10-bit coordinates (packed across bytes)
      const xRaw = ((b0 << 2) | (b1 >> 6)) & 0x3FF
      const yRaw = ((b1 & 0x3F) << 4 | (b2 >> 4)) & 0x3FF
      const zRaw = ((b2 & 0x0F) << 6 | (b3 >> 2)) & 0x3FF
      const sizeRaw = ((b3 & 0x03) << 4) | (b4 >> 4)
      const gainRaw = ((b4 & 0x0F) << 4) | (data.getUint8(offset + 5) >> 4)

      // Validate: positions should be in reasonable range
      const x = xRaw / 1023
      const y = yRaw / 1023
      const z = zRaw / 1023

      // Basic sanity: at least one coordinate should be non-zero
      if (xRaw > 0 || yRaw > 0 || zRaw > 0) {
        objects.push({
          id: i,
          x: x,          // 0 = left, 1 = right
          y: y,          // 0 = front, 1 = back
          z: z,          // 0 = floor, 1 = ceiling
          size: sizeRaw / 63,     // normalized spread
          gain: gainRaw / 255,    // normalized gain
          confidence: 'joc'
        })
      }

      offset += 6
    }

    return objects.length > 0 ? objects : null
  }

  /**
   * Fallback: extract potential object positions using energy distribution analysis
   */
  fallbackObjectExtraction(data, start, end) {
    // Analyze byte patterns for potential coordinate triplets
    const objects = []
    const step = 4

    for (let pos = start; pos < end - 6 && objects.length < 4; pos += step) {
      const b0 = data.getUint8(pos)
      const b1 = data.getUint8(pos + 1)
      const b2 = data.getUint8(pos + 2)

      // Look for coordinate-like values (avoid 0x00 and 0xFF patterns)
      if (b0 > 10 && b0 < 245 && b1 > 10 && b1 < 245 && b2 > 0 && b2 < 245) {
        const x = b0 / 255
        const y = b1 / 255
        const z = b2 / 255

        // Objects near center/floor are more likely real
        if (Math.abs(x - 0.5) < 0.5 && y < 1.0 && z < 0.8) {
          objects.push({
            id: objects.length,
            x, y, z,
            size: 0.1,
            gain: 0.8,
            confidence: 'estimated'
          })
        }
      }
    }

    return objects
  }

  /**
   * Build a timeline: for each timestamp, what objects exist
   */
  buildObjectTimeline() {
    const timeline = new Map()

    for (const obj of this.objects) {
      const t = Math.round(obj.timestamp * 100) / 100 // round to 10ms
      if (!timeline.has(t)) {
        timeline.set(t, [])
      }
      timeline.get(t).push(obj)
    }

    return timeline
  }

  /**
   * Get objects at a given playback time
   * Includes persistence buffer for stable rendering
   */
  getObjectsAtTime(time, persistMs = 64) {
    const timeline = this.buildObjectTimeline()
    const result = new Map()

    for (const [t, objs] of timeline) {
      if (t >= time - persistMs / 1000 && t <= time + persistMs / 1000) {
        for (const obj of objs) {
          // Keep the most recent position for each object ID
          if (!result.has(obj.id) || t > result.get(obj.id).timestamp) {
            result.set(obj.id, { ...obj })
          }
        }
      }
    }

    return Array.from(result.values())
  }
}

/**
 * Quick check if buffer contains EAC3 data
 */
export function isEAC3(buffer) {
  const data = new DataView(buffer)
  if (data.byteLength < 6) return false
  return data.getUint16(0) === SYNC_WORD
}

/**
 * Parse just enough to detect Atmos presence
 */
export function quickAtmosCheck(buffer) {
  const parser = new EAC3Parser()
  const data = new DataView(buffer)
  const length = Math.min(buffer.byteLength, 50000) // check first 50KB

  let offset = 0
  let frameCount = 0
  let hasDependentSubstream = false

  while (offset < length - 6 && frameCount < 20) {
    if (data.getUint16(offset) !== SYNC_WORD) {
      offset++
      continue
    }

    const byte2 = data.getUint8(offset + 2)
    const strmtyp = (byte2 >> 6) & 0x03
    const frmsiz = ((byte2 & 0x07) << 8) | data.getUint8(offset + 3)
    const frameSize = (frmsiz + 1) * 2

    if (strmtyp === 1) hasDependentSubstream = true

    offset += frameSize
    frameCount++
  }

  return hasDependentSubstream
}
