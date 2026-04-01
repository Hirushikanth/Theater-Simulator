import React, { useEffect, useRef } from 'react'
import { SPEAKERS } from '../utils/constants'
import { dbToPercent } from '../utils/helpers'

const METER_LAYOUT = [
  { id: 'FL',  label: 'FL' },
  { id: 'C',   label: 'C' },
  { id: 'LFE', label: 'LFE' },
  { id: 'FR',  label: 'FR' },
  { id: 'SL',  label: 'SL' },
  { id: 'SR',  label: 'SR' },
  { id: 'SBL', label: 'SBL' },
  { id: 'SBR', label: 'SBR' },
  { id: 'TFL', label: 'TFL' },
  { id: 'TFR', label: 'TFR' },
  { id: 'TRL', label: 'TRL' },
  { id: 'TRR', label: 'TRR' }
]

export default function ChannelMeters({ vuMeterEngine, isPlaying }) {
  const barsRef = useRef(new Map())
  const peaksRef = useRef(new Map())
  const labelsRef = useRef(new Map())
  const rafRef = useRef()

  // High-performance direct DOM mutation loop
  useEffect(() => {
    if (!isPlaying) {
      // Reset meters when stopped
      METER_LAYOUT.forEach(({ id }) => {
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

      METER_LAYOUT.forEach(({ id }) => {
        const db = levels.get(id) ?? -100
        const percent = dbToPercent(db, -60, 0)
        
        const bar = barsRef.current.get(id)
        const peak = peaksRef.current.get(id)
        const label = labelsRef.current.get(id)
        const speaker = SPEAKERS.find(s => s.id === id)

        if (bar) {
          bar.style.height = `${percent}%`
          bar.style.boxShadow = percent > 50 ? `0 0 8px ${speaker.color}44` : 'none'
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
  }, [isPlaying, vuMeterEngine])

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Spatial Energy Monitor</span>
        <span className="panel-badge badge-codec">7.1.4</span>
      </div>
      <div className="meters-container">
        <div className="meters-grid">
          {METER_LAYOUT.map((meter) => {
            const speaker = SPEAKERS.find(s => s.id === meter.id)
            return (
              <div key={meter.id} className="meter">
                <div className="meter-bar-container">
                  <div
                    ref={el => barsRef.current.set(meter.id, el)}
                    className="meter-bar"
                    style={{ 
                      background: `linear-gradient(to top, ${speaker?.color}33, ${speaker?.color})`, 
                      height: '0%' 
                    }}
                  />
                  <div
                    ref={el => peaksRef.current.set(meter.id, el)}
                    className="meter-peak"
                    style={{ backgroundColor: speaker?.color, opacity: 0 }}
                  />
                </div>
                <span className="meter-label">{meter.label}</span>
                <span ref={el => labelsRef.current.set(meter.id, el)} className="meter-db">—</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
