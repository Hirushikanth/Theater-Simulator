/**
 * Dolby Atmos Theater Visualizer — Constants
 * Speaker positions, colors, and layout configuration for 7.1.4
 */

// 7.1.4 Speaker Layout — angles in degrees
// Azimuth: 0° = front, positive = right, negative = left
// Elevation: 0° = ear level, positive = above
export const SPEAKERS = [
  { id: 'FL',  name: 'Front Left',      azimuth: -30,  elevation: 0,  group: 'front',    color: '#00ffd5' },
  { id: 'FR',  name: 'Front Right',     azimuth:  30,  elevation: 0,  group: 'front',    color: '#00ffd5' },
  { id: 'C',   name: 'Center',          azimuth:   0,  elevation: 0,  group: 'center',   color: '#ffffff' },
  { id: 'LFE', name: 'Subwoofer',       azimuth:   0,  elevation:-30, group: 'lfe',      color: '#ff1744' },
  { id: 'SL',  name: 'Surround Left',   azimuth: -90,  elevation: 0,  group: 'surround', color: '#4488ff' },
  { id: 'SR',  name: 'Surround Right',  azimuth:  90,  elevation: 0,  group: 'surround', color: '#4488ff' },
  { id: 'SBL', name: 'Rear Left',       azimuth:-135,  elevation: 0,  group: 'rear',     color: '#6366f1' },
  { id: 'SBR', name: 'Rear Right',      azimuth: 135,  elevation: 0,  group: 'rear',     color: '#6366f1' },
  { id: 'TFL', name: 'Top Front Left',  azimuth: -45,  elevation: 45, group: 'height',   color: '#a855f7' },
  { id: 'TFR', name: 'Top Front Right', azimuth:  45,  elevation: 45, group: 'height',   color: '#a855f7' },
  { id: 'TRL', name: 'Top Rear Left',   azimuth:-135,  elevation: 45, group: 'height',   color: '#c084fc' },
  { id: 'TRR', name: 'Top Rear Right',  azimuth: 135,  elevation: 45, group: 'height',   color: '#c084fc' }
]

// Convert spherical speaker positions to 3D cartesian
// Room dimensions (meters): 6m wide, 8m deep, 3.5m tall
export const ROOM = {
  width: 6,
  depth: 8,
  height: 3.5,
  listenerPosition: { x: 0, y: 1.2, z: 0 },
  radius: 3 // speakers placed on a sphere of 3m radius
}

// Convert azimuth/elevation to 3D position on a unit sphere (and offset for room)
export function speakerToCartesian(speaker, radius = ROOM.radius) {
  const azRad = (speaker.azimuth * Math.PI) / 180
  const elRad = (speaker.elevation * Math.PI) / 180
  
  // Ear level is y = 0. Floor is y = -1.
  let yVal = radius * Math.sin(elRad)
  if (speaker.id === 'LFE') {
    yVal = -1 // Subwoofer on the ground
  }

  return {
    x: radius * Math.cos(elRad) * Math.sin(azRad),
    y: Math.max(-1, yVal), // Ensure nothing goes below floor
    z:-radius * Math.cos(elRad) * Math.cos(azRad) // negative Z = forward
  }
}

// Atmos coordinate system → 3D room position
// Atmos: X: 0(left)→1(right), Y: 0(front)→1(back), Z: 0(floor)→1(ceiling)
export function atmosToRoom(ax, ay, az) {
  const halfW = ROOM.width / 2
  const halfD = ROOM.depth / 2
  return {
    x: (ax - 0.5) * ROOM.width,   // -3 to +3
    y: az * ROOM.height,           // 0 to 3.5
    z: (ay - 0.5) * ROOM.depth    // -4 to +4
  }
}

// Channel configuration for different decoder outputs
export const CHANNEL_LAYOUTS = {
  '7.1': ['FL', 'FR', 'C', 'LFE', 'SL', 'SR', 'SBL', 'SBR'],
  '7.1.4': ['FL', 'FR', 'C', 'LFE', 'SL', 'SR', 'SBL', 'SBR', 'TFL', 'TFR', 'TRL', 'TRR'],
  '5.1': ['FL', 'FR', 'C', 'LFE', 'SL', 'SR'],
  '5.1.2': ['FL', 'FR', 'C', 'LFE', 'SL', 'SR', 'TFL', 'TFR'],
  'stereo': ['FL', 'FR']
}

// Object colors — gradient from cyan (floor) to violet (ceiling) to magenta
export function objectColor(zNormalized) {
  const z = Math.max(0, Math.min(1, zNormalized))
  if (z < 0.3) return '#00ffd5'      // floor: cyan
  if (z < 0.5) return '#00ccff'      // low-mid: light blue
  if (z < 0.7) return '#7b61ff'      // mid: blue-violet
  if (z < 0.85) return '#a855f7'     // high: violet
  return '#ff00ff'                    // ceiling: magenta
}

// Hex to RGB
export function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return { r, g, b }
}

// Supported formats
export const SUPPORTED_EXTENSIONS = [
  '.mkv', '.mka', '.webm', '.weba',
  '.mp4', '.mov', '.qt', '.m4a', '.m4v',
  '.ac3', '.eac3', '.ec3',
  '.wav',
  '.laf'
]

// EAC3 sync word
export const EAC3_SYNC_WORD = 0x0B77

// Max objects in EAC3 JOC home delivery
export const MAX_JOC_OBJECTS = 16

// Object persistence buffer (ms)
export const OBJECT_PERSISTENCE_MS = 64

// Trail length (frames)
export const TRAIL_LENGTH = 30
