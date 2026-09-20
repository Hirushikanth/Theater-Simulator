import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('atmosAPI', {
  // File operations
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  // Resolve a real FS path for a dropped File (Electron no longer
  // reliably populates File.path in the renderer — use webUtils).
  getFilePath: (file) => {
    try {
      const p = webUtils.getPathForFile(file)
      if (p) return p
    } catch {}
    return file?.path
  },
  readBinary: (filePath) => ipcRenderer.invoke('file:readBinary', filePath),
  readText: (filePath) => ipcRenderer.invoke('file:readText', filePath),
  readAXMLChunk: (filePath) => ipcRenderer.invoke('file:readAXMLChunk', filePath),

  // Audio pipeline
  analyzeFile: (filePath) => ipcRenderer.invoke('audio:analyze', filePath),
  decodeAudio: (filePath, options) => ipcRenderer.invoke('audio:decode', filePath, options),
  decodeTrueHD: (filePath, options) => ipcRenderer.invoke('audio:decodeTrueHD', filePath, options),
  extractBitstream: (filePath, options) => ipcRenderer.invoke('audio:extractBitstream', filePath, options),
  extractTrueHDStream: (filePath, options) => ipcRenderer.invoke('audio:extractTrueHDStream', filePath, options),
  extractWavChannels: (filePath, options) => ipcRenderer.invoke('audio:extractWavChannels', filePath, options),
  cleanupTemp: (dirPath) => ipcRenderer.invoke('audio:cleanupTemp', dirPath),


  // Platform info
  platform: process.platform
})
