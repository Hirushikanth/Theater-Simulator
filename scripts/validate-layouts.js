import { LAYOUTS } from '../src/renderer/src/utils/layouts.js'
import { VBAPRenderer } from '../src/renderer/src/engine/vbap-renderer.js'
import { VUMeterEngine } from '../src/renderer/src/engine/vu-meter-engine.js'

const STEPS = 40
let failures = 0

const fauxAudioEngine = {
  getAllChannelLevels () {
    return new Map([
      ['FL', -6], ['FR', -6], ['C', -6], ['LFE', -6],
      ['SL', -6], ['SR', -6], ['SBL', -6], ['SBR', -6],
      ['TFL', -6], ['TFR', -6]
    ])
  }
}

function checkLayout (layout) {
  const renderer = new VBAPRenderer(layout)
  const panning = layout.speakers.filter(speaker => speaker.role !== 'LFE')
  const maxGain = new Map(panning.map(speaker => [speaker.id, 0]))

  for (let xi = 0; xi <= STEPS; xi++) {
    for (let yi = 0; yi <= STEPS; yi++) {
      for (let zi = 0; zi <= STEPS; zi++) {
        const gains = renderer.calculateGains(xi / STEPS, yi / STEPS, zi / STEPS)
        for (const speaker of panning) {
          maxGain.set(speaker.id, Math.max(maxGain.get(speaker.id), gains.get(speaker.id) || 0))
        }
      }
    }
  }

  const unreachable = panning
    .filter(speaker => maxGain.get(speaker.id) < 0.9)
    .map(speaker => `${speaker.id}=${maxGain.get(speaker.id).toFixed(3)}`)

  const subwoofers = layout.speakers.filter(speaker => speaker.role === 'LFE')
  const subGains = renderer.calculateGains(0.5, 0.5, 0)
  const silentSubs = subwoofers
    .filter(speaker => (subGains.get(speaker.id) || 0) < 0.1)
    .map(speaker => speaker.id)
  if (silentSubs.length > 0) unreachable.push(`subs:${silentSubs.join(',')}`)

  const meterEngine = new VUMeterEngine(fauxAudioEngine, renderer, layout)
  meterEngine.setSpeakerGains(subGains)
  meterEngine.calculateLevels()
  const levels = meterEngine.getLevels()
  const silentMeters = layout.speakers
    .filter(speaker => !Number.isFinite(levels.get(speaker.id)))
    .map(speaker => speaker.id)
  if (silentMeters.length > 0) unreachable.push(`meters:${silentMeters.join(',')}`)

  const subCount = subwoofers.length
  const status = unreachable.length === 0 ? 'PASS' : 'FAIL'
  if (unreachable.length > 0) failures++

  console.log(
    `${status} ${layout.id.padEnd(6)} speakers=${String(layout.speakers.length).padStart(2)} ` +
    `triangles=${String(renderer.triangles.length).padStart(2)} subs=${subCount}` +
    (unreachable.length ? ` unreachable: ${unreachable.join(', ')}` : '')
  )
}

for (const layout of Object.values(LAYOUTS)) {
  checkLayout(layout)
}

const scene = new VBAPRenderer(LAYOUTS['7.1.4'])
const rear = scene.calculateGains(0.5, 1, 0)
const surround = scene.calculateGains(0.5, 0.5, 0.5)
console.log('7.1.4 rear gains:', [...rear].filter(([, gain]) => gain > 0.01))
console.log('7.1.4 center gains:', [...surround].filter(([, gain]) => gain > 0.01))

if (failures > 0) {
  console.error(`\n${failures} layout(s) failed validation`)
  process.exit(1)
}

console.log('\nAll layouts passed.')
