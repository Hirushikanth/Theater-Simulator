/**
 * DAMF (Dolby Atmos Master Format) Metadata Parser
 *
 * Parses .atmos.metadata YAML files produced by truehdd.
 * These contain bed configuration and object trajectories with
 * precise X, Y, Z coordinates over time.
 */

export class DAMFParser {
  constructor() {
    this.objects = []
    this.beds = []
    this.duration = 0
    this.timeline = new Map()
  }

  /**
   * Parse DAMF metadata text (YAML format)
   * @param {string} yamlText - Contents of .atmos.metadata file
   */
  parse(yamlText) {
    try {
      // Simple YAML parser for the DAMF structure
      // The format is relatively flat — we parse key fields manually
      // to avoid requiring a full YAML library in the renderer
      const data = this.parseSimpleYAML(yamlText)
      
      if (data.objects) {
        this.parseObjects(data.objects)
      }
      if (data.beds) {
        this.parseBeds(data.beds)
      }
      if (data.duration) {
        this.duration = parseFloat(data.duration) || 0
      }

      this.buildTimeline()

      return {
        hasDAMF: true,
        objects: this.objects,
        beds: this.beds,
        timeline: this.timeline,
        duration: this.duration
      }
    } catch (err) {
      console.error('DAMF parse error:', err)
      return { hasDAMF: false, objects: [], timeline: new Map() }
    }
  }

  /**
   * Simple YAML-like parser for DAMF metadata
   */
  parseSimpleYAML(text) {
    const result = { objects: [], beds: [] }
    const lines = text.split('\n')
    let currentSection = null
    let currentObject = null

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      // Top-level keys
      if (!line.startsWith(' ') && !line.startsWith('\t')) {
        if (trimmed.startsWith('duration:')) {
          result.duration = trimmed.split(':').slice(1).join(':').trim()
        } else if (trimmed === 'objects:') {
          currentSection = 'objects'
        } else if (trimmed === 'beds:') {
          currentSection = 'beds'
        }
        continue
      }

      // Object entries
      if (currentSection === 'objects') {
        if (trimmed.startsWith('- id:') || trimmed.startsWith('-  id:')) {
          if (currentObject) result.objects.push(currentObject)
          currentObject = { id: trimmed.split(':')[1]?.trim(), positions: [] }
        } else if (currentObject) {
          if (trimmed.startsWith('name:')) {
            currentObject.name = trimmed.split(':').slice(1).join(':').trim()
          } else if (trimmed.startsWith('type:')) {
            currentObject.type = trimmed.split(':')[1]?.trim()
          } else if (trimmed.match(/^\d|^- time:/)) {
            // Position entry
            const pos = this.parsePositionLine(trimmed)
            if (pos) currentObject.positions.push(pos)
          } else if (trimmed.startsWith('x:') || trimmed.startsWith('y:') || trimmed.startsWith('z:')) {
            // Position components on separate lines
            if (currentObject.positions.length > 0) {
              const lastPos = currentObject.positions[currentObject.positions.length - 1]
              const key = trimmed.split(':')[0].trim()
              lastPos[key] = parseFloat(trimmed.split(':')[1]?.trim()) || 0
            }
          }
        }
      }
    }

    if (currentObject) result.objects.push(currentObject)
    return result
  }

  /**
   * Parse a position line from DAMF
   */
  parsePositionLine(line) {
    // Try format: "time: 0.5 x: 0.3 y: 0.7 z: 0.2"
    const timeMatch = line.match(/time:\s*([\d.]+)/)
    const xMatch = line.match(/x:\s*([\d.-]+)/)
    const yMatch = line.match(/y:\s*([\d.-]+)/)
    const zMatch = line.match(/z:\s*([\d.-]+)/)

    if (timeMatch) {
      return {
        time: parseFloat(timeMatch[1]),
        x: xMatch ? parseFloat(xMatch[1]) : 0.5,
        y: yMatch ? parseFloat(yMatch[1]) : 0.5,
        z: zMatch ? parseFloat(zMatch[1]) : 0,
        size: 0.05,
        gain: 1.0,
        confidence: 'damf'
      }
    }
    return null
  }

  parseObjects(objData) {
    for (let i = 0; i < objData.length; i++) {
      const raw = objData[i]
      this.objects.push({
        id: i,
        objectId: raw.id || String(i),
        name: raw.name || `Object ${i}`,
        type: raw.type || 'dynamic',
        positions: (raw.positions || []).map(p => ({
          time: p.time || 0,
          x: p.x ?? 0.5,
          y: p.y ?? 0.5,
          z: p.z ?? 0,
          size: p.size ?? 0.05,
          gain: p.gain ?? 1.0,
          confidence: 'damf'
        }))
      })
    }
  }

  parseBeds(bedData) {
    this.beds = bedData.map((b, i) => ({
      id: i,
      name: b.name || `Bed ${i}`,
      channelLayout: b.channelLayout || '7.1.4',
      channels: b.channels || 12
    }))
  }

  buildTimeline() {
    for (const obj of this.objects) {
      for (const pos of obj.positions) {
        const t = Math.round(pos.time * 100) / 100
        if (!this.timeline.has(t)) {
          this.timeline.set(t, [])
        }
        this.timeline.set(t, [...this.timeline.get(t), {
          id: obj.id,
          name: obj.name,
          ...pos
        }])

        if (pos.time > this.duration) this.duration = pos.time
      }
    }
  }

  getObjectsAtTime(time) {
    const result = []
    for (const obj of this.objects) {
      if (obj.positions.length === 0) continue

      let before = null, after = null
      for (const pos of obj.positions) {
        if (pos.time <= time) before = pos
        if (pos.time >= time && !after) after = pos
      }
      if (!before && !after) continue
      if (!before) before = after
      if (!after) after = before

      let x, y, z
      if (before === after || before.time === after.time) {
        x = before.x; y = before.y; z = before.z
      } else {
        const t = (time - before.time) / (after.time - before.time)
        x = before.x + (after.x - before.x) * t
        y = before.y + (after.y - before.y) * t
        z = before.z + (after.z - before.z) * t
      }

      result.push({
        id: obj.id,
        name: obj.name,
        x, y, z,
        size: before.size,
        gain: before.gain,
        confidence: 'damf'
      })
    }
    return result
  }
}
