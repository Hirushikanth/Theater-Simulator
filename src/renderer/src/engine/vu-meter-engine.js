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
    
    this.intervalId = null
    this.onUpdate = null // Callback to pipe data into React
    this.speakerGains = new Map()
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
    this.stop() // Prevent double-looping

    this.intervalId = setInterval(() => {
      if (!this.audioEngine || !this.audioEngine.isPlaying) return
      
      this.calculateLevels()
    }, 1000 / 60) // 60Hz explicit tick
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

    // 3. Spatially fold the geometric vectors and real audio amplitude
    const outputLevels = new Map()
    for (const speaker of SPEAKERS) {
      const id = speaker.id
      const baseDb = baseLevels.get(id) ?? -100
      
      // Base Decoder Track Energy
      const baseAmp = baseDb > -100 ? Math.pow(10, baseDb / 20) : 0
      
      // Dynamic Spatial Object Energy (Driven by geometric proximity * actual sound)
      const spatialGainRatio = this.speakerGains.get(id) || 0
      const spatialAmp = spatialGainRatio * maxBedAmp
      
      // True Combined Spatial Energy Output
      const totalAmp = baseAmp + spatialAmp
      const totalDb = totalAmp > 0.00001 ? 20 * Math.log10(totalAmp) : -100
      
      outputLevels.set(id, totalDb)
    }

    // 4. Pipe clean Data back to UI
    if (this.onUpdate) {
      this.onUpdate(outputLevels)
    }
  }

  /**
   * Halt the interval instantly
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    // Flush UI explicitly to 0
    if (this.onUpdate) {
      this.onUpdate(new Map())
    }
  }
}
