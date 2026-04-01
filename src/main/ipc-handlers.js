import { ipcMain, dialog } from 'electron'
import { readFile } from 'fs/promises'
import { analyzeFile, decodeAudio, extractBitstream } from './ffmpeg-bridge'
import { analyzeTrueHD, decodeTrueHD } from './truehd-bridge'

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

  // Extract raw bitstream for metadata parsing
  ipcMain.handle('audio:extractBitstream', async (_, filePath, options) => {
    try {
      return await extractBitstream(filePath, options)
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

  // Read file as ArrayBuffer (for bitstream parser)
  ipcMain.handle('file:readBinary', async (_, filePath) => {
    try {
      const buffer = await readFile(filePath)
      return buffer.buffer
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
}
