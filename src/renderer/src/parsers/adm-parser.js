/**
 * ADM BWF (Audio Definition Model Broadcast Wave Format) Parser
 *
 * Parses RIFF/RF64 WAV files containing ADM metadata in the 'axml' chunk.
 * The XML defines audioObjects, audioBlockFormats with time-stamped positions.
 *
 * CRITICAL FIX: Previous version queried ALL audioBlockFormat elements in
 * the document for every object. This version follows the proper ADM
 * reference chain:
 *   audioObject → audioPackFormatIDRef → audioPackFormat
 *     → audioChannelFormatIDRef → audioChannelFormat → audioBlockFormat
 *
 * Reference: ITU-R BS.2076
 */

export class ADMParser {
  constructor() {
    this.objects = []
    this.channels = []
    this.programmes = []
    this.duration = 0
  }

  /**
   * Parse a WAV/BW64 file buffer and extract ADM metadata
   * @param {ArrayBuffer} buffer - The WAV file
   */
  parse(buffer) {
    const data = new DataView(buffer)
    const xmlString = this.extractAXMLChunk(data)
    
    if (!xmlString) {
      return { hasADM: false, objects: [], programmes: [] }
    }

    return this.parseADMXml(xmlString)
  }

  /**
   * Parse directly from an XML string (used when axml is read efficiently via IPC)
   * @param {string} xmlString - The ADM XML content
   */
  parseFromXml(xmlString) {
    return this.parseADMXml(xmlString)
  }

  /**
   * Find and extract the 'axml' RIFF chunk from the binary
   */
  extractAXMLChunk(data) {
    const length = data.byteLength
    let offset = 0

    // Check RIFF or RF64 header
    const magic = String.fromCharCode(
      data.getUint8(0), data.getUint8(1), data.getUint8(2), data.getUint8(3)
    )

    if (magic !== 'RIFF' && magic !== 'RF64' && magic !== 'BW64') {
      return null
    }

    // Skip past the header (12 bytes: magic + size + format)
    offset = 12

    // Scan chunks
    while (offset < length - 8) {
      const chunkId = String.fromCharCode(
        data.getUint8(offset),
        data.getUint8(offset + 1),
        data.getUint8(offset + 2),
        data.getUint8(offset + 3)
      )
      const chunkSize = data.getUint32(offset + 4, true) // little-endian

      if (chunkId === 'axml') {
        // Found the ADM XML chunk
        const xmlBytes = new Uint8Array(data.buffer, offset + 8, chunkSize)
        const decoder = new TextDecoder('utf-8')
        return decoder.decode(xmlBytes)
      }

      // Move to next chunk (pad to even boundary)
      offset += 8 + chunkSize
      if (chunkSize % 2 !== 0) offset++
    }

    return null
  }

  /**
   * Parse ADM XML content
   */
  parseADMXml(xmlString) {
    const parser = new DOMParser()
    const doc = parser.parseFromString(xmlString, 'application/xml')

    // Check for parse errors
    const parseError = doc.querySelector('parsererror')
    if (parseError) {
      console.error('ADM XML parse error:', parseError.textContent)
      return { hasADM: false, objects: [], programmes: [] }
    }

    // Build lookup maps for the reference chain
    const packFormatMap = this._buildPackFormatMap(doc)
    const channelFormatMap = this._buildChannelFormatMap(doc)

    // Extract audio programmes
    const programmeElements = doc.querySelectorAll('audioProgramme')
    for (const pe of programmeElements) {
      this.programmes.push({
        id: pe.getAttribute('audioProgrammeID'),
        name: pe.getAttribute('audioProgrammeName') || 'Programme',
        language: pe.getAttribute('audioProgrammeLanguage') || ''
      })
    }

    // Extract audio objects and follow the reference chain for positions
    const objectElements = doc.querySelectorAll('audioObject')
    let objIndex = 0

    for (const oe of objectElements) {
      const objectId = oe.getAttribute('audioObjectID')
      const objectName = oe.getAttribute('audioObjectName') || `Object ${objIndex}`

      // Follow reference chain: object → packFormat → channelFormat → blockFormats
      const positions = this._extractObjectPositionsViaRefs(oe, packFormatMap, channelFormatMap)
      const trackRefs = oe.querySelectorAll('audioTrackUIDRef')

      if (positions.length > 0) {
        this.objects.push({
          id: objIndex,
          objectId,
          name: objectName,
          positions,
          trackRefs: Array.from(trackRefs).map(r => r.textContent)
        })
        objIndex++
      }
    }

    // Fallback: if no objects found via audioObject elements,
    // try extracting from audioChannelFormat elements directly
    if (this.objects.length === 0) {
      this._extractFromChannelFormats(doc, channelFormatMap)
    }

    return {
      hasADM: this.objects.length > 0,
      programmes: this.programmes,
      objects: this.objects,
      duration: this.duration
    }
  }

  /**
   * Build a map of audioPackFormatID → array of audioChannelFormatIDRefs
   */
  _buildPackFormatMap(doc) {
    const map = new Map()
    const packFormats = doc.querySelectorAll('audioPackFormat')

    for (const pf of packFormats) {
      const pfId = pf.getAttribute('audioPackFormatID')
      if (!pfId) continue

      const channelRefs = []
      const refElements = pf.querySelectorAll('audioChannelFormatIDRef')
      for (const ref of refElements) {
        channelRefs.push(ref.textContent.trim())
      }

      // Also check for nested pack format refs (recursive packs)
      const nestedPackRefs = pf.querySelectorAll('audioPackFormatIDRef')
      for (const ref of nestedPackRefs) {
        channelRefs.push({ nestedPackRef: ref.textContent.trim() })
      }

      map.set(pfId, channelRefs)
    }

    return map
  }

  /**
   * Build a map of audioChannelFormatID → { element, blockFormats }
   */
  _buildChannelFormatMap(doc) {
    const map = new Map()
    const channelFormats = doc.querySelectorAll('audioChannelFormat')

    for (const cf of channelFormats) {
      const cfId = cf.getAttribute('audioChannelFormatID')
      if (!cfId) continue

      const blockFormats = cf.querySelectorAll('audioBlockFormat')
      map.set(cfId, {
        element: cf,
        name: cf.getAttribute('audioChannelFormatName') || '',
        blockFormats: Array.from(blockFormats)
      })
    }

    return map
  }

  /**
   * Extract position data for an audio object by following the ADM reference chain.
   * audioObject → audioPackFormatIDRef → audioPackFormat → audioChannelFormatIDRef
   *   → audioChannelFormat → audioBlockFormat
   */
  _extractObjectPositionsViaRefs(objectElement, packFormatMap, channelFormatMap) {
    const positions = []

    // Get pack format references from this object
    const packRefs = objectElement.querySelectorAll('audioPackFormatIDRef')

    for (const packRef of packRefs) {
      const packId = packRef.textContent.trim()
      const channelRefs = packFormatMap.get(packId)
      if (!channelRefs) continue

      // Resolve channel format references
      const resolvedChannelIds = this._resolveChannelRefs(channelRefs, packFormatMap)

      for (const channelId of resolvedChannelIds) {
        const channelData = channelFormatMap.get(channelId)
        if (!channelData) continue

        // Only process object-type channels (type definition 0003)
        // Type codes: 0001=DirectSpeakers, 0002=Matrix, 0003=Objects, 0004=HOA
        const isObjectType = channelId.includes('0003') ||
                             channelData.name?.toLowerCase().includes('object')

        // If we can't determine type, include it anyway (better to show extra than miss objects)
        for (const bf of channelData.blockFormats) {
          const pos = this._parseBlockFormat(bf)
          if (pos) positions.push(pos)
        }
      }
    }

    return positions
  }

  /**
   * Resolve channel format references, handling nested pack formats
   */
  _resolveChannelRefs(refs, packFormatMap, depth = 0) {
    if (depth > 5) return [] // Prevent infinite recursion

    const channelIds = []
    for (const ref of refs) {
      if (typeof ref === 'string') {
        channelIds.push(ref)
      } else if (ref.nestedPackRef) {
        // Recursive pack format reference
        const nestedRefs = packFormatMap.get(ref.nestedPackRef)
        if (nestedRefs) {
          channelIds.push(...this._resolveChannelRefs(nestedRefs, packFormatMap, depth + 1))
        }
      }
    }
    return channelIds
  }

  /**
   * Parse a single audioBlockFormat element into a position entry
   */
  _parseBlockFormat(bf) {
    const rtime = bf.getAttribute('rtime') || '00:00:00.00000'
    const duration = bf.getAttribute('duration') || '00:00:00.01000'

    const time = this.parseADMTime(rtime)
    const dur = this.parseADMTime(duration)

    // Get position elements
    const posElements = bf.querySelectorAll('position')
    let azimuth = 0, elevation = 0, distance = 1
    let x = 0.5, y = 0.5, z = 0
    let isCartesian = false
    let hasPosition = false

    for (const pos of posElements) {
      hasPosition = true
      const coord = pos.getAttribute('coordinate')
      const value = parseFloat(pos.textContent)

      switch (coord) {
        case 'azimuth': azimuth = value; break
        case 'elevation': elevation = value; break
        case 'distance': distance = value; break
        case 'X': x = value; isCartesian = true; break
        case 'Y': y = value; isCartesian = true; break
        case 'Z': z = value; isCartesian = true; break
      }
    }

    if (!hasPosition) return null

    // Get width/height/depth if present
    const widthEl = bf.querySelector('width')
    const size = widthEl ? parseFloat(widthEl.textContent) / 360 : 0.05

    // Get gain
    const gainEl = bf.querySelector('gain')
    let gain = 1.0
    if (gainEl) {
      const gainDB = gainEl.getAttribute('gainUnit') === 'dB'
      const gainVal = parseFloat(gainEl.textContent)
      gain = gainDB ? Math.pow(10, gainVal / 20) : gainVal
    }

    let finalX, finalY, finalZ

    if (isCartesian) {
      // ADM Cartesian: X(-1 left, +1 right), Y(-1 back, +1 front), Z(0 bottom, 1 top)
      finalX = (x + 1) / 2       // normalize to 0-1
      finalY = (-y + 1) / 2      // normalize: +1 front → 0, -1 back → 1
      finalZ = Math.max(0, z)
    } else {
      // Convert spherical to our normalized coordinates
      // ADM Spherical: azimuth (-180 to 180, 0=front, +left), elevation (-90 to 90)
      const azRad = azimuth * Math.PI / 180
      const elRad = elevation * Math.PI / 180

      finalX = (-azimuth / 180 + 1) / 2  // 0=left, 1=right
      finalY = 0.5 - (distance * Math.cos(elRad) * Math.cos(azRad)) / 2
      finalZ = Math.max(0, Math.sin(elRad))
    }

    if (time + dur > this.duration) {
      this.duration = time + dur
    }

    return {
      time,
      duration: dur,
      x: clamp01(finalX),
      y: clamp01(finalY),
      z: clamp01(finalZ),
      size,
      gain,
      confidence: 'adm'
    }
  }

  /**
   * Extract objects from audioChannelFormat elements directly.
   * Fallback for ADM files that don't use audioObject → audioPackFormat linking.
   */
  _extractFromChannelFormats(doc, channelFormatMap) {
    let objIndex = 0

    for (const [cfId, channelData] of channelFormatMap) {
      // Only process object-type channels (type 0003)
      if (!cfId.includes('0003') && !channelData.name?.toLowerCase().includes('object')) continue

      const positions = []
      for (const bf of channelData.blockFormats) {
        const pos = this._parseBlockFormat(bf)
        if (pos) positions.push(pos)
      }

      if (positions.length > 0) {
        this.objects.push({
          id: objIndex,
          objectId: cfId,
          name: channelData.name || `Object ${objIndex}`,
          positions
        })
        objIndex++
      }
    }
  }

  /**
   * Get interpolated object positions at a given time.
   * Uses binary search for efficient lookup.
   */
  getObjectsAtTime(time) {
    const result = []

    for (const obj of this.objects) {
      if (obj.positions.length === 0) continue

      const positions = obj.positions
      let lo = 0, hi = positions.length - 1

      // Before first keyframe
      if (time <= positions[0].time) {
        const p = positions[0]
        result.push({
          id: obj.id, name: obj.name,
          x: p.x, y: p.y, z: p.z,
          size: p.size, gain: p.gain,
          confidence: 'adm'
        })
        continue
      }

      // After last keyframe
      if (time >= positions[hi].time) {
        const p = positions[hi]
        result.push({
          id: obj.id, name: obj.name,
          x: p.x, y: p.y, z: p.z,
          size: p.size, gain: p.gain,
          confidence: 'adm'
        })
        continue
      }

      // Binary search for bracket
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1
        if (positions[mid].time <= time) lo = mid
        else hi = mid
      }

      const before = positions[lo]
      const after = positions[hi]

      // Interpolate
      const dt = after.time - before.time
      const t = dt > 0 ? (time - before.time) / dt : 0

      result.push({
        id: obj.id,
        name: obj.name,
        x: before.x + (after.x - before.x) * t,
        y: before.y + (after.y - before.y) * t,
        z: before.z + (after.z - before.z) * t,
        size: before.size + (after.size - before.size) * t,
        gain: before.gain + (after.gain - before.gain) * t,
        confidence: 'adm'
      })
    }

    return result
  }

  /**
   * Parse ADM time string (HH:MM:SS.SSSSS or fractional)
   */
  parseADMTime(timeStr) {
    if (!timeStr) return 0
    // Format: HH:MM:SS.SSSSS or HH:MM:SS.SSSSSNNNNN
    const parts = timeStr.split(':')
    if (parts.length === 3) {
      const hours = parseInt(parts[0]) || 0
      const mins = parseInt(parts[1]) || 0
      const secs = parseFloat(parts[2]) || 0
      return hours * 3600 + mins * 60 + secs
    }
    return parseFloat(timeStr) || 0
  }
}

function clamp01(v) { return Math.max(0, Math.min(1, v)) }
