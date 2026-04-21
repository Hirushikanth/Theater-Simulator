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
  
  // Track the active temp dirs so we don't delete them while playing!
  const activeTempDirsRef = useRef([])

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
      for (const dir of activeTempDirsRef.current) {
        window.atmosAPI.cleanupTemp(dir)
      }
    }
  }, [])

  /**
   * Track a temp directory for cleanup later
   */
  const trackTempDir = (dir) => {
    if (dir && !activeTempDirsRef.current.includes(dir)) {
      activeTempDirsRef.current.push(dir)
    }
  }

  /**
   * Cleanup all tracked temp directories
   */
  const cleanupTrackedDirs = async () => {
    for (const dir of activeTempDirsRef.current) {
      await window.atmosAPI.cleanupTemp(dir)
    }
    activeTempDirsRef.current = []
  }

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

      // Cleanup PREVIOUS temp directories before creating new ones
      await cleanupTrackedDirs()

      const ext = getFileExtension(filePath)

      // Route based on file extension
      if (ext === '.atmos') {
        // Standalone .atmos file — DAMF root file with companion files
        await loadAtmosStandalone(filePath)
      } else {
        // Container or raw file — analyze with ffprobe first
        await loadAnalyzedFile(filePath, ext)
      }

      setIsLoading(false)
    } catch (err) {
      console.error('Load error:', err)
      setError(err.message)
      setIsLoading(false)
    }
  }, [volume, enableSyntheticUpmix, useProfessionalDecoder])

  /**
   * Load a standalone .atmos file (DAMF root).
   * Looks for companion .atmos.metadata and .atmos.audio files.
   */
  const loadAtmosStandalone = async (filePath) => {
    try {
      // The .atmos file is the root; companion files share the same prefix
      // e.g., myfile.atmos, myfile.atmos.metadata, myfile.atmos.audio
      const metadataPath = `${filePath}.metadata`
      const audioPath = `${filePath}.audio`

      // Read root file
      const rootContent = await window.atmosAPI.readText(filePath)
      if (!rootContent || rootContent.error) {
        throw new Error('Failed to read .atmos root file')
      }

      // Read metadata file
      const metadataContent = await window.atmosAPI.readText(metadataPath)
      if (!metadataContent || metadataContent.error) {
        throw new Error('Companion .atmos.metadata file not found')
      }

      // Parse DAMF
      const parser = new DAMFParser()
      const result = parser.parse(rootContent, metadataContent)

      if (result.hasDAMF && result.objects.length > 0) {
        metadataParserRef.current = parser
        setMetadataSource('damf-standalone')

        setFileInfo({
          codec: 'damf',
          codecLong: 'Dolby Atmos Master Format',
          channels: parser.beds.length + parser.objects.length,
          channelLayout: `${parser.beds.length} beds + ${parser.objects.length} objects`,
          sampleRate: parser.sampleRate,
          bitRate: 0,
          duration: parser.duration,
          isAtmos: true,
          format: 'DAMF',
          filePath
        })

        setDuration(parser.duration)
      } else {
        throw new Error('No Atmos object metadata found in .atmos files')
      }

      // Audio note: the companion .atmos.audio is a CAF file with all discrete
      // channels (beds + objects = 92+ ch). FFmpeg can't rematrix this and our
      // binary WAV extractor only handles RIFF/RF64 format, not CAF.
      // Visualization from DAMF metadata works perfectly without audio.
      // TODO: implement CAF binary channel extraction for audio playback.
      console.log('[DAMF standalone] Audio playback not yet supported for multi-channel CAF. Visualization only.')
    } catch (err) {
      console.error('Standalone .atmos load error:', err)
      throw err
    }
  }

  /**
   * Standard load path: analyze with ffprobe, then route by codec.
   */
  const loadAnalyzedFile = async (filePath, ext) => {
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

    // Step 2: Determine codec pipeline
    const isTrueHD = audioStream.isTrueHD
    const isEAC3 = audioStream.isEAC3 || audioStream.isAC3
    // All WAV files are candidates for ADM — the axml chunk check is cheap
    const isADM = ext === '.wav'

    // Step 3: Decode audio for playback
    let audioUrl = null

    if (isTrueHD && useProfessionalDecoder) {
      // TrueHD: truehdd for metadata, FFmpeg fallback in Step 3b for audio
      audioUrl = await decodeTrueHDFull(filePath, audioStream)
    } else if (!isADM) {
      // Non-ADM formats: FFmpeg standard decode (8ch cap for browser compat)
      // ADM .wav files are handled in Step 3b via extractWavChannels (no FFmpeg ch limit)
      const decodeResult = await window.atmosAPI.decodeAudio(filePath, {
        streamIndex: 0,
        channels: Math.min(audioStream.channels || 8, 8),
        sampleRate: audioStream.sampleRate || 48000,
        sourceChannels: audioStream.channels || 8
      })
      if (decodeResult.error) throw new Error(decodeResult.error)

      trackTempDir(decodeResult.outputDir)
      const safePath = decodeResult.outputPath.replace(/\\/g, '/')
      audioUrl = `atmos://stream/?path=${encodeURIComponent(safePath)}`
    }

    // Step 3b: No audio URL yet — decode for playback
    // ADM BWF WAV: use direct binary channel extraction (bypasses FFmpeg 64ch pan limit)
    // All other formats: FFmpeg decode
    if (!audioUrl) {
      let decodeResult

      if (isADM) {
        // Direct binary extraction — works for 92, 118, any channel count
        decodeResult = await window.atmosAPI.extractWavChannels(filePath, { outChannels: 8 })
      } else {
        decodeResult = await window.atmosAPI.decodeAudio(filePath, {
          streamIndex: 0,
          channels: Math.min(audioStream.channels || 8, 8),
          sampleRate: audioStream.sampleRate || 48000,
          sourceChannels: audioStream.channels || 8
        })
      }

      if (decodeResult && !decodeResult.error) {
        trackTempDir(decodeResult.outputDir)
        const safePath = decodeResult.outputPath.replace(/\\/g, '/')
        audioUrl = `atmos://stream/?path=${encodeURIComponent(safePath)}`
      }
    }

    // Step 4: Load audio into engine
    // Always seed duration from ffprobe — will be overridden once audio canplay fires
    setDuration(audioStream.duration || 0)

    if (audioUrl) {
      const loadResult = await audioEngine.loadAudio(
        audioUrl,
        Math.min(audioStream.channels || 8, 8),
        audioStream.duration
      )
      setDuration(loadResult.duration)
      audioEngine.setVolume(volume)
    }

    // Step 5: Parse metadata (unless TrueHD already did it in step 3)
    if (!metadataParserRef.current) {
      if (isEAC3) {
        await parseEAC3Metadata(filePath)
        if (!metadataParserRef.current && audioStream.isAtmos) {
          setMetadataSource('joc-encrypted')
        }
      } else if (isADM) {
        await parseADMMetadata(filePath)
      } else if (isTrueHD && !useProfessionalDecoder) {
        if (audioStream.isAtmos) {
          setMetadataSource('mat-encrypted')
        }
      }
    }

    // Step 6: Fallback
    if (!metadataParserRef.current && enableSyntheticUpmix) {
      metadataParserRef.current = new SpatialSimulator(audioEngine)
      setMetadataSource('synthetic')
    }
  }

  /**
   * Full TrueHD pipeline: truehdd for DAMF metadata, FFmpeg for audio.
   *
   * Architecture:
   *   - truehdd → .atmos.metadata → DAMF parser → object position visualization
   *   - FFmpeg → original file → standard 7.1 PCM → browser playback
   *
   * We do NOT use truehdd's CAF audio for playback. It has 25 discrete channels
   * with non-standard layout that causes FFmpeg rematrix failures. FFmpeg decodes
   * the original TrueHD container reliably to a clean 7.1 WAV.
   *
   * Returns null so loadAnalyzedFile falls through to its FFmpeg audio path (Step 4).
   */
  const decodeTrueHDFull = async (filePath, audioStream) => {
    try {
      const result = await window.atmosAPI.decodeTrueHD(filePath, {
        presentation: 3,
        bedConform: true,
        streamIndex: 0
      })

      if (result.error) {
        console.warn('truehdd decode error:', result.error)
        setMetadataSource('mat-encrypted')
        return null
      }

      // Track temp dirs for cleanup (metadata files, bitstream extraction)
      trackTempDir(result.outputDir)
      if (result.wavDir) trackTempDir(result.wavDir)

      // Parse DAMF metadata — this is the sole purpose of truehdd here
      if (result.metadataContent) {
        const parser = new DAMFParser()
        const parsed = parser.parse(result.rootContent, result.metadataContent)

        if (parsed.hasDAMF && parsed.objects.length > 0) {
          metadataParserRef.current = parser
          setMetadataSource('damf')
          console.log(`[TrueHD] DAMF parsed: ${parsed.objects.length} objects, ${parsed.beds.length} beds`)
        } else {
          setMetadataSource('mat-encrypted')
        }
      } else {
        setMetadataSource('mat-encrypted')
      }

      // Return null — let loadAnalyzedFile handle audio via FFmpeg (Step 4 below)
      return null
    } catch (err) {
      console.warn('TrueHD full decode failed:', err)
      setMetadataSource('mat-encrypted')
      return null
    }
  }

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
      // Use efficient axml-only reading instead of loading entire file
      const xmlString = await window.atmosAPI.readAXMLChunk(filePath)

      if (xmlString && !xmlString.error) {
        const parser = new ADMParser()
        const result = parser.parseFromXml(xmlString)

        if (result.hasADM && result.objects.length > 0) {
          metadataParserRef.current = parser
          setMetadataSource('adm')
          console.log(`[ADM] Parsed: ${result.objects.length} objects`)
          return
        }
      }

      // Fallback: try loading the full file (for small files or non-standard containers)
      const wavData = await window.atmosAPI.readBinary(filePath)
      if (wavData && !wavData.error) {
        const parser = new ADMParser()
        const result = parser.parse(wavData)

        if (result.hasADM && result.objects.length > 0) {
          metadataParserRef.current = parser
          setMetadataSource('adm')
        }
      }
    } catch (err) {
      console.warn('ADM parse failed:', err)
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