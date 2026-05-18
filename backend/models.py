"""Model registries and availability checks."""

# Check if audio-separator is available
try:
    from audio_separator.separator import Separator
    HAS_AUDIO_SEPARATOR = True
except ImportError:
    HAS_AUDIO_SEPARATOR = False


# Registry of available models with display info. Order matters: the first
# entry is the default low-latency choice and appears first in the picker.
DEMUCS_MODELS = {
    "mdx_extra_q":  "MDX-Net Extra Quantized (low-latency default)",
    "htdemucs":     "Demucs Hybrid Transformer (balanced)",
    "mdx_extra":    "MDX-Net Extra",
    "htdemucs_ft":  "Demucs Fine-Tuned (highest quality, slow, high VRAM)",
}

# audio-separator models (only if package is installed)
SEPARATOR_MODELS = {
    "BS-Roformer-ViperX-1297.ckpt":      "BS-Roformer ViperX",
    "Mel-Roformer-Viperx-De-Reverb.ckpt": "Mel-Roformer De-Reverb",
    "MDX23C-8KFFT-InstVoc_HQ.ckpt":       "MDX23C InstVoc HQ",
    "UVR-MDX-NET-Voc_FT.onnx":            "UVR-MDX-NET Vocal FT",
}
