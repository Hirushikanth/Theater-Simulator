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
  const [objects, setObjects] = useState([])
  const [speakerGains, setSpeakerGains] = useState(new Map())
  const [metadataSource, setMetadataSource] = useState(null)
  const [error, setError] = useState(null)

  const [enableSyntheticUpmix, setEnableSyntheticUpmix] = useState(false)
  const [useProfessionalDecoder, setUseProfessionalDecoder] = useState(true)

  const metadataParserRef = useRef(null)
  const rafRef = useRef(null)
  const lastTimeUpdate = useRef(0)
  
  // Track the active temp dir so we don't delete it while playing!
  const activeTempDirRef = useRef(null)

  const updateLoop = useCallback(() => {
    if (!audioEngine.isPlaying) return

    const time = audioEngine.getCurrentTime()

    // THROTTLE REACT STATE TO 4 FPS (Saves massive CPU overhead)
    if (time - lastTimeUpdate.current > 0.25) {
      setCurrentTime(time)
      lastTimeUpdate.current = time
    }

    if (metadataParserRef.current) {
      const objs = metadataParserRef.current.getObjectsAtTime(time)
      setObjects(objs)

      if (objs.length > 0) {
        const gains = vbapRenderer.calculateSceneGains(objs)
        setSpeakerGains(gains)
        vuMeterEngine.setSpeakerGains(gains)
      }
    }

    rafRef.current = requestAnimationFrame(updateLoop)
  }, [])

  useEffect(() => {
    audioEngine.onEnded = () => {
      setIsPlaying(false)
      vuMeterEngine.stop()
    }

    return () => {
      audioEngine.destroy()
      vuMeterEngine.stop()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      
      // Final cleanup on component unmount
      if (activeTempDirRef.current) {
        window.atmosAPI.cleanupTemp(activeTempDirRef.current)
      }
    }
  }, [])

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
    setCurrentTime(0)
    setSpeakerGains(new Map())
    metadataParserRef.current = null
    lastTimeUpdate.current = 0

    try {
      setFileName(getFileName(filePath))

      // Cleanup PREVIOUS temp directory before creating a new one
      if (activeTempDirRef.current) {
        await window.atmosAPI.cleanupTemp(activeTempDirRef.current)
        activeTempDirRef.current = null
      }

      // Step 1: Analyze file
      const analysis = await window.atmosAPI.analyzeFile(filePath)
      if (analysis.error) throw new Error(analysis.error)

      const audioStream = analysis.audioStreams?.[0]
      if (!audioStream) throw new Error('No audio stream found')

      setFileInfo({
        ...audioStream,
        format: analysis.format?.format_name || 'unknown',
        filePath
      })

      // Step 2: Decode audio to PCM WAV (Creates massive temp file)
      const decodeResult = await window.atmosAPI.decodeAudio(filePath, {
        streamIndex: 0,
        channels: Math.min(audioStream.channels || 8, 12),
        sampleRate: audioStream.sampleRate || 48000
      })
      if (decodeResult.error) throw new Error(decodeResult.error)

      // Mark this temp dir as active so we can delete it later
      activeTempDirRef.current = decodeResult.outputDir

      // Step 3: Stream the massive WAV file dynamically using custom protocol
      // We use a fake hostname ('stream') and pass the path as a query parameter
      // to prevent Chromium's media player from throwing "URL safety" errors.
      const safePath = decodeResult.outputPath.replace(/\\/g, '/')
      const streamUrl = `atmos://stream/?path=${encodeURIComponent(safePath)}`
      
      const loadResult = await audioEngine.loadAudio(
        streamUrl, 
        audioStream.channels || 8, 
        audioStream.duration
      )
      
      setDuration(loadResult.duration)
      audioEngine.setVolume(volume)

      // Step 4: Parse metadata based on codec type
      if (audioStream.isEAC3 || audioStream.isAC3) {
        await parseEAC3Metadata(filePath)
        if (!metadataParserRef.current && audioStream.isAtmos) {
          setMetadataSource('joc-encrypted')
        }
      } else if (getFileExtension(filePath) === '.wav') {
        await parseADMMetadata(filePath)
      } else if (audioStream.isTrueHD) {
        if (useProfessionalDecoder) {
          await parseTrueHDMetadata(filePath)
        } else if (audioStream.isAtmos) {
          setMetadataSource('mat-encrypted')
        }
      }

      // Step 5: Fallback
      if (!metadataParserRef.current && enableSyntheticUpmix) {
        metadataParserRef.current = new SpatialSimulator(audioEngine)
        setMetadataSource('synthetic')
      }

      setIsLoading(false)
    } catch (err) {
      console.error('Load error:', err)
      setError(err.message)
      setIsLoading(false)
    }
  }, [volume, enableSyntheticUpmix, useProfessionalDecoder])

  const parseEAC3Metadata = async (filePath) => {
    try {
      const bsResult = await window.atmosAPI.extractBitstream(filePath, { streamIndex: 0 })
      if (bsResult.error) return

      const bsData = await window.atmosAPI.readBinary(bsResult.outputPath)
      if (bsData.error) return

      const parser = new EAC3Parser()
      const result = parser.parse(bsData)

      if (result.objects.length > 0) {
        metadataParserRef.current = parser
        setMetadataSource('joc')
      } else if (result.isAtmos) {
        setMetadataSource('joc-encrypted')
      }
    } catch (err) {
      console.warn('EAC3 metadata parse failed:', err)
    }
  }

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

  const parseTrueHDMetadata = async (filePath) => {
    try {
      setIsLoading(true)
      const result = await window.atmosAPI.decodeTrueHD(filePath, { presentation: 3, bedConform: true })

      if (result.error) {
        console.warn('truehdd decode error:', result.error)
        setMetadataSource('mat-encrypted')
        return
      }

      if (result.metadataContent) {
        const parser = new DAMFParser()
        const parsed = parser.parse(result.metadataContent)

        if (parsed.hasDAMF && parsed.objects.length > 0) {
          metadataParserRef.current = parser
          setMetadataSource('damf')
        } else {
          setMetadataSource('mat-encrypted')
        }
      } else {
        setMetadataSource('mat-encrypted')
      }
    } catch (err) {
      console.warn('TrueHD metadata parse failed:', err)
      setMetadataSource('mat-encrypted')
    } finally {
      setIsLoading(false)
    }
  }

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
    setIsPlaying(false)
    setCurrentTime(0)
    vuMeterEngine.stop()
    setSpeakerGains(new Map())
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
  }, [])

  const handleSeek = useCallback((time) => {
    audioEngine.seek(time)
    setCurrentTime(time)
    lastTimeUpdate.current = time  // Reset throttle so UI updates immediately

    // Force a one-off update for the visualizer while paused
    if (!isPlaying && metadataParserRef.current) {
      const objs = metadataParserRef.current.getObjectsAtTime(time)
      setObjects(objs)

      if (objs.length > 0) {
        const gains = vbapRenderer.calculateSceneGains(objs)
        setSpeakerGains(gains)
        vuMeterEngine.setSpeakerGains(gains)
      } else {
        // Clear ghost glows if scrubbing to an empty section
        const emptyGains = new Map()
        setSpeakerGains(emptyGains)
        vuMeterEngine.setSpeakerGains(emptyGains)
      }
    }
  }, [isPlaying])

  const handleVolumeChange = useCallback((val) => {
    setVolume(val)
    audioEngine.setVolume(val)
  }, [])

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

  const handleToggleSynthetic = useCallback((e) => {
    const isEnabled = e.target.checked
    setEnableSyntheticUpmix(isEnabled)

    if (fileInfo && (!metadataSource || metadataSource.includes('encrypted') || metadataSource === 'synthetic')) {
      if (isEnabled) {
        metadataParserRef.current = new SpatialSimulator(audioEngine)
        setMetadataSource('synthetic')
      } else {
        metadataParserRef.current = null
        setObjects([])
        setSpeakerGains(new Map())

        if (fileInfo.isTrueHD && fileInfo.isAtmos) {
          setMetadataSource('mat-encrypted')
        } else if ((fileInfo.isEAC3 || fileInfo.isAC3) && fileInfo.isAtmos) {
          setMetadataSource('joc-encrypted')
        } else {
          setMetadataSource(null)
        }
      }
    }
  }, [fileInfo, metadataSource])

  const handleToggleProfessional = useCallback((e) => {
    setUseProfessionalDecoder(e.target.checked)
    if (fileInfo && fileInfo.isTrueHD && fileInfo.isAtmos) {
      loadFile(fileInfo.filePath)
    }
  }, [fileInfo, loadFile])

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
      <Header
        onOpenFile={handleFileOpen}
        fileName={fileName}
        isLoading={isLoading}
        enableSyntheticUpmix={enableSyntheticUpmix}
        onToggleSynthetic={handleToggleSynthetic}
        useProfessionalDecoder={useProfessionalDecoder}
        onToggleProfessional={handleToggleProfessional}
      />

      <div className="main-content">
        <TheaterView
          objects={objects}
          speakerGains={speakerGains}
          vuMeterEngine={vuMeterEngine}
          metadataSource={metadataSource}
          isPlaying={isPlaying}
          hasFile={hasFile}
          onOpenFile={handleFileOpen}
        />
      </div>

      <div className="side-panel">
        <FileInfo fileInfo={fileInfo} metadataSource={metadataSource} error={error} />
        <ChannelMeters vuMeterEngine={vuMeterEngine} isPlaying={isPlaying} />
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