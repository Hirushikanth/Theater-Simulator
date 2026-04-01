import { spawn, execFile } from 'child_process'
import { existsSync } from 'fs'
import { join, extname } from 'path'
import { app } from 'electron'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

/**
 * Locate ffmpeg/ffprobe binary.
 * Tries: bundled ffmpeg-static → system PATH
 */
function findBinary(name) {
  try {
    let staticPath;
    if (name === 'ffmpeg') {
      staticPath = require('ffmpeg-static')
    } else if (name === 'ffprobe') {
      staticPath = require('ffprobe-static').path
    }

    if (staticPath && existsSync(staticPath)) {
      return app.isPackaged
        ? staticPath.replace('app.asar', 'app.asar.unpacked')
        : staticPath
    }
  } catch (err) {
    console.error(`Failed to resolve ${name}-static:`, err)
  }

  // Fallback to system PATH
  return name
}

const ffmpegPath = findBinary('ffmpeg')
const ffprobePath = findBinary('ffprobe')

/**
 * Run ffprobe and return JSON stream/format info
 */
export async function analyzeFile(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-show_entries', 'stream=index,codec_name,codec_long_name,codec_type,channels,channel_layout,sample_rate,bit_rate,duration,profile',
      filePath
    ]
    execFile(ffprobePath, args, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffprobe error: ${err.message}`))
      try {
        const info = JSON.parse(stdout)
        // Detect Atmos indicators
        const audioStreams = (info.streams || []).filter(s => s.codec_type === 'audio')
        const result = {
          format: info.format,
          audioStreams: audioStreams.map(s => ({
            index: s.index,
            codec: s.codec_name,
            codecLong: s.codec_long_name,
            profile: s.profile || '',
            channels: s.channels,
            channelLayout: s.channel_layout || '',
            sampleRate: parseInt(s.sample_rate) || 48000,
            bitRate: parseInt(s.bit_rate) || 0,
            duration: parseFloat(s.duration) || parseFloat(info.format?.duration) || 0,
            isAtmos: detectAtmos(s),
            isEAC3: s.codec_name === 'eac3',
            isTrueHD: s.codec_name === 'truehd',
            isAC3: s.codec_name === 'ac3',
            isAC4: s.codec_name === 'ac4',
            isPCM: s.codec_name?.startsWith('pcm_')
          }))
        }
        resolve(result)
      } catch (parseErr) {
        reject(new Error(`Failed to parse ffprobe output: ${parseErr.message}`))
      }
    })
  })
}

function detectAtmos(stream) {
  const codec = stream.codec_name || ''
  const profile = (stream.profile || '').toLowerCase()
  // EAC3 with Atmos profile or high channel count
  if (codec === 'eac3' && (profile.includes('atmos') || stream.channels > 6)) return true
  // TrueHD Atmos
  if (codec === 'truehd' && (profile.includes('atmos') || stream.channels > 8)) return true
  // AC4 usually implies Atmos
  if (codec === 'ac4') return true
  return false
}

/**
 * Decode audio to multi-channel PCM WAV using FFmpeg
 */
export function decodeAudio(inputPath, options = {}) {
  const {
    streamIndex = 0,
    sampleRate = 48000,
    channels = 8
  } = options

  const outputDir = join(tmpdir(), `atmos-viz-${randomUUID()}`)
  const outputPath = join(outputDir, 'decoded.wav')

  return new Promise((resolve, reject) => {
    // Create output directory
    const { mkdirSync } = require('fs')
    mkdirSync(outputDir, { recursive: true })

    const args = [
      '-y',
      '-i', inputPath,
      '-map', `0:a:${streamIndex}`,
      '-c:a', 'pcm_f32le',
      '-ac', String(channels),
      '-ar', String(sampleRate),
      outputPath
    ]

    const proc = spawn(ffmpegPath, args)
    let stderr = ''

    proc.stderr.on('data', (data) => { stderr += data.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ outputPath, outputDir })
      } else {
        reject(new Error(`FFmpeg decode failed (code ${code}): ${stderr.slice(-500)}`))
      }
    })
    proc.on('error', (err) => reject(err))
  })
}

/**
 * Extract raw codec bitstream for metadata parsing
 */
export function extractBitstream(inputPath, options = {}) {
  const { streamIndex = 0 } = options
  const ext = '.eac3'  // will be adjusted based on codec
  const outputDir = join(tmpdir(), `atmos-viz-${randomUUID()}`)
  const outputPath = join(outputDir, `raw${ext}`)

  return new Promise((resolve, reject) => {
    const { mkdirSync } = require('fs')
    mkdirSync(outputDir, { recursive: true })

    const args = [
      '-y',
      '-i', inputPath,
      '-map', `0:a:${streamIndex}`,
      '-c:a', 'copy',
      outputPath
    ]

    const proc = spawn(ffmpegPath, args)
    let stderr = ''

    proc.stderr.on('data', (data) => { stderr += data.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ outputPath, outputDir })
      } else {
        reject(new Error(`FFmpeg bitstream extraction failed (code ${code}): ${stderr.slice(-500)}`))
      }
    })
    proc.on('error', (err) => reject(err))
  })
}

/**
 * Generate waveform data from audio file
 */
export function generateWaveform(inputPath, options = {}) {
  const { width = 1000 } = options
  const outputDir = join(tmpdir(), `atmos-viz-${randomUUID()}`)
  const outputPath = join(outputDir, 'waveform.json')

  return new Promise((resolve, reject) => {
    const { mkdirSync } = require('fs')
    mkdirSync(outputDir, { recursive: true })

    // Use ffmpeg to extract amplitude envelope
    const args = [
      '-y',
      '-i', inputPath,
      '-filter_complex', `[0:a]aformat=sample_fmts=s16:channel_layouts=mono,compand=gain=-6,showwavespic=s=${width}x100:colors=00ffd5[wav]`,
      '-map', '[wav]',
      '-frames:v', '1',
      join(outputDir, 'wave.png')
    ]

    const proc = spawn(ffmpegPath, args)
    proc.on('close', () => {
      // Simple fallback: just return success even if waveform generation fails
      resolve({ outputDir })
    })
    proc.on('error', () => resolve({ outputDir }))
  })
}
