import React from 'react';
import { formatCodecName } from '../utils/helpers';

export default function StreamSelector({ streams, onSelect, onCancel }) {
  if (!streams || streams.length === 0) return null;

  return (
    <div className="stream-selector-overlay animate-fade-in">
      <div className="stream-selector-card animate-slide-up">
        <div className="stream-selector-header">
          <div className="stream-selector-title">Select Audio Stream</div>
          <div className="stream-selector-subtitle">
            This container contains multiple audio tracks. Please choose one to proceed.
          </div>
        </div>
        
        <div className="stream-list">
          {streams.map((stream) => (
            <button 
              key={stream.index} 
              className={`stream-item ${stream.isTrueHD ? 'stream-item-pro' : ''}`}
              onClick={() => onSelect(stream)}
            >
              <div className="stream-item-main">
                <div className="stream-item-codec">
                  {formatCodecName(stream.codec)}
                  {stream.isAtmos && <span className="stream-badge-atmos">Atmos</span>}
                </div>
                <div className="stream-item-info">
                  {stream.channels} Channels • {stream.sampleRate / 1000}kHz
                </div>
              </div>
              
              <div className="stream-item-meta">
                <div className="stream-item-title">{stream.title || 'Untitled Track'}</div>
                <div className="stream-item-lang">{stream.language?.toUpperCase() || 'UNK'}</div>
              </div>

              {stream.isTrueHD && (
                <div className="stream-item-tag">Professional Decoder</div>
              )}
            </button>
          ))}
        </div>

        <div className="stream-selector-footer">
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .stream-selector-overlay {
          position: absolute;
          inset: 0;
          background: rgba(6, 6, 11, 0.85);
          backdrop-filter: blur(12px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 20px;
        }

        .stream-selector-card {
          width: 100%;
          max-width: 500px;
          background: linear-gradient(145deg, rgba(20, 22, 40, 0.9) 0%, rgba(10, 10, 18, 0.95) 100%);
          border: 1px solid var(--border-medium);
          border-radius: var(--radius-lg);
          box-shadow: 0 24px 64px rgba(0, 0, 0, 0.8);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .stream-selector-header {
          padding: var(--gap-xl);
          border-bottom: 1px solid var(--border-subtle);
        }

        .stream-selector-title {
          font-size: 18px;
          font-weight: 700;
          color: var(--text-primary);
          margin-bottom: 4px;
        }

        .stream-selector-subtitle {
          font-size: 12px;
          color: var(--text-tertiary);
          line-height: 1.4;
        }

        .stream-list {
          padding: var(--gap-md);
          display: flex;
          flex-direction: column;
          gap: var(--gap-sm);
          max-height: 400px;
          overflow-y: auto;
        }

        .stream-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: var(--gap-md) var(--gap-lg);
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          color: var(--text-primary);
          cursor: pointer;
          transition: all 0.2s ease;
          text-align: left;
          width: 100%;
        }

        .stream-item:hover {
          background: rgba(255, 255, 255, 0.06);
          border-color: var(--border-medium);
          transform: translateX(4px);
        }

        .stream-item-pro {
          border-color: rgba(0, 164, 228, 0.3);
          background: rgba(0, 164, 228, 0.05);
        }

        .stream-item-pro:hover {
          border-color: var(--dolby-blue);
          background: rgba(0, 164, 228, 0.1);
          box-shadow: 0 0 20px rgba(0, 164, 228, 0.1);
        }

        .stream-item-main {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .stream-item-codec {
          font-size: 13px;
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .stream-badge-atmos {
          font-size: 9px;
          background: linear-gradient(135deg, var(--dolby-blue), var(--atmos-violet));
          color: white;
          padding: 2px 6px;
          border-radius: 3px;
          text-transform: uppercase;
          font-weight: 800;
        }

        .stream-item-info {
          font-size: 11px;
          color: var(--text-secondary);
        }

        .stream-item-meta {
          text-align: right;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .stream-item-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-primary);
          max-width: 150px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .stream-item-lang {
          font-size: 10px;
          font-family: var(--font-mono);
          color: var(--text-tertiary);
        }

        .stream-item-tag {
          position: absolute;
          top: -8px;
          right: 12px;
          font-size: 8px;
          background: var(--dolby-blue);
          color: white;
          padding: 2px 6px;
          border-radius: 4px;
          text-transform: uppercase;
          font-weight: 700;
          opacity: 0;
          transition: opacity 0.2s ease;
        }

        .stream-item-pro:hover .stream-item-tag {
          opacity: 1;
        }

        .stream-selector-footer {
          padding: var(--gap-lg);
          border-top: 1px solid var(--border-subtle);
          display: flex;
          justify-content: flex-end;
          background: rgba(255, 255, 255, 0.02);
        }
      `}} />
    </div>
  );
}
