#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "kiss_fft.h"
#include "kiss_fftr.h"

/*
 * STFT-based vocal removal.
 *
 * Strategy: accumulate input into overlapping frames, FFT each frame,
 * attenuate center-panned energy only in vocal frequency bins,
 * IFFT and overlap-add back to continuous output.
 */

#define FFT_SIZE     2048
#define HOP_SIZE     512
#define OVERLAP      (FFT_SIZE / HOP_SIZE)  /* 4 */
#define NUM_BINS     (FFT_SIZE / 2 + 1)
#define OLA_SIZE     16384  /* output overlap-add buffer, power of 2 */
#define OLA_MASK     (OLA_SIZE - 1)

/* Input accumulation buffer (one full frame per channel) */
static float in_buf_l[FFT_SIZE];
static float in_buf_r[FFT_SIZE];
static int in_count = 0;           /* samples in current hop block */
static int frames_ready = 0;       /* have we filled at least one full frame? */
static int hop_count = 0;          /* how many hops we've accumulated */

/* Output overlap-add ring buffer */
static float ola_l[OLA_SIZE];
static float ola_r[OLA_SIZE];
static int ola_write = 0;          /* where next frame's overlap-add starts */
static int ola_read = 0;           /* where output pulls from */

/* FFT state */
static kiss_fftr_cfg fft_fwd = NULL;
static kiss_fftr_cfg fft_inv = NULL;

/* Scratch buffers */
static float window[FFT_SIZE];
static float frame_l[FFT_SIZE];
static float frame_r[FFT_SIZE];
static float ifft_l[FFT_SIZE];
static float ifft_r[FFT_SIZE];
static kiss_fft_cpx spec_l[NUM_BINS];
static kiss_fft_cpx spec_r[NUM_BINS];

/* Parameters */
/* Soft taper band edges (Hz):
 * below ramp_lo_hz: untouched (bass protection)
 * ramp_lo_hz..full_lo_hz: attenuation ramps 0 -> 1
 * full_lo_hz..full_hi_hz: full attenuation envelope
 * full_hi_hz..ramp_hi_hz: attenuation ramps 1 -> 0 */
static float ramp_lo_hz = 90.0f;
static float full_lo_hz = 160.0f;    /* protects kick/bass fundamentals */
static float full_hi_hz = 9000.0f;
static float ramp_hi_hz = 12000.0f;  /* catches sibilance/air */
static float centerness_exponent = 1.5f;  /* >1 sharpens the center mask */
/* "Spectral Deep" depth: 0 = strict center cancellation (lead vocal only),
 * up to ~0.85 — relaxes the centerness mask and widens the band to also catch
 * center/near-center backing vocals + doubled leads (thinner instrumental). */
static float depth = 0.0f;

/* legacy fields kept so stft_set_vocal_range stays export-safe (now inert) */
static float vocal_low_hz = 100.0f;
static float vocal_high_hz = 8000.0f;
static float attenuation = 0.85f;
static float sample_rate_hz = 48000.0f;

/* IO buffers for the worklet (128 samples each) */
#define MAX_BLOCK 512
static float io_in_l[MAX_BLOCK];
static float io_in_r[MAX_BLOCK];
static float io_out_l[MAX_BLOCK];
static float io_out_r[MAX_BLOCK];

/* Latency: one full FFT frame of delay */
static int latency_remaining = 0;

static void build_window(void) {
    for (int i = 0; i < FFT_SIZE; i++) {
        window[i] = 0.5f * (1.0f - cosf(2.0f * 3.14159265358979f * i / FFT_SIZE));
    }
}

/* Raised-cosine ramp: 0 below x=0, 1 above x=1, smooth in between. */
static inline float taper_ramp(float x) {
    if (x <= 0.0f) return 0.0f;
    if (x >= 1.0f) return 1.0f;
    return 0.5f * (1.0f - cosf(3.14159265358979f * x));
}

/* Per-bin frequency weight from the soft band edges (0 = untouched, 1 = full). */
static float band_weight(float freq_hz) {
    /* Deep mode lowers the full-attenuation low edge to catch more low-mid vocal
     * (160 -> ~120 Hz at depth=1) while ramp_lo_hz still protects the deep bass. */
    float flo = full_lo_hz - depth * 40.0f;
    if (freq_hz <= ramp_lo_hz || freq_hz >= ramp_hi_hz) return 0.0f;
    if (freq_hz < flo)
        return taper_ramp((freq_hz - ramp_lo_hz) / (flo - ramp_lo_hz));
    if (freq_hz > full_hi_hz)
        return taper_ramp((ramp_hi_hz - freq_hz) / (ramp_hi_hz - full_hi_hz));
    return 1.0f;
}

static void process_one_frame(void) {
    /* Apply analysis window */
    for (int i = 0; i < FFT_SIZE; i++) {
        frame_l[i] = in_buf_l[i] * window[i];
        frame_r[i] = in_buf_r[i] * window[i];
    }

    /* Forward FFT */
    kiss_fftr(fft_fwd, frame_l, spec_l);
    kiss_fftr(fft_fwd, frame_r, spec_r);

    /* Frequency-selective, pan-and-coherence-weighted center cancellation.
     * A bin is only attenuated to the degree it is BOTH level-balanced and
     * phase-coherent between L/R — i.e. genuinely center-panned, like a lead
     * vocal — so hard-panned instruments and reverb in the vocal range survive. */
    const float bin_hz = sample_rate_hz / (float)FFT_SIZE;
    const float EPS = 1e-9f;

    for (int k = 1; k < NUM_BINS; k++) {  /* k=0 (DC) skipped -> bass protection */
        float fw = band_weight((float)k * bin_hz);
        if (fw <= 0.0f) continue;          /* outside soft band: bin untouched */

        float lr = spec_l[k].r, li = spec_l[k].i;
        float rr = spec_r[k].r, ri = spec_r[k].i;

        float mag_l = sqrtf(lr * lr + li * li);
        float mag_r = sqrtf(rr * rr + ri * ri);

        /* magnitude balance: 1 when |L|==|R|, ->0 when one side dominates */
        float bal = (2.0f * mag_l * mag_r) / (mag_l * mag_l + mag_r * mag_r + EPS);

        /* phase coherence: cos(phase diff) = Re{L*conj(R)} / (|L||R|) */
        float dot = lr * rr + li * ri;
        float coh = dot / (mag_l * mag_r + EPS);
        if (coh < 0.0f) coh = 0.0f;
        if (coh > 1.0f) coh = 1.0f;

        /* Deep mode lowers the exponent so partially-center bins (backing
         * vocals, doubled leads) are attenuated too — not just dead-center leads. */
        float cexp = centerness_exponent - depth * 0.9f;   /* 1.5 -> ~0.6 at depth=1 */
        float centerness = powf(bal * coh, cexp);

        float eff_atten = attenuation * fw * centerness;
        if (eff_atten <= 0.0f) continue;
        float keep = 1.0f - eff_atten;

        float mid_r = (lr + rr) * 0.5f;
        float mid_i = (li + ri) * 0.5f;
        spec_l[k].r = (lr - mid_r) + mid_r * keep;
        spec_l[k].i = (li - mid_i) + mid_i * keep;
        spec_r[k].r = (rr - mid_r) + mid_r * keep;
        spec_r[k].i = (ri - mid_i) + mid_i * keep;
    }

    /* Inverse FFT */
    kiss_fftri(fft_inv, spec_l, ifft_l);
    kiss_fftri(fft_inv, spec_r, ifft_r);

    /* Apply synthesis window, normalize, and overlap-add into output ring */
    float norm = 1.0f / FFT_SIZE;
    for (int i = 0; i < FFT_SIZE; i++) {
        int idx = (ola_write + i) & OLA_MASK;
        ola_l[idx] += ifft_l[i] * norm * window[i];
        ola_r[idx] += ifft_r[i] * norm * window[i];
    }

    /* Advance write pointer by one hop */
    ola_write = (ola_write + HOP_SIZE) & OLA_MASK;
}

static void push_sample(float l, float r) {
    /* Shift the input buffer left by 1 sample and append new sample at end.
     * This is done efficiently: we only shift on hop boundaries. */
    in_buf_l[FFT_SIZE - HOP_SIZE + in_count] = l;
    in_buf_r[FFT_SIZE - HOP_SIZE + in_count] = r;
    in_count++;

    if (in_count >= HOP_SIZE) {
        /* We have a full hop of new samples */
        hop_count++;

        if (hop_count >= OVERLAP) {
            /* We have enough data for a full frame, process it */
            frames_ready = 1;
            process_one_frame();
        }

        /* Shift buffer: move last (FFT_SIZE - HOP_SIZE) samples to the front */
        memmove(in_buf_l, in_buf_l + HOP_SIZE, (FFT_SIZE - HOP_SIZE) * sizeof(float));
        memmove(in_buf_r, in_buf_r + HOP_SIZE, (FFT_SIZE - HOP_SIZE) * sizeof(float));
        in_count = 0;
    }
}

/* --- Exported API --- */

void stft_init(int sr) {
    sample_rate_hz = (float)sr;

    memset(in_buf_l, 0, sizeof(in_buf_l));
    memset(in_buf_r, 0, sizeof(in_buf_r));
    memset(ola_l, 0, sizeof(ola_l));
    memset(ola_r, 0, sizeof(ola_r));
    in_count = 0;
    hop_count = 0;
    frames_ready = 0;
    ola_write = 0;
    ola_read = 0;

    if (fft_fwd) { free(fft_fwd); fft_fwd = NULL; }
    if (fft_inv) { free(fft_inv); fft_inv = NULL; }

    fft_fwd = kiss_fftr_alloc(FFT_SIZE, 0, NULL, NULL);
    fft_inv = kiss_fftr_alloc(FFT_SIZE, 1, NULL, NULL);

    build_window();

    /* Latency = FFT_SIZE samples (time for first OVERLAP hops to accumulate) */
    latency_remaining = FFT_SIZE;
}

float *stft_get_input_l(void)  { return io_in_l; }
float *stft_get_input_r(void)  { return io_in_r; }
float *stft_get_output_l(void) { return io_out_l; }
float *stft_get_output_r(void) { return io_out_r; }

void stft_process(int num_samples) {
    /* Push all input samples */
    for (int i = 0; i < num_samples; i++) {
        push_sample(io_in_l[i], io_in_r[i]);
    }

    /* Pull output samples from the overlap-add buffer */
    for (int i = 0; i < num_samples; i++) {
        if (latency_remaining > 0) {
            /* Still in initial buffering period — output silence */
            io_out_l[i] = 0.0f;
            io_out_r[i] = 0.0f;
            latency_remaining--;
        } else {
            io_out_l[i] = ola_l[ola_read & OLA_MASK];
            io_out_r[i] = ola_r[ola_read & OLA_MASK];
            /* Clear for next overlap-add cycle */
            ola_l[ola_read & OLA_MASK] = 0.0f;
            ola_r[ola_read & OLA_MASK] = 0.0f;
            ola_read = (ola_read + 1) & OLA_MASK;
        }
    }
}

void stft_set_attenuation(float a) {
    if (a < 0.0f) a = 0.0f;
    if (a > 1.0f) a = 1.0f;
    attenuation = a;
}

/* 0 = Spectral (strict center). ~0.85 = Spectral Deep (catches center backing
 * vocals). Relaxes the centerness mask + widens the vocal band. */
void stft_set_depth(float d) {
    if (d < 0.0f) d = 0.0f;
    if (d > 1.0f) d = 1.0f;
    depth = d;
}

void stft_set_vocal_range(float low, float high) {
    vocal_low_hz = low;
    vocal_high_hz = high;
}

void stft_cleanup(void) {
    if (fft_fwd) { free(fft_fwd); fft_fwd = NULL; }
    if (fft_inv) { free(fft_inv); fft_inv = NULL; }
}

/* Phase 1 center-cancel (backward compat) */
static float *cc_in_l = NULL, *cc_in_r = NULL;
static float *cc_out_l = NULL, *cc_out_r = NULL;

/* One-pole low-pass state for basic-mode bass protection. The center-cancel is
 * applied only to the high-passed signal; the low-passed remainder is added
 * back untouched, so kick/bass survive and mix==0 stays bit-exact passthrough. */
static float bp_cutoff_hz = 150.0f;
static float bp_lp_l = 0.0f, bp_lp_r = 0.0f;
static float bp_coeff = 0.0f;
static float bp_sr = 0.0f;            /* 0 forces a coefficient recompute */

static void bp_update_coeff(void) {
    if (bp_sr == sample_rate_hz) return;
    bp_sr = sample_rate_hz;
    float dt = 1.0f / bp_sr;
    float rc = 1.0f / (2.0f * 3.14159265358979f * bp_cutoff_hz);
    bp_coeff = dt / (rc + dt);
}

void init(int max_block_size) {
    cc_in_l  = (float *)malloc(max_block_size * sizeof(float));
    cc_in_r  = (float *)malloc(max_block_size * sizeof(float));
    cc_out_l = (float *)malloc(max_block_size * sizeof(float));
    cc_out_r = (float *)malloc(max_block_size * sizeof(float));

    bp_lp_l = 0.0f;
    bp_lp_r = 0.0f;
    bp_sr = 0.0f;  /* recompute coefficient on first process call */
}

float *get_input_buffer_l(void)  { return cc_in_l; }
float *get_input_buffer_r(void)  { return cc_in_r; }
float *get_output_buffer_l(void) { return cc_out_l; }
float *get_output_buffer_r(void) { return cc_out_r; }

void process_center_cancel(int num_samples, float mix) {
    bp_update_coeff();
    for (int i = 0; i < num_samples; i++) {
        float l = cc_in_l[i];
        float r = cc_in_r[i];

        /* one-pole low-pass = protected bass content */
        bp_lp_l += bp_coeff * (l - bp_lp_l);
        bp_lp_r += bp_coeff * (r - bp_lp_r);
        if (fabsf(bp_lp_l) < 1e-15f) bp_lp_l = 0.0f;  /* denormal guard */
        if (fabsf(bp_lp_r) < 1e-15f) bp_lp_r = 0.0f;

        float low_l = bp_lp_l, low_r = bp_lp_r;
        float high_l = l - low_l, high_r = r - low_r;

        /* fully-wet signal: protected bass + center-cancelled high band */
        float side_l = (high_l - high_r) * 0.5f;
        float side_r = (high_r - high_l) * 0.5f;
        float wet_l = low_l + side_l;
        float wet_r = low_r + side_r;

        /* dry/wet blend — mix==0 is bit-exact passthrough */
        cc_out_l[i] = l * (1.0f - mix) + wet_l * mix;
        cc_out_r[i] = r * (1.0f - mix) + wet_r * mix;
    }
}

void cleanup(void) {
    free(cc_in_l); free(cc_in_r);
    free(cc_out_l); free(cc_out_r);
    cc_in_l = cc_in_r = cc_out_l = cc_out_r = NULL;
    stft_cleanup();
}
