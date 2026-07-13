// Alignment tap — a passive observer worklet for the listen-along lyrics
// aligner. It runs as a SEPARATE AudioWorkletNode branched off the capture
// source, so it never touches the vocal-remove processor or its WASM DSP.
//
// It reduces the raw tab audio to a coarse "vocal activity" envelope: the
// mid channel (L+R)/2 — where lead vocals live — band-limited to the vocal
// range, RMS-summarized per 512-sample block (~10.7ms @ 48k). Batches of
// blocks are posted to the offscreen page tagged with their absolute
// context sample position, so the page can map them onto media time.
//
// Cost: a few multiplies per sample. If the page-side consumer stalls, the
// only effect is dropped envelope batches — playback audio is unaffected.

const BLOCK_SIZE = 512;
const BLOCKS_PER_BATCH = 64; // ~0.68s per message @ 48k

class AlignmentTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // One-pole high-pass (~150 Hz) + one-pole low-pass (~4 kHz) on the mid
    // channel. Crude but plenty for an energy envelope.
    this.hpAlpha = Math.exp((-2 * Math.PI * 150) / sampleRate);
    this.lpBeta = 1 - Math.exp((-2 * Math.PI * 4000) / sampleRate);
    this.hpY = 0;
    this.hpPrevX = 0;
    this.lpY = 0;

    this.blockSum = 0;
    this.blockFill = 0;
    this.batch = new Float32Array(BLOCKS_PER_BATCH);
    this.batchFill = 0;
    this.batchStartSample = -1; // context-absolute sample of the batch's first block
    this.blockStartSample = -1;
  }

  process(inputs) {
    const input = inputs[0];
    const left = input && input[0];
    const right = input && input[1];
    const frames = 128; // render quantum

    for (let i = 0; i < frames; i++) {
      const l = left ? left[i] : 0;
      const r = right ? right[i] : left ? left[i] : 0;
      const mid = (l + r) * 0.5;

      // HP then LP
      this.hpY = this.hpAlpha * (this.hpY + mid - this.hpPrevX);
      this.hpPrevX = mid;
      this.lpY += this.lpBeta * (this.hpY - this.lpY);

      if (this.blockFill === 0) this.blockStartSample = currentFrame + i;
      this.blockSum += this.lpY * this.lpY;
      this.blockFill++;

      if (this.blockFill === BLOCK_SIZE) {
        const rms = Math.sqrt(this.blockSum / BLOCK_SIZE);
        if (this.batchFill === 0) this.batchStartSample = this.blockStartSample;
        this.batch[this.batchFill++] = rms;
        this.blockSum = 0;
        this.blockFill = 0;

        if (this.batchFill === BLOCKS_PER_BATCH) {
          const out = this.batch;
          this.port.postMessage(
            {
              type: "ENERGY",
              startSample: this.batchStartSample,
              blockSize: BLOCK_SIZE,
              sampleRate,
              rms: out,
            },
            [out.buffer]
          );
          this.batch = new Float32Array(BLOCKS_PER_BATCH);
          this.batchFill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("alignment-tap", AlignmentTapProcessor);
