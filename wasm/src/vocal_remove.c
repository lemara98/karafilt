#include <stdlib.h>

static float *input_buffer_l = NULL;
static float *input_buffer_r = NULL;
static float *output_buffer_l = NULL;
static float *output_buffer_r = NULL;

void init(int max_block_size) {
    input_buffer_l  = (float *)malloc(max_block_size * sizeof(float));
    input_buffer_r  = (float *)malloc(max_block_size * sizeof(float));
    output_buffer_l = (float *)malloc(max_block_size * sizeof(float));
    output_buffer_r = (float *)malloc(max_block_size * sizeof(float));
}

float *get_input_buffer_l(void)  { return input_buffer_l; }
float *get_input_buffer_r(void)  { return input_buffer_r; }
float *get_output_buffer_l(void) { return output_buffer_l; }
float *get_output_buffer_r(void) { return output_buffer_r; }

/*
 * Center-channel cancellation.
 * Vocals are typically panned to the center of a stereo mix.
 * Subtracting one channel from the other removes center content.
 *
 * mix: 0.0 = original audio, 1.0 = full vocal removal
 */
void process_center_cancel(int num_samples, float mix) {
    for (int i = 0; i < num_samples; i++) {
        float l = input_buffer_l[i];
        float r = input_buffer_r[i];

        /* Side signal: everything NOT in the center */
        float side_l = (l - r) * 0.5f;
        float side_r = (r - l) * 0.5f;

        /* Blend original with side-only based on mix */
        output_buffer_l[i] = l * (1.0f - mix) + side_l * mix;
        output_buffer_r[i] = r * (1.0f - mix) + side_r * mix;
    }
}

void cleanup(void) {
    free(input_buffer_l);
    free(input_buffer_r);
    free(output_buffer_l);
    free(output_buffer_r);
    input_buffer_l = input_buffer_r = output_buffer_l = output_buffer_r = NULL;
}
