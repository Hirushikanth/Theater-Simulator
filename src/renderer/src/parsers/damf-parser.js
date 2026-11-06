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

      // Detect sections. truehdd emits YAML *list-item* headers
      // ("      - channels:" / "- objects:"), older writers use plain
      // mapping keys ("channels:"), so accept both forms.
      if (/^-?\s*channels:/.test(trimmed)) {
        inBedChannels = true
        inObjects = false
        continue
      }
      if (/^-?\s*objects:/.test(trimmed)) {
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
          active: undefined,
          pos: null,
          gain: undefined,
          size: undefined,
          rampLength: undefined
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

      const positions = this._buildObjectTimeline(events)

      if (positions.some(p => p.active !== false)) {
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
   * Convert raw DAMF events into a state timeline.
   *
   * DAMF only writes properties that changed. `active`, `gain`, and `size`
   * are usually present on the first event and then omitted, so they must be
   * carried forward. An explicit `active: false` has to stay in the timeline
   * as a visibility boundary; otherwise the object remains visible until its
   * next active event and smooth mode interpolates straight through the gap.
   * Implicit terminal parks (a final jump onto the floor plane) are converted
   * to deactivations at the previous position.
   *
   * @param {Array} events  sorted events for one object
   * @returns {Array<{ time, x, y, z, gain, size, active, rampLength, confidence }>}
   */
  _buildObjectTimeline(events) {
    const positions = []
    let state = null

    for (const e of events) {
      if (!state) {
        state = {
          active: true,
          hasPosition: false,
          x: 0,
          y: 0,
          z: 0,
          gain: 1,
          size: 0.05,
          rampLength: 0
        }
      }

      let changed = false

      if (e.active !== undefined && e.active !== state.active) {
        state.active = e.active
        changed = true
      }

      // Ignore positions that arrive while the object is inactive. Encoders
      // park deactivated objects at the room origin or a screen corner, and
      // carrying that position forward would make the object reappear there.
      if (state.active && e.pos !== null) {
        const x = this._normalizeX(e.pos[0])
        const y = this._normalizeY(e.pos[1])
        const z = this._normalizeZ(e.pos[2])
        if (!state.hasPosition || x !== state.x || y !== state.y || z !== state.z) {
          state.x = x
          state.y = y
          state.z = z
          state.hasPosition = true
          changed = true
        }
      }

      if (e.gain !== undefined) {
        const gain = this._parseGainValue(e.gain)
        if (gain !== state.gain) {
          state.gain = gain
          changed = true
        }
      }

      if (e.size !== undefined) {
        const size = Math.max(0.03, e.size * 0.1 + 0.05)
        if (size !== state.size) {
          state.size = size
          changed = true
        }
      }

      if (e.rampLength !== undefined) {
        state.rampLength = e.rampLength
      }

      if (!state.hasPosition) continue

      // The first positioned event establishes the object's initial state.
      // Later events only need a keyframe when something visual changed.
      if (changed || positions.length === 0) {
        positions.push({
          time: e.samplePos / this.sampleRate,
          x: state.x,
          y: state.y,
          z: state.z,
          gain: state.gain,
          size: state.size,
          active: state.active,
          rampLength: state.rampLength,
          confidence: 'damf'
        })
      }
    }

    this._hideImplicitTerminalPark(positions)

    return positions
  }

  /**
   * Hide an object whose final metadata event is an implicit park.
   *
   * TrueHD encoders do not always emit `active: false` when an object goes
   * offline. Instead the last event often teleports the object to a floor
   * position (the Dolby renderer's park spot), after which no more events
   * arrive. Interpolating to that park makes the object glide into the
   * front-left corner before vanishing. Replace the park keyframe with a
   * deactivation at the previous position so the object disappears where it
   * was last visible.
   *
   * Large final moves that stay above the floor are real object motion (e.g.
   * a fly to the ceiling) and are left untouched.
   *
   * @param {Array} positions  timeline for one object, modified in place
   */
  _hideImplicitTerminalPark(positions) {
    if (positions.length < 2) return

    const last = positions[positions.length - 1]
    const previous = positions[positions.length - 2]

    if (last.active === false || previous.active === false) return
    if (previous.gain <= 0.001 || last.time <= previous.time) return

    const jump = Math.hypot(
      last.x - previous.x,
      last.y - previous.y,
      last.z - previous.z
    )

    // Parks are large horizontal jumps onto the floor plane. Use a
    // conservative threshold so ordinary end-of-scene motion is preserved.
    if (jump < 0.3 || last.z > 0.05) return

    positions[positions.length - 1] = {
      ...previous,
      time: last.time,
      active: false,
      confidence: 'damf'
    }
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
    return (damfX + 1) / 2
  }

  _normalizeY(damfY) {
    // DAMF Y: +1 = front, -1 = back → viz 0 = front, 1 = back
    return (-damfY + 1) / 2
  }

  _normalizeZ(damfZ) {
    // DAMF Z: 0 = floor, 1 = ceiling → viz 0 = floor, 1 = ceiling
    return damfZ
  }

  _parseGainValue(gain) {
    if (gain === -Infinity || gain <= -100) return 0
    // Convert dB to linear gain
    return Math.pow(10, gain / 20)
  }

  /**
   * Get object positions at a given playback time.
   *
   * @param {number} time - Playback time in seconds
   * @param {boolean} smooth - true = interpolate between events;
   *                           false = hold the exact latest event
   * @returns {Array<{ id, name, x, y, z, gain, size, confidence }>}
   */
  getObjectsAtTime(time, smooth = true) {
    const result = []

    for (const obj of this.objects) {
      if (obj.positions.length === 0) continue

      const positions = obj.positions
      const firstTime = positions[0].time
      const lastTime = positions[positions.length - 1].time

      // Don't show object before its first event
      if (time < firstTime) continue

      // Last event at or before `time`
      let lo = 0, hi = positions.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (positions[mid].time <= time) lo = mid
        else hi = mid - 1
      }

      const before = positions[lo]

      // Inactive/silent objects disappear until an explicit active event.
      if (before.active === false || before.gain <= 0.001) continue

      if (!smooth || time >= lastTime) {
        result.push({
          id: obj.id,
          name: obj.name,
          x: before.x, y: before.y, z: before.z,
          gain: before.gain,
          size: before.size,
          confidence: 'damf'
        })
        continue
      }

      const after = positions[lo + 1]

      // Never interpolate across an inactive/silent gap. Hold the last
      // visible state until the deactivation event, then vanish.
      if (!after || after.active === false || after.gain <= 0.001) {
        result.push({
          id: obj.id,
          name: obj.name,
          x: before.x, y: before.y, z: before.z,
          gain: before.gain,
          size: before.size,
          confidence: 'damf'
        })
        continue
      }

      // Interpolate within a continuous active span
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
