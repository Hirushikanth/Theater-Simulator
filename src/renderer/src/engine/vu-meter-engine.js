import { SPEAKERS } from '../utils/constants'

/**
 * Dedicated 60Hz Engine to calculate pure Spatial Output VU levels.
 * This relieves the React layer from heavy mathematical overhead and 
 * calculates true up-mixed levels independently of the main frame render.
 */
export class VUMeterEngine {
  constructor(audioEngine, vbapRenderer) {
    this.audioEngine = audioEngine
    this.vbapRenderer = vbapRenderer
    
    this.rafId = null
    this.speakerGains = new Map()
    this.outputLevels = new Map() // FIX: Reuse map to prevent GC spikes
  }

  /**
   * Keep a fresh reference to the current metadata spatial gains
   * so the background loop can accurately map them to the audio bed
   */
  setSpeakerGains(gains) {
    this.speakerGains = gains
  }

  /**
   * Start polling the WebAudio analyser nodes at 60 Frames Per Second (16.6ms)
   */
  start() {
    this.stop()
    const loop = () => {
      this.calculateLevels()
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  /**
   * Internal loop strictly computing real-time energy combining
   */
  calculateLevels() {
    // 1. Get raw base energy from decoded streams
    const baseLevels = this.audioEngine.getAllChannelLevels()
    
    // 2. Scan peak bed amplitude as the current absolute room "envelope"
    let maxBedAmp = 0
    for (const db of baseLevels.values()) {
      const amp = db > -100 ? Math.pow(10, db / 20) : 0
      if (amp > maxBedAmp) maxBedAmp = amp
    }

    // Update existing map instead of creating a new one
    for (const speaker of SPEAKERS) {
      const id = speaker.id
      const baseDb = baseLevels.get(id) ?? -100
      const baseAmp = baseDb > -100 ? Math.pow(10, baseDb / 20) : 0
      const spatialGainRatio = this.speakerGains.get(id) || 0
      const spatialAmp = spatialGainRatio * maxBedAmp
      
      const totalAmp = baseAmp + spatialAmp
      const totalDb = totalAmp > 0.00001 ? 20 * Math.log10(totalAmp) : -100
      
      this.outputLevels.set(id, totalDb)
    }
  }

  /**
   * Get the current calculated levels
   */
  getLevels() {
    return this.outputLevels
  }

  /**
   * Halt the interval instantly
   */
  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.outputLevels.clear()
  }
}
