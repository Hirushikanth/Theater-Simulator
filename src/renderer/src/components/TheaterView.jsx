import React, { useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { TheaterScene } from '../three/TheaterScene'

/**
 * TheaterView — Three.js canvas container.
 *
 * Scene updates are driven DIRECTLY by App.jsx via the forwarded ref:
 *   theaterViewRef.current.updateObjects(objs)        — called every rAF, no React state
 *   theaterViewRef.current.updateSpeakerGains(gains)  — called every rAF, no React state
 *
 * This bypasses the React state → re-render → useEffect pipeline entirely,
 * eliminating the ~16 ms scheduling latency that caused visual stutter.
 */
const TheaterView = forwardRef(function TheaterView (
  { objects, speakerGains, vuMeterEngine, metadataSource, isPlaying, hasFile, onOpenFile },
  ref
) {
  const containerRef = useRef(null)
  const sceneRef     = useRef(null)
  const rafRef       = useRef(null)

  // ── Expose direct imperative methods to App.jsx ───────────────────────────
  // Called inside the 60fps rAF loop — no React state, no re-render, no lag.
  useImperativeHandle(ref, () => ({
    updateObjects (objects) {
      if (!sceneRef.current) return
      sceneRef.current.updateObjects(objects)
    },
    updateSpeakerGains (gains) {
      if (!sceneRef.current) return
      sceneRef.current.updateSpeakerGains(gains)
    }
  }), [])

  // ── Initialize Three.js scene ─────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    sceneRef.current = new TheaterScene(containerRef.current)
    return () => {
      if (sceneRef.current) {
        sceneRef.current.destroy()
        sceneRef.current = null
      }
    }
  }, [])

  // ── Audio-level speaker glow (only when no VBAP spatial data is active) ──
  // When metadata IS active, App.jsx drives speaker glow via the ref above.
  // When no metadata, this loop reads raw audio levels from vuMeterEngine.
  useEffect(() => {
    if (!sceneRef.current) return

    // Kill any previous loop first to prevent accumulation
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    // Run audio-level loop only when playing and no VBAP gains are present
    if (isPlaying && speakerGains.size === 0) {
      const updateLevels = () => {
        if (!sceneRef.current) return
        const levels = vuMeterEngine.getLevels()
        if (levels.size > 0) sceneRef.current.updateSpeakerLevels(levels)
        rafRef.current = requestAnimationFrame(updateLevels)
      }
      rafRef.current = requestAnimationFrame(updateLevels)
    }

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [isPlaying, speakerGains, vuMeterEngine])

  const activeCount = objects.length

  return (
    <div className="theater-view">
      <div ref={containerRef} className="theater-canvas" />

      {/* HUD Overlay */}
      <div className="theater-overlay">
        <div className={`theater-hud ${isPlaying ? 'theater-hud-active' : ''}`}>
          {isPlaying ? '● LIVE' : '○ IDLE'} &nbsp;|&nbsp; 7.1.4 Layout
        </div>
        {metadataSource && metadataSource !== 'synthetic' && (
          <div className="theater-hud theater-hud-active">
            {metadataSource === 'joc' ? 'E-AC-3 JOC' :
             metadataSource === 'adm' ? 'ADM BWF' :
             metadataSource === 'damf' ? 'DAMF' : 'Unknown'} Metadata
            &nbsp;|&nbsp; {activeCount} Object{activeCount !== 1 ? 's' : ''}
          </div>
        )}
        {metadataSource === 'synthetic' && (
          <div className="theater-hud" style={{ color: 'var(--color-orange)', borderColor: 'rgba(255, 140, 0, 0.3)' }}>
            SYNTHETIC UPMIX ENGINE ACTIVE
            &nbsp;|&nbsp; {activeCount} Object{activeCount !== 1 ? 's' : ''}
          </div>
        )}
        {metadataSource === 'joc' && (
          <div className="theater-hud" style={{ color: 'var(--color-orange)' }}>
            ⚡ Best-Effort Extraction
          </div>
        )}
      </div>

      {/* Drop zone when no file loaded */}
      {!hasFile && (
        <div className="drop-zone" id="drop-zone">
          <div className="drop-zone-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
          <div className="drop-zone-title">Drop Audio File Here</div>
          <div className="drop-zone-subtitle">
            Load Dolby Atmos content — EAC3, AC3, TrueHD, ADM BWF, or any supported container
          </div>
          <div className="drop-zone-formats">
            {['MKV', 'MP4', 'M4A', 'EAC3', 'AC3', 'WAV', 'MOV', 'WEBM', 'LAF'].map(fmt => (
              <span key={fmt} className="format-tag">{fmt}</span>
            ))}
          </div>
          <button className="btn btn-primary" onClick={onOpenFile} style={{ marginTop: '12px' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
            </svg>
            Browse Files
          </button>
        </div>
      )}
    </div>
  )
})

export default TheaterView
