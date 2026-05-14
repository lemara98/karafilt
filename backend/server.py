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

import torch
import websockets

from models import HAS_AUDIO_SEPARATOR
from backends import ModelManager
from websocket_handler import handle_client

# Suppress noisy websocket handshake errors (harmless connection probes)
logging.getLogger("websockets").setLevel(logging.ERROR)


async def main(port, device, auth_token=None):
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

    print(f"\nStarting WebSocket server on ws://localhost:{port}")
    async with websockets.serve(
        functools.partial(handle_client, manager=manager, auth_token=auth_token),
        "localhost", port,
        logger=logging.getLogger("websockets"),
        max_size=10 * 1024 * 1024,  # 10MB — audio chunks can be ~2MB for 5s stereo
    ):
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Karaoke Filter Multi-Model Backend")
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument("--device", type=str, default="auto",
                        help="Device: cpu, cuda, or auto")
    parser.add_argument("--auth-token", type=str, default=None,
                        help="Require clients to authenticate with this token")
    args = parser.parse_args()

    if args.device == "auto":
        args.device = "cuda" if torch.cuda.is_available() else "cpu"

    asyncio.run(main(args.port, args.device, args.auth_token))
