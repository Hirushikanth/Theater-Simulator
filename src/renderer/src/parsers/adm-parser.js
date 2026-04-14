/**
 * ADM BWF (Audio Definition Model Broadcast Wave Format) Parser
 *
 * Parses RIFF/RF64 WAV files containing ADM metadata in the 'axml' chunk.
 * The XML defines audioObjects, audioBlockFormats with time-stamped positions.
 *
 * Reference: ITU-R BS.2076
 */

export class ADMParser {
  constructor() {
    this.objects = []
    this.channels = []
    this.programmes = []
    this.timeline = new Map()
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
      return { hasADM: false, objects: [], timeline: new Map() }
    }

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

    // Extract audio programmes
    const programmeElements = doc.querySelectorAll('audioProgramme')
    for (const pe of programmeElements) {
      this.programmes.push({
        id: pe.getAttribute('audioProgrammeID'),
        name: pe.getAttribute('audioProgrammeName') || 'Programme',
        language: pe.getAttribute('audioProgrammeLanguage') || ''
      })
    }

    // Extract audio objects and their positions
    const objectElements = doc.querySelectorAll('audioObject')
    let objIndex = 0

    for (const oe of objectElements) {
      const objectId = oe.getAttribute('audioObjectID')
      const objectName = oe.getAttribute('audioObjectName') || `Object ${objIndex}`

      // Find referenced audioPackFormats → audioChannelFormats → audioBlockFormats
      const packRefs = oe.querySelectorAll('audioPackFormatIDRef')
      const trackRefs = oe.querySelectorAll('audioTrackUIDRef')

      // Get positions from audioBlockFormat elements
      // These can be in audioChannelFormat elements referenced by the pack
      const positions = this.extractObjectPositions(doc, objectId, objIndex)

      this.objects.push({
        id: objIndex,
        objectId,
        name: objectName,
        positions,
        trackRefs: Array.from(trackRefs).map(r => r.textContent)
      })

      objIndex++
    }

    // Also look for audioChannelFormat directly (some ADM files structure differently)
    if (this.objects.length === 0) {
      this.extractFromChannelFormats(doc)
    }

    // Build timeline
    this.buildTimeline()

    return {
      hasADM: true,
      programmes: this.programmes,
      objects: this.objects,
      timeline: this.timeline,
      duration: this.duration
    }
  }

  /**
   * Extract position data for an audio object
   */
  extractObjectPositions(doc, objectId, objIndex) {
    const positions = []

    // Find all audioBlockFormat elements (they contain position data)
    const blockFormats = doc.querySelectorAll('audioBlockFormat')

    for (const bf of blockFormats) {
      const rtime = bf.getAttribute('rtime') || '00:00:00.00000'
      const duration = bf.getAttribute('duration') || '00:00:00.01000'
      
      const time = this.parseADMTime(rtime)
      const dur = this.parseADMTime(duration)

      // Get position elements
      const posElements = bf.querySelectorAll('position')
      let azimuth = 0, elevation = 0, distance = 1
      let x = 0.5, y = 0.5, z = 0
      let isCartesian = false

      for (const pos of posElements) {
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

      // Get width/height/depth if present
      const widthEl = bf.querySelector('width')
      const heightEl = bf.querySelector('height')
      const depthEl = bf.querySelector('depth')
      const size = widthEl ? parseFloat(widthEl.textContent) / 360 : 0.05

      // Get gain
      const gainEl = bf.querySelector('gain')
      const gain = gainEl ? parseFloat(gainEl.textContent) : 1.0

      let finalX, finalY, finalZ

      if (isCartesian) {
        // ADM Cartesian: X(-1 left, +1 right), Y(-1 back, +1 front), Z(0 bottom, 1 top)
        finalX = (x + 1) / 2    // normalize to 0-1
        finalY = (-y + 1) / 2   // normalize: +1 front → 0, -1 back → 1
        finalZ = Math.max(0, z)
      } else {
        // Convert spherical to our normalized coordinates
        // Azimuth: -180 to 180 (0=front, positive=left in ADM)
        // Elevation: -90 to 90
        finalX = (-azimuth / 180 + 1) / 2  // normalize to 0-1 (0=left, 1=right)
        finalY = 0.5 - (distance * Math.cos(elevation * Math.PI / 180) * Math.cos(azimuth * Math.PI / 180)) / 2
        finalZ = Math.max(0, Math.sin(elevation * Math.PI / 180))
      }

      positions.push({
        time,
        duration: dur,
        x: finalX,
        y: finalY,
        z: finalZ,
        size,
        gain,
        confidence: 'adm'
      })

      if (time + dur > this.duration) {
        this.duration = time + dur
      }
    }

    return positions
  }

  /**
   * Extract objects from audioChannelFormat elements directly
   */
  extractFromChannelFormats(doc) {
    const channelFormats = doc.querySelectorAll('audioChannelFormat')
    let objIndex = 0

    for (const cf of channelFormats) {
      const typeLabel = cf.getAttribute('audioChannelFormatID') || ''
      // Only process object-type channels (type 0003)
      if (!typeLabel.includes('0003') && !typeLabel.includes('Objects')) continue

      const name = cf.getAttribute('audioChannelFormatName') || `Object ${objIndex}`
      const blockFormats = cf.querySelectorAll('audioBlockFormat')
      const positions = []

      for (const bf of blockFormats) {
        const rtime = bf.getAttribute('rtime') || '00:00:00.00000'
        const time = this.parseADMTime(rtime)

        const posElements = bf.querySelectorAll('position')
        let x = 0.5, y = 0.5, z = 0

        for (const pos of posElements) {
          const coord = pos.getAttribute('coordinate')
          const value = parseFloat(pos.textContent)
          if (coord === 'azimuth') x = (-value / 180 + 1) / 2
          if (coord === 'elevation') z = Math.max(0, Math.sin(value * Math.PI / 180))
          if (coord === 'X') x = (value + 1) / 2
          if (coord === 'Y') y = (-value + 1) / 2
          if (coord === 'Z') z = Math.max(0, value)
        }

        positions.push({ time, duration: 0.02, x, y, z, size: 0.05, gain: 1.0, confidence: 'adm' })
        if (time > this.duration) this.duration = time
      }

      if (positions.length > 0) {
        this.objects.push({
          id: objIndex,
          objectId: typeLabel,
          name,
          positions
        })
        objIndex++
      }
    }
  }

  /**
   * Build a time-indexed map of object positions
   */
  buildTimeline() {
    for (const obj of this.objects) {
      for (const pos of obj.positions) {
        // Use integer milliseconds for safe Map keys
        const tMs = Math.round(pos.time * 1000)
        if (!this.timeline.has(tMs)) {
          this.timeline.set(tMs, [])
        }
        this.timeline.set(tMs, [...this.timeline.get(tMs), {
          id: obj.id,
          name: obj.name,
          x: pos.x,
          y: pos.y,
          z: pos.z,
          size: pos.size,
          gain: pos.gain,
          confidence: pos.confidence
        }])
      }
    }
  }

  /**
   * Get interpolated object positions at a given time
   */
  getObjectsAtTime(time) {
    const result = []

    for (const obj of this.objects) {
      if (obj.positions.length === 0) continue

      // Find the position entries surrounding this time
      let before = null, after = null

      for (const pos of obj.positions) {
        if (pos.time <= time) before = pos
        if (pos.time >= time && !after) after = pos
      }

      if (!before && !after) continue
      if (!before) before = after
      if (!after) after = before

      // Interpolate
      let x, y, z, size, gain
      if (before === after || before.time === after.time) {
        x = before.x; y = before.y; z = before.z
        size = before.size; gain = before.gain
      } else {
        const t = (time - before.time) / (after.time - before.time)
        x = before.x + (after.x - before.x) * t
        y = before.y + (after.y - before.y) * t
        z = before.z + (after.z - before.z) * t
        size = before.size + (after.size - before.size) * t
        gain = before.gain + (after.gain - before.gain) * t
      }

      result.push({
        id: obj.id,
        name: obj.name,
        x, y, z, size, gain,
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
