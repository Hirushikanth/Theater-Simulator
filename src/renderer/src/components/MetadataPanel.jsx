import React from 'react'
import { objectColor } from '../utils/constants'

export default function MetadataPanel({ objects, metadataSource }) {
  if (!metadataSource) {
    return (
      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-header">
          <span className="panel-title">Object Metadata</span>
        </div>
        <div className="panel-body">
          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', textAlign: 'center', padding: '20px 0' }}>
            No spatial metadata detected.
            <br /><br />
            Load a Dolby Atmos file to see real-time object positions.
          </p>
        </div>
      </div>
    )
  }

  const sortedObjects = [...objects]
    .sort((a, b) => (b.gain || 1) - (a.gain || 1))
    .slice(0, 8)

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-header">
        <span className="panel-title">Object Metadata</span>
        <span className="panel-badge badge-atmos">
          {metadataSource === 'joc' ? 'JOC' : 
           metadataSource === 'joc-encrypted' ? 'JOC ⚠' : 
           metadataSource === 'mat-encrypted' ? 'MAT ⚠' : 
           metadataSource === 'adm' ? 'ADM' : 'DAMF'}
        </span>
      </div>
      <div className="panel-body">
        {metadataSource?.includes('encrypted') ? (
          <p style={{ fontSize: '11px', color: 'var(--color-orange)', textAlign: 'center', padding: '20px 10px', lineHeight: 1.4 }}>
            Object metadata could not be parsed from this stream.
            <br /><br />
            Playing decoded bed audio. The native OAMD parser may need updates for this encoder variant.
          </p>
        ) : sortedObjects.length === 0 ? (
          <p style={{ fontSize: '10px', color: 'var(--text-tertiary)', textAlign: 'center' }}>
            Waiting for object data...
          </p>
        ) : (
          <div className="metadata-list">
            {sortedObjects.map((obj, i) => {
              const color = objectColor(obj.z || 0)
              const isActive = (obj.gain || 0) > 0.3
              return (
                <div key={obj.id ?? i} className={`metadata-object ${isActive ? 'active' : ''}`}>
                  <div className="metadata-object-id" style={{ backgroundColor: color }}>
                    {obj.id ?? i}
                  </div>
                  <div className="metadata-coord">
                    <span style={{ color }}>X</span> {(obj.x ?? 0).toFixed(2)}
                  </div>
                  <div className="metadata-coord">
                    <span style={{ color }}>Y</span> {(obj.y ?? 0).toFixed(2)}
                  </div>
                  <div className="metadata-coord">
                    <span style={{ color }}>Z</span> {(obj.z ?? 0).toFixed(2)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
