import React, { useMemo } from 'react'
import { SPEAKERS } from '../utils/constants'
import { dbToPercent } from '../utils/helpers'

const METER_LAYOUT = [
  { id: 'FL',  label: 'FL' },
  { id: 'C',   label: 'C' },
  { id: 'FR',  label: 'FR' },
  { id: 'SL',  label: 'SL' },
  { id: 'SR',  label: 'SR' },
  { id: 'SBL', label: 'SBL' },
  { id: 'SBR', label: 'SBR' },
  { id: 'LFE', label: 'LFE' },
  { id: 'TFL', label: 'TFL' },
  { id: 'TFR', label: 'TFR' },
  { id: 'TRL', label: 'TRL' },
  { id: 'TRR', label: 'TRR' }
]

export default function ChannelMeters({ channelLevels, isPlaying }) {
  const meters = useMemo(() => {
    return METER_LAYOUT.map(({ id, label }) => {
      const speaker = SPEAKERS.find(s => s.id === id)
      const db = channelLevels.get(id) ?? -100
      const percent = dbToPercent(db, -60, 0)

      return {
        id,
        label,
        color: speaker?.color || '#666',
        group: speaker?.group || 'unknown',
        percent: isPlaying ? percent : 0,
        db: isPlaying ? Math.max(-60, db) : -Infinity
      }
    })
  }, [channelLevels, isPlaying])

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Spatial Energy Monitor</span>
        <span className="panel-badge badge-codec">7.1.4</span>
      </div>
      <div className="meters-container">
        <div className="meters-grid">
          {meters.map((meter) => (
            <div key={meter.id} className="meter">
              <div className="meter-bar-container">
                <div
                  className="meter-bar"
                  style={{
                    height: `${meter.percent}%`,
                    background: `linear-gradient(to top, ${meter.color}33, ${meter.color})`,
                    boxShadow: meter.percent > 50 ? `0 0 8px ${meter.color}44` : 'none'
                  }}
                />
                <div
                  className="meter-peak"
                  style={{
                    bottom: `${Math.min(100, meter.percent + 2)}%`,
                    backgroundColor: meter.color,
                    opacity: meter.percent > 5 ? 0.8 : 0
                  }}
                />
              </div>
              <span className="meter-label" style={{ color: meter.percent > 10 ? meter.color : undefined }}>
                {meter.label}
              </span>
              <span className="meter-db">
                {meter.db > -60 ? `${Math.round(meter.db)}` : '—'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
