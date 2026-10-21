/**
 * Speaker layout registry.
 *
 * Every layout is data-driven: the renderer, 3D scene, VBAP triangulation and
 * meters all read from the selected layout instead of a hardcoded 7.1.4 array.
 *
 * Coordinates are spherical (azimuth/elevation in degrees) and converted to
 * room positions by `speakerToCartesian`. Subwoofers use explicit positions
 * because they are not part of the panning sphere.
 */

import { ROOM } from './constants'

export const DEFAULT_LAYOUT_ID = '7.1.4'

const COLORS = {
  front: '#00ffd5',
  center: '#ffffff',
  surround: '#4488ff',
  rear: '#6366f1',
  wide: '#22d3ee',
  heightFront: '#a855f7',
  heightRear: '#c084fc',
  lfe: '#ff1744'
}

const SPEAKER_DEFS = {
  FL:  { name: 'Front Left',       azimuth: -30,  elevation: 0,  group: 'front',   color: COLORS.front },
  FR:  { name: 'Front Right',      azimuth:  30,  elevation: 0,  group: 'front',   color: COLORS.front },
  C:   { name: 'Center',           azimuth:   0,  elevation: 0,  group: 'center',  color: COLORS.center },
  SL:  { name: 'Surround Left',    azimuth: -90,  elevation: 0,  group: 'surround', color: COLORS.surround },
  SR:  { name: 'Surround Right',   azimuth:  90,  elevation: 0,  group: 'surround', color: COLORS.surround },
  SBL: { name: 'Rear Left',        azimuth:-135,  elevation: 0,  group: 'rear',    color: COLORS.rear },
  SBR: { name: 'Rear Right',       azimuth: 135,  elevation: 0,  group: 'rear',    color: COLORS.rear },
  FWL: { name: 'Front Wide Left',  azimuth: -60,  elevation: 0,  group: 'wide',    color: COLORS.wide },
  FWR: { name: 'Front Wide Right', azimuth:  60,  elevation: 0,  group: 'wide',    color: COLORS.wide },
  TFL: { name: 'Top Front Left',   azimuth: -45,  elevation: 45, group: 'height',  color: COLORS.heightFront },
  TFR: { name: 'Top Front Right',  azimuth:  45,  elevation: 45, group: 'height',  color: COLORS.heightFront },
  TML: { name: 'Top Middle Left',  azimuth: -90,  elevation: 60, group: 'height',  color: COLORS.heightFront },
  TMR: { name: 'Top Middle Right', azimuth:  90,  elevation: 60, group: 'height',  color: COLORS.heightFront },
  TRL: { name: 'Top Rear Left',    azimuth:-135,  elevation: 45, group: 'height',  color: COLORS.heightRear },
  TRR: { name: 'Top Rear Right',   azimuth: 135,  elevation: 45, group: 'height',  color: COLORS.heightRear }
}

// Meters are ordered to keep the existing 7.1.4 panel familiar:
// FL, C, LFE, FR, surrounds, rears, then heights.
const METER_ORDER = [
  'FL', 'C', 'LFE', 'LFE1', 'LFE2', 'FR',
  'SL', 'SR', 'SBL', 'SBR', 'FWL', 'FWR',
  'TFL', 'TFR', 'TML', 'TMR', 'TRL', 'TRR'
]

function makeSpeaker (id) {
  const def = SPEAKER_DEFS[id]
  if (!def) throw new Error(`Unknown speaker: ${id}`)
  return {
    id,
    role: id,
    label: id,
    ...def
  }
}

function makeSubwoofers (count) {
  const frontGround = { x: 0, y: -1, z: -ROOM.depth / 2 + 0.5 }

  if (count === 1) {
    return [{
      id: 'LFE',
      role: 'LFE',
      label: 'LFE',
      name: 'Subwoofer',
      group: 'lfe',
      color: COLORS.lfe,
      position: frontGround
    }]
  }

  return [
    {
      id: 'LFE1',
      role: 'LFE',
      label: 'SUB1',
      name: 'Subwoofer 1',
      group: 'lfe',
      color: COLORS.lfe,
      position: { x: -ROOM.width * 0.3, y: -1, z: -ROOM.depth * 0.42 }
    },
    {
      id: 'LFE2',
      role: 'LFE',
      label: 'SUB2',
      name: 'Subwoofer 2',
      group: 'lfe',
      color: COLORS.lfe,
      position: { x: ROOM.width * 0.3, y: -1, z: ROOM.depth * 0.42 }
    }
  ]
}

function makeLayout (id, bedIds, heightIds = [], subCount = 1) {
  const speakers = [
    ...bedIds.map(makeSpeaker),
    ...heightIds.map(makeSpeaker),
    ...makeSubwoofers(subCount)
  ]

  const speakerById = new Map(speakers.map(speaker => [speaker.id, speaker]))
  const meterOrder = METER_ORDER.filter(speakerId => speakerById.has(speakerId))

  return {
    id,
    label: id,
    speakers,
    speakerById,
    meterOrder,
    subwooferCount: subCount
  }
}

const BED_51 = ['FL', 'FR', 'C', 'SL', 'SR']
const BED_71 = [...BED_51, 'SBL', 'SBR']
const BED_91 = [...BED_71, 'FWL', 'FWR']

const HEIGHTS_2 = ['TFL', 'TFR']
const HEIGHTS_4 = ['TFL', 'TFR', 'TRL', 'TRR']
const HEIGHTS_6 = ['TFL', 'TFR', 'TML', 'TMR', 'TRL', 'TRR']

export const LAYOUTS = {
  '5.1': makeLayout('5.1', BED_51),
  '5.1.2': makeLayout('5.1.2', BED_51, HEIGHTS_2),
  '5.1.4': makeLayout('5.1.4', BED_51, HEIGHTS_4),
  '5.2.2': makeLayout('5.2.2', BED_51, HEIGHTS_2, 2),
  '5.2.4': makeLayout('5.2.4', BED_51, HEIGHTS_4, 2),

  '7.1': makeLayout('7.1', BED_71),
  '7.1.2': makeLayout('7.1.2', BED_71, HEIGHTS_2),
  '7.1.4': makeLayout('7.1.4', BED_71, HEIGHTS_4),
  '7.1.6': makeLayout('7.1.6', BED_71, HEIGHTS_6),
  '7.2.2': makeLayout('7.2.2', BED_71, HEIGHTS_2, 2),
  '7.2.4': makeLayout('7.2.4', BED_71, HEIGHTS_4, 2),
  '7.2.6': makeLayout('7.2.6', BED_71, HEIGHTS_6, 2),

  '9.1.6': makeLayout('9.1.6', BED_91, HEIGHTS_6),
  '9.2.6': makeLayout('9.2.6', BED_91, HEIGHTS_6, 2)
}

export const LAYOUT_GROUPS = [
  { label: '5.x', ids: ['5.1', '5.1.2', '5.1.4'] },
  { label: '5.x Dual Sub', ids: ['5.2.2', '5.2.4'] },
  { label: '7.x', ids: ['7.1', '7.1.2', '7.1.4', '7.1.6'] },
  { label: '7.x Dual Sub', ids: ['7.2.2', '7.2.4', '7.2.6'] },
  { label: '9.x', ids: ['9.1.6'] },
  { label: '9.x Dual Sub', ids: ['9.2.6'] }
]

export const DEFAULT_LAYOUT = LAYOUTS[DEFAULT_LAYOUT_ID]

export function getLayout (layoutId) {
  return LAYOUTS[layoutId] || DEFAULT_LAYOUT
}

export function isLayoutId (layoutId) {
  return Object.prototype.hasOwnProperty.call(LAYOUTS, layoutId)
}
