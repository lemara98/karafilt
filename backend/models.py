"""Model registries and availability checks."""

# Check if audio-separator is available
try:
    from audio_separator.separator import Separator
    HAS_AUDIO_SEPARATOR = True
except ImportError:
    HAS_AUDIO_SEPARATOR = False


# Registry of available models with display info. Order matters: the first
# entry is the default and appears first in the picker. htdemucs is the
# quality sweet spot — fast enough for our worker pool to keep up and
# produces noticeably cleaner separation than the quantized variants.
DEMUCS_MODELS = {
    "htdemucs":     "Demucs Hybrid Transformer (default)",
    "htdemucs_ft":  "Demucs Fine-Tuned (highest quality, slow, high VRAM)",
    "mdx_extra":    "MDX-Net Extra",
    "mdx_extra_q":  "MDX-Net Extra Quantized (fastest, lower quality)",
}

# audio-separator models (only if package is installed)
SEPARATOR_MODELS = {
    "BS-Roformer-ViperX-1297.ckpt":      "BS-Roformer ViperX",
    "Mel-Roformer-Viperx-De-Reverb.ckpt": "Mel-Roformer De-Reverb",
    "MDX23C-8KFFT-InstVoc_HQ.ckpt":       "MDX23C InstVoc HQ",
    "UVR-MDX-NET-Voc_FT.onnx":            "UVR-MDX-NET Vocal FT",
}
