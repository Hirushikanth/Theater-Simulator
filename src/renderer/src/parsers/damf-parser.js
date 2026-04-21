/**
 * DAMF (Dolby Atmos Master Format) Metadata Parser
 *
 * Parses the output files from truehdd:
 *   - .atmos       → Root file (YAML): bed channel mapping + object IDs
 *   - .atmos.metadata → Metadata file (YAML): per-object position events over time
 *
 * The metadata format is events-based:
 *   sampleRate: 48000
 *   events:
 *     - ID: 10
 *       samplePos: 0
 *       active: true
 *       pos: [-1, 1, 0.5]
 *       gain: 0
 *       size: 0
 *       rampLength: 0
 *
 * Reference: Cavern's DolbyAtmosMasterMetadataFile.cs and DolbyAtmosMasterRootFile.cs
 */

export class DAMFParser {
  constructor() {
    this.objects = []        // dynamic objects with position trajectories
    this.beds = []           // bed channels (static speakers)
    this.sampleRate = 48000
    this.duration = 0
    this.objectMapping = []  // maps PCM stream index → internal object ID
    this._objectEvents = new Map()  // ID → sorted array of events
  }

  /**
   * Parse both the root file and metadata file.
   * @param {string} rootYaml     - Contents of .atmos root file (can be null)
   * @param {string} metadataYaml - Contents of .atmos.metadata file
   * @returns {{ hasDAMF, objects, beds, duration }}
   */
  parse(rootYaml, metadataYaml) {
    try {
      // Parse root file first (gives us bed/object ID mapping)
      if (rootYaml) {
        this.parseRootFile(rootYaml)
      }

      // Parse metadata events
      if (metadataYaml) {
        this.parseMetadataFile(metadataYaml)
      }

      return {
        hasDAMF: this.objects.length > 0,
        objects: this.objects,
        beds: this.beds,
        duration: this.duration,
        sampleRate: this.sampleRate,
        objectCount: this.objects.length,
        bedCount: this.beds.length
      }
    } catch (err) {
      console.error('DAMF parse error:', err)
      return { hasDAMF: false, objects: [], beds: [], duration: 0 }
    }
  }

  /**
   * Parse the .atmos root file (YAML).
   * Extracts bed channel definitions and object ID mapping.
   *
   * Structure:
   *   presentations:
   *     - bedInstances:
   *         - channels:
   *             - channel: L
   *               ID: 0
   *         objects:
   *           - ID: 10
   */
  parseRootFile(yamlText) {
    const lines = yamlText.split('\n')
    let inBedChannels = false
    let inObjects = false
    let currentBed = null
    const bedChannels = []
    const objectIDs = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      // Detect sections
      if (trimmed === 'channels:' || trimmed.startsWith('channels:')) {
        inBedChannels = true
        inObjects = false
        continue
      }
      if (trimmed === 'objects:' || trimmed.startsWith('objects:')) {
        inObjects = true
        inBedChannels = false
        continue
      }

      // Parse bed channels
      if (inBedChannels) {
        const channelMatch = trimmed.match(/channel:\s*(.+)/)
        const idMatch = trimmed.match(/ID:\s*(\d+)/)

        if (trimmed.startsWith('- ')) {
          // New channel entry
          if (currentBed) bedChannels.push(currentBed)
          currentBed = { name: '', id: -1 }
          // Check inline values
          const inlineChannel = trimmed.match(/channel:\s*(\w+)/)
          const inlineId = trimmed.match(/ID:\s*(\d+)/)
          if (inlineChannel) currentBed.name = inlineChannel[1]
          if (inlineId) currentBed.id = parseInt(inlineId[1])
        } else if (currentBed) {
          if (channelMatch) currentBed.name = channelMatch[1].trim()
          if (idMatch) currentBed.id = parseInt(idMatch[1])
        }

        // Break out of bed channels when we hit an unindented line
        if (!line.startsWith(' ') && !line.startsWith('\t') && !trimmed.startsWith('-')) {
          inBedChannels = false
          if (currentBed) { bedChannels.push(currentBed); currentBed = null }
        }
      }

      // Parse object IDs
      if (inObjects) {
        const idMatch = trimmed.match(/ID:\s*(\d+)/)
        if (idMatch) {
          objectIDs.push(parseInt(idMatch[1]))
        }

        if (!line.startsWith(' ') && !line.startsWith('\t') && !trimmed.startsWith('-')) {
          inObjects = false
        }
      }
    }

    // Flush last bed
    if (currentBed) bedChannels.push(currentBed)

    // Store bed channels
    this.beds = bedChannels.map((b, i) => ({
      id: i,
      objectId: b.id,
      name: b.name || `Bed ${i}`,
      channelName: b.name
    }))

    // Build object mapping: PCM stream index → object ID
    // First N streams are bed channels, then dynamic objects
    this.objectMapping = [
      ...bedChannels.map(b => b.id),
      ...objectIDs
    ]

    console.log(`[DAMF] Root: ${bedChannels.length} bed channels, ${objectIDs.length} dynamic objects`)
  }

  /**
   * Parse the .atmos.metadata file (YAML).
   * Events-based format with ID, samplePos, pos, gain, size, etc.
   */
  parseMetadataFile(yamlText) {
    const lines = yamlText.split('\n')
    let inEvents = false
    let currentEvent = null
    const allEvents = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      // Top-level sampleRate
      const srMatch = trimmed.match(/^sampleRate:\s*(\d+)/)
      if (srMatch) {
        this.sampleRate = parseInt(srMatch[1]) || 48000
        continue
      }

      // Detect events section
      if (trimmed === 'events:') {
        inEvents = true
        continue
      }

      if (!inEvents) continue

      // New event entry (starts with "- ")
      if (trimmed.startsWith('- ')) {
        if (currentEvent) allEvents.push(currentEvent)
        currentEvent = {
          id: -1,
          samplePos: 0,
          active: true,
          pos: null,
          gain: 0,
          size: 0,
          rampLength: 0
        }
        // Parse inline key-value on the same line as "- "
        const inlineContent = trimmed.substring(2).trim()
        this._parseEventField(currentEvent, inlineContent)
        continue
      }

      // Continuation of current event (any indent = child of current "- " entry)
      if (currentEvent && (line[0] === ' ' || line[0] === '\t')) {
        this._parseEventField(currentEvent, trimmed)
      }
    }

    // Flush last event
    if (currentEvent) allEvents.push(currentEvent)

    console.log(`[DAMF] Metadata: ${allEvents.length} events, sampleRate=${this.sampleRate}`)

    // Group events by object ID
    this._objectEvents.clear()
    const bedObjectIds = new Set(this.beds.map(b => b.objectId))

    for (const evt of allEvents) {
      if (evt.id < 0) continue
      // Skip bed channel events (static positions)
      if (bedObjectIds.has(evt.id)) continue

      if (!this._objectEvents.has(evt.id)) {
        this._objectEvents.set(evt.id, [])
      }
      this._objectEvents.get(evt.id).push(evt)
    }

    // Sort each object's events by samplePos
    for (const [id, events] of this._objectEvents) {
      events.sort((a, b) => a.samplePos - b.samplePos)
    }

    // Build objects array
    let objIndex = 0
    for (const [id, events] of this._objectEvents) {
      if (events.length === 0) continue

      const positions = events
        .filter(e => e.pos !== null && e.active)
        .map(e => ({
          time: e.samplePos / this.sampleRate,
          x: this._normalizeX(e.pos[0]),
          y: this._normalizeY(e.pos[1]),
          z: this._normalizeZ(e.pos[2]),
          gain: this._parseGainValue(e.gain),
          size: Math.max(0.03, (e.size || 0) * 0.1 + 0.05),
          rampLength: e.rampLength,
          confidence: 'damf'
        }))

      if (positions.length > 0) {
        const lastTime = positions[positions.length - 1].time
        if (lastTime > this.duration) this.duration = lastTime

        this.objects.push({
          id: objIndex,
          objectId: id,
          name: `Object ${id}`,
          positions
        })
        objIndex++
      }
    }

    console.log(`[DAMF] Built ${this.objects.length} tracked objects, duration=${this.duration.toFixed(2)}s`)
  }

  /**
   * Parse a single key:value field from an event entry.
   */
  _parseEventField(event, text) {
    if (!text) return

    // ID
    const idMatch = text.match(/ID:\s*(\d+)/)
    if (idMatch) event.id = parseInt(idMatch[1])

    // samplePos
    const spMatch = text.match(/samplePos:\s*(\d+)/)
    if (spMatch) event.samplePos = parseInt(spMatch[1])

    // active
    const activeMatch = text.match(/active:\s*(true|false)/)
    if (activeMatch) event.active = activeMatch[1] === 'true'

    // pos: [x, y, z] — array on one line
    const posMatch = text.match(/pos:\s*\[([^\]]+)\]/)
    if (posMatch) {
      const parts = posMatch[1].split(',').map(s => parseFloat(s.trim()))
      if (parts.length >= 3 && parts.every(p => !isNaN(p))) {
        event.pos = parts
      }
    }

    // gain (could be a number or "-inf")
    const gainMatch = text.match(/gain:\s*(.+)/)
    if (gainMatch) {
      const val = gainMatch[1].trim()
      event.gain = val === '-inf' ? -Infinity : parseFloat(val) || 0
    }

    // size
    const sizeMatch = text.match(/size:\s*([\d.]+)/)
    if (sizeMatch) event.size = parseFloat(sizeMatch[1]) || 0

    // rampLength
    const rampMatch = text.match(/rampLength:\s*(\d+)/)
    if (rampMatch) event.rampLength = parseInt(rampMatch[1]) || 0
  }

  /**
   * DAMF coordinate normalization.
   * DAMF: X ∈ [-1, 1] (left/right), Y ∈ [-1, 1] (back/front), Z ∈ [0, 1] (height)
   * Visualizer: all axes ∈ [0, 1]
   *
   * Cavern swaps Y and Z when reading pos: position = Vector3(x, z, y)
   * From the Cavern source: "new Vector3(parts[0], parts[2], parts[1])"
   * So DAMF [x, y, z] → Cavern (x=left/right, z=front/back, y=height)
   */
  _normalizeX(damfX) {
    // DAMF X: -1 = left, +1 = right → viz 0 = left, 1 = right
    return clamp01((damfX + 1) / 2)
  }

  _normalizeY(damfY) {
    // DAMF Y: +1 = front, -1 = back → viz 0 = front, 1 = back
    return clamp01((-damfY + 1) / 2)
  }

  _normalizeZ(damfZ) {
    // DAMF Z: 0 = floor, 1 = ceiling → viz 0 = floor, 1 = ceiling
    return clamp01(damfZ)
  }

  _parseGainValue(gain) {
    if (gain === -Infinity || gain <= -100) return 0
    // Convert dB to linear gain
    return Math.pow(10, gain / 20)
  }

  /**
   * Get interpolated object positions at a given playback time.
   * For each object, binary-searches the event timeline and interpolates.
   * Objects are only shown AFTER their first active event.
   *
   * @param {number} time - Playback time in seconds
   * @returns {Array<{ id, name, x, y, z, gain, size, confidence }>}
   */
  getObjectsAtTime(time) {
    const result = []

    for (const obj of this.objects) {
      if (obj.positions.length === 0) continue

      const positions = obj.positions
      const firstTime = positions[0].time
      const lastTime = positions[positions.length - 1].time

      // Don't show object before its first active event
      if (time < firstTime) continue

      // After last keyframe: show at last known position
      if (time >= lastTime) {
        const p = positions[positions.length - 1]
        result.push({
          id: obj.id,
          name: obj.name,
          x: p.x, y: p.y, z: p.z,
          gain: p.gain,
          size: p.size,
          confidence: 'damf'
        })
        continue
      }

      // Binary search for bracket
      let lo = 0, hi = positions.length - 1
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
        gain: before.gain + (after.gain - before.gain) * t,
        size: before.size + (after.size - before.size) * t,
        confidence: 'damf'
      })
    }

    return result
  }
}

function clamp01(v) { return Math.max(0, Math.min(1, v)) }
