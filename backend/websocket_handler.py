"""WebSocket connection handler for the karaoke filter server."""

import asyncio
import json
import os
import struct
import urllib.request

import numpy as np
import websockets

# ── Phase 3: token trust boundary ───────────────────────────────────────────
# When FILTER_JWT_SECRET is set, clients must authenticate with a short-lived JWT
# issued by the website (POST /api/filter-token), and the backend reports
# processed seconds to the website's /api/usage so the trial meter ticks down.
# All optional: without them the server keeps its old behaviour (open, or a
# static --auth-token).
FILTER_JWT_SECRET = os.environ.get("FILTER_JWT_SECRET")
USAGE_REPORT_URL = os.environ.get("KARAFILT_USAGE_URL")  # e.g. https://karafilt.com/api/usage
USAGE_API_SECRET = os.environ.get("USAGE_API_SECRET")
USAGE_REPORT_INTERVAL_S = float(os.environ.get("KARAFILT_USAGE_INTERVAL", "30"))

try:
    import jwt as _pyjwt  # PyJWT
    _HAS_PYJWT = True
except ImportError:
    _HAS_PYJWT = False
    if FILTER_JWT_SECRET:
        print("[auth] WARNING: FILTER_JWT_SECRET is set but PyJWT is not installed "
              "(`pip install pyjwt`); filter-token auth will reject all clients.")


def _verify_filter_token(token):
    """Verify a website-issued filter JWT (HS256). Returns the claims dict or None."""
    if not (FILTER_JWT_SECRET and _HAS_PYJWT and token):
        return None
    try:
        return _pyjwt.decode(token, FILTER_JWT_SECRET, algorithms=["HS256"])
    except Exception as e:  # any failure = rejected
        print(f"[auth] filter token rejected: {e}")
        return None


def _post_usage_sync(user_id, seconds):
    payload = json.dumps(
        {"userId": user_id, "secondsProcessed": round(seconds, 2)}
    ).encode("utf-8")
    req = urllib.request.Request(
        USAGE_REPORT_URL,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {USAGE_API_SECRET}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except Exception as e:
        print(f"[usage] report failed: {e}")


async def _report_usage(user_id, seconds):
    """Best-effort POST of processed seconds to the website's /api/usage meter."""
    if not (USAGE_REPORT_URL and USAGE_API_SECRET and user_id and seconds > 0):
        return
    await asyncio.to_thread(_post_usage_sync, user_id, seconds)


async def handle_client(websocket, manager, auth_token=None, num_workers=4):
    """Handle a WebSocket connection from the browser extension."""
    print(f"Client connected: {websocket.remote_address} (workers={num_workers})")
    session_model = "htdemucs"
    session_two_pass = False
    # Auth is required if a static token OR filter-JWT auth is configured.
    require_auth = bool(auth_token) or bool(FILTER_JWT_SECRET)
    authenticated = not require_auth

    # Phase 3 session identity (from the filter JWT) + usage accounting.
    session_user_id = None
    session_entitlement = None
    session_unreported_seconds = 0.0
    usage_tasks = set()

    # AI worker pool. Each binary chunk gets a monotonic seq id and is enqueued
    # for one of num_workers coroutines to process via asyncio.to_thread.
    # `sender` ships completed chunks back in strict seq order so the frontend's
    # overlap crossfade stays valid. Workers may finish out of order; sender
    # buffers and reorders. GPU compute is serialized on a single CUDA stream,
    # so on GPU the speedup vs. serial is bounded by CPU prep overlap.
    work_queue: asyncio.Queue = asyncio.Queue(maxsize=max(num_workers * 2, 4))
    result_buffer: dict = {}
    result_ready = asyncio.Event()
    send_state = {"next_seq": 0}
    incoming_seq = 0

    async def ai_worker():
        while True:
            seq_id, sr, stereo, model_name, two_pass = await work_queue.get()
            try:
                accompaniment = await asyncio.to_thread(
                    manager.process, stereo, sr, model_name, two_pass
                )
                result_buffer[seq_id] = (sr, accompaniment)
            except Exception as e:
                import traceback
                print(f"[ai-worker] error on chunk #{seq_id}: {e}")
                traceback.print_exc()
                result_buffer[seq_id] = None  # let sender skip past
            finally:
                work_queue.task_done()
                result_ready.set()

    async def ai_sender():
        while True:
            await result_ready.wait()
            result_ready.clear()
            while send_state["next_seq"] in result_buffer:
                seq = send_state["next_seq"]
                payload = result_buffer.pop(seq)
                send_state["next_seq"] = seq + 1
                if payload is None:
                    continue
                sr, accompaniment = payload
                interleaved = accompaniment.T.flatten().astype(np.float32)
                out_samples = accompaniment.shape[1]
                header = struct.pack("<II", sr, out_samples)
                await websocket.send(header + interleaved.tobytes())
                print(f"Sent {out_samples} processed samples (chunk #{seq})")

    worker_tasks = [asyncio.create_task(ai_worker()) for _ in range(num_workers)]
    sender_task = asyncio.create_task(ai_sender())

    try:
        async for message in websocket:
            if isinstance(message, str):
                data = json.loads(message)
                msg_type = data.get("type")

                if msg_type == "auth":
                    token = data.get("token")
                    # Preferred: website-issued filter JWT (when FILTER_JWT_SECRET is set).
                    if FILTER_JWT_SECRET:
                        claims = _verify_filter_token(token)
                        if claims:
                            authenticated = True
                            session_user_id = claims.get("sub")
                            session_entitlement = claims.get("entitlement")
                            await websocket.send(json.dumps({"type": "auth", "status": "ok"}))
                            print(f"Client authenticated via filter token: "
                                  f"user={session_user_id} entitlement={session_entitlement}")
                        else:
                            await websocket.send(json.dumps({"type": "auth", "status": "denied"}))
                            await websocket.close(4001, "Invalid token")
                            return
                        continue
                    # Legacy: static --auth-token.
                    if auth_token and token == auth_token:
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

            expected_bytes = num_samples * 2 * 4
            if len(pcm_data) != expected_bytes:
                print(f"Warning: expected {expected_bytes} bytes, got {len(pcm_data)}")
                continue

            samples = np.frombuffer(pcm_data, dtype=np.float32).copy()
            stereo = samples.reshape(-1, 2).T

            tp_label = "+two-pass" if session_two_pass else ""
            print(f"Queued {num_samples} samples at {sample_rate} Hz "
                  f"({num_samples / sample_rate:.1f}s, model={session_model}{tp_label}, seq=#{incoming_seq})")

            item = (incoming_seq, sample_rate, stereo, session_model, session_two_pass)
            try:
                work_queue.put_nowait(item)
            except asyncio.QueueFull:
                # Drop oldest unprocessed chunk to make room. Mark its slot as
                # None so the sender skips past it instead of stalling forever.
                try:
                    dropped_seq = work_queue.get_nowait()[0]
                    work_queue.task_done()
                    result_buffer[dropped_seq] = None
                    result_ready.set()
                    print(f"[ai-worker] queue full; dropped chunk #{dropped_seq}")
                except asyncio.QueueEmpty:
                    pass
                work_queue.put_nowait(item)
            incoming_seq += 1

            # Phase 3: meter processed audio for trial users.
            if session_entitlement == "trial" and session_user_id and sample_rate > 0:
                session_unreported_seconds += num_samples / sample_rate
                if session_unreported_seconds >= USAGE_REPORT_INTERVAL_S:
                    secs = session_unreported_seconds
                    session_unreported_seconds = 0.0
                    t = asyncio.create_task(_report_usage(session_user_id, secs))
                    usage_tasks.add(t)
                    t.add_done_callback(usage_tasks.discard)

    except websockets.exceptions.ConnectionClosed:
        print(f"Client disconnected: {websocket.remote_address}")
    except Exception as e:
        import traceback
        print(f"Error: {e}")
        traceback.print_exc()
    finally:
        # Flush any unreported trial usage before tearing down.
        if (
            session_entitlement == "trial"
            and session_user_id
            and session_unreported_seconds > 0
        ):
            try:
                await _report_usage(session_user_id, session_unreported_seconds)
            except Exception:
                pass
        for t in worker_tasks:
            t.cancel()
        sender_task.cancel()
        await asyncio.gather(*worker_tasks, sender_task, return_exceptions=True)
