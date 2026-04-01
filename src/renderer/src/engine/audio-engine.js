/**
 * Audio Engine — Web Audio API graph with per-channel analysis
 *
 * Handles:
 * - Loading and playing decoded PCM WAV files
 * - Channel splitting for per-channel metering
 * - AnalyserNode per channel for real-time FFT/time-domain data
 * - Playback synchronization for visualization
 */

import { SPEAKERS } from '../utils/constants'

export class AudioEngine {
  constructor() {
    this.ctx = null
    this.source = null
    this.buffer = null
    this.splitter = null
    this.analysers = new Map()
    this.gainNodes = new Map()
    this.masterGain = null
    this.isPlaying = false
    this.startTime = 0
    this.pauseTime = 0
    this.duration = 0
    this.channelCount = 0
    this.onTimeUpdate = null
    this.onEnded = null
    this._rafId = null
  }

  /**
   * Initialize the AudioContext
   */
  async init() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 48000 })
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume()
    }
    return this.ctx
  }

  /**
   * Load a decoded WAV file
   * @param {ArrayBuffer} audioData - PCM WAV data
   */
  async loadAudio(audioData) {
    await this.init()
    this.stop()

    try {
        this.buffer = await this.ctx.decodeAudioData(audioData.slice(0))
      this.duration = this.buffer.duration
      this.channelCount = this.buffer.numberOfChannels

      this.setupGraph()
      return {
        duration: this.duration,
        channelCount: this.channelCount,
        sampleRate: this.buffer.sampleRate
      }
    } catch (err) {
      console.error('Failed to decode audio:', err)
      throw err
    }
  }

  /**
   * Set up the Web Audio graph with per-channel analysis
   */
  setupGraph() {
    // Master gain
    this.masterGain = this.ctx.createGain()
    this.masterGain.gain.value = 1.0
    this.masterGain.connect(this.ctx.destination)

    // Channel splitter
    this.splitter = this.ctx.createChannelSplitter(this.channelCount)

    // Create analyser for each channel
    this.analysers.clear()
    this.gainNodes.clear()

    // Map channels to speaker IDs
    const channelMap = this.getChannelMap()

    for (let ch = 0; ch < this.channelCount; ch++) {
      const speakerId = channelMap[ch] || `CH${ch}`
      
      const analyser = this.ctx.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.3
      analyser.minDecibels = -90
      analyser.maxDecibels = 0

      const gainNode = this.ctx.createGain()
      gainNode.gain.value = 1.0

      // Connect: splitter[ch] → analyser
      this.splitter.connect(analyser, ch)
      
      // CRITICAL GARBAGE COLLECTION BUG FIX: Chrome suspends dead-end nodes!
      // Wire the analyser cleanly into a 0.0 volume sink down to the master output.
      const dummyGain = this.ctx.createGain()
      dummyGain.gain.value = 0.0
      analyser.connect(dummyGain)
      dummyGain.connect(this.masterGain)

      // Connect splitter → gainNode → merger (playback tracking)
      this.splitter.connect(gainNode, ch)

      this.analysers.set(speakerId, analyser)
      this.gainNodes.set(speakerId, gainNode)
    }

    // Also connect splitter directly to master for playback
    // We use a merger to downmix if needed
    const merger = this.ctx.createChannelMerger(Math.min(this.channelCount, 2))
    
    // Simple stereo downmix for playback through local speakers
    if (this.channelCount >= 2) {
      const leftGain = this.ctx.createGain()
      const rightGain = this.ctx.createGain()
      leftGain.gain.value = 0.7
      rightGain.gain.value = 0.7

      this.splitter.connect(leftGain, 0)   // FL
      this.splitter.connect(rightGain, 1)   // FR

      // Mix center to both
      if (this.channelCount > 2) {
        const centerL = this.ctx.createGain()
        const centerR = this.ctx.createGain()
        centerL.gain.value = 0.5
        centerR.gain.value = 0.5
        this.splitter.connect(centerL, 2)
        this.splitter.connect(centerR, 2)
        centerL.connect(merger, 0, 0)
        centerR.connect(merger, 0, 1)
      }

      // Mix surrounds
      if (this.channelCount > 4) {
        const slGain = this.ctx.createGain()
        const srGain = this.ctx.createGain()
        slGain.gain.value = 0.4
        srGain.gain.value = 0.4
        this.splitter.connect(slGain, 4)
        this.splitter.connect(srGain, 5)
        slGain.connect(merger, 0, 0)
        srGain.connect(merger, 0, 1)
      }

      leftGain.connect(merger, 0, 0)
      rightGain.connect(merger, 0, 1)
    }

    merger.connect(this.masterGain)
  }

  /**
   * Map channel indices to speaker IDs based on standard layouts
   */
  getChannelMap() {
    const layouts = {
      2: ['FL', 'FR'],
      6: ['FL', 'FR', 'C', 'LFE', 'SL', 'SR'],
      8: ['FL', 'FR', 'C', 'LFE', 'SL', 'SR', 'SBL', 'SBR'],
      12: ['FL', 'FR', 'C', 'LFE', 'SL', 'SR', 'SBL', 'SBR', 'TFL', 'TFR', 'TRL', 'TRR']
    }
    return layouts[this.channelCount] || layouts[8] || []
  }

  /**
   * Start playback
   */
  play(fromTime = null) {
    if (!this.buffer || !this.ctx) return

    this.stop()

    this.source = this.ctx.createBufferSource()
    this.source.buffer = this.buffer
    this.source.connect(this.splitter)
    
    this.source.onended = () => {
      this.isPlaying = false
      if (this.onEnded) this.onEnded()
    }

    const offset = fromTime !== null ? fromTime : this.pauseTime
    this.startTime = this.ctx.currentTime - offset
    this.source.start(0, offset)
    this.isPlaying = true

    this.startTimeUpdateLoop()
  }

  /**
   * Pause playback
   */
  pause() {
    if (!this.isPlaying) return
    this.pauseTime = this.getCurrentTime()
    this.stop()
  }

  /**
   * Stop playback
   */
  stop() {
    if (this.source) {
      this.source.onended = null // Safely remove listener to prevent seek race conditions
      try { this.source.stop() } catch {}
      this.source.disconnect()
      this.source = null
    }
    this.isPlaying = false
    this.stopTimeUpdateLoop()
  }

  /**
   * Seek to a specific time
   */
  seek(time) {
    const wasPlaying = this.isPlaying
    this.pauseTime = Math.max(0, Math.min(time, this.duration))
    if (wasPlaying) {
      this.play(this.pauseTime)
    }
  }

  /**
   * Get current playback time
   */
  getCurrentTime() {
    if (!this.ctx) return 0
    if (this.isPlaying) {
      return Math.min(this.ctx.currentTime - this.startTime, this.duration)
    }
    return this.pauseTime
  }

  /**
   * Set master volume (0-1)
   */
  setVolume(value) {
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02)
    }
  }

  /**
   * Get time-domain data for a specific channel
   * @returns {Float32Array}
   */
  getTimeDomainData(speakerId) {
    const analyser = this.analysers.get(speakerId)
    if (!analyser) return new Float32Array(1024)

    const data = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(data)
    return data
  }

  /**
   * Get frequency data for a specific channel
   * @returns {Uint8Array}
   */
  getFrequencyData(speakerId) {
    const analyser = this.analysers.get(speakerId)
    if (!analyser) return new Uint8Array(1024)

    const data = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(data)
    return data
  }

  /**
   * Get RMS level for a channel (in dB)
   */
  getChannelLevel(speakerId) {
    const data = this.getTimeDomainData(speakerId)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      sum += data[i] * data[i]
    }
    const rms = Math.sqrt(sum / data.length)
    return rms > 0 ? 20 * Math.log10(rms) : -100
  }

  /**
   * Get levels for all channels
   * @returns {Map<string, number>} speakerId → dB level
   */
  getAllChannelLevels() {
    const levels = new Map()
    for (const [id] of this.analysers) {
      levels.set(id, this.getChannelLevel(id))
    }
    return levels
  }

  /**
   * Time update loop for driving visualization
   */
  startTimeUpdateLoop() {
    const update = () => {
      if (!this.isPlaying) return
      if (this.onTimeUpdate) {
        this.onTimeUpdate(this.getCurrentTime())
      }
      this._rafId = requestAnimationFrame(update)
    }
    this._rafId = requestAnimationFrame(update)
  }

  stopTimeUpdateLoop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
    }
  }

  /**
   * Cleanup
   */
  destroy() {
    this.stop()
    if (this.ctx) {
      this.ctx.close()
      this.ctx = null
    }
  }
}
