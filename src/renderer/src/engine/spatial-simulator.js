/**
 * Synthetic Spatial Engine (Atmos Fallback)
 * 
 * When proprietary JOC or ADM metadata is unavailable, this engine 
 * mathematically analyzes the 7.1/5.1 bed channels from the Web Audio graph 
 * to generate stunning, audio-reactive 3D objects in the room. This provides
 * a beautiful visual experience even without literal dynamic spatial data.
 */

export class SpatialSimulator {
  constructor(audioEngine) {
    this.audioEngine = audioEngine
    this.virtualObjects = []
    this.lastUpdateTime = 0
    this.complexity = 0
    
    // Virtual seed objects
    this.initVirtualObjects()
  }

  initVirtualObjects() {
    // We create a pool of 8 virtual objects that will dance through the room
    this.virtualObjects = Array.from({ length: 8 }, (_, i) => ({
      id: `sim_obj_${i}`,
      baseAngle: (i / 8) * Math.PI * 2,
      baseRadius: 0.3 + (i % 3) * 0.2,
      speed: 0.1 + Math.random() * 0.5,
      x: 0,
      y: 0,
      z: 0,
      size: 0.2,
      gain: 0,
      confidence: 'simulated'
    }))
  }

  /**
   * Get dynamic objects at the given playback time by injecting FFT analysis
   */
  getObjectsAtTime(time) {
    if (!this.audioEngine || !this.audioEngine.isPlaying) return []

    // Prevent excessive re-calculation 
    if (Math.abs(time - this.lastUpdateTime) < 0.016) {
      return this.virtualObjects.filter(o => o.gain > 0.05)
    }
    this.lastUpdateTime = time

    const levels = this.audioEngine.getAllChannelLevels()
    
    // Group energies to drive the objects dynamically
    let frontEnergy = 0
    let surroundEnergy = 0
    let lfeEnergy = 0

    // Safely aggregate energies
    levels.forEach((val, id) => {
      // Map dB back to linear relative amplitude
      const amp = Math.pow(10, val / 20)
      if (id.includes('F')) frontEnergy += amp
      if (id.includes('S')) surroundEnergy += amp
      if (id === 'LFE') lfeEnergy += amp
    })

    // Update object positions
    this.virtualObjects.forEach((obj, i) => {
      // Use time and energy to orbit objects organically
      const theta = obj.baseAngle + time * obj.speed + (frontEnergy * 0.5)
      const radiusX = obj.baseRadius + (surroundEnergy * 0.3)
      const radiusZ = obj.baseRadius + (frontEnergy * 0.2)

      // X and Z revolve in a circle
      obj.x = 0.5 + Math.cos(theta) * radiusX
      obj.z = 0.5 + Math.sin(theta) * radiusZ

      // Elevation (Y) bounces based on total system energy + LFE punch
      const energyPulse = (frontEnergy + surroundEnergy) / 4
      obj.y = Math.min(1.0, 0.2 + energyPulse + lfeEnergy * 2 + Math.sin(time * 2 + i) * 0.3)
      
      // Sizes expand on bass hits
      obj.size = 0.1 + lfeEnergy * 0.5
      
      // Gain determines if the object is visible and triggers VBAP
      // Only keep objects alive if there's enough room energy to warrant them
      const threshold = 0.05 + (i * 0.02)
      obj.gain = energyPulse > threshold ? Math.min(1.0, energyPulse * 2.0) : 0
    })

    // Return the active objects. If there's high complexity (lots of energy), return more.
    this.complexity = this.virtualObjects.filter(o => o.gain > 0.1).length
    return this.virtualObjects.filter(o => o.gain > 0.05)
  }
}
