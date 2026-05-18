/*
 * Native numerical test harness for the client-side vocal-removal DSP.
 *
 * NOT part of the shipped extension and NOT wired into the Makefile. Compile
 * against the real DSP sources and run to validate the algorithm:
 *
 *   gcc -O2 -I wasm/src wasm/test/dsp_test.c wasm/src/vocal_remove_stft.c \
 *       wasm/src/kiss_fft.c wasm/src/kiss_fftr.c -lm -o /tmp/dsp_test
 *   /tmp/dsp_test
 */
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>

/* --- DSP public API (from vocal_remove_stft.c) --- */
void   init(int max_block_size);
float *get_input_buffer_l(void);
float *get_input_buffer_r(void);
float *get_output_buffer_l(void);
float *get_output_buffer_r(void);
void   process_center_cancel(int num_samples, float mix);

void   stft_init(int sr);
float *stft_get_input_l(void);
float *stft_get_input_r(void);
float *stft_get_output_l(void);
float *stft_get_output_r(void);
void   stft_process(int num_samples);
void   stft_set_attenuation(float a);

#define SR        48000
#define BLOCK     128
#define STFT_LAT  2048   /* FFT_SIZE: initial silence from stft_process */

static int failures = 0;

static void check(const char *name, int pass, const char *detail) {
    printf("  [%s] %s%s%s\n", pass ? "PASS" : "FAIL", name,
           detail ? " — " : "", detail ? detail : "");
    if (!pass) failures++;
}

static float rms(const float *x, int n) {
    double acc = 0.0;
    for (int i = 0; i < n; i++) acc += (double)x[i] * (double)x[i];
    return (float)sqrt(acc / (n > 0 ? n : 1));
}

static int has_bad(const float *x, int n) {
    for (int i = 0; i < n; i++) if (!isfinite(x[i])) return 1;
    return 0;
}

/* Run a stereo signal through basic mode, block by block. */
static void run_basic(const float *in_l, const float *in_r,
                      float *out_l, float *out_r, int n, float mix) {
    init(BLOCK);
    float *il = get_input_buffer_l(), *ir = get_input_buffer_r();
    float *ol = get_output_buffer_l(), *or_ = get_output_buffer_r();
    for (int p = 0; p < n; p += BLOCK) {
        int b = (n - p < BLOCK) ? (n - p) : BLOCK;
        memcpy(il, in_l + p, b * sizeof(float));
        memcpy(ir, in_r + p, b * sizeof(float));
        process_center_cancel(b, mix);
        memcpy(out_l + p, ol, b * sizeof(float));
        memcpy(out_r + p, or_, b * sizeof(float));
    }
}

/* Run a stereo signal through STFT mode, block by block. */
static void run_stft(const float *in_l, const float *in_r,
                     float *out_l, float *out_r, int n, float atten) {
    stft_init(SR);
    stft_set_attenuation(atten);
    float *il = stft_get_input_l(), *ir = stft_get_input_r();
    float *ol = stft_get_output_l(), *or_ = stft_get_output_r();
    for (int p = 0; p < n; p += BLOCK) {
        int b = (n - p < BLOCK) ? (n - p) : BLOCK;
        memcpy(il, in_l + p, b * sizeof(float));
        memcpy(ir, in_r + p, b * sizeof(float));
        stft_process(b);
        memcpy(out_l + p, ol, b * sizeof(float));
        memcpy(out_r + p, or_, b * sizeof(float));
    }
}

#define N 16384
static float sig_l[N], sig_r[N], out_l[N], out_r[N];

static void fill_tone(float *buf, int n, float freq, float amp) {
    for (int i = 0; i < n; i++)
        buf[i] = amp * sinf(2.0f * (float)M_PI * freq * i / SR);
}

/* RMS of the steady region, safely past STFT latency + transients. */
static float steady_rms(const float *x) { return rms(x + 4096, 8192); }

int main(void) {
    printf("DSP validation harness\n");

    /* 1. Basic mode, mix=0 -> bit-exact passthrough */
    fill_tone(sig_l, N, 1000.0f, 0.5f);
    fill_tone(sig_r, N, 1000.0f, 0.5f);
    run_basic(sig_l, sig_r, out_l, out_r, N, 0.0f);
    {
        int exact = 1;
        for (int i = 0; i < N; i++)
            if (out_l[i] != sig_l[i] || out_r[i] != sig_r[i]) { exact = 0; break; }
        check("basic mix=0 is bit-exact passthrough", exact, NULL);
    }

    /* 2a. Basic mode: centered 1kHz tone is attenuated at mix=0.85 */
    run_basic(sig_l, sig_r, out_l, out_r, N, 0.85f);
    {
        float ratio = rms(out_l + 2048, 8192) / rms(sig_l + 2048, 8192);
        char d[64]; snprintf(d, sizeof d, "out/in RMS = %.3f", ratio);
        check("basic: centered tone attenuated (ratio < 0.4)", ratio < 0.4f, d);
    }

    /* 2b. STFT: centered 1kHz tone is attenuated at attenuation=0.85 */
    run_stft(sig_l, sig_r, out_l, out_r, N, 0.85f);
    {
        float ratio = steady_rms(out_l) / steady_rms(sig_l);
        char d[64]; snprintf(d, sizeof d, "out/in RMS = %.3f", ratio);
        check("stft: centered tone attenuated (ratio < 0.5)", ratio < 0.5f, d);
        check("stft: centered-tone output finite", !has_bad(out_l, N), NULL);
    }

    /* 3. STFT: hard-panned tone (L only) is preserved (key new behavior) */
    fill_tone(sig_l, N, 1000.0f, 0.5f);
    memset(sig_r, 0, sizeof sig_r);
    run_stft(sig_l, sig_r, out_l, out_r, N, 0.85f);
    {
        float ratio = steady_rms(out_l) / steady_rms(sig_l);
        char d[64]; snprintf(d, sizeof d, "out/in RMS = %.3f (expect ~1.5 OLA gain)", ratio);
        check("stft: hard-panned tone preserved (ratio > 1.3)", ratio > 1.3f, d);
    }
    /* basic mode: time-domain (L-R)/2 inherently halves hard-panned content
     * (M/S math) — same as the old algorithm (~0.58). Just assert we didn't
     * regress; true pan discrimination is STFT mode's job (checked above). */
    run_basic(sig_l, sig_r, out_l, out_r, N, 0.85f);
    {
        float ratio = rms(out_l + 2048, 8192) / rms(sig_l + 2048, 8192);
        char d[64]; snprintf(d, sizeof d, "out/in RMS = %.3f", ratio);
        check("basic: hard-panned tone not regressed (ratio > 0.5)", ratio > 0.5f, d);
    }

    /* 4. Bass protection: centered 60Hz tone passes through both modes */
    fill_tone(sig_l, N, 60.0f, 0.5f);
    fill_tone(sig_r, N, 60.0f, 0.5f);
    run_stft(sig_l, sig_r, out_l, out_r, N, 0.85f);
    {
        float ratio = steady_rms(out_l) / steady_rms(sig_l);
        char d[64]; snprintf(d, sizeof d, "out/in RMS = %.3f", ratio);
        check("stft: centered bass preserved (ratio > 1.2)", ratio > 1.2f, d);
    }
    run_basic(sig_l, sig_r, out_l, out_r, N, 0.85f);
    {
        float ratio = rms(out_l + 2048, 8192) / rms(sig_l + 2048, 8192);
        char d[64]; snprintf(d, sizeof d, "out/in RMS = %.3f (old algo would be ~0.15)", ratio);
        check("basic: centered bass preserved (ratio > 0.7)", ratio > 0.7f, d);
    }

    /* 5. No NaN/Inf anywhere (re-check basic path) */
    check("basic: output finite", !has_bad(out_l, N) && !has_bad(out_r, N), NULL);

    /* 6. STFT OLA gain regression: attenuation=0 -> reconstruction only.
     *    Hann^2 analysis+synthesis with 4x overlap and 1/FFT_SIZE norm = ~1.5x. */
    fill_tone(sig_l, N, 1000.0f, 0.5f);
    fill_tone(sig_r, N, 1000.0f, 0.5f);
    run_stft(sig_l, sig_r, out_l, out_r, N, 0.0f);
    {
        float ratio = steady_rms(out_l) / steady_rms(sig_l);
        char d[80]; snprintf(d, sizeof d, "reconstruction gain = %.3f (expect ~1.5)", ratio);
        check("stft: OLA gain unchanged (1.4 < gain < 1.6)",
              ratio > 1.4f && ratio < 1.6f, d);
    }

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "ALL PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
