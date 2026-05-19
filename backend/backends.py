"""Separation backends: Demucs, audio-separator, and the unified ModelManager."""

import os
import tempfile
import threading

import numpy as np
import torch
import torchaudio
from demucs.pretrained import get_model
from demucs.apply import apply_model

from models import (
    DEMUCS_MODELS,
    SEPARATOR_MODELS,
    HAS_AUDIO_SEPARATOR,
)

if HAS_AUDIO_SEPARATOR:
    from audio_separator.separator import Separator


class DemucsBackend:
    """Handles separation using Demucs models."""

    # Internal processing segment (seconds). Default htdemucs uses ~7.8s, which
    # peaks near 2 GB on GPU. 3s keeps peak memory ~1 GB — fits comfortably in 2 GB cards.
    SEGMENT_SECONDS = 3.0

    def __init__(self, device):
        self.device = torch.device(device)
        self.models = {}  # lazy cache: model_name -> loaded model
        # Serializes the lazy first-load so concurrent workers don't all
        # allocate a fresh copy of the model on the GPU (which exhausts VRAM
        # and triggers CPU fallback for everyone).
        self._load_lock = threading.Lock()
        # Serializes GPU inference (apply_model) across workers. CUDA already
        # serializes ops on the default stream, so parallel apply_model calls
        # don't speed up — they only multiply working memory and cause OOM.
        # Workers still run CPU prep/post in parallel; the GPU work itself
        # is one-at-a-time.
        self._inference_lock = threading.Lock()

    def _get_model(self, model_name):
        # Fast path: model already cached.
        cached = self.models.get(model_name)
        if cached is not None:
            return cached
        # Slow path: acquire the lock and double-check, then load. Only one
        # thread does the GPU allocation; the others just wait and reuse.
        with self._load_lock:
            cached = self.models.get(model_name)
            if cached is not None:
                return cached
            print(f"Loading Demucs model '{model_name}' on {self.device}...")
            model = get_model(model_name)
            try:
                model.to(self.device)
            except torch.cuda.OutOfMemoryError:
                # OOM while moving the model onto the GPU — degrade to CPU
                # instead of crashing, mirroring the inference-path fallback.
                torch.cuda.empty_cache()
                self._fall_back_to_cpu()
                model.to(self.device)
            model.eval()
            self.models[model_name] = model
            print(f"  Loaded. Sample rate: {model.samplerate} Hz, sources: {model.sources}")
            return model

    def _fall_back_to_cpu(self):
        """Move all loaded models to CPU after a GPU OOM. Persists for the session."""
        print("  ⚠ GPU out of memory — falling back to CPU for remaining requests.")
        self.device = torch.device("cpu")
        for model in self.models.values():
            model.to(self.device)
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def _apply(self, model, audio):
        """Run apply_model with smaller segments and automatic CPU fallback on OOM."""
        kwargs = dict(progress=False, overlap=0.25, shifts=1,
                      split=True, segment=self.SEGMENT_SECONDS)
        with self._inference_lock:
            try:
                with torch.no_grad():
                    return apply_model(model, audio, **kwargs)
            except torch.cuda.OutOfMemoryError:
                torch.cuda.empty_cache()
                self._fall_back_to_cpu()
                audio = audio.to(self.device)
                with torch.no_grad():
                    return apply_model(model, audio, **kwargs)

    def process(self, pcm_float32, input_sr, model_name="htdemucs", two_pass=False):
        model = self._get_model(model_name)
        sr = model.samplerate

        audio = torch.from_numpy(pcm_float32).float()
        if input_sr != sr:
            audio = torchaudio.functional.resample(audio, orig_freq=input_sr, new_freq=sr)

        audio = audio.unsqueeze(0).to(self.device)

        sources = self._apply(model, audio)

        source_names = model.sources
        vocals_idx = source_names.index("vocals")
        other_idx = source_names.index("other")

        accompaniment = torch.zeros_like(sources[0, 0])
        for i in range(len(source_names)):
            if i != vocals_idx:
                if i == other_idx and two_pass:
                    other_stem = sources[0, other_idx].unsqueeze(0)
                    other_sources = self._apply(model, other_stem)
                    for j in range(len(source_names)):
                        if j != vocals_idx:
                            accompaniment += other_sources[0, j]
                    print("  Pass 2: removed backing vocals from 'other' stem")
                else:
                    accompaniment += sources[0, i]

        accompaniment = accompaniment.cpu()

        # Release GPU memory between chunks to prevent fragmentation buildup
        if self.device.type == "cuda":
            del sources
            torch.cuda.empty_cache()

        # Loudness matching: scale accompaniment so its RMS matches the original mix
        original_rms = audio.squeeze(0).cpu().float().pow(2).mean().sqrt().item()
        acc_rms = accompaniment.float().pow(2).mean().sqrt().item()
        if acc_rms > 1e-6:
            gain = original_rms / acc_rms
            # Clamp to avoid extreme amplification on near-silent segments
            gain = min(gain, 6.0)
            accompaniment = accompaniment * gain
            print(f"  Loudness matching: gain={gain:.2f}x (original RMS={original_rms:.4f}, acc RMS={acc_rms:.4f})")

        if input_sr != sr:
            accompaniment = torchaudio.functional.resample(
                accompaniment, orig_freq=sr, new_freq=input_sr
            )

        return accompaniment.numpy()


class AudioSeparatorBackend:
    """Handles separation using audio-separator models (BS-Roformer, Mel-Roformer, etc.)."""

    def __init__(self, device):
        self.device = "cuda" if "cuda" in device else "cpu"
        self.separators = {}  # lazy cache

    def _get_separator(self, model_name):
        if model_name not in self.separators:
            print(f"Loading audio-separator model '{model_name}'...")
            sep = Separator(
                output_dir=tempfile.mkdtemp(),
                output_format="FLOAT",
            )
            sep.load_model(model_filename=model_name)
            self.separators[model_name] = sep
            print(f"  Loaded.")
        return self.separators[model_name]

    def process(self, pcm_float32, input_sr, model_name, two_pass=False):
        sep = self._get_separator(model_name)

        # audio-separator works with file paths, so write a temp wav
        tmp_in = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        try:
            audio_tensor = torch.from_numpy(pcm_float32).float()
            torchaudio.save(tmp_in.name, audio_tensor, input_sr)
            tmp_in.close()

            # Separate — returns list of output file paths
            # First output is typically instrumental, second is vocals
            output_files = sep.separate(tmp_in.name)

            # Load the instrumental (first output)
            accompaniment, out_sr = torchaudio.load(output_files[0])

            # Loudness matching: scale accompaniment so its RMS matches the original mix
            original_rms = audio_tensor.float().pow(2).mean().sqrt().item()
            acc_rms = accompaniment.float().pow(2).mean().sqrt().item()
            if acc_rms > 1e-6:
                gain = original_rms / acc_rms
                gain = min(gain, 6.0)
                accompaniment = accompaniment * gain
                print(f"  Loudness matching: gain={gain:.2f}x")

            accompaniment = accompaniment.numpy()

            if out_sr != input_sr:
                acc_tensor = torch.from_numpy(accompaniment)
                acc_tensor = torchaudio.functional.resample(
                    acc_tensor, orig_freq=out_sr, new_freq=input_sr
                )
                accompaniment = acc_tensor.numpy()

            # Clean up temp files
            for f in output_files:
                try:
                    os.unlink(f)
                except OSError:
                    pass

            return accompaniment
        finally:
            try:
                os.unlink(tmp_in.name)
            except OSError:
                pass


class ModelManager:
    """Manages all backends and routes processing to the right one."""

    def __init__(self, device):
        self.device = device
        self.demucs = DemucsBackend(device)
        self.audio_sep = AudioSeparatorBackend(device) if HAS_AUDIO_SEPARATOR else None

    def get_available_models(self):
        models = {}
        for key, label in DEMUCS_MODELS.items():
            models[key] = {"label": label, "backend": "demucs"}
        if HAS_AUDIO_SEPARATOR:
            for key, label in SEPARATOR_MODELS.items():
                models[key] = {"label": label, "backend": "audio-separator"}
        return models

    def process(self, pcm_float32, input_sr, model_name, two_pass=False):
        if model_name in DEMUCS_MODELS:
            return self.demucs.process(pcm_float32, input_sr, model_name, two_pass)
        elif HAS_AUDIO_SEPARATOR and model_name in SEPARATOR_MODELS:
            return self.audio_sep.process(pcm_float32, input_sr, model_name, two_pass)
        else:
            print(f"Unknown model '{model_name}', falling back to htdemucs")
            return self.demucs.process(pcm_float32, input_sr, "htdemucs", two_pass)
