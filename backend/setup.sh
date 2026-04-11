#!/bin/bash
# Karaoke Filter — Backend Setup
# Creates a virtual environment and installs Demucs + dependencies

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"

echo "=== Karaoke Filter Backend Setup ==="

# Create venv if it doesn't exist
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

echo "Activating virtual environment..."
source "$VENV_DIR/bin/activate"

echo "Installing dependencies (this may take a few minutes)..."
pip install --upgrade pip
pip install -r "$SCRIPT_DIR/requirements.txt"

echo ""
echo "=== Setup complete! ==="
echo ""
echo "To start the backend server:"
echo "  cd $SCRIPT_DIR"
echo "  source venv/bin/activate"
echo "  python server.py"
echo ""
echo "Options:"
echo "  --device cuda    (use GPU, much faster)"
echo "  --device cpu     (use CPU, slower but always works)"
echo "  --model htdemucs_ft  (fine-tuned model, slightly better quality)"
echo "  --port 9876      (default port)"
