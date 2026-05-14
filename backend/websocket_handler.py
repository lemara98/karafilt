"""WebSocket connection handler for the karaoke filter server."""

import asyncio
import json
import struct

import numpy as np
import websockets

import aligner


async def handle_client(websocket, manager, auth_token=None):
    """Handle a WebSocket connection from the browser extension."""
    print(f"Client connected: {websocket.remote_address}")
    session_model = "htdemucs"
    session_two_pass = False
    authenticated = auth_token is None  # no token required = auto-authenticated

    # Smart-sync alignment session state. Active when the client has sent
    # `align_start`; PCM frames received during this period are buffered
    # instead of being passed to the vocal-removal pipeline.
    align_active = False
    align_song_key = None
    align_lyrics = None
    align_sample_rate = None
    align_chunks = []
    align_total_samples = 0
    ALIGN_MAX_SAMPLES = 16000 * 60 * 8  # cap at 8 minutes of mono 16kHz audio

    try:
        async for message in websocket:
            if isinstance(message, str):
                data = json.loads(message)
                msg_type = data.get("type")

                if msg_type == "auth":
                    if auth_token and data.get("token") == auth_token:
                        authenticated = True
                        await websocket.send(json.dumps({"type": "auth", "status": "ok"}))
                        print(f"Client authenticated: {websocket.remote_address}")
                    elif auth_token:
                        await websocket.send(json.dumps({"type": "auth", "status": "denied"}))
                        print(f"Auth denied: {websocket.remote_address}")
                        await websocket.close(4001, "Invalid token")
                        return
                    continue

                if not authenticated:
                    await websocket.send(json.dumps({"type": "error", "message": "Not authenticated"}))
                    await websocket.close(4001, "Not authenticated")
                    return

                if msg_type == "ping":
                    await websocket.send(json.dumps({"type": "pong"}))

                elif msg_type == "get_models":
                    models = manager.get_available_models()
                    await websocket.send(json.dumps({
                        "type": "models",
                        "models": models,
                        "current": session_model,
                    }))

                elif msg_type == "set_model":
                    session_model = data.get("value", "htdemucs")
                    print(f"Model switched to: {session_model}")

                elif msg_type == "set_two_pass":
                    session_two_pass = bool(data.get("value", False))
                    print(f"Two-pass mode: {'enabled' if session_two_pass else 'disabled'}")

                elif msg_type == "align_start":
                    align_song_key = data.get("song_key")
                    align_lyrics = data.get("lyrics", "")
                    align_sample_rate = int(data.get("sample_rate", 16000))
                    align_chunks = []
                    align_total_samples = 0
                    align_active = True
                    print(f"[align] session start: song_key={align_song_key!r}, "
                          f"sr={align_sample_rate}, lyric_chars={len(align_lyrics)}")

                elif msg_type == "align_cancel":
                    print(f"[align] session cancelled: song_key={align_song_key!r}")
                    align_active = False
                    align_song_key = None
                    align_lyrics = None
                    align_chunks = []
                    align_total_samples = 0

                elif msg_type == "align_finalize":
                    if not align_active or not align_chunks:
                        await websocket.send(json.dumps({
                            "type": "align_result",
                            "song_key": align_song_key,
                            "ok": False,
                            "error": "no audio captured",
                        }))
                        align_active = False
                        align_song_key = None
                        align_lyrics = None
                        align_chunks = []
                        align_total_samples = 0
                        continue

                    pcm = np.concatenate(align_chunks).astype(np.float32, copy=False)
                    sr = align_sample_rate
                    lyrics = align_lyrics or ""
                    song_key = align_song_key
                    # Reset state before running (which can take many seconds)
                    align_active = False
                    align_song_key = None
                    align_lyrics = None
                    align_chunks = []
                    align_total_samples = 0

                    print(f"[align] finalizing: {len(pcm) / sr:.1f}s of audio, song_key={song_key!r}")
                    try:
                        synced = await asyncio.to_thread(
                            aligner.align,
                            pcm,
                            sr,
                            lyrics,
                            manager.demucs,
                            str(manager.device),
                        )
                        await websocket.send(json.dumps({
                            "type": "align_result",
                            "song_key": song_key,
                            "ok": True,
                            "lines": synced,
                        }))
                    except ImportError as e:
                        await websocket.send(json.dumps({
                            "type": "align_result",
                            "song_key": song_key,
                            "ok": False,
                            "error": f"aligner unavailable: {e}",
                        }))
                    except Exception as e:
                        import traceback
                        traceback.print_exc()
                        await websocket.send(json.dumps({
                            "type": "align_result",
                            "song_key": song_key,
                            "ok": False,
                            "error": f"alignment failed: {e}",
                        }))

                continue

            # Require authentication for binary (audio) data
            if not authenticated:
                await websocket.close(4001, "Not authenticated")
                return

            # Binary message: header (8 bytes) + PCM data
            if len(message) < 8:
                continue

            sample_rate = struct.unpack("<I", message[0:4])[0]
            num_samples = struct.unpack("<I", message[4:8])[0]
            pcm_data = message[8:]

            # Alignment session: PCM is mono float32 (no stereo interleave).
            # Buffer it for whisperx instead of running the vocal-removal pipeline.
            if align_active:
                expected_mono = num_samples * 4
                if len(pcm_data) != expected_mono:
                    print(f"[align] frame size mismatch: expected {expected_mono}, got {len(pcm_data)} — dropping")
                    continue
                samples = np.frombuffer(pcm_data, dtype=np.float32).copy()
                if align_total_samples + num_samples > ALIGN_MAX_SAMPLES:
                    # Cap reached — drop further frames silently; finalize will use what we have.
                    continue
                align_chunks.append(samples)
                align_total_samples += num_samples
                continue

            expected_bytes = num_samples * 2 * 4
            if len(pcm_data) != expected_bytes:
                print(f"Warning: expected {expected_bytes} bytes, got {len(pcm_data)}")
                continue

            samples = np.frombuffer(pcm_data, dtype=np.float32)
            stereo = samples.reshape(-1, 2).T

            tp_label = "+two-pass" if session_two_pass else ""
            print(f"Processing {num_samples} samples at {sample_rate} Hz "
                  f"({num_samples / sample_rate:.1f}s, model={session_model}{tp_label})...")

            accompaniment = manager.process(stereo, sample_rate, session_model, session_two_pass)

            interleaved = accompaniment.T.flatten().astype(np.float32)
            out_samples = accompaniment.shape[1]
            header = struct.pack("<II", sample_rate, out_samples)
            await websocket.send(header + interleaved.tobytes())

            print(f"Sent {out_samples} processed samples")

    except websockets.exceptions.ConnectionClosed:
        print(f"Client disconnected: {websocket.remote_address}")
    except Exception as e:
        import traceback
        print(f"Error: {e}")
        traceback.print_exc()
