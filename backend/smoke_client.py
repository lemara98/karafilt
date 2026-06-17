#!/usr/bin/env python3
"""
Smoke-test client for the Karafilt filtering backend.

Mints a website-style filter JWT (HS256 with FILTER_JWT_SECRET), connects over
WebSocket exactly like the extension's offscreen client does, and pushes one
synthetic stereo chunk through the separator to prove the full path works:
auth → set_model → set_two_pass → binary chunk in → processed chunk out.

Use it twice:
  1. Locally before paying for a pod:
       export FILTER_JWT_SECRET=<prod value>
       python server.py --device cpu        # in one shell
       python smoke_client.py ws://localhost:9876
  2. Against the live pod once it's up:
       export FILTER_JWT_SECRET=<prod value>
       python smoke_client.py wss://<podid>-9876.proxy.runpod.net

The wire protocol mirrors backend/websocket_handler.py and offscreen.js:
  - JSON control messages: {"type":"auth","token":...}, set_model, set_two_pass, get_models
  - Binary chunk = 8-byte little-endian header (uint32 sample_rate, uint32 num_samples)
    followed by float32 stereo PCM, interleaved L,R,L,R...
"""

import argparse
import asyncio
import json
import os
import struct
import sys
import time
import uuid

import numpy as np

try:
    import jwt as pyjwt  # PyJWT
except ImportError:
    print("FAIL: PyJWT not installed — run `pip install -r requirements.txt`")
    sys.exit(2)

try:
    import websockets
except ImportError:
    print("FAIL: websockets not installed — run `pip install -r requirements.txt`")
    sys.exit(2)

MAX_MSG = 10 * 1024 * 1024  # match the server's max_size


def mint_token(secret, entitlement, user_id):
    """Build a 5-minute HS256 filter JWT shaped like the website issues."""
    now = int(time.time())
    claims = {
        "sub": user_id,
        "entitlement": entitlement,
        "email": "smoke@karafilt.test",
        "iat": now,
        "exp": now + 300,
    }
    return pyjwt.encode(claims, secret, algorithm="HS256")


def make_chunk(sample_rate, seconds):
    """Synthetic stereo test tone (A4 left / E5 right + a little noise)."""
    n = int(sample_rate * seconds)
    t = np.arange(n, dtype=np.float32) / sample_rate
    left = 0.3 * np.sin(2 * np.pi * 440.0 * t)
    right = 0.3 * np.sin(2 * np.pi * 659.25 * t)
    noise = 0.02 * np.random.randn(n).astype(np.float32)
    stereo = np.stack([left + noise, right + noise], axis=1).astype(np.float32)  # (n, 2)
    interleaved = stereo.flatten()  # L,R,L,R...
    header = struct.pack("<II", sample_rate, n)
    return header + interleaved.tobytes(), n


async def run(url, secret, entitlement, user_id, two_pass, sample_rate, seconds, timeout):
    print(f"→ connecting to {url}")
    async with websockets.connect(url, max_size=MAX_MSG, open_timeout=20) as ws:
        # 1) auth (only if a secret is configured; an open server needs none)
        if secret:
            token = mint_token(secret, entitlement, user_id)
            await ws.send(json.dumps({"type": "auth", "token": token}))
            reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
            if reply.get("type") != "auth" or reply.get("status") != "ok":
                print(f"FAIL: auth rejected → {reply}")
                return False
            print(f"✓ auth ok (entitlement={entitlement}, user={user_id})")
        else:
            print("• no FILTER_JWT_SECRET set — connecting to an open server (no auth)")

        # 2) optional: list models the server actually has loaded
        await ws.send(json.dumps({"type": "get_models"}))
        try:
            models_msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
            if models_msg.get("type") == "models":
                names = list(models_msg.get("models", {}).keys())
                print(f"✓ models available: {names} (current={models_msg.get('current')})")
        except asyncio.TimeoutError:
            print("• server did not answer get_models (continuing)")

        # 3) configure the session like the extension does
        await ws.send(json.dumps({"type": "set_model", "value": "htdemucs"}))
        await ws.send(json.dumps({"type": "set_two_pass", "value": two_pass}))

        # 4) push one chunk and wait for the processed result
        chunk, n_in = make_chunk(sample_rate, seconds)
        print(f"→ sending {seconds:.1f}s chunk ({n_in} samples @ {sample_rate}Hz, "
              f"{len(chunk)/1e6:.2f} MB, two_pass={two_pass})")
        t0 = time.time()
        await ws.send(chunk)

        # Skip any stray JSON (e.g. pong) and wait for the binary reply.
        while True:
            msg = await asyncio.wait_for(ws.recv(), timeout=timeout)
            if isinstance(msg, (bytes, bytearray)):
                break
            print(f"• ignoring control message while waiting: {msg[:120]}")

        dt = time.time() - t0
        sr_out, n_out = struct.unpack("<II", msg[0:8])
        pcm = np.frombuffer(msg[8:], dtype=np.float32)
        if pcm.size != n_out * 2:
            print(f"FAIL: payload size {pcm.size} != expected {n_out*2}")
            return False
        rms = float(np.sqrt(np.mean(pcm ** 2))) if pcm.size else 0.0
        print(f"✓ received {n_out} samples @ {sr_out}Hz in {dt:.1f}s "
              f"({dt/seconds:.2f}× realtime), output RMS={rms:.4f}")
        if n_out == 0 or rms == 0.0:
            print("FAIL: empty / silent output")
            return False
        return True


def main():
    ap = argparse.ArgumentParser(description="Karafilt backend smoke test")
    ap.add_argument("url", nargs="?", default="ws://localhost:9876",
                    help="ws:// or wss:// server URL (default: ws://localhost:9876)")
    ap.add_argument("--entitlement", default="trial", choices=["trial", "subscription"],
                    help="entitlement claim to mint into the JWT (default: trial)")
    ap.add_argument("--user-id", default=None, help="JWT sub claim (default: random uuid)")
    ap.add_argument("--two-pass", action="store_true", help="request ai2 deep-clean mode")
    ap.add_argument("--sample-rate", type=int, default=44100)
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--timeout", type=float, default=180.0,
                    help="seconds to wait for the processed chunk (CPU is slow)")
    args = ap.parse_args()

    secret = os.environ.get("FILTER_JWT_SECRET")
    user_id = args.user_id or str(uuid.uuid4())

    try:
        ok = asyncio.run(run(
            args.url, secret, args.entitlement, user_id, args.two_pass,
            args.sample_rate, args.seconds, args.timeout,
        ))
    except Exception as e:
        print(f"FAIL: {type(e).__name__}: {e}")
        sys.exit(1)

    print("\nPASS ✅ backend round-trip works" if ok else "\nFAIL ❌ see errors above")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
