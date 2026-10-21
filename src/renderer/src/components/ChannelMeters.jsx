import React, { useEffect, useRef } from 'react'
import { DEFAULT_LAYOUT } from '../utils/layouts'
import { dbToPercent } from '../utils/helpers'

const DEFAULT_COLOR = '#00ffd5'

export default function ChannelMeters({ vuMeterEngine, isPlaying, layout = DEFAULT_LAYOUT }) {
  const barsRef = useRef(new Map())
  const peaksRef = useRef(new Map())
  const labelsRef = useRef(new Map())
  const rafRef = useRef()

  const speakers = layout.meterOrder
    .map(id => layout.speakerById.get(id))
    .filter(Boolean)

  const columns = speakers.length <= 12
    ? Math.max(1, speakers.length)
    : Math.ceil(speakers.length / 2)
  const barHeight = speakers.length > 12 ? 92 : 120

  // High-performance direct DOM mutation loop
  useEffect(() => {
    if (!isPlaying) {
      // Reset meters when stopped
      speakers.forEach(({ id }) => {
        const bar = barsRef.current.get(id)
        const peak = peaksRef.current.get(id)
        const label = labelsRef.current.get(id)
        if (bar) bar.style.height = '0%'
        if (peak) {
          peak.style.bottom = '0%'
          peak.style.opacity = '0'
        }
        if (label) label.textContent = '—'
      })
      return
    }

    const updateMeters = () => {
      const levels = vuMeterEngine.getLevels()

      speakers.forEach(({ id, color }) => {
        const db = levels.get(id) ?? -100
        const percent = dbToPercent(db, -60, 0)

        const bar = barsRef.current.get(id)
        const peak = peaksRef.current.get(id)
        const label = labelsRef.current.get(id)
        const speakerColor = color || DEFAULT_COLOR

        if (bar) {
          bar.style.height = `${percent}%`
          bar.style.boxShadow = percent > 50 ? `0 0 8px ${speakerColor}44` : 'none'
        }
        if (peak) {
          peak.style.bottom = `${Math.min(100, percent + 2)}%`
          peak.style.opacity = percent > 5 ? '0.8' : '0'
        }
        if (label) {
          if (db > -60) {
            label.textContent = `${Math.round(db)}dB`
          } else {
            label.textContent = '—'
          }
        }
      })
      rafRef.current = requestAnimationFrame(updateMeters)
    }

    rafRef.current = requestAnimationFrame(updateMeters)

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [isPlaying, vuMeterEngine, layout])

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Spatial Energy Monitor</span>
        <span className="panel-badge badge-codec">{layout.label}</span>
      </div>
      <div className="meters-container">
        <div
          className="meters-grid"
          style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
        >
          {speakers.map((speaker) => (
            <div key={speaker.id} className="meter" title={speaker.name}>
              <div className="meter-bar-container" style={{ height: `${barHeight}px` }}>
                <div
                  ref={el => {
                    if (el) barsRef.current.set(speaker.id, el)
                    else barsRef.current.delete(speaker.id)
                  }}
                  className="meter-bar"
                  style={{
                    background: `linear-gradient(to top, ${speaker.color}33, ${speaker.color})`,
                    height: '0%'
                  }}
                />
                <div
                  ref={el => {
                    if (el) peaksRef.current.set(speaker.id, el)
                    else peaksRef.current.delete(speaker.id)
                  }}
                  className="meter-peak"
                  style={{ backgroundColor: speaker.color, opacity: 0 }}
                />
              </div>
              <span className="meter-label">{speaker.label}</span>
              <span
                ref={el => {
                  if (el) labelsRef.current.set(speaker.id, el)
                  else labelsRef.current.delete(speaker.id)
                }}
                className="meter-db"
              >
                —
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
