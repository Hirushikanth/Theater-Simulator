import React from 'react'
import { formatCodecName, formatBitrate } from '../utils/helpers'

export default function FileInfo({ fileInfo, metadataSource, error }) {
  if (error) {
    return (
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">Stream Info</span>
          <span className="panel-badge badge-warning">ERROR</span>
        </div>
        <div className="panel-body">
          <p style={{ fontSize: '11px', color: 'var(--color-red)', lineHeight: 1.4 }}>{error}</p>
        </div>
      </div>
    )
  }

  if (!fileInfo) {
    return (
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">Stream Info</span>
        </div>
        <div className="panel-body">
          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', textAlign: 'center', padding: '12px 0' }}>
            No file loaded
          </p>
        </div>
      </div>
    )
  }

  const isAtmos = fileInfo.isAtmos || (metadataSource && metadataSource !== 'synthetic')
  const codecDisplay = formatCodecName(fileInfo.codec)

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Stream Info</span>
        {isAtmos && <span className="panel-badge badge-atmos">ATMOS</span>}
        {metadataSource === 'synthetic' && <span className="panel-badge badge-synthetic">SYNTHETIC</span>}
      </div>
      <div className="panel-body">
        <div className="file-info-grid">
          <span className="file-info-label">Codec</span>
          <span className="file-info-value">{codecDisplay}</span>

          <span className="file-info-label">Channels</span>
          <span className="file-info-value">
            {fileInfo.channels}ch {fileInfo.channelLayout ? `(${fileInfo.channelLayout})` : ''}
          </span>

          <span className="file-info-label">Sample Rate</span>
          <span className="file-info-value">{(fileInfo.sampleRate / 1000).toFixed(1)} kHz</span>

          <span className="file-info-label">Bitrate</span>
          <span className="file-info-value">{formatBitrate(fileInfo.bitRate)}</span>

          <span className="file-info-label">Container</span>
          <span className="file-info-value">{fileInfo.format?.toUpperCase() || 'N/A'}</span>

          {fileInfo.profile && (
            <>
              <span className="file-info-label">Profile</span>
              <span className="file-info-value">{fileInfo.profile}</span>
            </>
          )}

          <span className="file-info-label">Duration</span>
          <span className="file-info-value">
            {fileInfo.duration ? `${Math.floor(fileInfo.duration / 60)}:${String(Math.floor(fileInfo.duration % 60)).padStart(2, '0')}` : 'N/A'}
          </span>

          {metadataSource && (
            <>
              <span className="file-info-label">Metadata</span>
              <span className="file-info-value" style={{ color: metadataSource === 'synthetic' || metadataSource.includes('encrypted') ? 'var(--color-orange)' : 'var(--color-cyan)' }}>
                {metadataSource === 'joc' ? 'JOC OAMD' :
                 metadataSource === 'joc-encrypted' ? 'E-AC-3 (Objects Encrypted)' :
                 metadataSource === 'mat-encrypted' ? 'TrueHD MAT (Objects Encrypted)' :
                 metadataSource === 'adm' ? 'ADM XML' :
                 metadataSource === 'damf' ? 'DAMF YAML' : 
                 metadataSource === 'synthetic' ? 'SYNTHETIC UPMIX' : 'Unknown'}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
