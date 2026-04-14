/**
 * Audio Engine — Web Audio API graph with per-channel analysis
 *
 * Handles:
 * - Streaming decoded PCM WAV files via HTML5 Audio
 * - Channel splitting for per-channel metering
 * - AnalyserNode per channel for real-time FFT/time-domain data
 * - Playback synchronization for visualization
 */

import { SPEAKERS } from '../utils/constants'

export class AudioEngine {
  constructor() {
    this.ctx = null
    this.audioEl = null
    this.source = null
    this.splitter = null
    this.analysers = new Map()
    this.gainNodes = new Map()
    this.masterGain = null

    this.isPlaying = false
    this.duration = 0
    this.channelCount = 0
    this.onTimeUpdate = null
    this.onEnded = null
    this._rafId = null

    // Pre-allocated buffer to avoid GC churn at 60fps
    this.sharedBuffer = new Float32Array(2048)
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
   * Load streaming audio via URL instead of RAM Buffer
   * @param {string} url - The atmos:// URL mapped to the WAV file
   * @param {number} knownChannelCount - Channels from ffprobe
   * @param {number} knownDuration - Duration from ffprobe
   */
  async loadAudio(url, knownChannelCount, knownDuration) {
    await this.init()
    this.cleanupGraph()
    this.stop()

    this.channelCount = knownChannelCount || 8
    this.duration = knownDuration || 0

    return new Promise((resolve, reject) => {
      // Create hidden audio element for streaming from disk
      this.audioEl = new Audio()
      
      this.audioEl.preload = "auto"
      
      this.audioEl.addEventListener('canplay', () => {
        // Native element sometimes provides higher precision duration once loaded
        if (this.audioEl.duration && isFinite(this.audioEl.duration)) {
          this.duration = this.audioEl.duration
        }
        this.setupGraph()
        resolve({
          duration: this.duration,
          channelCount: this.channelCount,
          sampleRate: this.ctx.sampleRate
        })
      }, { once: true })

      this.audioEl.addEventListener('error', (e) => {
        console.error('Audio element error:', this.audioEl.error)
        reject(new Error("Failed to stream audio file via custom protocol."))
      })

      this.audioEl.addEventListener('ended', () => {
        this.isPlaying = false
        if (this.onEnded) this.onEnded()
      })

      // Start streaming
      this.audioEl.src = url
    })
  }

  /**
   * Set up the Web Audio graph with per-channel analysis
   */
  setupGraph() {
    // MediaElementSource can only be created once per element
    this.source = this.ctx.createMediaElementSource(this.audioEl)
    
    // CRITICAL: Force the source node to preserve all discrete channels.
    // Prevents the browser from downmixing the stream.
    this.source.channelCount = this.channelCount
    this.source.channelCountMode = 'explicit'
    this.source.channelInterpretation = 'discrete'

    // Master gain
    this.masterGain = this.ctx.createGain()
    this.masterGain.gain.value = 1.0
    this.masterGain.connect(this.ctx.destination)

    // Channel splitter
    this.splitter = this.ctx.createChannelSplitter(this.channelCount)
    this.splitter.channelCountMode = 'explicit'
    this.splitter.channelInterpretation = 'discrete'

    // Connect source to splitter
    this.source.connect(this.splitter)

    this.analysers.clear()
    this.gainNodes.clear()

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

      this.splitter.connect(analyser, ch)
      
      // Prevent GC suspension of "dead-end" analysers
      const dummyGain = this.ctx.createGain()
      dummyGain.gain.value = 0.0
      analyser.connect(dummyGain)
      dummyGain.connect(this.masterGain)

      this.splitter.connect(gainNode, ch)

      this.analysers.set(speakerId, analyser)
      this.gainNodes.set(speakerId, gainNode)
    }

    // Downmix merger for local speakers
    const merger = this.ctx.createChannelMerger(Math.min(this.channelCount, 2))
    
    if (this.channelCount >= 2) {
      const leftGain = this.ctx.createGain()
      const rightGain = this.ctx.createGain()
      leftGain.gain.value = 0.7
      rightGain.gain.value = 0.7

      this.splitter.connect(leftGain, 0)
      this.splitter.connect(rightGain, 1)

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

      if (this.channelCount > 6) {
        const sblGain = this.ctx.createGain()
        const sbrGain = this.ctx.createGain()
        sblGain.gain.value = 0.4
        sbrGain.gain.value = 0.4
        this.splitter.connect(sblGain, 6)
        this.splitter.connect(sbrGain, 7)
        sblGain.connect(merger, 0, 0)
        sbrGain.connect(merger, 0, 1)
      }

      if (this.channelCount > 8) {
        const heightLGain = this.ctx.createGain()
        const heightRGain = this.ctx.createGain()
        heightLGain.gain.value = 0.25
        heightRGain.gain.value = 0.25
        
        this.splitter.connect(heightLGain, 8)
        if (this.channelCount > 10) this.splitter.connect(heightLGain, 10)
        
        this.splitter.connect(heightRGain, 9)
        if (this.channelCount > 11) this.splitter.connect(heightRGain, 11)

        heightLGain.connect(merger, 0, 0)
        heightRGain.connect(merger, 0, 1)
      }

      leftGain.connect(merger, 0, 0)
      rightGain.connect(merger, 0, 1)
    }

    merger.connect(this.masterGain)
  }

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
  play() {
    if (!this.audioEl || !this.ctx) return
    if (this.ctx.state === 'suspended') this.ctx.resume()

    this.audioEl.play()
    this.isPlaying = true
    this.startTimeUpdateLoop()
  }

  /**
   * Pause playback
   */
  pause() {
    if (!this.audioEl) return
    this.audioEl.pause()
    this.isPlaying = false
  }

  /**
   * Stop playback completely
   */
  stop() {
    if (this.audioEl) {
      this.audioEl.pause()
      this.audioEl.currentTime = 0
    }
    this.isPlaying = false
    this.stopTimeUpdateLoop()
  }

  /**
   * Seek to a specific time
   */
  seek(time) {
    if (this.audioEl) {
      this.audioEl.currentTime = Math.max(0, Math.min(time, this.duration))
    }
  }

  /**
   * Get current playback time
   */
  getCurrentTime() {
    if (this.audioEl) return this.audioEl.currentTime
    return 0
  }

  /**
   * Set master volume (0-1)
   */
  setVolume(value) {
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02)
    }
  }

  getTimeDomainData(speakerId) {
    const analyser = this.analysers.get(speakerId)
    if (!analyser) return this.sharedBuffer.fill(0)

    // Reuse the exact same memory array endlessly!
    analyser.getFloatTimeDomainData(this.sharedBuffer)
    return this.sharedBuffer
  }

  getFrequencyData(speakerId) {
    const analyser = this.analysers.get(speakerId)
    if (!analyser) return new Uint8Array(1024)

    const data = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(data)
    return data
  }

  getChannelLevel(speakerId) {
    const data = this.getTimeDomainData(speakerId)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      sum += data[i] * data[i]
    }
    const rms = Math.sqrt(sum / data.length)
    return rms > 0 ? 20 * Math.log10(rms) : -100
  }

  getAllChannelLevels() {
    const levels = new Map()
    for (const [id] of this.analysers) {
      levels.set(id, this.getChannelLevel(id))
    }
    return levels
  }

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

  cleanupGraph() {
    if (this.source) {
      try { this.source.disconnect() } catch {}
      this.source = null
    }

    if (this.splitter) {
      try { this.splitter.disconnect() } catch {}
      this.splitter = null
    }

    if (this.masterGain) {
      try { this.masterGain.disconnect() } catch {}
      this.masterGain = null
    }

    for (const analyser of this.analysers.values()) {
      try { analyser.disconnect() } catch {}
    }
    for (const gainNode of this.gainNodes.values()) {
      try { gainNode.disconnect() } catch {}
    }

    this.analysers.clear()
    this.gainNodes.clear()

    if (this.audioEl) {
      this.audioEl.pause()
      this.audioEl.removeAttribute('src')
      this.audioEl.load()
      this.audioEl = null
    }
  }

  destroy() {
    this.stop()
    this.cleanupGraph()
    if (this.ctx) {
      this.ctx.close()
      this.ctx = null
    }
  }
}