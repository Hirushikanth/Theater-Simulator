# Atmos Theater Visualizer 🎬

**Atmos Theater Visualizer** is a professional-grade, Electron-based desktop application for real-time decoding, parsing, and 3D spatial visualization of Dolby Atmos audio across all major formats — including native TrueHD DAMF, ADM BWF, and E-AC-3 JOC streams.

> [!IMPORTANT]
> **LEGAL NOTICE & USAGE:** This is an **unofficial** Dolby Atmos object viewer developed strictly for **educational and individual use**. It is not affiliated with, endorsed by, or licensed by Dolby Laboratories.

---

## ✨ Key Features

- **Real-Time 3D Theater Visualization:** A stunning Three.js-powered home theater with dynamic object spheres, trajectory trails, and per-speaker glow indicators — updated at 60 FPS.
- **Professional TrueHD Atmos Decoding:** Full end-to-end pipeline using the Rust-based **[truehdd](https://github.com/truehdd/truehdd)** decoder:
  - Auto-detects and extracts raw `.thd` bitstreams from MKV/MKA containers via FFmpeg
  - Decodes to **DAMF** (Dolby Atmos Master Format): `.atmos` root + `.atmos.metadata` events
  - Parses all object trajectories with frame-accurate binary-search interpolation
  - FFmpeg provides the 7.1 playback audio from the original container
- **Native ADM BWF Support (up to 118+ channels):**
  - Efficiently reads **only** the `axml` RIFF chunk for XML metadata (avoids loading multi-GB audio into RAM)
  - Proper ADM reference chain resolution: `audioObject → audioPackFormat → audioChannelFormat → audioBlockFormat`
  - **Direct binary WAV/BW64 channel extraction** (no FFmpeg): overcomes the FFmpeg `pan` filter 64-channel hard limit for high-channel-count master files
  - Supports **RIFF** (≤4 GB) and **RF64/BW64** (>4 GB) formats, 16/24/32-bit PCM
- **Native E-AC-3 JOC Parser:** Custom bit-level protocol decoder for Dolby Digital Plus Atmos streams. Extracts OAMD spatial keyframes natively from `.eac3`, `.mp4`, `.mkv`.
- **DAMF Standalone Support:** Opens `.atmos` root files with companion `.atmos.metadata` — visualizes up to 80+ dynamic object trajectories.
- **Advanced Spatial Panning (VBAP):** Vector Base Amplitude Panning for precise per-speaker gain calculation from 3D object positions.
- **12-Channel VU Metering:** Real-time high-resolution level metering across the full 7.1.4 speaker array.
- **Synthetic Upmix Fallback:** Audio-reactive virtual objects for files where proprietary metadata is inaccessible (optional, can be disabled).
- **Premium Glassmorphic UI:** Professional dashboard with dark-mode design, real-time object metadata panel, and stream info sidebar.

---

## 📂 Supported Formats

| Format | Metadata Source | Audio |
|---|---|---|
| TrueHD / MKV, MKA | DAMF (truehdd decoded) | FFmpeg 7.1 from container |
| E-AC-3 JOC / MP4, MKV, .eac3 | Native JOC OAMD parser | FFmpeg decode |
| ADM BWF / .wav (≤118ch, BW64) | ADM XML (axml chunk) | Binary WAV extractor |
| Standalone `.atmos` | DAMF (direct file) | Visualization only |
| PCM / WAV | None | Direct playback |

---

## 🛠️ Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher)
- [npm](https://www.npmjs.com/)
- [Rust & Cargo](https://rustup.rs/) — required for the Professional TrueHD Decoder

### Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Hirushikanth/Theater-Simulator.git
   cd Theater-Simulator
   ```

2. **Install Node dependencies:**
   ```bash
   npm install
   ```

3. **Build & install the Professional TrueHD Decoder (Recommended):**

   The application uses `truehdd` for native TrueHD Atmos DAMF extraction. Without it, TrueHD files will show a MAT-Encrypted fallback (no object visualization).

   ```bash
   # Clone truehdd
   git clone https://github.com/truehdd/truehdd
   cd truehdd

   # Build the release binary
   cargo build --release

   # Copy binary to the project's bin folder
   mkdir -p ../Theater-Simulator/bin
   cp target/release/truehdd ../Theater-Simulator/bin/
   ```

4. **Run in Development Mode:**
   ```bash
   npm run dev
   ```

5. **Build for Production:**
   ```bash
   npm run build
   ```

---

## 🖱️ How to Use

1. **Launch the App** (`npm run dev`)
2. **Enable Professional Decoder** in the top bar (requires `bin/truehdd` binary)
3. **Click Open File** — supported formats are listed above
4. **Watch the terminal** for real-time decode progress (truehdd frame count, wav-extract stats, etc.)
5. **Hit Play** and watch the Atmos objects move through the 3D theater in sync with the audio

> **Tip:** Objects activate a few seconds into TrueHD content — this reflects the real DAMF event timeline where objects start inactive and transition to active positions.

---

## 🏗️ Architecture

```
File Opened
├── .atmos  → loadAtmosStandalone()
│               └── DAMFParser (root + .atmos.metadata)
│
└── Other   → analyzeFile (ffprobe)
              ├── TrueHD + Professional Decoder
              │     ├── FFmpeg extracts raw .thd from container
              │     ├── truehdd decodes → DAMF files
              │     ├── DAMFParser → object trajectories
              │     └── FFmpeg decodes original container → 7.1 WAV (playback)
              │
              ├── E-AC-3 / AC-3
              │     ├── FFmpeg → PCM WAV (playback)
              │     └── JOC OAMD parser → object positions
              │
              └── WAV (ADM BWF)
                    ├── readAXMLChunk → ADM XML parser → object positions
                    └── extractWavChannels → first 8ch binary extract → playback
```

**Key design decisions:**
- **Audio and metadata are decoupled** for TrueHD: truehdd handles metadata, FFmpeg handles audio. This avoids complex multi-channel CAF rematrix issues.
- **ADM audio bypasses FFmpeg entirely**: the bundled `wav-extract.js` copies PCM frames at the binary level — no channel limit, no codec conversion, no quality loss for the first 8 channels.
- **axml-only parsing** for ADM: only the XML chunk is read from disk, not the GB-scale audio data.
- **Metadata updates throttled to 4 FPS** to prevent React performance degradation.

---

## 🔊 Metadata Sources

| Source Label | Description |
|---|---|
| `JOC OAMD` | Native E-AC-3 JOC bit-level parse — highest fidelity for streaming Atmos |
| `DAMF (TrueHD Decoded)` | truehdd-decoded `.atmos.metadata` — frame-accurate object events |
| `DAMF (Standalone)` | Direct `.atmos` file — full DAMF trajectory visualization |
| `ADM XML` | ITU-R BS.2076 ADM XML — professional mastering source positions |
| `TrueHD MAT (Parse Fallback)` | truehdd unavailable or incompatible binary |
| `E-AC-3 (Parse Fallback)` | Encrypted/proprietary JOC payload |
| `SYNTHETIC UPMIX` | Audio-reactive fallback (optional) |

---

## 🏛️ Credits & Acknowledgements

- **[Cavern](https://github.com/VoidXH/Cavern):** Open-source research and reverse-engineering of E-AC-3 JOC and ADM formats. The DAMF event structure, ADM reference chain resolution, and binary WAV extraction approach in this project are directly informed by Cavern's implementations.
- **[truehdd](https://github.com/truehdd/truehdd):** The Rust engine for professional TrueHD Atmos DAMF extraction.
- **[FFmpeg](https://ffmpeg.org/):** Bundled via `ffmpeg-static` for container analysis, bitstream extraction, and audio decoding.
- **[Three.js](https://threejs.org/):** The 3D engine powering the theater visualization.

---

## ⚠️ Known Limitations

- **Standalone `.atmos` audio:** The companion `.atmos.audio` CAF file has 92+ discrete channels in a format not yet supported for playback extraction. Visualization works fully from DAMF metadata.
- **truehdd required:** TrueHD files without a compatible `bin/truehdd` binary will show a MAT-Encrypted fallback with no object data.
- **E-AC-3 encryption:** Some proprietary/encrypted JOC payloads (common in Blu-ray) cannot be parsed at the bit level and will show a parse fallback.
