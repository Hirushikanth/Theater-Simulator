import { ipcMain, dialog } from 'electron'
import { readFile, stat } from 'fs/promises'
import { analyzeFile, decodeAudio, extractBitstream, extractTrueHDStream, readAXMLChunk, cleanupTempDir } from './ffmpeg-bridge'
import { analyzeTrueHD, decodeTrueHD } from './truehd-bridge'
import { extractWavChannels } from './wav-extract'

export function setupIpcHandlers() {
  // Open file dialog
  ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open Audio File',
      filters: [
        {
          name: 'Dolby Atmos Audio',
          extensions: [
            'mkv', 'mka', 'webm', 'weba',
            'mp4', 'mov', 'qt', 'm4a', 'm4v',
            'ac3', 'eac3', 'ec3', 'thd', 'truehd',
            'wav', 'laf', 'atmos'
          ]
        },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Analyze file with ffprobe
  ipcMain.handle('audio:analyze', async (_, filePath) => {
    try {
      return await analyzeFile(filePath)
    } catch (err) {
      return { error: err.message }
    }
  })

  // Decode audio to PCM WAV
  ipcMain.handle('audio:decode', async (_, filePath, options) => {
    try {
      return await decodeAudio(filePath, options)
    } catch (err) {
      return { error: err.message }
    }
  })

  // Cleanup temporary decoding directories
  ipcMain.handle('audio:cleanupTemp', async (_, dirPath) => {
    await cleanupTempDir(dirPath)
  })

  // Extract raw bitstream for metadata parsing
  ipcMain.handle('audio:extractBitstream', async (_, filePath, options) => {
    try {
      return await extractBitstream(filePath, options)
    } catch (err) {
      return { error: err.message }
    }
  })

  // Extract raw TrueHD bitstream from container
  ipcMain.handle('audio:extractTrueHDStream', async (_, filePath, options) => {
    try {
      return await extractTrueHDStream(filePath, options)
    } catch (err) {
      return { error: err.message }
    }
  })

  // Decode TrueHD with truehdd (Professional/High-fidelity)
  ipcMain.handle('audio:decodeTrueHD', async (_, filePath, options) => {
    try {
      return await decodeTrueHD(filePath, options)
    } catch (err) {
      return { error: err.message }
    }
  })

  // Read file as ArrayBuffer (for bitstream parser).
  // Slices to the view's byte range so pooled Buffer backing stores never
  // leak pool garbage / wrong length into DataView consumers. Refuses
  // GB-scale files (e.g. ADM masters — use readAXMLChunk for those) instead
  // of cloning them over IPC.
  ipcMain.handle('file:readBinary', async (_, filePath) => {
    try {
      const MAX_READ_BINARY_BYTES = 256 * 1024 * 1024
      const st = await stat(filePath)
      if (st.size > MAX_READ_BINARY_BYTES) {
        return { error: `File too large for readBinary (${st.size} bytes > ${MAX_READ_BINARY_BYTES} bytes) — use a chunked reader (e.g. file:readAXMLChunk for WAV/ADM)` }
      }
      const buffer = await readFile(filePath)
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    } catch (err) {
      return { error: err.message }
    }
  })

  // Read file as text
  ipcMain.handle('file:readText', async (_, filePath) => {
    try {
      const text = await readFile(filePath, 'utf-8')
      return text
    } catch (err) {
      return { error: err.message }
    }
  })

  // Efficiently read just the axml chunk from a WAV/BW64 file
  // Avoids loading multi-GB audio data into memory
  ipcMain.handle('file:readAXMLChunk', async (_, filePath) => {
    try {
      const xml = await readAXMLChunk(filePath)
      return xml
    } catch (err) {
      return { error: err.message }
    }
  })

  // Extract first N channels from a high-channel WAV/BW64 file (ADM BWF)
  // Bypasses FFmpeg 64-channel pan filter limit via direct binary extraction
  ipcMain.handle('audio:extractWavChannels', async (_, filePath, options) => {
    try {
      return await extractWavChannels(filePath, options)
    } catch (err) {
      return { error: err.message }
    }
  })
}
