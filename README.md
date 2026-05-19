# Karafilt

<p align="center">
  <img src="icons/icon128.png" alt="Karafilt" width="96">
</p>

**Real-time vocal removal for any browser tab.** Turn any song playing in Chrome into a karaoke track — no downloads, no uploads, just click and sing.

## How It Works

Karafilt captures audio from your active browser tab and removes the vocals in real time. It works with YouTube, Spotify Web Player, SoundCloud, or any website that plays audio.

### Processing Modes

| Mode | Quality | Latency | Requires Server |
|------|---------|---------|-----------------|
| **Spectral (Good)** | Medium | Real-time | No |
| **Basic (Fast)** | Lower | Real-time | No |
| **AI Separation (Best)** | High | ~5s | Yes |
| **AI + Deep Clean** | Highest | ~10s | Yes |

- **Spectral** and **Basic** modes run entirely in your browser using WebAssembly — no server needed.
- **AI** modes use neural network vocal separation (Demucs) for significantly better quality, but require a backend server for processing.

## Installation

### From Chrome Web Store

*Coming soon*

### Manual Install (Developer Mode)

1. Download or clone this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this folder
5. The Karafilt icon appears in your toolbar

## Usage

1. Play a song in any tab (YouTube, Spotify, etc.)
2. Click the Karafilt extension icon
3. Choose a processing mode
4. Adjust the **Vocal Removal** slider (0-100%)
5. Click **Start Filtering**

### Settings

Click the gear icon in the popup to configure:

- **Server URL** — WebSocket endpoint for AI processing (default: `ws://localhost:9876`)
- **API Key** — Authentication token for hosted backends

Your settings (mode, slider position, model, server URL) are saved automatically and persist across sessions.

---

## For Developers

### Architecture

```
Browser Extension (Chrome Manifest V3)
  ├── popup/          — UI controls (mode, mix slider, settings)
  ├── service-worker  — orchestrates capture lifecycle
  ├── offscreen.js    — audio capture & processing (Web Audio API)
  ├── worklet-processor.js — real-time WASM processing on audio thread
  └── wasm/           — C source & compiled WebAssembly (STFT, center-cancel)

Backend Server (Python)
  ├── server.py             — WebSocket server entry point
  ├── websocket_handler.py  — client connection handler + auth
  ├── backends.py           — Demucs & audio-separator wrappers
  └── models.py             — model registry
```

Audio flows through two parallel pipelines:
1. **WASM pipeline** (always active) — real-time spectral processing via AudioWorklet
2. **AI pipeline** (optional) — 5-second chunks sent to the backend via WebSocket, results crossfaded in

The WASM pipeline serves as an instant preview while AI chunks are being processed.

### Building the WASM Module

Requires [Emscripten](https://emscripten.org/docs/getting_started/downloads.html):

```bash
make phase2   # builds wasm/build/vocal_remove.wasm
```

### Running the Backend Server

```bash
cd backend
./setup.sh            # creates venv, installs dependencies
source venv/bin/activate
python server.py      # starts on ws://localhost:9876
```

Options:
```
--port 9876           # WebSocket port (default: 9876)
--device auto         # cpu, cuda, or auto (default: auto)
--auth-token SECRET   # require clients to authenticate
--workers 4           # per-session AI worker pool size (default 4, env: KARAFILT_WORKERS)
```

The server auto-detects GPU (CUDA) and falls back to CPU. First run downloads the Demucs model (~1.5GB).

Each session spawns `--workers` concurrent Demucs inferences fed from a per-session queue; results are reordered before being sent back. On a single GPU, CUDA serializes compute so the throughput speedup vs. 1 worker is bounded by CPU prep overlap — lower `--workers` if VRAM is tight (each in-flight chunk uses ~1 GB on top of model weights).

### Supported AI Models

**Demucs** (built-in):
- `htdemucs` — Hybrid Transformer (default, quality sweet spot)
- `htdemucs_ft` — Fine-tuned (highest quality, slow, high VRAM)
- `mdx_extra` — MDX variant
- `mdx_extra_q` — MDX quantized (fastest, lower quality)

**Audio Separator** (optional, install separately):
- BS-Roformer, Mel-Roformer, MDX23C, UVR-MDX-NET

### WebSocket Protocol

- **Text messages**: JSON commands (`auth`, `set_model`, `set_two_pass`, `get_models`, `ping`)
- **Binary messages**: 8-byte header (uint32 sample_rate + uint32 num_samples) + interleaved float32 PCM

### Authentication

When running with `--auth-token`, clients must send an auth message before any other commands:

```json
{"type": "auth", "token": "your-secret-token"}
```

## License

*TBD*
