# Karafilt AI filtering backend — Demucs vocal separation over WebSocket.
#
# Build:  docker build -t ghcr.io/lemara98/karafilt-backend backend/
# Push:   docker push ghcr.io/lemara98/karafilt-backend
# Run:    docker run --gpus all -p 9876:9876 \
#           -e FILTER_JWT_SECRET=... \
#           -e USAGE_API_SECRET=... \
#           -e KARAFILT_USAGE_URL=https://karafilt.com/api/usage \
#           ghcr.io/lemara98/karafilt-backend
#
# See docs/DEPLOY.md §2 for the RunPod runbook.
FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime

WORKDIR /app

# ffmpeg: audio decode dependency of torchaudio/demucs tooling.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# torch/torchaudio come from the base image; pip installs the rest.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-bake the default model (~1.5 GB) so a fresh pod serves immediately
# instead of downloading on the first connection.
RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs')"

COPY *.py ./

EXPOSE 9876
CMD ["python", "server.py", "--device", "auto", "--port", "9876"]
