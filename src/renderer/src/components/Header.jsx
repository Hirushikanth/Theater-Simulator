import React from 'react'
import { LAYOUTS, LAYOUT_GROUPS } from '../utils/layouts'

export default function Header({ 
  onOpenFile, fileName, isLoading, 
  enableSyntheticUpmix, onToggleSynthetic,
  useProfessionalDecoder, onToggleProfessional,
  layoutId, onLayoutChange
}) {
  return (
    <div className="titlebar">
      <div className="titlebar-brand">
        <div className="titlebar-logo">D</div>
        <div>
          <div className="titlebar-title">ATMOS THEATER VISUALIZER</div>
          <div className="titlebar-subtitle">Spatial Audio Diagnostic Engine</div>
        </div>
      </div>

      <div className="titlebar-actions">
        <label className="layout-picker">
          <span>Speaker Layout</span>
          <select
            className="layout-select"
            value={layoutId}
            onChange={onLayoutChange}
            aria-label="Speaker layout"
          >
            {LAYOUT_GROUPS.map(group => (
              <optgroup key={group.label} label={group.label}>
                {group.ids.map(id => (
                  <option key={id} value={id}>{LAYOUTS[id].label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginRight: '16px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input 
            type="checkbox" 
            checked={useProfessionalDecoder} 
            onChange={onToggleProfessional} 
            style={{ accentColor: '#ff6b00', cursor: 'pointer' }}
          />
          Professional Decoder (truehdd)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginRight: '16px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input 
            type="checkbox" 
            checked={enableSyntheticUpmix} 
            onChange={onToggleSynthetic} 
            style={{ accentColor: 'var(--color-cyan)', cursor: 'pointer' }}
          />
          Synthetic Upmix (Fallback)
        </label>
        {isLoading && (
          <div className="loading-indicator">
            <div className="loading-spinner"></div>
            <span>Decoding...</span>
          </div>
        )}
        {fileName && !isLoading && (
          <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
            {fileName}
          </span>
        )}
        <button className="btn btn-primary" onClick={onOpenFile}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
          Open File
        </button>
      </div>
    </div>
  )
}
