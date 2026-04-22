/**
 * EAC-3 JOC / OAMD Native Metadata Decoder
 *
 * A faithful JavaScript port of the Cavern open-source decoder
 * (github.com/VoidXH/Cavern) which reverse-engineered Dolby's
 * Extensible Metadata Delivery Format (EMDF) and the Object Audio
 * Metadata (OAMD, Payload ID 11) bitstream.
 *
 * Architecture mirrors Cavern's C# classes:
 *   ExtensibleMetadataDecoder → ObjectAudioMetadata → OAElementMD → ObjectInfoBlock
 *
 * What we extract: per-frame 3D coordinates (X, Y, Z), gain, size for
 * every Atmos object. We do NOT implement JOC audio de-matrixing DSP
 * (QMFB / Huffman / matrix pipeline) — that is audio separation, not
 * metadata visualisation.
 *
 * Reference files from Cavern studied for this port:
 *   ExtensibleMetadataDecoder.cs, ObjectAudioMetadata.cs,
 *   ObjectAudioElementMetadata.cs, ObjectInfoBlock.cs,
 *   JointObjectCoding.cs, JointObjectCodingTables.cs
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants — ported directly from Cavern source constants
// ─────────────────────────────────────────────────────────────────────────────

const EAC3_SYNC_WORD   = 0x0B77
const EMDF_SYNC_WORD   = 0x5838
const OAMD_PAYLOAD_ID  = 11    // Object Audio Metadata
const JOC_PAYLOAD_ID   = 14    // Joint Object Coding

// Cavern ObjectInfoBlock constants
const XY_SCALE   = 1 / 62     // 6-bit absolute position → 0..1
const Z_SCALE    = 1 / 15     // 4-bit signed height    → ±1
const SIZE_SCALE = 1 / 31     // 5-bit object size      → 0..1
const GAIN_ATTEN = 0.707      // 3 dB attenuation applied by Dolby encoders

// Distance factor LUT (16 entries) — from ObjectInfoBlockMetadata.cs
const DISTANCE_FACTORS = [
  1.1, 1.3, 1.6, 2.0, 2.5, 3.2, 4.0, 5.0,
  6.3, 7.9, 10.0, 12.6, 15.8, 20.0, 25.1, 50.1
]

// Screen-anchor depth factor LUT (4 entries)
const DEPTH_FACTORS = [0.25, 0.5, 1.0, 2.0]

// OAElementMD timing tables
const SAMPLE_OFFSET_INDEX  = [8, 16, 18, 24]
const RAMP_DURATIONS       = [0, 512, 1536]
const RAMP_DURATION_INDEX  = [
  32, 64, 128, 256, 320, 480, 1000, 1001,
  1024, 1600, 1601, 1602, 1920, 2000, 2002, 2048
]

// ObjectAnchor enum
const OBJ_ANCHOR_ROOM    = 0
const OBJ_ANCHOR_SCREEN  = 1
const OBJ_ANCHOR_SPEAKER = 2   // bed channel → static position

// ISF (Intermediate Spatial Format) object counts
const ISF_OBJECT_COUNT = [4, 8, 10, 14, 15, 30]

// Standard bed channel assignment — which NonStandardBedChannel indices
// each of the 10 "standard" bits maps to. Matches Cavern's standardBedChannels.
const STANDARD_BED_CHANNELS = [
  [0, 1], [2], [3], [4, 5], [6, 7],
  [8, 9], [10, 11], [12, 13], [14, 15], [16]
]

// E-AC-3 sample rates per fscod
const SAMPLE_RATES = [48000, 44100, 32000]
// Number of audio blocks per E-AC-3 frame per numblkscod
const BLOCKS_PER_FRAME = [1, 2, 3, 6]

// ─────────────────────────────────────────────────────────────────────────────
// BitReader — matches Cavern's BitExtractor
// ─────────────────────────────────────────────────────────────────────────────

class BitReader {
  /**
   * @param {ArrayBuffer} buffer
   * @param {number} byteOffset   start of region
   * @param {number} byteLength   length of region
   * @param {number} [backByte]   exclusive byte upper bound for bounds checks
   */
  constructor (buffer, byteOffset, byteLength, backByte) {
    this.data        = new Uint8Array(buffer, byteOffset, byteLength)
    this.bitPos      = 0                          // current read position in bits
    this.bitLen      = byteLength * 8             // total region size in bits
    // backPosition is the last valid bit before the end fence (for EMDF decoder)
    this.backPosition = backByte != null
      ? (backByte - byteOffset) * 8
      : this.bitLen
  }

  get position ()      { return this.bitPos }
  set position (v)     { this.bitPos = v }

  /** Read `n` bits as an unsigned integer (MSB first). */
  read (n) {
    if (n <= 0) return 0
    let val = 0
    for (let i = 0; i < n; i++) {
      if (this.bitPos >= this.bitLen) break
      const byteIdx = this.bitPos >> 3
      const bitIdx  = 7 - (this.bitPos & 7)
      val = (val << 1) | ((this.data[byteIdx] >> bitIdx) & 1)
      this.bitPos++
    }
    return val >>> 0   // keep unsigned
  }

  /** Read exactly 1 bit as boolean. Matches Cavern's ReadBit(). */
  readBit () { return this.read(1) === 1 }

  /** Read exactly 1 bit as integer 0/1. Matches Cavern's ReadBitInt(). */
  readBitInt () { return this.read(1) }

  /**
   * Read a signed integer.
   * Matches Cavern's BitExtractor.ReadSigned() exactly:
   *   int sign = value & (1 << bits);
   *   return sign << (31 - bits) + value - sign;
   * For small bit-counts (e.g. 3), this effectively returns unsigned (0..7)
   * because Read(n) can never set bit n. Cavern's implementation works
   * this way and real OAMD content is encoded for it.
   */
  readSigned (n) {
    const value = this.read(n)
    const sign = value & (1 << n)   // always 0 for n-bit reads, matching Cavern
    return ((sign << (31 - n)) + value - sign) | 0
  }

  /** Read `n` bits as a boolean array (MSB = index 0). */
  readBits (n) {
    const arr = new Array(n)
    for (let i = 0; i < n; i++) arr[i] = this.readBit()
    return arr
  }

  /** Skip `n` bits. */
  skip (n) { this.bitPos += n }

  /**
   * Cavern's ExtensibleMetadataExtensions.VariableBits(extractor, bits):
   * Reads `n` data bits, then 1 CONTINUATION BIT. If the continuation
   * bit is set, shifts the accumulated value left by n and repeats.
   *
   * CRITICAL: This is NOT "read chunks until < max". Each iteration
   * consumes n+1 bits (n data + 1 flag). Getting this wrong desynchronizes
   * every subsequent field in the EMDF block.
   */
  variableBits (n) {
    let value = 0
    let readMore
    do {
      value += this.read(n)
      readMore = this.readBit()
      if (readMore) {
        value = (value + 1) << n
      }
    } while (readMore && this.bitPos < this.bitLen)
    return value
  }

  /** Bounds check used by EMDF decoder */
  get safe () { return this.bitPos < this.backPosition - 32 }
}

// ─────────────────────────────────────────────────────────────────────────────
// ObjectInfoBlock — per Cavern's ObjectInfoBlock.cs
// ─────────────────────────────────────────────────────────────────────────────

class ObjectInfoBlock {
  constructor () {
    this.validPosition      = false
    this.differentialPos    = false
    this.gain               = -1    // -1 = reuse last
    this.size               = -1    // -1 = reuse last
    this.distance           = NaN
    this.anchor             = OBJ_ANCHOR_ROOM
    this.screenFactor       = 0
    this.depthFactor        = 1
    this.posX               = 0.5
    this.posY               = 0.5
    this.posZ               = 0
    this.deltaX             = 0
    this.deltaY             = 0
    this.deltaZ             = 0
    // last absolute position (for differential accumulation)
    this.lastX              = 0.5
    this.lastY              = 0.5
    this.lastZ              = 0
  }

  /**
   * Parse one block's worth of ObjectInfoBlock data.
   * Matches Cavern's ObjectInfoBlock.Update(extractor, blk, bedOrISFObject).
   *
   * @param {BitReader} reader
   * @param {number}    blk              block index (0 = first block of frame)
   * @param {boolean}   bedOrISFObject   true for bed/ISF objects
   */
  update (reader, blk, bedOrISFObject) {
    const inactive        = reader.readBit()
    // basicInfoStatus: blk==0 always 1; otherwise read 2 bits
    const basicInfoStatus = inactive ? 0 : (blk === 0 ? 1 : reader.read(2))

    if ((basicInfoStatus & 1) === 1) {
      this._readBasicInfo(reader, basicInfoStatus === 1)
    }

    let renderInfoStatus = 0
    if (!inactive && !bedOrISFObject) {
      renderInfoStatus = blk === 0 ? 1 : reader.read(2)
    }
    if ((renderInfoStatus & 1) === 1) {
      this._readRenderInfo(reader, blk, renderInfoStatus === 1)
    }

    // Additional table data
    if (reader.readBit()) {
      reader.skip((reader.read(4) + 1) * 8)
    }

    if (bedOrISFObject) {
      this.anchor = OBJ_ANCHOR_SPEAKER
    }
  }

  /**
   * Compute the final world-space position for this block.
   * Equivalent to Cavern's ObjectInfoBlock.UpdateSource(), but returns
   * a plain {x, y, z} in our 0-1 coordinate space.
   *
   * @param {number} lastX previous absolute X (used for differential)
   * @param {number} lastY
   * @param {number} lastZ
   * @returns {{ x: number, y: number, z: number, valid: boolean }}
   */
  resolvePosition (lastX, lastY, lastZ) {
    if (!this.validPosition || this.anchor === OBJ_ANCHOR_SPEAKER) {
      return { x: lastX, y: lastY, z: lastZ, valid: false }
    }

    let x, y, z

    if (this.differentialPos) {
      x = lastX + this.deltaX
      y = lastY + this.deltaY
      z = lastZ + this.deltaZ
    } else {
      x = this.posX
      y = this.posY
      z = this.posZ
    }

    // Distance-based depth correction (if encoder specified it)
    if (!isNaN(this.distance) && this.anchor === OBJ_ANCHOR_ROOM) {
      // Map to unit cube first, then scale by distance factor
      const norm = Math.sqrt(
        (x - 0.5) * (x - 0.5) +
        (y - 0.5) * (y - 0.5) +
        (z - 0.5) * (z - 0.5)
      ) || 0.001
      const intersectLen = norm
      const distanceFactor = intersectLen / this.distance
      x = distanceFactor * x + (1 - distanceFactor) * 0.5
      y = distanceFactor * y + (1 - distanceFactor) * 0.5
      z = distanceFactor * z + (1 - distanceFactor) * 0.5
    }

    // Screen-anchored transform
    if (this.anchor === OBJ_ANCHOR_SCREEN) {
      // Simplified screen anchor: scale X around center, Y depth curve
      const sf = this.screenFactor
      const cx = 0.5
      x = cx + (x - cx) * sf
      const depth = Math.pow(y, this.depthFactor)
      y = Math.max(0, depth)
    }

    return { x, y, z, valid: true }
  }

  // ── private ─────────────────────────────────────────────────────────────────

  _readBasicInfo (reader, readAllBlocks) {
    const blocks = readAllBlocks ? 3 : reader.read(2)

    // Gain (blocks & 2)
    if ((blocks & 2) !== 0) {
      const gainHelper = reader.read(2)
      switch (gainHelper) {
        case 0: this.gain = 1.0 * GAIN_ATTEN; break
        case 1: this.gain = 0.0; break
        case 2: {
          const g = reader.read(6)
          // dB-coded: if g < 15 → (15-g) dB atten; else → (14-g) dB (can be positive)
          const dB = g < 15 ? 15 - g : 14 - g
          this.gain = dbToGain(dB) * GAIN_ATTEN
          break
        }
        default: this.gain = -1   // reuse last
      }
    }

    // Priority (blocks & 1) — Cavern skips this, so do we
    if ((blocks & 1) !== 0 && !reader.readBit()) {
      reader.skip(5)
    }
  }

  _readRenderInfo (reader, blk, readAllBlocks) {
    const blocks = readAllBlocks ? 15 : reader.read(4)

    // ── Spatial position (blocks & 1) ────────────────────────────────────────
    this.validPosition = (blocks & 1) !== 0
    if (this.validPosition) {
      this.differentialPos = blk !== 0 && reader.readBit()

      if (this.differentialPos) {
        // 3-bit signed delta scaled
        this.deltaX = reader.readSigned(3) * XY_SCALE
        this.deltaY = reader.readSigned(3) * XY_SCALE
        this.deltaZ = reader.readSigned(3) * Z_SCALE
      } else {
        // Absolute 6+6+5-bit position
        const rawX = reader.read(6)
        const rawY = reader.read(6)
        // posZ: sign bit then 4-bit magnitude; sign=(readBitInt()<<1)-1 gives +1 or -1
        const zSign = (reader.readBitInt() << 1) - 1
        const rawZ  = reader.read(4)
        this.posX = Math.min(1, rawX * XY_SCALE)
        this.posY = Math.min(1, rawY * XY_SCALE)
        this.posZ = Math.min(1, Math.max(0, zSign * rawZ * Z_SCALE))
      }

      // Distance
      if (reader.readBit()) {
        if (reader.readBit()) {
          this.distance = 100   // infinite distance (Cavern uses 100 as "close enough")
        } else {
          this.distance = DISTANCE_FACTORS[reader.read(4)]
        }
      } else {
        this.distance = NaN
      }
    }

    // ── Zone constraints (blocks & 2) ─────────────────────────────────────────
    if ((blocks & 2) !== 0) reader.skip(4)

    // ── Object size (blocks & 4) ──────────────────────────────────────────────
    if ((blocks & 4) !== 0) {
      const sizeType = reader.read(2)
      switch (sizeType) {
        case 0: this.size = 0; break
        case 1: this.size = reader.read(5) * SIZE_SCALE; break
        case 2: {
          // 3D size — use vector length as scalar
          const sx = reader.read(5) * SIZE_SCALE
          const sy = reader.read(5) * SIZE_SCALE
          const sz = reader.read(5) * SIZE_SCALE
          this.size = Math.sqrt(sx * sx + sy * sy + sz * sz)
          break
        }
        default: this.size = -1   // reuse last
      }
    }

    // ── Screen anchoring (blocks & 8) ─────────────────────────────────────────
    if ((blocks & 8) !== 0 && reader.readBit()) {
      this.anchor      = OBJ_ANCHOR_SCREEN
      this.screenFactor = (reader.read(3) + 1) * 0.125
      this.depthFactor  = DEPTH_FACTORS[reader.read(2)]
    }

    reader.skip(1)   // snap-to-nearest-channel flag (unused in renderer)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OAElementMD — per Cavern's ObjectAudioElementMetadata.cs
// ─────────────────────────────────────────────────────────────────────────────

const OBJECT_ELEMENT_INDEX = 1

class OAElementMD {
  constructor () {
    this._valid            = false
    this.minOffset         = -1   // -1 = not an object element
    this._sampleOffset     = 0
    this._blockOffsets     = []   // blockOffsetFactor[]
    this._rampDurations    = []   // rampDuration[]
    this._infoBlocks       = []   // [objectIndex][blockIndex] = ObjectInfoBlock
  }

  /**
   * Parse one element from the OAMD payload.
   * Matches Cavern's OAElementMD.Read().
   */
  read (reader, alternateObjectPresent, objectCount, bedOrISFObjects) {
    const elementIndex = reader.read(4)
    // Element payload size: VariableBits(extractor, 4, 4) — result is in BITS.
    // Cavern: endPos = extractor.Position + VariableBits(extractor, 4, 4) + 1
    // The +1 is a padding bit. Do NOT multiply by 8 — it's already in bits.
    const payloadBitSize = variableBits44(reader) + 1
    const endPos         = reader.position + payloadBitSize

    reader.skip(alternateObjectPresent ? 5 : 1)   // extension flags

    if (elementIndex === OBJECT_ELEMENT_INDEX) {
      this._readObjectElement(reader, objectCount, bedOrISFObjects)
      this._valid = true
    } else {
      // Not an object element — mark with negative sentinel
      this.minOffset = -1 - elementIndex
    }

    reader.position = endPos   // padding / skip remainder
  }

  /**
   * Get per-object positions from this element at the given timecode.
   * Returns an array of { id, x, y, z, gain, size, valid } per object.
   *
   * @param {number} timecode  samples since start of audio frame
   * @returns {{ id: number, x: number, y: number, z: number,
   *             gain: number, size: number, valid: boolean }[]}
   */
  getPositions (timecode) {
    if (!this._valid || this._infoBlocks.length === 0) return []

    // Find which block applies at this timecode
    let blkIdx = 0
    for (let b = 0; b < this._blockOffsets.length; b++) {
      if (this._blockOffsets[b] <= timecode) blkIdx = b
    }

    const results = []
    for (let obj = 0; obj < this._infoBlocks.length; obj++) {
      const blocks = this._infoBlocks[obj]
      if (!blocks || !blocks[blkIdx]) continue

      const block = blocks[blkIdx]
      // accumulate differential positions starting from block 0
      let lx = 0.5, ly = 0.5, lz = 0
      for (let b = 0; b <= blkIdx; b++) {
        const pos = this._infoBlocks[obj][b].resolvePosition(lx, ly, lz)
        if (pos.valid) { lx = pos.x; ly = pos.y; lz = pos.z }
      }

      results.push({
        id:   obj,
        x:    lx,
        y:    ly,
        z:    lz,
        gain: block.gain >= 0 ? block.gain : 1.0,
        size: block.size >= 0 ? Math.max(0.05, block.size) : 0.1,
        valid: block.validPosition,
        isBed: block.anchor === OBJ_ANCHOR_SPEAKER
      })
    }
    return results
  }

  // ── private ─────────────────────────────────────────────────────────────────

  _readObjectElement (reader, objectCount, bedOrISFObjects) {
    this._readMDUpdateInfo(reader)

    if (!reader.readBit()) {   // reserved bit
      reader.skip(5)
    }

    // Allocate info block matrix [objectCount][blockCount]
    const blockCount = this._blockOffsets.length
    this._infoBlocks = []
    for (let obj = 0; obj < objectCount; obj++) {
      this._infoBlocks[obj] = []
      for (let blk = 0; blk < blockCount; blk++) {
        this._infoBlocks[obj][blk] = new ObjectInfoBlock()
      }
    }

    // Read info blocks: outer = objects, inner = blocks
    for (let obj = 0; obj < objectCount; obj++) {
      for (let blk = 0; blk < blockCount; blk++) {
        this._infoBlocks[obj][blk].update(reader, blk, obj < bedOrISFObjects)
      }
    }

    this.minOffset = this._blockOffsets[0] ?? 0
  }

  _readMDUpdateInfo (reader) {
    // sampleOffset: 2-bit mode
    const offsetMode = reader.read(2)
    switch (offsetMode) {
      case 0: this._sampleOffset = 0; break
      case 1: this._sampleOffset = SAMPLE_OFFSET_INDEX[reader.read(2)]; break
      case 2: this._sampleOffset = reader.read(5); break
      default: this._sampleOffset = 0   // mode 3 = unsupported
    }

    // Number of blocks
    const blockCount = reader.read(3) + 1
    this._blockOffsets  = new Array(blockCount)
    this._rampDurations = new Array(blockCount)

    for (let blk = 0; blk < blockCount; blk++) {
      this._readBlockUpdateInfo(reader, blk)
    }
  }

  _readBlockUpdateInfo (reader, blk) {
    this._blockOffsets[blk]  = reader.read(6) + this._sampleOffset
    const rampCode           = reader.read(2)
    if (rampCode === 3) {
      this._rampDurations[blk] = reader.readBit()
        ? RAMP_DURATION_INDEX[reader.read(4)]
        : reader.read(11)
    } else {
      this._rampDurations[blk] = RAMP_DURATIONS[rampCode]
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ObjectAudioMetadata — per Cavern's ObjectAudioMetadata.cs
// ─────────────────────────────────────────────────────────────────────────────

class ObjectAudioMetadata {
  constructor () {
    this.objectCount    = 0
    this.bedCount       = 0
    this._elements      = []   // OAElementMD[]
    this._isfInUse      = false
    this._isfIndex      = 0
  }

  /**
   * Decode an OAMD payload.
   * Matches Cavern's ObjectAudioMetadata.Decode().
   */
  decode (reader, sampleOffset) {
    // Version check
    let version = reader.read(2)
    if (version === 3) version += reader.read(3)
    if (version !== 0) return false   // unsupported version

    // Object count (5-bit + optional 7-bit extension)
    this.objectCount = reader.read(5) + 1
    if (this.objectCount === 32) this.objectCount += reader.read(7)

    this._parseProgramAssignment(reader)

    const alternateObjectPresent = reader.readBit()

    // Element count (4-bit + optional 5-bit extension)
    let elementCount = reader.read(4)
    if (elementCount === 15) elementCount += reader.read(5)

    const bedOrISFObjects = this.bedCount +
      (this._isfInUse ? (ISF_OBJECT_COUNT[this._isfIndex] ?? 0) : 0)

    this._elements = []
    for (let i = 0; i < elementCount; i++) {
      const el = new OAElementMD()
      el.read(reader, alternateObjectPresent, this.objectCount, bedOrISFObjects)
      this._elements.push(el)
    }

    return true
  }

  /**
   * Get object positions at the given sample timecode.
   * Returns the element whose minOffset best brackets timecode.
   */
  getObjectsAtTimecode (timecode) {
    // Find the most-recently-applicable element (like Cavern's UpdateSources)
    let best = null
    for (let i = this._elements.length - 1; i >= 0; i--) {
      const el = this._elements[i]
      if (el.minOffset < 0) continue
      if (el.minOffset <= timecode) { best = el; break }
    }
    if (!best && this._elements.length > 0) {
      // fallback: last valid element
      for (let i = this._elements.length - 1; i >= 0; i--) {
        if (this._elements[i].minOffset >= 0) { best = this._elements[i]; break }
      }
    }
    return best ? best.getPositions(timecode) : []
  }

  // ── private ─────────────────────────────────────────────────────────────────

  /**
   * Parse program assignment block.
   * Full port of Cavern's ObjectAudioMetadata.ProgramAssignment().
   */
  _parseProgramAssignment (reader) {
    this.bedCount   = 0
    this._isfInUse  = false

    if (reader.readBit()) {
      // Dynamic-object-only program
      if (reader.readBit()) {
        // LFE present → 1 bed channel
        this.bedCount = 1
      }
      return
    }

    const contentDesc = reader.read(4)

    // Bit 0: bed objects with speaker-anchored coordinates
    if ((contentDesc & 1) !== 0) {
      reader.skip(1)   // distributable flag
      const multiInstance = reader.readBit()
      const bedCount      = multiInstance ? reader.read(3) + 2 : 1
      for (let bed = 0; bed < bedCount; bed++) {
        if (reader.readBit()) {
          // LFE only
          this.bedCount += 1
        } else {
          if (reader.readBit()) {
            // Standard 10-bit assignment
            const bits = reader.readBits(10)
            for (let i = 0; i < bits.length; i++) {
              if (bits[i]) {
                this.bedCount += STANDARD_BED_CHANNELS[i].length
              }
            }
          } else {
            // Non-standard 17-bit assignment
            const bits = reader.readBits(17)
            this.bedCount += bits.filter(Boolean).length
          }
        }
      }
    }

    // Bit 1: ISF (Intermediate Spatial Format)
    if ((contentDesc & 2) !== 0) {
      this._isfInUse  = true
      this._isfIndex  = reader.read(3)
    }

    // Bit 2: room/screen-anchored dynamic objects count (informational)
    if ((contentDesc & 4) !== 0) {
      if (reader.read(5) === 31) reader.skip(7)
    }

    // Bit 3: reserved
    if ((contentDesc & 8) !== 0) {
      reader.skip((reader.read(4) + 1) * 8)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JOC header parser — minimal port to get objectCount + ObjectActive[]
// ─────────────────────────────────────────────────────────────────────────────

class JocHeader {
  constructor () {
    this.channelCount  = 0
    this.objectCount   = 0
    this.objectActive  = []
    this.gain          = 1.0
  }

  /**
   * Decode JOC payload header + info section (no DSP data).
   * Matches Cavern's JointObjectCoding.DecodeHeader() + DecodeInfo().
   */
  decode (reader) {
    try {
      // Header
      const downmixConfig = reader.read(3)
      if (downmixConfig > 4) return false
      this.channelCount = (downmixConfig === 0 || downmixConfig === 3) ? 5 : 7
      this.objectCount  = reader.read(6) + 1
      this.objectActive = new Array(this.objectCount).fill(false)

      if (reader.read(3) !== 0) return false   // joc_ext_config_idx must be 0

      // Info section: gain + sequence counter + per-object active flags
      const gainPower = reader.read(3)
      const gainFrac  = reader.read(5)
      this.gain = 1 + (gainFrac / 32) * Math.pow(2, gainPower - 4)
      reader.skip(10)   // sequence counter

      for (let obj = 0; obj < this.objectCount; obj++) {
        this.objectActive[obj] = reader.readBit()
        if (this.objectActive[obj]) {
          reader.skip(3)              // bandsIndex
          reader.readBit()            // sparseCoded
          reader.readBitInt()         // quantizationTable
          const steep = reader.readBit()  // steepSlope
          const dps   = reader.read(1) + 1   // dataPoints
          if (steep) reader.skip(dps * 5)    // timeslot offsets
        }
      }
      return true
    } catch {
      return false
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ExtensibleMetadataDecoder — per Cavern's ExtensibleMetadataDecoder.cs
// ─────────────────────────────────────────────────────────────────────────────

class ExtensibleMetadataDecoder {
  constructor () {
    this.hasObjects  = false
    this.oamd        = new ObjectAudioMetadata()
    this.joc         = new JocHeader()
  }

  /**
   * Scan a binary region for the EMDF sync word and decode the block.
   *
   * @param {Uint8Array} frameData   full frame bytes (for byte-level scan)
   * @param {ArrayBuffer} fullBuffer original buffer
   * @param {number} frameByteStart  byte offset of frame start in fullBuffer
   * @param {number} frameByteLen    frame length in bytes
   */
  decode (frameData, fullBuffer, frameByteStart, frameByteLen) {
    this.hasObjects = false

    // ── Scan BACKWARDS for EMDF sync word (0x5838) ────────────────────────────
    // EMDF data lives in the auxiliary data region at the END of each frame.
    // Scanning forward from byte 0 would hit false positives in compressed
    // audio data. Scanning backward finds the real EMDF immediately.
    // This matches Cavern's approach of scanning from the current (end)
    // position in the extractor after audio decoding.
    let emdfByteOffset = -1
    for (let i = frameByteLen - 2; i >= 5; i--) {
      if (frameData[i] === 0x58 && frameData[i + 1] === 0x38) {
        emdfByteOffset = i + 2   // skip sync word; length field starts here
        break
      }
    }
    if (emdfByteOffset === -1) return false

    // Build a BitReader starting just after the sync word
    const regionLen = frameByteLen - emdfByteOffset
    if (regionLen < 4) return false

    const reader = new BitReader(
      fullBuffer,
      frameByteStart + emdfByteOffset,
      regionLen,
      frameByteStart + frameByteLen   // backPosition fence
    )

    return this._decodeBlock(reader)
  }

  // ── private ─────────────────────────────────────────────────────────────────

  _decodeBlock (reader) {
    const length       = reader.read(16)
    const frameEndBit  = reader.position + length * 8

    if (frameEndBit > reader.bitLen) return false

    // Version
    let version = reader.read(2)
    if (version === 3) version += reader.variableBits(2)
    // Key
    let key = reader.read(3)
    if (key === 7) key += reader.variableBits(3)

    if (version !== 0 || key !== 0) return false

    // ── Payload loop ──────────────────────────────────────────────────────────
    while (reader.position < frameEndBit) {
      let payloadID = reader.read(5)
      if (payloadID === 0) break   // end of payloads

      if (payloadID === 0x1F) payloadID += reader.variableBits(5)
      if (payloadID > JOC_PAYLOAD_ID) return false   // Cavern bails here

      // Payload wrapper header (matches Cavern's ExtensibleMetadataDecoder.DecodeBlock)
      const hasSampleOffset = reader.readBit()
      let sampleOffset = 0
      if (hasSampleOffset) {
        // 12-bit value, lowest bit is reserved (shift away) → Cavern: Read(12) >> 1
        sampleOffset = reader.read(12) >> 1
      }

      // Three optional extension flag fields in Cavern source order:
      if (reader.readBit()) reader.variableBits(11)   // EMDF extension field 1
      if (reader.readBit()) reader.variableBits(2)    // EMDF extension field 2
      if (reader.readBit()) reader.skip(8)            // EMDF extension field 3

      // Frame-alignment / presentation-offset flags
      if (!reader.readBit()) {
        let frameAligned = false
        if (!hasSampleOffset) {
          frameAligned = reader.readBit()
          if (frameAligned) reader.skip(2)
        }
        if (hasSampleOffset || frameAligned) reader.skip(7)
      }

      // Payload length in bytes (variable-bits * 8 → bits)
      const payloadBytes = reader.variableBits(8)
      const payloadEnd   = reader.position + payloadBytes * 8

      if (payloadEnd > reader.bitLen) return false

      if (payloadID === OAMD_PAYLOAD_ID) {
        this.oamd.decode(reader, sampleOffset)
        this.hasObjects = true
      } else if (payloadID === JOC_PAYLOAD_ID) {
        this.joc.decode(reader)
        this.hasObjects = true
      }

      reader.position = payloadEnd   // skip to next payload
    }

    return true
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EAC3Parser — public API (frame-level orchestration)
// ─────────────────────────────────────────────────────────────────────────────

export class EAC3Parser {
  constructor () {
    this.objects      = []
    this.sampleRate   = 48000
    this.channelCount = 0
    this.isAtmos      = false
    this.totalDuration = 0
    this._timelineCache = null
  }

  /**
   * Parse a raw E-AC-3 bitstream and extract all Atmos object metadata.
   *
   * @param {ArrayBuffer} buffer  raw .eac3 / .ec3 bitstream
   * @returns {{ sampleRate, channelCount, isAtmos, duration, objects }}
   */
  parse (buffer) {
    const data        = new DataView(buffer)
    const bytes       = new Uint8Array(buffer)
    const length      = buffer.byteLength
    let   offset      = 0
    let   frameIndex  = 0
    let   sampleTime  = 0   // in samples
    this.objects      = []
    this._timelineCache = null

    const emdfDecoder = new ExtensibleMetadataDecoder()

    while (offset < length - 8) {
      // ── Find E-AC-3 sync word ─────────────────────────────────────────────
      if (data.getUint16(offset) !== EAC3_SYNC_WORD) {
        offset++
        continue
      }

      // ── Parse frame header ─────────────────────────────────────────────────
      // Byte 2: [strmtyp(2)][substreamid(3)][frmsiz_hi(3)]
      // Byte 3: [frmsiz_lo(8)]
      // Byte 4: [fscod(2)][numblkscod(2)][acmod(3)][lfeon(1)]
      const b2   = bytes[offset + 2]
      const b3   = bytes[offset + 3]
      const b4   = bytes[offset + 4]

      const strmtyp    = (b2 >> 6) & 0x03
      const frmsizCode = ((b2 & 0x07) << 8) | b3
      const frameSize  = (frmsizCode + 1) * 2   // in bytes

      if (frameSize < 8 || offset + frameSize > length) {
        offset += 2
        continue
      }

      const fscod      = (b4 >> 6) & 0x03
      const numblkscod = (b4 >> 4) & 0x03
      const sampleRate = fscod < 3 ? SAMPLE_RATES[fscod] : 48000
      const numBlocks  = BLOCKS_PER_FRAME[numblkscod] ?? 6
      const frameSamples = numBlocks * 256

      if (frameIndex === 0) {
        this.sampleRate   = sampleRate
        this.channelCount = _getChannelCount(b4)
      }

      // ── Scan ALL frame types for EMDF
      // Real Atmos: strmtyp==1 (dependent) is primary. We also check 0 / 2.
      // Wrapped in try-catch: a malformed frame must not kill the entire parse.
      try {
        const frameBytes = new Uint8Array(buffer, offset, frameSize)
        const decoded    = emdfDecoder.decode(
          frameBytes, buffer, offset, frameSize
        )

        if (decoded && emdfDecoder.hasObjects) {
          this.isAtmos = true
          // Convert sampleTime to seconds for our timeline
          const timestamp = sampleTime / sampleRate
          // Get objects from OAMD (prefer block 0 timecode = 0)
          const objs = emdfDecoder.oamd.getObjectsAtTimecode(0)
          for (const obj of objs) {
            if (obj.valid && !obj.isBed) {
              this.objects.push({
                id:         obj.id,
                timestamp,
                x:          obj.x,
                y:          obj.y,
                z:          obj.z,
                size:       obj.size,
                gain:       obj.gain,
                confidence: 'joc-native'
              })
            }
          }
        }
      } catch (frameErr) {
        // Skip malformed frames silently — continue parsing the next one
      }

      sampleTime  += frameSamples
      offset      += frameSize
      frameIndex++
    }

    this.totalDuration = sampleTime / this.sampleRate

    return {
      sampleRate:   this.sampleRate,
      channelCount: this.channelCount,
      isAtmos:      this.isAtmos,
      duration:     this.totalDuration,
      objectCount:  emdfDecoder.oamd.objectCount,
      objects:      this.objects
    }
  }

  /**
   * Get interpolated object positions at playback time `time` (seconds).
   * Reuses a time-bucketed cache for O(1) lookup after first call.
   *
   * @param {number} time         playback time in seconds
   * @param {number} [persistMs]  how long (ms) to keep showing an object after last update
   */
  getObjectsAtTime (time, persistMs = 64) {
    if (this.objects.length === 0) return []

    if (!this._timelineCache) {
      this._timelineCache = new Map()
      for (const obj of this.objects) {
        // FIXED: Convert to integer milliseconds for safe Map keys
        const tMs = Math.round(obj.timestamp * 1000)
        if (!this._timelineCache.has(tMs)) this._timelineCache.set(tMs, [])
        this._timelineCache.get(tMs).push(obj)
      }
    }

    const result = new Map()
    const timeMs = Math.round(time * 1000)

    // Lookup safely using integers
    for (let c = timeMs - persistMs; c <= timeMs + persistMs; c++) {
      const objs = this._timelineCache.get(c)
      if (objs) {
        for (const obj of objs) {
          if (!result.has(obj.id) || c > Math.round(result.get(obj.id).timestamp * 1000)) {
            result.set(obj.id, { ...obj })
          }
        }
      }
    }

    return Array.from(result.values())
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Clamp a number to [0, 1]. */
function clamp01 (v) { return Math.max(0, Math.min(1, v)) }

/** Convert dB to linear gain. */
function dbToGain (db) { return Math.pow(10, db / 20) }

/**
 * Cavern's ExtensibleMetadataExtensions.VariableBits(extractor, 4, 4)
 * Same continuation-bit algorithm as BitReader.variableBits(), but with
 * a limit parameter (4) that caps the number of extension iterations.
 * Used in OAElementMD for element payload sizes (result is in BITS).
 */
function variableBits44 (reader) {
  let value = 0
  let readMore
  let limit = 4
  do {
    value += reader.read(4)
    readMore = reader.readBit()
    if (readMore) {
      value = (value + 1) << 4
    }
  } while (readMore && limit-- !== 0)
  return value
}

/** Extract base channel count from the acmod field (byte 4 lower bits). */
function _getChannelCount (b4) {
  const acmod = (b4 >> 1) & 0x07
  const lfeon = b4 & 0x01
  const baseCh = [2, 1, 2, 3, 3, 4, 4, 5][acmod] ?? 2
  return baseCh + lfeon
}