import { app, BrowserWindow, protocol, net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { setupIpcHandlers } from './ipc-handlers'
import { cleanupAllTempDirs } from './ffmpeg-bridge'

// Must be registered before app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'atmos',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
      corsEnabled: true
    }
  }
])

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    backgroundColor: '#0a0a0f',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true 
    }
  })

  mainWindow.setTitle('Dolby Atmos Theater Visualizer')

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

app.whenReady().then(async () => {
  // Updated protocol handler using URL searchParams
  protocol.handle('atmos', (request) => {
    try {
      const url = new URL(request.url)
      let filePath = url.searchParams.get('path')
      
      if (!filePath) return new Response('No path provided', { status: 400 })

      // Handle Windows pathing issues (removing leading slash from /C:/...)
      if (process.platform === 'win32' && filePath.startsWith('/')) {
        filePath = filePath.slice(1)
      }
      
      // Stream the file chunk by chunk to the renderer using net.fetch
      return net.fetch(pathToFileURL(filePath).toString())
    } catch (err) {
      console.error('Protocol error:', err)
      return new Response('Protocol Error', { status: 500 })
    }
  })

  // Garbage collect any leftover temp files from crashed sessions
  await cleanupAllTempDirs()

  setupIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Cleanup massive temporary files when the app closes.
// The async cleanup runs once, then a normal quit is allowed to proceed so the
// regular shutdown ordering (window teardown, session flush) is not skipped by
// a forced app.exit().
let shutdownCleanupDone = false

app.on('before-quit', async (e) => {
  if (shutdownCleanupDone) return
  e.preventDefault()
  shutdownCleanupDone = true
  try {
    await cleanupAllTempDirs()
  } catch (err) {
    console.error('Failed to clean temp dirs on quit:', err)
  }
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})