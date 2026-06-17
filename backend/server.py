#!/usr/bin/env python3
"""
Karaoke Filter — Multi-Model WebSocket Backend

Receives raw PCM audio chunks from the browser extension,
runs vocal separation using the selected model, and returns the accompaniment.

Supported backends:
  - Demucs: htdemucs, htdemucs_ft, mdx_extra, mdx_extra_q
  - audio-separator (optional): BS-Roformer, Mel-Roformer, MDX23C, UVR-MDX-NET

Usage:
    python server.py [--port 9876] [--device cuda]
"""

import argparse
import asyncio
import functools
import logging
import os

import torch
import websockets

from models import HAS_AUDIO_SEPARATOR
from backends import ModelManager
from websocket_handler import handle_client, stats_snapshot, log


async def stats_heartbeat(interval=60):
    """Periodically log aggregate throughput so a deployed pod is observable
    via `tail -f` on the log (and tells you at a glance if the GPU keeps up)."""
    while True:
        await asyncio.sleep(interval)
        s = stats_snapshot()
        if s["connections"] == 0:
            continue  # nothing has happened yet; stay quiet
        log(f"[heartbeat] active={s['active']} conns={s['connections']} "
            f"recv={s['received']} sent={s['sent']} dropped={s['dropped']} "
            f"drop_rate={s['drop_rate'] * 100:.0f}% "
            f"avg_proc={s['avg_process_s']:.2f}s/chunk rtf={s['realtime_factor']:.2f}")

# Suppress noisy websocket handshake errors (harmless connection probes)
logging.getLogger("websockets").setLevel(logging.ERROR)


async def main(host, port, device, auth_token=None, num_workers=4):
    manager = ModelManager(device=device)

    available = manager.get_available_models()
    print(f"Available models ({len(available)}):")
    for key, info in available.items():
        print(f"  {key}: {info['label']} [{info['backend']}]")
    if not HAS_AUDIO_SEPARATOR:
        print("Note: install 'audio-separator' for BS-Roformer, Mel-Roformer, MDX23C models")

    if auth_token:
        print(f"Authentication enabled (token set via --auth-token)")
    else:
        print("Authentication disabled (no --auth-token provided)")

    if os.environ.get("FILTER_JWT_SECRET"):
        print("Filter-token (JWT) auth enabled via FILTER_JWT_SECRET")
        if os.environ.get("KARAFILT_USAGE_URL"):
            print(f"Usage metering → {os.environ.get('KARAFILT_USAGE_URL')}")
        else:
            print("Usage metering disabled (set KARAFILT_USAGE_URL + USAGE_API_SECRET)")

    print(f"\nStarting WebSocket server on ws://{host}:{port} (workers={num_workers})")
    asyncio.create_task(stats_heartbeat())
    async with websockets.serve(
        functools.partial(
            handle_client,
            manager=manager,
            auth_token=auth_token,
            num_workers=num_workers,
        ),
        host, port,
        logger=logging.getLogger("websockets"),
        max_size=10 * 1024 * 1024,  # 10MB — audio chunks can be ~2MB for 5s stereo
    ):
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Karaoke Filter Multi-Model Backend")
    parser.add_argument("--host", type=str,
                        default=os.environ.get("KARAFILT_HOST", "0.0.0.0"),
                        help="Bind address (env: KARAFILT_HOST, default 0.0.0.0 so the "
                             "RunPod/host proxy can reach it; use 127.0.0.1 for local-only)")
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument("--device", type=str, default="auto",
                        help="Device: cpu, cuda, or auto")
    parser.add_argument("--auth-token", type=str, default=None,
                        help="Require clients to authenticate with this token")
    parser.add_argument("--workers", type=int,
                        default=int(os.environ.get("KARAFILT_WORKERS", "4")),
                        help="Per-session AI worker pool size (env: KARAFILT_WORKERS, default 4)")
    args = parser.parse_args()

    if args.device == "auto":
        args.device = "cuda" if torch.cuda.is_available() else "cpu"

    if args.workers < 1:
        args.workers = 1

    asyncio.run(main(args.host, args.port, args.device, args.auth_token, args.workers))
