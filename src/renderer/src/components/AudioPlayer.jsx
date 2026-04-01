import React, { useCallback } from 'react'
import { formatTime, formatCodecName } from '../utils/helpers'

export default function AudioPlayer({
  isPlaying, currentTime, duration, volume, fileInfo,
  metadataSource, objectCount, onPlay, onStop, onSeek, onVolumeChange
}) {
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  const handleProgressClick = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    onSeek(ratio * duration)
  }, [duration, onSeek])

  const handleVolumeInput = useCallback((e) => {
    onVolumeChange(parseFloat(e.target.value))
  }, [onVolumeChange])

  return (
    <div className="player-bar">
      {/* Transport controls */}
      <div className="player-controls">
        <button className="player-btn" onClick={onStop} title="Stop">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="1" />
          </svg>
        </button>
        <button className="player-btn player-btn-play" onClick={onPlay} title={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6,4 20,12 6,20" />
            </svg>
          )}
        </button>
      </div>

      {/* Timeline */}
      <div className="player-timeline">
        <div className="player-progress-track" onClick={handleProgressClick}>
          <div className="player-progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="player-time-row">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Info & Volume */}
      <div className="player-info">
        <div className="player-format">
          {fileInfo && (
            <span className="panel-badge badge-codec" style={{ fontSize: '8px' }}>
              {fileInfo.codec?.toUpperCase()}
            </span>
          )}
          {metadataSource && (
            <span className="panel-badge badge-atmos" style={{ fontSize: '8px' }}>
              ATMOS
            </span>
          )}
          {objectCount > 0 && (
            <span style={{ fontSize: '10px', color: 'var(--color-cyan)', fontFamily: 'var(--font-mono)' }}>
              {objectCount} obj
            </span>
          )}
        </div>
        <div className="player-volume">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2">
            <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" fill="var(--text-tertiary)" />
            {volume > 0.5 && <path d="M19.07 4.93a10 10 0 010 14.14" />}
            {volume > 0.2 && <path d="M15.54 8.46a5 5 0 010 7.07" />}
          </svg>
          <input
            type="range"
            className="volume-slider"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={handleVolumeInput}
          />
        </div>
      </div>
    </div>
  )
}
