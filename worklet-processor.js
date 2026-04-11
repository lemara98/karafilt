class VocalRemoveProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.ready = false;
    this.mix = 1.0;
    this.mode = "stft"; // "basic" or "stft"

    this.port.onmessage = (event) => {
      const d = event.data;
      if (d.type === "SET_MIX") {
        this.mix = d.value;
        // Update STFT attenuation if in stft mode
        if (this.ready && this.exports.stft_set_attenuation) {
          this.exports.stft_set_attenuation(d.value);
        }
      }
      if (d.type === "SET_MODE") {
        this.mode = d.value;
      }
    };

    const wasmModule = options.processorOptions.wasmModule;
    const sr = options.processorOptions.sampleRate || 48000;
    this.sampleRateValue = sr;
    this._initWasm(wasmModule);
  }

  async _initWasm(wasmModule) {
    const imports = [
      // Try with common Emscripten stubs
      {
        env: { emscripten_notify_memory_growth: () => {} },
        wasi_snapshot_preview1: {
          proc_exit: () => {},
          fd_write: () => 0,
          fd_seek: () => 0,
          fd_close: () => 0,
        },
      },
      // Minimal fallback
      { env: {} },
    ];

    for (const importObj of imports) {
      try {
        this.instance = await WebAssembly.instantiate(wasmModule, importObj);
        this.exports = this.instance.exports;
        this.memory = this.exports.memory;
        break;
      } catch (e) {
        continue;
      }
    }

    if (!this.exports) {
      console.error("WASM init failed with all import variants");
      return;
    }

    // Init Phase 1 (center cancel) buffers
    this.exports.init(128);
    this.ccInputLPtr = this.exports.get_input_buffer_l();
    this.ccInputRPtr = this.exports.get_input_buffer_r();
    this.ccOutputLPtr = this.exports.get_output_buffer_l();
    this.ccOutputRPtr = this.exports.get_output_buffer_r();

    // Init Phase 2 (STFT)
    this.exports.stft_init(this.sampleRateValue);
    this.exports.stft_set_attenuation(this.mix);
    this.stftInputLPtr = this.exports.stft_get_input_l();
    this.stftInputRPtr = this.exports.stft_get_input_r();
    this.stftOutputLPtr = this.exports.stft_get_output_l();
    this.stftOutputRPtr = this.exports.stft_get_output_r();

    this._updateViews();
    this.ready = true;
  }

  _updateViews() {
    const buf = this.memory.buffer;
    // Phase 1 views
    this.ccInL = new Float32Array(buf, this.ccInputLPtr, 128);
    this.ccInR = new Float32Array(buf, this.ccInputRPtr, 128);
    this.ccOutL = new Float32Array(buf, this.ccOutputLPtr, 128);
    this.ccOutR = new Float32Array(buf, this.ccOutputRPtr, 128);
    // Phase 2 views
    this.stftInL = new Float32Array(buf, this.stftInputLPtr, 128);
    this.stftInR = new Float32Array(buf, this.stftInputRPtr, 128);
    this.stftOutL = new Float32Array(buf, this.stftOutputLPtr, 128);
    this.stftOutR = new Float32Array(buf, this.stftOutputRPtr, 128);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) return true;

    // Pass through while WASM loads
    if (!this.ready) {
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].set(input[Math.min(ch, input.length - 1)]);
      }
      return true;
    }

    const numSamples = input[0].length;
    const leftIn = input[0];
    const rightIn = input.length > 1 ? input[1] : input[0];

    if (this.mode === "passthrough_muted") {
      // AI mode: output silence (processed audio plays via AudioBufferSource)
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].fill(0);
      }
    } else if (this.mode === "stft") {
      // STFT spectral processing
      this.stftInL.set(leftIn);
      this.stftInR.set(rightIn);
      this.exports.stft_process(numSamples);
      output[0].set(this.stftOutL);
      if (output.length > 1) output[1].set(this.stftOutR);
    } else {
      // Basic center-channel cancellation
      this.ccInL.set(leftIn);
      this.ccInR.set(rightIn);
      this.exports.process_center_cancel(numSamples, this.mix);
      output[0].set(this.ccOutL);
      if (output.length > 1) output[1].set(this.ccOutR);
    }

    return true;
  }
}

registerProcessor("vocal-remove-processor", VocalRemoveProcessor);
