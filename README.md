# Atmos Theater Visualizer 🚀

**Atmos Theater Visualizer** is a high-fidelity, Electron-based desktop application designed to simulate and visualize 7.1.4 Dolby Atmos spatial audio environments in real-time. 

> [!IMPORTANT]
> **LEGAL NOTICE & USAGE:** This is an **unofficial** Dolby Atmos object viewer developed strictly for **educational and individual use**. It is not affiliated with, endorsed by, or licensed by Dolby Laboratories.

### 🤖 AI-Assisted Development
This project was developed with significant **AI assistance (Antigravity by Google DeepMind)** to engineer the complex spatial math, bitstream parsing heuristics, and the 3D WebGL rendering engine.

---

## ✨ Key Features
- **Real-Time 3D Visualization:** A stunning Three.js-powered home theater environment with dynamic object spheres and speaker glow indicators.
- **Professional Atmos Decoding:** Integrated with the Rust-based **[truehdd](https://github.com/truehdd/truehdd)** decoder for high-fidelity extraction of OAMD metadata from TrueHD/MAT 2.0 bitstreams.
- **Advanced Spatial Panning (VBAP):** Implements **Vector Base Amplitude Panning** to calculate precise speaker gains based on 3D object trajectories.
- **Native Audio Pipeline:** Uses bundled **FFmpeg** and **ffprobe** for high-performance audio decoding (E-AC-3, AC-3, TrueHD, ADM BWF) directly on your desktop.
- **Dynamic Metadata Parsing:** 
  - **Native E-AC-3 JOC:** A custom-built bit-level protocol decoder that extracts exact Object Audio Metadata (OAMD) natively from Dolby Digital Plus Atmos streams—calculating dynamic spatial keyframes flawlessly!
  - **ADM BWF:** Full ITU-R BS.2076 XML metadata parsing.
  - **DAMF:** Support for `.atmos.metadata` YAML trajectories.
- **Synthetic Upmix Engine:** A fallback spatializer that generates audio-reactive virtual objects when proprietary MAT metadata is un-parsable, ensuring the 7.1.4 array always remains visually active.
- **Premium Glassmorphic UI:** A professional-grade dashboard with 12-channel high-resolution VU metering and real-time object tracking.

---

## 🛠️ Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [npm](https://www.npmjs.com/) (usually comes with Node.js)
- [Rust & Cargo](https://rustup.rs/) (Required for the Professional Atmos Decoder)

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

3. **Provide Professional Decoder (Optional but Recommended):**
   The application uses `truehdd` for professional-grade Atmos decoding. To set it up:
   ```bash
   # Clone the truehdd repository
   git clone https://github.com/truehdd/truehdd
   cd truehdd
   
   # Build the release binary
   cargo build --release
   
   # Copy the binary to the project's bin folder
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

## 🏛️ Credits & Acknowledgements
- **[Cavern](https://github.com/VoidXH/Cavern)**: Monumental open-source research and reverse-engineering of the Dolby E-AC-3 JOC bit-level protocols, directly enabling our native Javascript parser.
- **[truehdd](https://github.com/truehdd/truehdd)**: The core engine for professional-grade TrueHD/Atmos OAMD extraction.
- **Google DeepMind (Antigravity)**: AI-assisted engineering for spatial math and bitstream parsing.
- **Three.js**: The powerful 3D engine driving the theater visualization.

---

## 🔊 Native E-AC-3 JOC Support
The Theater Simulator formally features a **completely native bitstream parser for E-AC-3 JOC files**! 
This means any standard Dolby Digital Plus Atmos file (`.eac3`, `.mp4`, `.mkv`) generated from streaming platforms properly parses through our bespoke `eac3-parser`. We read every single dependent substream and map the 3D differential position data (OAMD) directly into the Three.js physics sandbox!

## ⚠️ Metadata Limitations & Synthetic Engine
While E-AC-3, ADM BWF, and DAMF provide breathtaking native spatial paths, it is important to note:
- **TrueHD MAT 2.0 Complexity:** Currently, parsing native TrueHD Atmos relies heavily on the `truehdd` binary decoder, and some proprietary TrueHD payloads might trigger a **Parse Fallback** if they contain un-supported MAT multiplexing states.
- **Synthetic Visualization:** To ensure the 3D theater remains dynamic when encountering files that trigger a Parse Fallback, the app auto-engages a **Synthetic Object Engine**. This generates audio-reactive virtual objects that synthesize spatial movement based on frequency energy—providing a stunning visual representation of the soundstage even when true metadata is locked.

---

## 📂 Supported Formats
- **Codecs:** E-AC-3 (JOC), AC-3, TrueHD (MAT 2.0), ADM BWF (WAV), PCM.
- **Containers:** .mkv, .mp4, .m4a, .mov, .webm, .wav, .eac3.

---

## 🖱️ How to Use
1. **Launch the App.**
2. **Enable Professional Decoder** in the top bar (if you have provided the `truehdd` binary).
3. **Drop a file** (like a TrueHD Atmos MKV) into the theater.
4. **Decoding Progress:** Watch the terminal/console for real-time `truehdd` progress logs.
5. **Hit Play:** Experience the high-fidelity spatial trajectories!

---
