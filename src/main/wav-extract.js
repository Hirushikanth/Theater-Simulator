/**
 * WAV/BW64 Channel Extractor
 *
 * Extracts the first N channels from a high-channel-count PCM WAV or BW64/RF64 file
 * as a new WAV without any audio codec re-encoding.
 *
 * Why not FFmpeg?
 *   - FFmpeg's pan filter supports max 64 channels
 *   - -map_channel internally uses pan (same limit)
 *   - SWR refuses to rematrix unknown channel layouts
 *
 * This implementation reads the binary WAV structure directly:
 *   RIFF/RF64 → fmt  → data → extract frames
 *
 * Supports:
 *   - Standard WAV (RIFF, up to 4 GB)
 *   - BW64/RF64 (RF64 + ds64 chunk, for > 4 GB files)
 *   - WAVEFORMATEXTENSIBLE (format 0xFFFE)
 *   - 16-bit, 24-bit, 32-bit PCM
 */

import { open, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

const CHUNK_FRAMES = 2048   // frames processed per I/O batch (memory budget ~= CHUNK_FRAMES × 92 × 3 ≈ 567 KB)

/**
 * Write a standard 44-byte WAV header for PCM output.
 */
function writeWavHeader(channels, sampleRate, bitDepth, dataBytes) {
  const blockAlign = channels * (bitDepth / 8)
  const byteRate = sampleRate * blockAlign
  const buf = Buffer.alloc(44)

  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)        // fileSize - 8
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)                   // fmt chunk size
  buf.writeUInt16LE(1, 20)                    // PCM
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(bitDepth, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)

  return buf
}

/**
 * Parse the WAV/BW64 header from an already-opened file descriptor.
 * Returns { channels, sampleRate, bitDepth, dataOffset, dataSize }
 */
async function parseWavHeader(fd) {
  // Read RIFF ID
  const riffBuf = Buffer.alloc(12)
  await fd.read(riffBuf, 0, 12, 0)

  const riffId = riffBuf.toString('ascii', 0, 4)
  const waveId = riffBuf.toString('ascii', 8, 12)

  if (waveId !== 'WAVE') throw new Error('Not a WAV/BW64 file')
  if (riffId !== 'RIFF' && riffId !== 'RF64') {
    throw new Error(`Unknown RIFF type: ${riffId}`)
  }

  const isRF64 = riffId === 'RF64'
  let pos = 12

  let channels = 0, sampleRate = 0, bitDepth = 0
  let dataOffset = 0, dataSize = 0

  // For RF64 files, the ds64 chunk holds the real data size
  let ds64DataSize = 0

  while (true) {
    const chunkHdr = Buffer.alloc(8)
    const { bytesRead } = await fd.read(chunkHdr, 0, 8, pos)
    if (bytesRead < 8) break

    const id = chunkHdr.toString('ascii', 0, 4)
    let size = chunkHdr.readUInt32LE(4)

    if (id === 'ds64' && isRF64) {
      // RF64 extended size chunk
      const ds64 = Buffer.alloc(28)
      await fd.read(ds64, 0, 28, pos + 8)
      // dataSize is at offset 16 (low) and 20 (high) within ds64
      const lo = ds64.readUInt32LE(8)
      const hi = ds64.readUInt32LE(12)
      ds64DataSize = lo + hi * 0x100000000
    } else if (id === 'fmt ') {
      const fmtData = Buffer.alloc(Math.min(size, 40))
      await fd.read(fmtData, 0, fmtData.length, pos + 8)

      const audioFormat = fmtData.readUInt16LE(0)
      if (audioFormat !== 1 && audioFormat !== 0xFFFE) {
        throw new Error(`Unsupported audio format: 0x${audioFormat.toString(16)} (only PCM supported)`)
      }

      channels   = fmtData.readUInt16LE(2)
      sampleRate = fmtData.readUInt32LE(4)
      bitDepth   = fmtData.readUInt16LE(14)
    } else if (id === 'data') {
      dataOffset = pos + 8
      // RF64 uses 0xFFFFFFFF as placeholder; real size is in ds64
      dataSize = (size === 0xFFFFFFFF && isRF64) ? ds64DataSize : size
      break  // data chunk always comes after fmt
    }

    // Advance: chunk size + alignment byte if odd
    pos += 8 + size + (size % 2)
  }

  if (!dataOffset)   throw new Error('No data chunk found in WAV')
  if (!channels)     throw new Error('No fmt chunk found in WAV')
  if (bitDepth === 0) throw new Error('Could not determine bit depth')

  return { channels, sampleRate, bitDepth, dataOffset, dataSize }
}

/**
 * Extract first `outChannels` channels from a WAV/BW64 file.
 * Returns { outputPath, outputDir, channelCount }.
 */
export async function extractWavChannels(inputPath, options = {}) {
  const { outChannels = 8 } = options

  const outputDir = join(tmpdir(), `atmos-viz-${randomUUID()}`)
  await mkdir(outputDir, { recursive: true })
  const outputPath = join(outputDir, 'extracted.wav')

  const fd = await open(inputPath, 'r')

  try {
    const { channels: inChannels, sampleRate, bitDepth, dataOffset, dataSize } = await parseWavHeader(fd)

    const actualOut = Math.min(outChannels, inChannels)
    const bytesPerSample = bitDepth / 8
    const inBlockAlign  = inChannels  * bytesPerSample
    const outBlockAlign = actualOut   * bytesPerSample

    const numFrames  = Math.floor(dataSize / inBlockAlign)
    const outDataSize = numFrames * outBlockAlign

    console.log(`[wav-extract] ${inChannels}ch → ${actualOut}ch | ${bitDepth}-bit @ ${sampleRate}Hz | ${numFrames} frames | ${(outDataSize / 1024 / 1024).toFixed(1)} MB output`)

    // Write output file
    const outFd = await open(outputPath, 'w')

    try {
      const header = writeWavHeader(actualOut, sampleRate, bitDepth, outDataSize)
      await outFd.write(header, 0, header.length, 0)

      let inPos  = dataOffset
      let outPos = header.length

      for (let frame = 0; frame < numFrames; frame += CHUNK_FRAMES) {
        const batchFrames = Math.min(CHUNK_FRAMES, numFrames - frame)
        const inBuf  = Buffer.alloc(batchFrames * inBlockAlign)
        const outBuf = Buffer.alloc(batchFrames * outBlockAlign)

        await fd.read(inBuf, 0, inBuf.length, inPos)

        // Copy only the first actualOut channels from each frame
        for (let f = 0; f < batchFrames; f++) {
          inBuf.copy(outBuf, f * outBlockAlign, f * inBlockAlign, f * inBlockAlign + outBlockAlign)
        }

        await outFd.write(outBuf, 0, outBuf.length, outPos)
        inPos  += batchFrames * inBlockAlign
        outPos += outBuf.length
      }
    } finally {
      await outFd.close()
    }
  } finally {
    await fd.close()
  }

  return { outputPath, outputDir, channelCount: outChannels }
}
