"""Model registries and availability checks."""

# Check if audio-separator is available
try:
    from audio_separator.separator import Separator
    HAS_AUDIO_SEPARATOR = True
except ImportError:
    HAS_AUDIO_SEPARATOR = False


# Registry of available models with display info
DEMUCS_MODELS = {
    "htdemucs":     "Demucs Hybrid Transformer (recommended)",
    "htdemucs_ft":  "Demucs Fine-Tuned (slow, high VRAM)",
    "mdx_extra":    "MDX-Net Extra",
    "mdx_extra_q":  "MDX-Net Extra (quantized, faster)",
}

# audio-separator models (only if package is installed)
SEPARATOR_MODELS = {
    "BS-Roformer-ViperX-1297.ckpt":      "BS-Roformer ViperX",
    "Mel-Roformer-Viperx-De-Reverb.ckpt": "Mel-Roformer De-Reverb",
    "MDX23C-8KFFT-InstVoc_HQ.ckpt":       "MDX23C InstVoc HQ",
    "UVR-MDX-NET-Voc_FT.onnx":            "UVR-MDX-NET Vocal FT",
}
