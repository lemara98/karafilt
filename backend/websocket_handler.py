"""WebSocket connection handler for the karaoke filter server."""

import json
import struct

import numpy as np
import websockets


async def handle_client(websocket, manager):
    """Handle a WebSocket connection from the browser extension."""
    print(f"Client connected: {websocket.remote_address}")
    session_model = "htdemucs_ft"
    session_two_pass = False

    try:
        async for message in websocket:
            if isinstance(message, str):
                data = json.loads(message)
                msg_type = data.get("type")

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
                    session_model = data.get("value", "htdemucs_ft")
                    print(f"Model switched to: {session_model}")

                elif msg_type == "set_two_pass":
                    session_two_pass = bool(data.get("value", False))
                    print(f"Two-pass mode: {'enabled' if session_two_pass else 'disabled'}")

                continue

            # Binary message: header (8 bytes) + PCM data
            if len(message) < 8:
                continue

            sample_rate = struct.unpack("<I", message[0:4])[0]
            num_samples = struct.unpack("<I", message[4:8])[0]
            pcm_data = message[8:]

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
