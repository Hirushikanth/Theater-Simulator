import React, { useEffect, useRef, useState } from 'react'
import { LAYOUTS, LAYOUT_GROUPS } from '../utils/layouts'

function GearIcon () {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function CloseIcon () {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function ToggleRow ({ title, description, checked, onChange }) {
  return (
    <label className="settings-toggle-row">
      <span className="settings-toggle-copy">
        <span className="settings-toggle-title">{title}</span>
        <span className="settings-toggle-description">{description}</span>
      </span>
      <span className="toggle-switch">
        <input
          className="toggle-input"
          type="checkbox"
          checked={checked}
          onChange={onChange}
        />
        <span className="toggle-track" aria-hidden="true">
          <span className="toggle-thumb" />
        </span>
      </span>
    </label>
  )
}

export default function SettingsMenu ({
  layoutId,
  onLayoutChange,
  enableSyntheticUpmix,
  onToggleSynthetic,
  useProfessionalDecoder,
  onToggleProfessional
}) {
  const [isOpen, setIsOpen] = useState(false)
  const wrapperRef = useRef(null)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)

  const layout = LAYOUTS[layoutId] || LAYOUTS['7.1.4']
  const subwooferLabel = layout.subwooferCount === 1 ? 'subwoofer' : 'subwoofers'

  useEffect(() => {
    if (!isOpen) return

    const handlePointerDown = (event) => {
      if (!wrapperRef.current?.contains(event.target)) {
        setIsOpen(false)
      }
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsOpen(false)
        triggerRef.current?.focus()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    panelRef.current?.focus()

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  const closeSettings = () => {
    setIsOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div className="settings-wrapper" ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`settings-trigger${isOpen ? ' is-open' : ''}`}
        onClick={() => setIsOpen(open => !open)}
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls="app-settings-panel"
        title="Settings"
      >
        <GearIcon />
      </button>

      {isOpen && (
        <div
          id="app-settings-panel"
          ref={panelRef}
          className="settings-panel"
          role="dialog"
          aria-label="Settings"
          tabIndex={-1}
        >
          <div className="settings-panel-header">
            <span className="settings-panel-title">Settings</span>
            <button
              type="button"
              className="settings-close"
              onClick={closeSettings}
              aria-label="Close settings"
            >
              <CloseIcon />
            </button>
          </div>

          <section className="settings-section">
            <div className="settings-section-label">Output</div>

            <label className="settings-field-label" htmlFor="settings-layout">
              Speaker Layout
            </label>
            <select
              id="settings-layout"
              className="settings-select"
              value={layoutId}
              onChange={onLayoutChange}
            >
              {LAYOUT_GROUPS.map(group => (
                <optgroup key={group.label} label={group.label}>
                  {group.ids.map(id => (
                    <option key={id} value={id}>{LAYOUTS[id].label}</option>
                  ))}
                </optgroup>
              ))}
            </select>

            <div className="settings-layout-summary">
              {layout.speakers.length} speakers · {layout.subwooferCount} {subwooferLabel}
            </div>
            <p className="settings-hint">
              Room, panning, and meters update instantly.
            </p>
          </section>

          <section className="settings-section">
            <div className="settings-section-label">Decoding</div>

            <ToggleRow
              title="Professional Decoder"
              description="truehdd metadata decoding"
              checked={useProfessionalDecoder}
              onChange={onToggleProfessional}
            />
            <ToggleRow
              title="Synthetic Upmix"
              description="Fallback when metadata is unavailable"
              checked={enableSyntheticUpmix}
              onChange={onToggleSynthetic}
            />
          </section>
        </div>
      )}
    </div>
  )
}
