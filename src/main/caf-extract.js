/**
 * CAF (Core Audio Format) audio extractor / fold-down mixer.
 *
 * The standalone DAMF (`.atmos`) path has no source container to decode with
 * FFmpeg — the only audio is the companion `<name>.atmos.audio`, a CAF file
 * with one PCM channel per bed channel + object (25 ch for the Amaze master).
 * Compressed browser playback of that is impossible (Chromium cannot decode
 * CAF, and a 25-channel unknown-layout file cannot be rematrixed by FFmpeg
 * without a layout).
 *
 * This module reads the CAF structure directly — no FFmpeg, no re-encode — and
 * folds every input channel into a small output WAV (stereo by default) that
 * Chromium can play. That makes the "visualization only" standalone path audible.
 *
 * Parsed layout (ITU/Apple CAF):
 *   caff header (8 B) → chunks: type(4) + int64-BE size, payload
 *   'desc' = AudioStreamBasicDescription (32 B, all fields big-endian):
 *            sampleRate(f64) formatID(4cc) flags(u32) bytesPerPacket(u32)
 *            framesPerPacket(u32) channels(u32) bitsPerChannel(u32)
 *   'data' = uint32 edit count, then interleaved PCM
 *
 * Endianness note: FFmpeg decodes CAF LPCM with
 *   ff_mov_get_lpcm_codec_id(bits, (flags ^ 0x2) | 0x4)
 * i.e. the endianness flag is inverted versus MOV (bit 1 set = little-endian)
 * and integer LPCM is always signed. truehdd 0.4.0 writes flags=0 and
 * big-endian 24-bit samples — ffprobe reports pcm_s24be — so we mirror that
 * rule exactly.
 */

import { open, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

const CHUNK_FRAMES = 4096   // frames per I/O batch (4096 × 75 B ≈ 300 KB input)

/**
 * Write a standard 44-byte PCM WAV header.
 */
function writeWavHeader(channels, sampleRate, bitDepth, dataBytes) {
  const blockAlign = channels * (bitDepth / 8)
  const byteRate = sampleRate * blockAlign
  const buf = Buffer.alloc(44)

  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
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
 * Walk the CAF chunk list and return the audio description + data location.
 */
async function parseCaf(fd) {
  const fileSize = (await fd.stat()).size
  const header = Buffer.alloc(8)
  await fd.read(header, 0, 8, 0)
  if (header.toString('ascii', 0, 4) !== 'caff') {
    throw new Error('Not a CAF file (missing "caff" magic)')
  }

  let pos = 8
  let desc = null
  let dataOffset = 0
  let dataSize = 0

  while (pos + 12 <= fileSize) {
    const chunk = Buffer.alloc(12)
    const { bytesRead } = await fd.read(chunk, 0, 12, pos)
    if (bytesRead < 12) break

    const id = chunk.toString('ascii', 0, 4)
    let size = Number(chunk.readBigInt64BE(4))
    if (size < 0) size = fileSize - pos - 12   // 0/-1 = "to end of file"

    if (id === 'desc') {
      const d = Buffer.alloc(32)
      await fd.read(d, 0, 32, pos + 12)
      const flags = d.readUInt32BE(12)
      desc = {
        sampleRate: d.readDoubleBE(0),
        formatID: d.toString('ascii', 8, 12),
        isFloat: (flags & 0x1) !== 0,
        // FFmpeg inverts the endianness bit for CAF (see module docs)
        isBigEndian: (flags & 0x2) === 0,
        bytesPerPacket: d.readUInt32BE(16),
        framesPerPacket: d.readUInt32BE(20),
        channels: d.readUInt32BE(24),
        bitsPerChannel: d.readUInt32BE(28)
      }
    } else if (id === 'data') {
      // First 4 bytes are the edit count, then the audio data.
      dataOffset = pos + 12 + 4
      dataSize = Math.max(0, size - 4)
      break   // audio comes after desc in practice; no need to scan further
    }

    pos += 12 + size + (size % 2)   // guard: even-byte chunk alignment
  }

  if (!desc) throw new Error('No desc chunk found in CAF')
  if (!dataOffset) throw new Error('No data chunk found in CAF')
  if (desc.formatID !== 'lpcm') {
    throw new Error(`Unsupported CAF codec "${desc.formatID}" (only lpcm supported)`)
  }
  if (desc.isFloat) {
    throw new Error('Unsupported CAF format: floating-point LPCM')
  }
  if (![16, 24, 32].includes(desc.bitsPerChannel)) {
    throw new Error(`Unsupported CAF bit depth: ${desc.bitsPerChannel}`)
  }
  if (desc.framesPerPacket > 1) {
    throw new Error(`Unsupported CAF packetization (framesPerPacket=${desc.framesPerPacket})`)
  }

  const bytesPerSample = desc.bitsPerChannel / 8
  const blockAlign = desc.channels * bytesPerSample
  const frames = Math.floor(dataSize / blockAlign)

  return { ...desc, bytesPerSample, blockAlign, frames, dataOffset }
}

/** Read one signed PCM sample of `bytes` bytes from a buffer. */
function readSample(buf, offset, bytes, bigEndian) {
  if (bytes === 2) return bigEndian ? buf.readInt16BE(offset) : buf.readInt16LE(offset)
  if (bytes === 4) return bigEndian ? buf.readInt32BE(offset) : buf.readInt32LE(offset)
  // 24-bit: no Buffer helper — sign-extend manually
  return bigEndian
    ? (buf.readInt8(offset) << 16) | buf.readUInt16BE(offset + 1)
    : (buf.readInt8(offset + 2) << 16) | buf.readUInt16LE(offset)
}

/**
 * Extract (and fold down) a CAF file to a playable WAV.
 *
 * @param {string} inputPath
 * @param {object} [options]
 * @param {number} [options.outChannels=2]  output channels (all receive the same mono fold)
 * @param {number} [options.maxFrames]      limit for testing/truncation
 * @returns {Promise<{outputPath, outputDir, channelCount, inputChannels, frames, sampleRate}>}
 */
export async function extractCafAudio(inputPath, options = {}) {
  const { outChannels = 2, maxFrames = Infinity } = options

  const outputDir = join(tmpdir(), `atmos-viz-${randomUUID()}`)
  await mkdir(outputDir, { recursive: true })
  const outputPath = join(outputDir, 'extracted.wav')

  const fd = await open(inputPath, 'r')
  let header = null

  try {
    const caf = await parseCaf(fd)
    header = caf

    const frames = Math.min(caf.frames, maxFrames)
    const outBitDepth = 16
    const outBytesPerSample = outBitDepth / 8
    const outBlockAlign = outChannels * outBytesPerSample
    const outDataSize = frames * outBlockAlign

    // Equal-power fold-down: uncorrelated channels sum to ~unity RMS.
    const weight = 1 / Math.sqrt(caf.channels)

    console.log(
      `[caf-extract] ${caf.channels}ch → ${outChannels}ch | ` +
      `${caf.bitsPerChannel}-bit ${caf.isBigEndian ? 'BE' : 'LE'} @ ${caf.sampleRate}Hz | ` +
      `${frames} frames | ${(outDataSize / 1024 / 1024).toFixed(1)} MB output`
    )

    const outFd = await open(outputPath, 'w')
    try {
      await outFd.write(writeWavHeader(outChannels, caf.sampleRate, outBitDepth, outDataSize), 0, 44, 0)

      const inBuf = Buffer.alloc(CHUNK_FRAMES * caf.blockAlign)
      const outBuf = Buffer.alloc(CHUNK_FRAMES * outBlockAlign)

      let inPos = caf.dataOffset
      let outPos = 44

      for (let frame = 0; frame < frames; frame += CHUNK_FRAMES) {
        const batch = Math.min(CHUNK_FRAMES, frames - frame)
        const inBytes = batch * caf.blockAlign
        await fd.read(inBuf, 0, inBytes, inPos)

        for (let f = 0; f < batch; f++) {
          let mix = 0
          const frameBase = f * caf.blockAlign
          for (let ch = 0; ch < caf.channels; ch++) {
            const s = readSample(inBuf, frameBase + ch * caf.bytesPerSample, caf.bytesPerSample, caf.isBigEndian)
            // normalize by full-scale for this bit depth
            mix += (s / (2 ** (caf.bitsPerChannel - 1))) * weight
          }
          // clamp to the 16-bit range (rare, only for hot correlated mixes)
          const v = Math.max(-1, Math.min(1, mix))
          const out = Math.round(v * 32767)
          const outFrame = f * outBlockAlign
          for (let ch = 0; ch < outChannels; ch++) {
            outBuf.writeInt16LE(out, outFrame + ch * outBytesPerSample)
          }
        }

        await outFd.write(outBuf, 0, batch * outBlockAlign, outPos)
        inPos += inBytes
        outPos += batch * outBlockAlign
      }
    } finally {
      await outFd.close()
    }
  } finally {
    await fd.close()
  }

  return {
    outputPath,
    outputDir,
    channelCount: outChannels,
    inputChannels: header?.channels ?? 0,
    frames: header ? Math.min(header.frames, maxFrames) : 0,
    sampleRate: header?.sampleRate ?? 48000
  }
}