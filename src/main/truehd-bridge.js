import { spawn, execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join, extname } from 'path'
import { app } from 'electron'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { extractTrueHDStream, convertCAFToWAV } from './ffmpeg-bridge'

/**
 * Locate the truehdd binary.
 * Tries: bin/truehdd in project root → system PATH
 */
function findTrueHDBinary() {
  const localPath = app.isPackaged
    ? join(process.resourcesPath, 'bin', 'truehdd')
    : join(app.getAppPath(), 'bin', 'truehdd')

  if (existsSync(localPath)) {
    return localPath
  }

  // Fallback to system PATH
  return 'truehdd'
}

const truehddPath = findTrueHDBinary()

// Extensions that are already raw TrueHD bitstreams (no container extraction needed)
const RAW_TRUEHD_EXTS = new Set(['.thd', '.truehd', '.mlp'])

/**
 * Analyze a TrueHD file using truehdd info
 */
export async function analyzeTrueHD(filePath) {
  // If the file is in a container, extract the bitstream first
  const bitstreamPath = await ensureRawBitstream(filePath)

  return new Promise((resolve, reject) => {
    const args = ['info', '--log-format', 'json', bitstreamPath]
    execFile(truehddPath, args, (err, stdout, stderr) => {
      if (err) return reject(new Error(`truehdd info error: ${err.message}`))
      try {
        resolve({ raw: stdout, stderr })
      } catch (parseErr) {
        reject(new Error(`Failed to parse truehdd output: ${parseErr.message}`))
      }
    })
  })
}

/**
 * Ensure we have a raw TrueHD bitstream.
 * If the input is a container (MKV/MKA/MP4), extract via FFmpeg.
 * If it's already raw .thd/.truehd, return the path directly.
 *
 * @returns {string} path to the raw TrueHD bitstream
 */
async function ensureRawBitstream(filePath, options = {}) {
  const ext = extname(filePath).toLowerCase()

  if (RAW_TRUEHD_EXTS.has(ext)) {
    return filePath
  }

  // Container file — extract the TrueHD bitstream via FFmpeg
  console.log(`[truehd] Extracting TrueHD bitstream from container: ${filePath}`)
  const extraction = await extractTrueHDStream(filePath, {
    streamIndex: options.streamIndex || 0
  })

  console.log(`[truehd] Bitstream extracted to: ${extraction.outputPath}`)
  return extraction.outputPath
}

/**
 * Decode TrueHD to DAMF (Atmos Master Format).
 * 
 * Pipeline:
 *   1. Extract raw bitstream from container (if needed)
 *   2. Run truehdd decode → produces .atmos, .atmos.audio, .atmos.metadata
 *   3. Read both root (.atmos) and metadata files
 *   4. Convert CAF audio to WAV for browser playback
 */
export async function decodeTrueHD(filePath, options = {}) {
  const { presentation = 3, bedConform = true, streamIndex = 0 } = options
  const outputDir = join(tmpdir(), `truehd-decode-${randomUUID()}`)
  const outputPrefix = join(outputDir, 'decoded')

  // Step 1: Ensure raw bitstream
  let bitstreamPath
  try {
    bitstreamPath = await ensureRawBitstream(filePath, { streamIndex })
  } catch (err) {
    console.error('[truehd] Failed to extract bitstream:', err)
    throw new Error(`Bitstream extraction failed: ${err.message}`)
  }

  // Step 2: Run truehdd decode
  await new Promise((resolve, reject) => {
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    const args = [
      'decode',
      '--presentation', String(presentation),
      '--output-path', outputPrefix,
      bitstreamPath
    ]

    if (bedConform) {
      args.push('--bed-conform')
    }

    const proc = spawn(truehddPath, args)
    let stderr = ''
    let stdout = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
      console.log(`[truehdd] ${data.toString().trim()}`)
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        console.error(`[truehdd] Decode failed with code ${code}. Stderr: ${stderr}`)
        reject(new Error(`truehdd decode failed (code ${code}): ${stderr.slice(-500)}`))
      }
    })

    proc.on('error', (err) => reject(err))
  })

  // Step 3: Read output files
  const rootPath = `${outputPrefix}.atmos`
  const metadataPath = `${outputPrefix}.atmos.metadata`
  const audioPath = `${outputPrefix}.atmos.audio`

  console.log(`[truehdd] Decode success. Root: ${rootPath}, Metadata: ${metadataPath}, Audio: ${audioPath}`)

  const result = {
    outputDir,
    rootPath: existsSync(rootPath) ? rootPath : null,
    metadataPath: existsSync(metadataPath) ? metadataPath : null,
    audioPath: existsSync(audioPath) ? audioPath : null,
    prefix: outputPrefix,
    rootContent: null,
    metadataContent: null,
    wavPath: null,
    wavDir: null
  }

  // Read root file (.atmos) — contains bed/object channel mapping
  if (result.rootPath) {
    try {
      result.rootContent = readFileSync(result.rootPath, 'utf8')
      console.log(`[truehd] Root file read (${result.rootContent.length} bytes)`)
    } catch (e) {
      console.error('[truehd] Failed to read root file:', e)
    }
  }

  // Read metadata file (.atmos.metadata) — contains object position events
  if (result.metadataPath) {
    try {
      result.metadataContent = readFileSync(result.metadataPath, 'utf8')
      console.log(`[truehd] Metadata read (${result.metadataContent.length} bytes)`)
    } catch (e) {
      console.error('[truehd] Failed to read decoded metadata:', e)
    }
  }

  // Step 4: CAF audio conversion is no longer needed here.
  // App.jsx uses FFmpeg on the original file for playback (simpler, more reliable).
  // truehdd's role is metadata-only: .atmos root + .atmos.metadata

  return result
}
