# Atmos Theater Visualizer 🚀

**Atmos Theater Visualizer** is a high-fidelity, Electron-based desktop application designed to simulate and visualize 7.1.4 Dolby Atmos spatial audio environments in real-time. 

> [!IMPORTANT]
> **LEGAL NOTICE & USAGE:** This is an **unofficial** Dolby Atmos object viewer developed strictly for **educational and individual use**. It is not affiliated with, endorsed by, or licensed by Dolby Laboratories.

### 🤖 AI-Assisted Development
This project was developed with significant **AI assistance (Antigravity by Google DeepMind)** to engineer the complex spatial math, bitstream parsing heuristics, and the 3D WebGL rendering engine.

---

## ✨ Key Features
- **Real-Time 3D Visualization:** A stunning Three.js-powered home theater environment with dynamic object spheres and speaker glow indicators.
- **Advanced Spatial Panning (VBAP):** Implements **Vector Base Amplitude Panning** to calculate precise speaker gains based on 3D object trajectories.
- **Native Audio Pipeline:** Uses bundled **FFmpeg** and **ffprobe** for high-performance audio decoding (E-AC-3, AC-3, TrueHD, ADM BWF) directly on your desktop.
- **Dynamic Metadata Parsing:** 
  - **JOC OAMD:** Heuristic-based extraction of Object Audio Metadata from E-AC-3 streams.
  - **ADM BWF:** Full ITU-R BS.2076 XML metadata parsing.
  - **DAMF:** Support for `.atmos.metadata` YAML trajectories.
- **Synthetic Upmix Engine:** A fallback spatializer that generates audio-reactive virtual objects when proprietary metadata is encrypted or missing, ensuring the 7.1.4 array always remains visually active.
- **Premium Glassmorphic UI:** A professional-grade dashboard with 12-channel high-resolution VU metering and real-time object tracking.

---

## 🛠️ Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [npm](https://www.npmjs.com/) (usually comes with Node.js)

### Installation & Installation
1. **Clone the repository:**
   ```bash
   git clone https://github.com/Hirushikanth/Theater-Simulator.git
   cd Theater-Simulator
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run in Development Mode:**
   ```bash
   npm run dev
   ```

4. **Build for Production:**
   ```bash
   npm run build
   ```

---

## 📂 Supported Formats
- **Codecs:** E-AC-3 (JOC), AC-3, TrueHD, ADM BWF (WAV), PCM.
- **Containers:** .mkv, .mp4, .m4a, .mov, .webm, .wav, .eac3.

---

## 🖱️ How to Use
1. **Launch the App.**
2. **Drag and Drop** any supported audio or video file into the center of the theater view.
3. **Wait for Decoding:** The app will analyze and decode the stream in the background.
4. **Hit Play:** Watch as the 3D objects traverse the room and the speakers glow in sync with the spatial energy!

---
