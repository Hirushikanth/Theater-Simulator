import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { EAC3Parser } from '../src/renderer/src/parsers/eac3-parser.js'
import { DAMFParser } from '../src/renderer/src/parsers/damf-parser.js'
import { ADMParser } from '../src/renderer/src/parsers/adm-parser.js'

const require = createRequire(import.meta.url)
const root = process.env.PROJECT_ROOT || process.cwd()

let ffmpeg = process.env.FFMPEG_PATH
if (!ffmpeg) {
  try {
    ffmpeg = require('ffmpeg-static')
  } catch {
    ffmpeg = 'ffmpeg'
  }
}

const fixtures = {
  chid: path.join(root, 'test-assets/dolby-ondk/ChID_voices_1280x720p_25fps_h264_6ch_640kbps_ddp_joc.mp4'),
  avsync: path.join(root, 'test-assets/dolby-ondk/AVSync_1280x720p_25fps_h264_6ch_640kbps_ddp_joc.mp4'),
  ddp51: path.join(root, 'test-assets/dolby-ondk/ChID_voices_1280x720p_25fps_h264_6ch_256kbps_ddp.mp4'),
  jocMkv: path.join(root, 'test-assets/atmos-video/EAC3-JOC ATMOS.mkv'),
  amazeRoot: path.join(root, 'test-assets/generated/Dolby Amaze.ATMOS.atmos'),
  amazeMeta: path.join(root, 'test-assets/generated/Dolby Amaze.ATMOS.atmos.metadata')
}

const missingFixtures = Object.entries(fixtures)
  .filter(([, file]) => !fs.existsSync(file))
  .map(([name, file]) => `  ${name}: ${file}`)

if (missingFixtures.length > 0) {
  console.error('Missing parser test fixtures:')
  console.error(missingFixtures.join('\n'))
  process.exit(1)
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theater-parser-tests-'))
let passed = 0
let failed = 0

function check (name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
    passed++
  } catch (err) {
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.message}`)
    failed++
  }
}

function assert (condition, message) {
  if (!condition) throw new Error(message)
}

function approx (actual, expected, epsilon, label) {
  assert(
    Math.abs(actual - expected) <= epsilon,
    `${label}: expected ${expected} ± ${epsilon}, got ${actual}`
  )
}

function extractEac3 (input) {
  const output = path.join(
    tempDir,
    path.basename(input).replace(/[^a-z0-9]+/gi, '_') + '.eac3'
  )
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-map', '0:a:0',
    '-c:a', 'copy',
    '-f', 'eac3',
    output
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  return output
}

function parseEac3 (input) {
  const buffer = fs.readFileSync(input)
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  )
  const parser = new EAC3Parser()
  const result = parser.parse(arrayBuffer)
  return { parser, result }
}

function statesAt (parser, start, seconds, smooth, samples = 120) {
  const states = new Set()
  for (let i = 0; i < samples; i++) {
    const objs = parser.getObjectsAtTime(start + (i / samples) * seconds, smooth)
    states.add(JSON.stringify(objs.map(o => [
      o.id,
      o.x.toFixed(5),
      o.y.toFixed(5),
      o.z.toFixed(5),
      o.gain.toFixed(5),
      o.size.toFixed(5)
    ])))
  }
  return states
}

function activeEvents (result) {
  return result.objects.filter(o => o.active !== false)
}

console.log('E-AC-3 fixtures')

const chidPath = extractEac3(fixtures.chid)
const chid = parseEac3(chidPath)
const chidTimes = [...new Set(activeEvents(chid.result).map(o => o.timestamp))]
  .sort((a, b) => a - b)
const chidFirst = chidTimes[0]
const chidObjectIds = [...new Set(chid.result.objects.map(o => o.id))]
let movedId = -1
let movedEvents = []

check('ChID is detected as Atmos', () => {
  assert(chid.result.isAtmos, 'isAtmos is false')
  assert(chid.result.objects.length > 0, 'no object events emitted')
})

check('ChID duration matches the bitstream', () => {
  approx(chid.result.duration, 75.552, 0.05, 'duration')
})

check('ChID block offsets use 32-sample OAMD units', () => {
  approx(chidFirst, 0.308, 0.02, 'first event')
})

check('ChID emits timestamps in order', () => {
  for (let i = 1; i < chidTimes.length; i++) {
    assert(chidTimes[i] >= chidTimes[i - 1], `timestamp ${i} is out of order`)
  }
})

check('ChID keeps every object visible between metadata updates', () => {
  for (let i = 0; i < 400; i++) {
    const t = chidFirst + (i / 400) * (chid.result.duration - chidFirst - 0.1)
    const objs = chid.parser.getObjectsAtTime(t, false)
    assert(objs.length === chidObjectIds.length,
      `${objs.length} objects at t=${t.toFixed(3)}, expected ${chidObjectIds.length}`)
  }
})

check('ChID exact lookup is cached between events', () => {
  const objs = chid.parser.getObjectsAtTime(chidFirst + 0.001, false)
  const same = chid.parser.getObjectsAtTime(chidFirst + 0.002, false)
  assert(objs === same, 'exact lookup rebuilt an identical state')
})

for (const id of chidObjectIds) {
  const events = activeEvents(chid.result).filter(o => o.id === id)
  if (events.length < 2) continue
  const from = events[0]
  const to = events[1]
  if (from.x !== to.x || from.y !== to.y || from.z !== to.z) {
    movedId = id
    movedEvents = events
    break
  }
}

check('ChID has a moving object', () => {
  assert(movedId !== -1, 'no moving object found')
})

check('ChID exact mode holds the latest metadata event', () => {
  assert(movedId !== -1, 'no moving object found')
  const from = movedEvents[0]
  const to = movedEvents[1]
  const mid = (from.timestamp + to.timestamp) / 2
  const obj = chid.parser.getObjectsAtTime(mid, false).find(o => o.id === movedId)
  assert(obj, 'moving object missing from exact lookup')
  approx(obj.x, from.x, 1e-9, 'x')
  approx(obj.y, from.y, 1e-9, 'y')
  approx(obj.z, from.z, 1e-9, 'z')
})

check('ChID smooth mode interpolates between metadata events', () => {
  assert(movedId !== -1, 'no moving object found')
  const from = movedEvents[0]
  const to = movedEvents[1]
  const mid = (from.timestamp + to.timestamp) / 2
  const obj = chid.parser.getObjectsAtTime(mid, true).find(o => o.id === movedId)
  assert(obj, 'moving object missing from smooth lookup')
  const expected = from.x + (to.x - from.x) / 2
  approx(obj.x, expected, 1e-9, 'interpolated x')
  assert(
    (obj.x >= Math.min(from.x, to.x) - 1e-9 && obj.x <= Math.max(from.x, to.x) + 1e-9),
    'interpolated x is outside the event bracket'
  )
})

check('ChID smooth mode produces per-frame motion', () => {
  const start = chidFirst + 1
  const exact = statesAt(chid.parser, start, 1, false)
  const smooth = statesAt(chid.parser, start, 1, true)
  assert(smooth.size > 60, `smooth produced only ${smooth.size} states`)
  assert(smooth.size > exact.size * 3,
    `smooth=${smooth.size} states, exact=${exact.size} states`)
})

check('ChID object values are finite and in range', () => {
  for (const t of [chidFirst + 0.5, chidFirst + 20, chidFirst + 60]) {
    for (const obj of chid.parser.getObjectsAtTime(t, true)) {
      for (const key of ['x', 'y', 'z', 'gain', 'size']) {
        assert(Number.isFinite(obj[key]), `${key} is not finite at t=${t}`)
      }
      assert(obj.x >= 0 && obj.x <= 1, `x out of range: ${obj.x}`)
      assert(obj.y >= 0 && obj.y <= 1, `y out of range: ${obj.y}`)
      assert(obj.z >= 0 && obj.z <= 1, `z out of range: ${obj.z}`)
      assert(obj.size >= 0.05, `size below floor: ${obj.size}`)
    }
  }
})

const avsync = parseEac3(extractEac3(fixtures.avsync))

check('AVSync is detected as Atmos', () => {
  assert(avsync.result.isAtmos, 'isAtmos is false')
  assert(avsync.result.objects.length > 0, 'no object events emitted')
})

check('AVSync static signal stays static', () => {
  const first = Math.min(...activeEvents(avsync.result).map(o => o.timestamp))
  const a = avsync.parser.getObjectsAtTime(first + 1, true)
  const b = avsync.parser.getObjectsAtTime(first + 60, true)
  const byId = new Map(b.map(o => [o.id, o]))
  for (const obj of a) {
    const other = byId.get(obj.id)
    assert(other, `object ${obj.id} disappeared`)
    approx(other.x, obj.x, 1e-9, `object ${obj.id} x`)
    approx(other.y, obj.y, 1e-9, `object ${obj.id} y`)
    approx(other.z, obj.z, 1e-9, `object ${obj.id} z`)
  }
})

check('E-AC-3 JOC MKV is detected as Atmos', () => {
  const joc = parseEac3(extractEac3(fixtures.jocMkv))
  assert(joc.result.isAtmos, 'isAtmos is false')
  assert(joc.result.objects.length > 0, 'no object events emitted')
})

check('non-JOC E-AC-3 does not report Atmos objects', () => {
  const ddp = parseEac3(extractEac3(fixtures.ddp51))
  assert(!ddp.result.isAtmos, 'isAtmos should be false')
  assert(ddp.result.objects.length === 0, 'unexpected object events')
  assert(ddp.result.duration > 0, 'duration was not accumulated')
})

console.log('DAMF fixture')

const damf = new DAMFParser()
const damfResult = damf.parse(
  fs.readFileSync(fixtures.amazeRoot, 'utf8'),
  fs.readFileSync(fixtures.amazeMeta, 'utf8')
)

check('DAMF parses the Amaze fixture', () => {
  assert(damfResult.hasDAMF, 'hasDAMF is false')
  assert(damfResult.objects.length > 0, 'no dynamic objects')
})

check('DAMF exact mode holds the latest metadata event', () => {
  const obj = damf.objects.find(o => o.positions.length > 2)
  assert(obj, 'no object with enough events')
  const from = obj.positions[5]
  const to = obj.positions[6]
  const mid = (from.time + to.time) / 2
  const exact = damf.getObjectsAtTime(mid, false).find(o => o.id === obj.id)
  assert(exact, 'object missing from exact lookup')
  approx(exact.x, from.x, 1e-9, 'x')
  approx(exact.y, from.y, 1e-9, 'y')
  approx(exact.z, from.z, 1e-9, 'z')
})

check('DAMF smooth mode interpolates between metadata events', () => {
  const obj = damf.objects.find(o => o.positions.length > 2)
  const from = obj.positions[5]
  const to = obj.positions[6]
  const mid = (from.time + to.time) / 2
  const smooth = damf.getObjectsAtTime(mid, true).find(o => o.id === obj.id)
  assert(smooth, 'object missing from smooth lookup')
  const expected = from.x + (to.x - from.x) / 2
  approx(smooth.x, expected, 1e-9, 'interpolated x')
})

check('DAMF smooth mode produces more states than exact mode', () => {
  const start = 20
  const exact = statesAt(damf, start, 1, false)
  const smooth = statesAt(damf, start, 1, true)
  assert(smooth.size > exact.size * 2,
    `smooth=${smooth.size} states, exact=${exact.size} states`)
})

check('DAMF object values are finite and in range', () => {
  for (const t of [1, 20, 40]) {
    for (const obj of damf.getObjectsAtTime(t, true)) {
      for (const key of ['x', 'y', 'z', 'gain', 'size']) {
        assert(Number.isFinite(obj[key]), `${key} is not finite at t=${t}`)
      }
      assert(obj.x >= 0 && obj.x <= 1, `x out of range: ${obj.x}`)
      assert(obj.y >= 0 && obj.y <= 1, `y out of range: ${obj.y}`)
      assert(obj.z >= 0 && obj.z <= 1, `z out of range: ${obj.z}`)
    }
  }
})

check('DAMF hides terminal parks instead of gliding to the corner', () => {
  const before = damf.getObjectsAtTime(40, true).find(o => o.name === 'Object 23')
  assert(before, 'Object 23 missing before its terminal park')
  approx(before.x, 0.8870967741935485, 1e-9, 'held x before terminal park')
  approx(before.y, 0.8387096774193549, 1e-9, 'held y before terminal park')
  assert(!damf.getObjectsAtTime(40.02, true).some(o => o.name === 'Object 23'),
    'Object 23 still visible after terminal park')

  // Objects that make real end-of-scene moves above the floor stay visible.
  assert(damf.getObjectsAtTime(61, true).some(o => o.name === 'Object 22'),
    'Object 22 was mistaken for a park')
  assert(damf.getObjectsAtTime(61, true).some(o => o.name === 'Object 24'),
    'Object 24 was mistaken for a park')
})

console.log('Inactive-object handling')

const gapDamf = new DAMFParser()
gapDamf.parse(null, `sampleRate: 48000
events:
  - ID: 10
    samplePos: 0
    active: true
    pos: [-1, 0, 0]
    gain: -20
    size: 0.5
  - ID: 10
    samplePos: 48000
    pos: [-0.9, 0, 0]
  - ID: 10
    samplePos: 96000
    active: false
  - ID: 10
    samplePos: 144000
    pos: [1, 0, 0]
  - ID: 10
    samplePos: 192000
    active: true
    pos: [0.5, 0, 0]
`)

check('DAMF carries omitted active/gain/size fields', () => {
  const before = gapDamf.getObjectsAtTime(1.5, false)[0]
  assert(before, 'object missing before deactivation')
  approx(before.x, 0.05, 1e-9, 'x')
  approx(before.gain, 0.1, 1e-9, 'gain')
  approx(before.size, 0.1, 1e-9, 'size')
})

check('DAMF hides inactive objects and does not smooth across the gap', () => {
  assert(gapDamf.getObjectsAtTime(1.99, true).length === 1, 'object vanished too early')
  assert(gapDamf.getObjectsAtTime(2, true).length === 0, 'object visible at deactivation')
  assert(gapDamf.getObjectsAtTime(2.5, true).length === 0, 'object visible while inactive')
  assert(gapDamf.getObjectsAtTime(3.5, true).length === 0, 'missing active flag reactivated object')

  const reappeared = gapDamf.getObjectsAtTime(4, true)[0]
  assert(reappeared, 'object did not reappear')
  approx(reappeared.x, 0.75, 1e-9, 'reappearance x')
})

const parkDamf = new DAMFParser()
parkDamf.parse(null, `sampleRate: 48000
events:
  - ID: 20
    samplePos: 0
    active: true
    pos: [-0.5, 0, 0]
    gain: 0
    size: 0
  - ID: 20
    samplePos: 48000
    gain: -inf
    pos: [-1, 1, 0]
  - ID: 20
    samplePos: 96000
    active: true
    pos: [0.5, 0, 0]
    gain: 0
`)

check('DAMF hides zero-gain objects at their last position', () => {
  const before = parkDamf.getObjectsAtTime(0.5, true)[0]
  assert(before, 'object missing before silence')
  approx(before.x, 0.25, 1e-9, 'held x')
  assert(parkDamf.getObjectsAtTime(1, true).length === 0, 'object visible at silence')
  assert(parkDamf.getObjectsAtTime(1.5, true).length === 0, 'object visible while silent')

  const after = parkDamf.getObjectsAtTime(2, true)[0]
  assert(after, 'object did not reappear')
  approx(after.x, 0.75, 1e-9, 'reappearance x')
})

const inactivePosDamf = new DAMFParser()
inactivePosDamf.parse(null, `sampleRate: 48000
events:
  - ID: 30
    samplePos: 0
    active: true
    pos: [-0.5, 0, 0]
    gain: 0
  - ID: 30
    samplePos: 48000
    active: false
    pos: [1, 1, 0]
  - ID: 30
    samplePos: 96000
    active: true
`)

check('DAMF ignores positions carried by inactive events', () => {
  const before = inactivePosDamf.getObjectsAtTime(0.5, true)[0]
  assert(before, 'object missing before deactivation')
  approx(before.x, 0.25, 1e-9, 'x before deactivation')
  assert(inactivePosDamf.getObjectsAtTime(1.5, true).length === 0, 'object visible while inactive')

  const reactivated = inactivePosDamf.getObjectsAtTime(2, true)[0]
  assert(reactivated, 'object did not reactivate')
  approx(reactivated.x, 0.25, 1e-9, 'reactivated at parked position')
})

const terminalParkDamf = new DAMFParser()
terminalParkDamf.parse(null, `sampleRate: 48000
events:
  - ID: 40
    samplePos: 0
    active: true
    pos: [-1, 0, 0]
    gain: 0
  - ID: 40
    samplePos: 48000
    pos: [0, 0, 0]
  - ID: 40
    samplePos: 96000
    pos: [-1, 1, 0]
  - ID: 41
    samplePos: 0
    active: true
    pos: [-1, 0, 0]
    gain: 0
  - ID: 41
    samplePos: 48000
    pos: [1, 1, 1]
`)

check('DAMF hides implicit terminal parks at the previous position', () => {
  const before = terminalParkDamf.getObjectsAtTime(1.5, true).find(o => o.name === 'Object 40')
  assert(before, 'object missing before terminal park')
  approx(before.x, 0.5, 1e-9, 'held x before terminal park')
  approx(before.y, 0.5, 1e-9, 'held y before terminal park')

  assert(!terminalParkDamf.getObjectsAtTime(2, true).some(o => o.name === 'Object 40'),
    'object visible at terminal park')

  // A large final move that stays above the floor is real motion, not a park.
  const ceiling = terminalParkDamf.getObjectsAtTime(1.5, true).find(o => o.name === 'Object 41')
  assert(ceiling, 'ceiling move was mistaken for a park')
  approx(ceiling.z, 1, 1e-9, 'ceiling z')
})

const gapEac3 = new EAC3Parser()
gapEac3.objects = [
  { id: 0, timestamp: 0, x: 0, y: 0.5, z: 0, gain: 1, size: 0.1, active: true, confidence: 'joc-native' },
  { id: 0, timestamp: 1, x: 0.1, y: 0.5, z: 0, gain: 1, size: 0.1, active: true, confidence: 'joc-native' },
  { id: 0, timestamp: 2, x: 0.1, y: 0.5, z: 0, gain: 1, size: 0.1, active: false, confidence: 'joc-native' },
  { id: 0, timestamp: 3, x: 0.9, y: 0.5, z: 0, gain: 1, size: 0.1, active: true, confidence: 'joc-native' },
  { id: 1, timestamp: 0, x: 0.2, y: 0.5, z: 0, gain: 1, size: 0.1, active: true, confidence: 'joc-native' },
  { id: 1, timestamp: 1, x: 0, y: 0, z: 0, gain: 0, size: 0.1, active: true, confidence: 'joc-native' },
  { id: 1, timestamp: 2, x: 0.9, y: 0.5, z: 0, gain: 1, size: 0.1, active: true, confidence: 'joc-native' }
]

check('E-AC-3 hides inactive objects and does not smooth across the gap', () => {
  const first = gapEac3.getObjectsAtTime(0.5, true).find(o => o.id === 0)
  approx(first.x, 0.05, 1e-9, 'first span')
  approx(gapEac3.getObjectsAtTime(1.5, true).find(o => o.id === 0).x, 0.1, 1e-9, 'held before deactivation')
  assert(!gapEac3.getObjectsAtTime(2.5, true).some(o => o.id === 0), 'object visible while inactive')
  assert(!gapEac3.getObjectsAtTime(2.99, true).some(o => o.id === 0), 'object visible just before reactivation')
  approx(gapEac3.getObjectsAtTime(3, true).find(o => o.id === 0).x, 0.9, 1e-9, 'reappearance x')
})

check('E-AC-3 hides zero-gain objects at their last position', () => {
  const before = gapEac3.getObjectsAtTime(0.5, true).find(o => o.id === 1)
  assert(before, 'object missing before silence')
  approx(before.x, 0.2, 1e-9, 'held x')
  assert(!gapEac3.getObjectsAtTime(1.5, true).some(o => o.id === 1), 'object visible while silent')

  const after = gapEac3.getObjectsAtTime(2, true).find(o => o.id === 1)
  assert(after, 'object did not reappear')
  approx(after.x, 0.9, 1e-9, 'reappearance x')
})

const gapAdm = new ADMParser()
gapAdm.objects = [{
  id: 0,
  name: 'Object 0',
  positions: [
    { time: 0, duration: 0.5, x: 0.2, y: 0.5, z: 0, size: 0.05, gain: 1, confidence: 'adm' },
    { time: 1, duration: 0.5, x: 0.2, y: 0.5, z: 0, size: 0.05, gain: 0, confidence: 'adm' },
    { time: 2, duration: 0.5, x: 0.9, y: 0.5, z: 0, size: 0.05, gain: 1, confidence: 'adm' }
  ]
}]

check('ADM hides silent objects and does not smooth across the gap', () => {
  const before = gapAdm.getObjectsAtTime(0.5, true)[0]
  assert(before, 'object missing before silence')
  approx(before.x, 0.2, 1e-9, 'held x before silence')
  assert(gapAdm.getObjectsAtTime(1.5, true).length === 0, 'object visible while silent')
  approx(gapAdm.getObjectsAtTime(2, true)[0].x, 0.9, 1e-9, 'reappearance x')
  assert(gapAdm.getObjectsAtTime(1.5, false).length === 0, 'exact mode shows silent object')
})

fs.rmSync(tempDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
