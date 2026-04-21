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
  // TrueHD Atmos - often not explicitly labeled, so we treat 8+ channels as candidates
  if (codec === 'truehd' && (profile.includes('atmos') || stream.channels >= 8)) return true
  // AC4 usually implies Atmos
  if (codec === 'ac4') return true
  return false
}

/**
 * Decode audio to multi-channel PCM WAV using FFmpeg.
 *
 * For high-channel-count sources (ADM BWF, DAMF .atmos, TrueHD CAF) with
 * non-standard layouts, FFmpeg's automatic channel rematrix (SWR) fails with
 * "Input channel layout X is invalid or unsupported". In that case we use
 * -map_channel to explicitly pick channels by index, bypassing SWR.
 */
export function decodeAudio(inputPath, options = {}) {
  const {
    streamIndex = 0,
    sampleRate = 48000,
    channels = 8,
    sourceChannels = null  // actual channel count in the source (if known)
  } = options

  const outputDir = join(tmpdir(), `atmos-viz-${randomUUID()}`)
  const outputPath = join(outputDir, 'decoded.wav')

  // How many output channels we want (never more than 8 for browser compat)
  const outChannels = Math.min(channels, 8)

  // If source has more channels than we want (or we know it's non-standard),
  // use explicit -map_channel to pick channels 0..outChannels-1 by index.
  // This bypasses SWR's rematrix entirely.
  const needsExplicitMap = sourceChannels !== null && sourceChannels > outChannels

  return new Promise((resolve, reject) => {
    const { mkdirSync } = require('fs')
    mkdirSync(outputDir, { recursive: true })

    let args
    if (needsExplicitMap) {
      // Explicit channel-by-index selection — works for any channel count
      const mapArgs = []
      for (let ch = 0; ch < outChannels; ch++) {
        mapArgs.push('-map_channel', `0.${streamIndex}.${ch}`)
      }
      args = [
        '-y',
        '-i', inputPath,
        ...mapArgs,
        '-c:a', 'pcm_s16le',
        '-ar', String(sampleRate),
        outputPath
      ]
    } else {
      // Standard path — FFmpeg handles the downmix (works for ≤8ch sources)
      args = [
        '-y',
        '-i', inputPath,
        '-map', `0:a:${streamIndex}`,
        '-c:a', 'pcm_s16le',
        '-ac', String(outChannels),
        '-ar', String(sampleRate),
        outputPath
      ]
    }

    const proc = spawn(ffmpegPath, args)
    let stderr = ''

    proc.stderr.on('data', (data) => { stderr += data.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ outputPath, outputDir, channelCount: outChannels })
      } else {
        // Retry with explicit map_channel if standard path failed on high-ch source
        if (!needsExplicitMap && stderr.includes('channel')) {
          console.warn('[ffmpeg] Standard decode failed, retrying with explicit channel map...')
          const mapArgs = []
          for (let ch = 0; ch < outChannels; ch++) {
            mapArgs.push('-map_channel', `0.${streamIndex}.${ch}`)
          }
          const retryArgs = [
            '-y', '-i', inputPath,
            ...mapArgs,
            '-c:a', 'pcm_s16le',
            '-ar', String(sampleRate),
            outputPath
          ]
          const retryProc = spawn(ffmpegPath, retryArgs)
          let retryStderr = ''
          retryProc.stderr.on('data', (d) => { retryStderr += d.toString() })
          retryProc.on('close', (retryCode) => {
            if (retryCode === 0) {
              resolve({ outputPath, outputDir, channelCount: outChannels })
            } else {
              reject(new Error(`FFmpeg decode failed (code ${retryCode}): ${retryStderr.slice(-500)}`))
            }
          })
          retryProc.on('error', (err) => reject(err))
        } else {
          reject(new Error(`FFmpeg decode failed (code ${code}): ${stderr.slice(-500)}`))
        }
      }
    })
    proc.on('error', (err) => reject(err))
  })
}

/**
 * Extract raw codec bitstream for metadata parsing
 */
export function extractBitstream(inputPath, options = {}) {
  const { streamIndex = 0, codecRawFileExt = '.eac3' } = options
  const ext = codecRawFileExt
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
 * Extract raw TrueHD bitstream from an MKV/MKA container.
 * truehdd requires a raw .thd stream, not a container.
 */
export function extractTrueHDStream(inputPath, options = {}) {
  const { streamIndex = 0 } = options
  const outputDir = join(tmpdir(), `atmos-viz-${randomUUID()}`)
  const outputPath = join(outputDir, 'raw.thd')

  return new Promise((resolve, reject) => {
    const { mkdirSync } = require('fs')
    mkdirSync(outputDir, { recursive: true })

    const args = [
      '-y',
      '-i', inputPath,
      '-map', `0:a:${streamIndex}`,
      '-c:a', 'copy',
      '-f', 'truehd',
      outputPath
    ]

    const proc = spawn(ffmpegPath, args)
    let stderr = ''

    proc.stderr.on('data', (data) => { stderr += data.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ outputPath, outputDir })
      } else {
        reject(new Error(`FFmpeg TrueHD extraction failed (code ${code}): ${stderr.slice(-500)}`))
      }
    })
    proc.on('error', (err) => reject(err))
  })
}

/**
 * Convert CAF (Core Audio Format) from truehdd to WAV for browser playback.
 * Chromium cannot play CAF natively, and also cannot handle >8 channel WAV.
 * @param {string} inputPath - Path to .atmos.audio (CAF) file
 * @param {object} options
 * @param {number} options.sampleRate - Output sample rate
 * @param {number} options.maxChannels - Channel limit for browser compat (default 8)
 */
export function convertCAFToWAV(inputPath, options = {}) {
  const { sampleRate = 48000, maxChannels = 8 } = options
  const outputDir = join(tmpdir(), `atmos-viz-${randomUUID()}`)
  const outputPath = join(outputDir, 'decoded.wav')

  return new Promise((resolve, reject) => {
    const { mkdirSync } = require('fs')
    mkdirSync(outputDir, { recursive: true })

    const args = [
      '-y',
      '-i', inputPath,
      // Explicitly extract the first 8 bed channels by index using the pan filter.
      // -ac N alone fails for non-standard channel counts because FFmpeg needs
      // a named layout to rematrix from. The pan filter maps by channel index directly.
      '-filter_complex',
      `pan=7.1|c0=c0|c1=c1|c2=c2|c3=c3|c4=c4|c5=c5|c6=c6|c7=c7`,
      '-c:a', 'pcm_s16le',
      '-ar', String(sampleRate),
      outputPath
    ]

    const proc = spawn(ffmpegPath, args)
    let stderr = ''

    proc.stderr.on('data', (data) => { stderr += data.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ outputPath, outputDir, channelCount: maxChannels })
      } else {
        reject(new Error(`FFmpeg CAF→WAV conversion failed (code ${code}): ${stderr.slice(-500)}`))
      }
    })
    proc.on('error', (err) => reject(err))
  })
}

/**
 * Read only the 'axml' RIFF chunk from a WAV/BW64 file.
 * This avoids loading multi-GB audio data into memory just to extract ADM XML.
 */
export async function readAXMLChunk(filePath) {
  const { open } = require('fs/promises')
  let fh

  try {
    fh = await open(filePath, 'r')

    // Read RIFF header (12 bytes)
    const headerBuf = Buffer.alloc(12)
    await fh.read(headerBuf, 0, 12, 0)

    const magic = headerBuf.toString('ascii', 0, 4)
    if (magic !== 'RIFF' && magic !== 'RF64' && magic !== 'BW64') {
      return null  // Not a WAV file
    }

    let offset = 12
    const stat = await fh.stat()
    const fileSize = stat.size

    // Scan RIFF chunks for 'axml'
    const chunkHeaderBuf = Buffer.alloc(8)
    while (offset < fileSize - 8) {
      await fh.read(chunkHeaderBuf, 0, 8, offset)
      const chunkId = chunkHeaderBuf.toString('ascii', 0, 4)
      const chunkSize = chunkHeaderBuf.readUInt32LE(4)

      if (chunkId === 'axml') {
        // Read just the XML chunk
        const xmlBuf = Buffer.alloc(chunkSize)
        await fh.read(xmlBuf, 0, chunkSize, offset + 8)
        return xmlBuf.toString('utf-8')
      }

      // Skip to next chunk (pad to even boundary)
      offset += 8 + chunkSize
      if (chunkSize % 2 !== 0) offset++
    }

    return null  // No axml chunk found
  } catch (err) {
    console.error('Failed to read axml chunk:', err)
    return null
  } finally {
    if (fh) await fh.close()
  }
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

/**
 * Cleanup temporary directories created during decoding/extraction
 */
export async function cleanupTempDir(dirPath) {
  const { rm } = require('fs/promises')
  try {
    // Safety check: ensure we only delete directories in the temp path that we likely created
    if (dirPath && (dirPath.includes('atmos-viz') || dirPath.includes('truehd-decode'))) {
      await rm(dirPath, { recursive: true, force: true })
    }
  } catch (err) {
    console.error('Failed to cleanup temp dir:', err)
  }
}

export async function cleanupAllTempDirs() {
  const { readdir, rm } = require('fs/promises')
  const osTmp = tmpdir()
  try {
    const files = await readdir(osTmp)
    for (const file of files) {
      if (file.startsWith('atmos-viz-') || file.startsWith('truehd-decode-')) {
        await rm(join(osTmp, file), { recursive: true, force: true }).catch(() => {})
      }
    }
  } catch (err) {
    console.error('Failed to cleanup global temp dirs:', err)
  }
}
