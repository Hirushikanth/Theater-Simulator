/**
 * Dolby Atmos Theater Visualizer — Helper Utilities
 */

// Format time in MM:SS.ms
export function formatTime(seconds) {
  if (!seconds || !isFinite(seconds)) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

// Convert amplitude (0-1) to dB
export function amplitudeToDB(amplitude) {
  if (amplitude <= 0) return -Infinity
  return 20 * Math.log10(amplitude)
}

// Convert dB to display percentage (0-100) using a visually pleasing scale
export function dbToPercent(db, minDB = -60, maxDB = 0) {
  if (db <= minDB) return 0
  if (db >= maxDB) return 100
  
  // Square root mapping (0.5 power) pushes lower dB levels upward visually,
  // making the VU meters feel extremely punchy and active even with quiet mixes.
  // e.g., an RMS of -30dB (0.5 normalized) becomes 70% height instead of 50%.
  const normalized = (db - minDB) / (maxDB - minDB)
  return Math.pow(normalized, 0.5) * 100
}

// Smooth value with exponential decay
export function smoothValue(current, target, smoothing = 0.85) {
  return current * smoothing + target * (1 - smoothing)
}

// Clamp value between min and max
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

// Linear interpolation
export function lerp(a, b, t) {
  return a + (b - a) * t
}

// Map a value from one range to another
export function mapRange(value, inMin, inMax, outMin, outMax) {
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin)
}

// 3D distance between two points
export function distance3D(a, b) {
  return Math.sqrt(
    (a.x - b.x) ** 2 +
    (a.y - b.y) ** 2 +
    (a.z - b.z) ** 2
  )
}

// Normalize a 3D vector
export function normalize3D(v) {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
  if (len === 0) return { x: 0, y: 0, z: 0 }
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

// Get file extension
export function getFileExtension(path) {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return ''
  return path.slice(dot).toLowerCase()
}

// Get file name from path
export function getFileName(path) {
  return path.split(/[\\/]/).pop() || path
}

// Format file size
export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// Format bitrate
export function formatBitrate(bps) {
  if (!bps) return 'N/A'
  if (bps >= 1000000) return `${(bps / 1000000).toFixed(1)} Mbps`
  return `${Math.round(bps / 1000)} kbps`
}

// Format codec name for display
export function formatCodecName(codec) {
  const names = {
    'eac3': 'Dolby Digital Plus',
    'ac3': 'Dolby Digital',
    'truehd': 'Dolby TrueHD',
    'ac4': 'Dolby AC-4',
    'aac': 'AAC',
    'flac': 'FLAC',
    'pcm_f32le': 'PCM Float 32-bit',
    'pcm_s16le': 'PCM 16-bit',
    'pcm_s24le': 'PCM 24-bit'
  }
  return names[codec] || codec?.toUpperCase() || 'Unknown'
}

// Debounce function calls
export function debounce(fn, delay) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

// Generate a random ID
export function randomId() {
  return Math.random().toString(36).slice(2, 10)
}
