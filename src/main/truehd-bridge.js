import { spawn, execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

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

/**
 * Analyze a TrueHD file using truehdd info
 */
export async function analyzeTrueHD(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['info', '--log-format', 'json', filePath]
    execFile(truehddPath, args, (err, stdout, stderr) => {
      if (err) return reject(new Error(`truehdd info error: ${err.message}`))
      try {
        // truehdd outputs multiple JSON lines for logs, we want the final info if any
        // For now, we'll just parse the stdout if it's formatted as expected
        // Note: truehdd 0.4.0 info might not output a single clean JSON yet
        resolve({ raw: stdout, stderr })
      } catch (parseErr) {
        reject(new Error(`Failed to parse truehdd output: ${parseErr.message}`))
      }
    })
  })
}

/**
 * Decode TrueHD to DAMF (Atmos Master Format)
 * This generates .atmos, .atmos.audio, and .atmos.metadata files
 */
export async function decodeTrueHD(filePath, options = {}) {
  const { presentation = 3, bedConform = true } = options
  const outputDir = join(tmpdir(), `truehd-decode-${randomUUID()}`)
  const outputPrefix = join(outputDir, 'decoded')

  return new Promise((resolve, reject) => {
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    const args = [
      'decode',
      '--presentation', String(presentation),
      '--output-path', outputPrefix,
      filePath
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
      // Log progress or errors in real-time for easier debugging
      console.log(`[truehdd] ${data.toString().trim()}`)
    })

    proc.on('close', (code) => {
      if (code === 0) {
        // truehdd creates files: decoded.atmos, decoded.atmos.audio, decoded.atmos.metadata
        const metadataPath = `${outputPrefix}.atmos.metadata`
        const audioPath = `${outputPrefix}.atmos.audio`

        console.log(`[truehdd] Decode success. Metadata: ${metadataPath}, Audio: ${audioPath}`)

        const result = {
          outputDir,
          metadataPath: existsSync(metadataPath) ? metadataPath : null,
          audioPath: existsSync(audioPath) ? audioPath : null,
          prefix: outputPrefix
        }

        // Read metadata if it exists to return it immediately
        if (result.metadataPath) {
          try {
            result.metadataContent = readFileSync(result.metadataPath, 'utf8')
            console.log(`[truehdd] Metadata read successfully (${result.metadataContent.length} bytes)`)
          } catch (e) {
            console.error('[truehdd] Failed to read decoded metadata:', e)
          }
        }

        resolve(result)
      } else {
        console.error(`[truehdd] Decode failed with code ${code}. Stderr: ${stderr}`)
        reject(new Error(`truehdd decode failed (code ${code}): ${stderr.slice(-500)}`))
      }
    })

    proc.on('error', (err) => reject(err))
  })
}
