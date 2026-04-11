EMCC = emcc
WASM_SRC = wasm/src
WASM_OUT = wasm/build

.PHONY: all phase1 phase2 build clean

all: phase2

# Phase 1: simple center-channel cancellation
phase1:
	mkdir -p $(WASM_OUT)
	$(EMCC) $(WASM_SRC)/vocal_remove.c \
		-O3 \
		-msimd128 \
		--no-entry \
		-s WASM=1 \
		-s "EXPORTED_FUNCTIONS=[\"_init\",\"_get_input_buffer_l\",\"_get_input_buffer_r\",\"_get_output_buffer_l\",\"_get_output_buffer_r\",\"_process_center_cancel\",\"_cleanup\",\"_malloc\",\"_free\"]" \
		-s ALLOW_MEMORY_GROWTH=0 \
		-s INITIAL_MEMORY=1048576 \
		-s TOTAL_STACK=65536 \
		-o $(WASM_OUT)/vocal_remove.wasm

# Phase 2: STFT spectral processing (includes Phase 1 functions too)
phase2:
	mkdir -p $(WASM_OUT)
	$(EMCC) \
		$(WASM_SRC)/vocal_remove_stft.c \
		$(WASM_SRC)/kiss_fft.c \
		$(WASM_SRC)/kiss_fftr.c \
		-I$(WASM_SRC) \
		-O3 \
		-msimd128 \
		--no-entry \
		-lm \
		-s WASM=1 \
		-s "EXPORTED_FUNCTIONS=[\"_init\",\"_get_input_buffer_l\",\"_get_input_buffer_r\",\"_get_output_buffer_l\",\"_get_output_buffer_r\",\"_process_center_cancel\",\"_cleanup\",\"_stft_init\",\"_stft_get_input_l\",\"_stft_get_input_r\",\"_stft_get_output_l\",\"_stft_get_output_r\",\"_stft_process\",\"_stft_set_attenuation\",\"_stft_set_vocal_range\",\"_stft_cleanup\",\"_malloc\",\"_free\"]" \
		-s ALLOW_MEMORY_GROWTH=0 \
		-s INITIAL_MEMORY=4194304 \
		-s TOTAL_STACK=262144 \
		-o $(WASM_OUT)/vocal_remove.wasm

# Alias
build: phase2

clean:
	rm -f $(WASM_OUT)/*
