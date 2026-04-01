import React, { useState, useRef, useCallback, useEffect } from 'react'
import Header from './components/Header'
import TheaterView from './components/TheaterView'
import ChannelMeters from './components/ChannelMeters'
import MetadataPanel from './components/MetadataPanel'
import FileInfo from './components/FileInfo'
import AudioPlayer from './components/AudioPlayer'
import { AudioEngine } from './engine/audio-engine'
import { VBAPRenderer } from './engine/vbap-renderer'
import { EAC3Parser } from './parsers/eac3-parser'
import { ADMParser } from './parsers/adm-parser'
import { DAMFParser } from './parsers/damf-parser'
import { SpatialSimulator } from './engine/spatial-simulator'
import { VUMeterEngine } from './engine/vu-meter-engine'
import { SPEAKERS } from './utils/constants'
import { getFileExtension, getFileName } from './utils/helpers'

const audioEngine = new AudioEngine()
const vbapRenderer = new VBAPRenderer()
const vuMeterEngine = new VUMeterEngine(audioEngine, vbapRenderer)

export default function App() {
  const [fileInfo, setFileInfo] = useState(null)
  const [fileName, setFileName] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.8)
  const [channelLevels, setChannelLevels] = useState(new Map())
  const [objects, setObjects] = useState([])
  const [speakerGains, setSpeakerGains] = useState(new Map())
  const [metadataSource, setMetadataSource] = useState(null) // 'joc', 'adm', 'damf', null
  const [error, setError] = useState(null)

  const metadataParserRef = useRef(null)
  const rafRef = useRef(null)

  // Main visualization loop
  const updateLoop = useCallback(() => {
    if (!audioEngine.isPlaying) return

    const time = audioEngine.getCurrentTime()
    setCurrentTime(time)

    // Get objects at current time from metadata parser
    if (metadataParserRef.current) {
      const objs = metadataParserRef.current.getObjectsAtTime(time)
      setObjects(objs)

      // Calculate VBAP speaker gains from objects
      if (objs.length > 0) {
        const gains = vbapRenderer.calculateSceneGains(objs)
        setSpeakerGains(gains)
        vuMeterEngine.setSpeakerGains(gains) // Forward vector gains to VU Engine
      }
    }

    rafRef.current = requestAnimationFrame(updateLoop)
  }, [])

  useEffect(() => {
    vuMeterEngine.onUpdate = (levels) => {
      setChannelLevels(new Map(levels))
    }

    audioEngine.onTimeUpdate = (time) => {
      // Handled in RAF loop
    }
    audioEngine.onEnded = () => {
      setIsPlaying(false)
      vuMeterEngine.stop()
    }

    return () => {
      audioEngine.destroy()
      vuMeterEngine.stop()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Handle file loading
  const handleFileOpen = useCallback(async () => {
    if (!window.atmosAPI) {
      setError('Native API not available. Please run as Electron app.')
      return
    }

    const filePath = await window.atmosAPI.openFileDialog()
    if (!filePath) return

    await loadFile(filePath)
  }, [])

  const loadFile = useCallback(async (filePath) => {
    setIsLoading(true)
    setError(null)
    setObjects([])
    setMetadataSource(null)
    metadataParserRef.current = null

    try {
      setFileName(getFileName(filePath))

      // Step 1: Analyze file with ffprobe
      const analysis = await window.atmosAPI.analyzeFile(filePath)
      if (analysis.error) throw new Error(analysis.error)

      const audioStream = analysis.audioStreams?.[0]
      if (!audioStream) throw new Error('No audio stream found')

      setFileInfo({
        ...audioStream,
        format: analysis.format?.format_name || 'unknown',
        filePath
      })

      // Step 2: Decode audio to PCM WAV
      const decodeResult = await window.atmosAPI.decodeAudio(filePath, {
        streamIndex: 0,
        channels: Math.min(audioStream.channels || 8, 12),
        sampleRate: audioStream.sampleRate || 48000
      })
      if (decodeResult.error) throw new Error(decodeResult.error)

      // Step 3: Load decoded audio
      const audioData = await window.atmosAPI.readBinary(decodeResult.outputPath)
      if (audioData.error) throw new Error(audioData.error)

      const loadResult = await audioEngine.loadAudio(audioData)
      setDuration(loadResult.duration)
      audioEngine.setVolume(volume)

      // Step 4: Parse metadata based on codec type
      if (audioStream.isEAC3 || audioStream.isAC3) {
        await parseEAC3Metadata(filePath)
      } else if (getFileExtension(filePath) === '.wav') {
        await parseADMMetadata(filePath)
      }

      // Step 5: Fallback to synthetic upmix simulator if no metadata found
      if (!metadataParserRef.current) {
        metadataParserRef.current = new SpatialSimulator(audioEngine)
        setMetadataSource('synthetic')
      }

      setIsLoading(false)
    } catch (err) {
      console.error('Load error:', err)
      setError(err.message)
      setIsLoading(false)
    }
  }, [volume])

  // Parse EAC3 JOC metadata
  const parseEAC3Metadata = async (filePath) => {
    try {
      // Extract raw bitstream for metadata parsing
      const bsResult = await window.atmosAPI.extractBitstream(filePath, { streamIndex: 0 })
      if (bsResult.error) return

      const bsData = await window.atmosAPI.readBinary(bsResult.outputPath)
      if (bsData.error) return

      const parser = new EAC3Parser()
      const result = parser.parse(bsData)

      if (result.isAtmos || result.objects.length > 0) {
        metadataParserRef.current = parser
        setMetadataSource('joc')
      }
    } catch (err) {
      console.warn('EAC3 metadata parse failed:', err)
    }
  }

  // Parse ADM BWF metadata
  const parseADMMetadata = async (filePath) => {
    try {
      const wavData = await window.atmosAPI.readBinary(filePath)
      if (wavData.error) return

      const parser = new ADMParser()
      const result = parser.parse(wavData)

      if (result.hasADM && result.objects.length > 0) {
        metadataParserRef.current = parser
        setMetadataSource('adm')
      }
    } catch (err) {
      console.warn('ADM parse failed:', err)
    }
  }

  // Playback controls
  const handlePlay = useCallback(() => {
    if (isPlaying) {
      audioEngine.pause()
      setIsPlaying(false)
      vuMeterEngine.stop()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    } else {
      audioEngine.play()
      setIsPlaying(true)
      vuMeterEngine.start()
      rafRef.current = requestAnimationFrame(updateLoop)
    }
  }, [isPlaying, updateLoop])

  const handleStop = useCallback(() => {
    audioEngine.stop()
    audioEngine.pauseTime = 0
    setIsPlaying(false)
    setCurrentTime(0)
    vuMeterEngine.stop()
    setSpeakerGains(new Map())
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
  }, [])

  const handleSeek = useCallback((time) => {
    audioEngine.seek(time)
    setCurrentTime(time)
  }, [])

  const handleVolumeChange = useCallback((val) => {
    setVolume(val)
    audioEngine.setVolume(val)
  }, [])

  // Drag and drop
  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const files = e.dataTransfer?.files
    if (files?.length > 0) {
      loadFile(files[0].path)
    }
  }, [loadFile])

  const hasFile = !!fileInfo

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return
      if (e.code === 'Space') {
        e.preventDefault()
        handlePlay()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handlePlay])

  return (
    <div className="app-container" onDragOver={handleDragOver} onDrop={handleDrop}>
      <Header onOpenFile={handleFileOpen} fileName={fileName} isLoading={isLoading} />

      <div className="main-content">
        <TheaterView
          objects={objects}
          speakerGains={speakerGains}
          channelLevels={channelLevels}
          metadataSource={metadataSource}
          isPlaying={isPlaying}
          hasFile={hasFile}
          onOpenFile={handleFileOpen}
        />
      </div>

      <div className="side-panel">
        <FileInfo fileInfo={fileInfo} metadataSource={metadataSource} error={error} />
        <ChannelMeters channelLevels={channelLevels} isPlaying={isPlaying} />
        <MetadataPanel objects={objects} metadataSource={metadataSource} />
      </div>

      <AudioPlayer
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        volume={volume}
        fileInfo={fileInfo}
        metadataSource={metadataSource}
        objectCount={objects.length}
        onPlay={handlePlay}
        onStop={handleStop}
        onSeek={handleSeek}
        onVolumeChange={handleVolumeChange}
      />
    </div>
  )
}
