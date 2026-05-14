"""Forced alignment of plain-text lyrics to audio.

Pipeline:
  1. Optional: Demucs to isolate the vocal stem (drastically improves Whisper
     transcription on songs with backing instrumentation).
  2. WhisperX transcription with word-level timestamps (wav2vec2 forced alignment).
  3. Needleman-Wunsch sequence alignment between Whisper's transcript and the
     supplied ground-truth lyrics text. Whisper's text is unreliable on sung vocals
     but its TIMING is good — we project its timestamps onto the correct lyric words.
  4. Group projected words into lines using the source line breaks.

Returns a list of synced lines, each with optional per-word timestamps.

If whisperx is not installed, `align()` raises ImportError. Callers should treat
this as a soft failure (smart sync silently no-ops).
"""

import os
import re

import numpy as np
import torch

try:
    import whisperx
    HAS_WHISPERX = True
except ImportError:
    HAS_WHISPERX = False


WHISPER_MODEL_NAME = os.environ.get("KFL_WHISPER_MODEL", "base")
TARGET_SR = 16000

_whisper_model = None
_whisper_device = None


def _load_whisper(device):
    global _whisper_model, _whisper_device
    if _whisper_model is not None and _whisper_device == device:
        return _whisper_model
    compute_type = "float16" if device.startswith("cuda") else "int8"
    print(f"[aligner] loading WhisperX model '{WHISPER_MODEL_NAME}' on {device} ({compute_type})...")
    _whisper_model = whisperx.load_model(
        WHISPER_MODEL_NAME, device, compute_type=compute_type
    )
    _whisper_device = device
    return _whisper_model


def _normalize_word(w):
    return re.sub(r"[^a-z0-9']", "", (w or "").lower())


def _needleman_wunsch(a, b, match=2, mismatch=-1, gap=-2):
    """Global sequence alignment. Returns list of (i, j) pairs; either index may be None for a gap."""
    n, m = len(a), len(b)
    if n == 0:
        return [(None, j) for j in range(m)]
    if m == 0:
        return [(i, None) for i in range(n)]
    score = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        score[i][0] = i * gap
    for j in range(m + 1):
        score[0][j] = j * gap
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            mm = match if a[i - 1] == b[j - 1] and a[i - 1] != "" else mismatch
            score[i][j] = max(
                score[i - 1][j - 1] + mm,
                score[i - 1][j] + gap,
                score[i][j - 1] + gap,
            )
    pairs = []
    i, j = n, m
    while i > 0 and j > 0:
        mm = match if a[i - 1] == b[j - 1] and a[i - 1] != "" else mismatch
        if score[i][j] == score[i - 1][j - 1] + mm:
            pairs.append((i - 1, j - 1))
            i -= 1
            j -= 1
        elif score[i][j] == score[i - 1][j] + gap:
            pairs.append((i - 1, None))
            i -= 1
        else:
            pairs.append((None, j - 1))
            j -= 1
    while i > 0:
        pairs.append((i - 1, None))
        i -= 1
    while j > 0:
        pairs.append((None, j - 1))
        j -= 1
    pairs.reverse()
    return pairs


def _resample_to_16k(pcm, sr):
    if sr == TARGET_SR:
        return pcm.astype(np.float32, copy=False)
    import torchaudio
    t = torch.from_numpy(pcm).float()
    t = torchaudio.functional.resample(t, orig_freq=sr, new_freq=TARGET_SR)
    return t.numpy().astype(np.float32, copy=False)


def _isolate_vocals(pcm_mono, sr, demucs_backend, model_name="htdemucs_ft"):
    """Run Demucs on mono input and return the isolated vocal stem as mono float32."""
    # Demucs expects (channels, samples). Duplicate mono → stereo for the model.
    stereo = np.stack([pcm_mono, pcm_mono], axis=0)
    model = demucs_backend._get_model(model_name)
    audio = torch.from_numpy(stereo).float().unsqueeze(0).to(demucs_backend.device)
    if sr != model.samplerate:
        import torchaudio
        audio = torchaudio.functional.resample(audio, orig_freq=sr, new_freq=model.samplerate)
    sources = demucs_backend._apply(model, audio)
    vocals_idx = model.sources.index("vocals")
    vocals = sources[0, vocals_idx].cpu().numpy()  # shape: (2, N)
    # Mono mixdown
    mono = vocals.mean(axis=0)
    if sr != model.samplerate:
        import torchaudio
        mono_t = torch.from_numpy(mono).float().unsqueeze(0)
        mono_t = torchaudio.functional.resample(mono_t, orig_freq=model.samplerate, new_freq=sr)
        mono = mono_t.squeeze(0).numpy()
    return mono.astype(np.float32, copy=False)


def align(pcm_mono, sample_rate, lyrics, demucs_backend=None, device="cpu"):
    """Run forced alignment of `lyrics` to `pcm_mono` and return synced lines.

    Args:
        pcm_mono: 1-D numpy float32 array of mono audio samples.
        sample_rate: sample rate of pcm_mono.
        lyrics: plain-text lyrics with newline-separated lines.
        demucs_backend: optional DemucsBackend instance for vocal isolation.
        device: "cpu" or "cuda".

    Returns:
        list[dict]: synced lines in the form
            [{"time": float, "text": str, "words": [{"t": float, "w": str}, ...]}, ...]
    """
    if not HAS_WHISPERX:
        raise ImportError("whisperx is not installed; install it to enable smart sync")

    audio = pcm_mono.astype(np.float32, copy=False)

    # 1. Vocal isolation (best-effort)
    if demucs_backend is not None:
        try:
            print(f"[aligner] isolating vocals via Demucs ({len(audio) / sample_rate:.1f}s)...")
            audio = _isolate_vocals(audio, sample_rate, demucs_backend)
        except Exception as e:
            print(f"[aligner] Demucs vocal isolation failed, using raw mix: {e}")

    # 2. Resample to 16kHz for WhisperX
    audio_16k = _resample_to_16k(audio, sample_rate)

    # 3. WhisperX transcription + word-level alignment
    model = _load_whisper(device)
    print(f"[aligner] transcribing {len(audio_16k) / TARGET_SR:.1f}s of audio...")
    result = model.transcribe(audio_16k, batch_size=8)
    lang = result.get("language", "en")

    print(f"[aligner] aligning words (language={lang})...")
    align_model, align_meta = whisperx.load_align_model(language_code=lang, device=device)
    aligned = whisperx.align(
        result["segments"], align_model, align_meta, audio_16k, device,
        return_char_alignments=False,
    )

    whisper_words = []
    for seg in aligned.get("segments", []):
        for w in seg.get("words", []):
            if "start" in w and "end" in w and "word" in w:
                whisper_words.append({
                    "t": (w["start"] + w["end"]) / 2.0,
                    "start": w["start"],
                    "raw": w["word"],
                })
    if not whisper_words:
        raise RuntimeError("WhisperX produced no word-level timestamps")

    # 4. Tokenize ground-truth lyrics, preserving line indices
    raw_lines = [ln for ln in lyrics.split("\n")]
    truth_lines = []
    truth_words = []  # list of dicts {line: int, raw: str, t: float|None}
    for li, line in enumerate(raw_lines):
        tokens = line.split()
        if not tokens:
            continue
        truth_lines.append({"index": li, "text": line.strip(), "word_start": len(truth_words)})
        for tok in tokens:
            truth_words.append({"line_idx": len(truth_lines) - 1, "raw": tok, "t": None})
        truth_lines[-1]["word_end"] = len(truth_words)

    if not truth_words:
        return []

    # 5. Needleman-Wunsch alignment between Whisper's transcript and the truth
    a_norm = [_normalize_word(w["raw"]) for w in whisper_words]
    b_norm = [_normalize_word(w["raw"]) for w in truth_words]
    pairs = _needleman_wunsch(a_norm, b_norm)

    # 6. Project timestamps from matched whisper words → truth words
    for (i, j) in pairs:
        if i is None or j is None:
            continue
        if a_norm[i] and a_norm[i] == b_norm[j]:
            truth_words[j]["t"] = whisper_words[i]["start"]

    # 7. Interpolate timestamps for unmatched truth words (linear between known anchors)
    known = [k for k, w in enumerate(truth_words) if w["t"] is not None]
    if not known:
        raise RuntimeError("No matching words between Whisper and ground truth — alignment failed")

    # Fill leading unknowns with the first known timestamp
    for k in range(0, known[0]):
        truth_words[k]["t"] = truth_words[known[0]]["t"]
    # Fill trailing unknowns with the last known timestamp
    for k in range(known[-1] + 1, len(truth_words)):
        truth_words[k]["t"] = truth_words[known[-1]]["t"]
    # Linear interpolation between consecutive anchors
    for a, b in zip(known, known[1:]):
        if b - a <= 1:
            continue
        t0, t1 = truth_words[a]["t"], truth_words[b]["t"]
        for k in range(a + 1, b):
            frac = (k - a) / (b - a)
            truth_words[k]["t"] = t0 + frac * (t1 - t0)

    # 8. Group into output lines
    out = []
    for line in truth_lines:
        words_in_line = truth_words[line["word_start"]:line["word_end"]]
        if not words_in_line:
            continue
        line_time = words_in_line[0]["t"]
        out.append({
            "time": float(line_time),
            "text": line["text"],
            "words": [{"t": float(w["t"]), "w": w["raw"]} for w in words_in_line],
        })

    # Ensure monotonic line times (occasional dips can happen near misaligned regions)
    for i in range(1, len(out)):
        if out[i]["time"] < out[i - 1]["time"]:
            out[i]["time"] = out[i - 1]["time"] + 0.01

    print(f"[aligner] produced {len(out)} synced lines from {len(truth_words)} words "
          f"({len(known)} matched directly to Whisper).")
    return out
