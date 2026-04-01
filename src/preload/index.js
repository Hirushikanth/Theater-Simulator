import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('atmosAPI', {
  // File operations
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  readBinary: (filePath) => ipcRenderer.invoke('file:readBinary', filePath),
  readText: (filePath) => ipcRenderer.invoke('file:readText', filePath),

  // Audio pipeline
  analyzeFile: (filePath) => ipcRenderer.invoke('audio:analyze', filePath),
  decodeAudio: (filePath, options) => ipcRenderer.invoke('audio:decode', filePath, options),
  decodeTrueHD: (filePath, options) => ipcRenderer.invoke('audio:decodeTrueHD', filePath, options),
  extractBitstream: (filePath, options) => ipcRenderer.invoke('audio:extractBitstream', filePath, options),

  // Platform info
  platform: process.platform
})
