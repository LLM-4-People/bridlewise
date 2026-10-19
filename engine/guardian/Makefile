# Makefile for harness-landlock-guardian + test_payload.
# Standalone static-ish C build. No node-gyp, no binding.gyp, no external deps.

# Detect a C compiler if CC is not supplied. Fail-closed if none found.
CC ?= $(shell command -v cc 2>/dev/null || command -v gcc 2>/dev/null || command -v clang 2>/dev/null)
ifeq ($(CC),)
$(error No C compiler found (checked: cc, gcc, clang). Install one before building.)
endif

CFLAGS := -std=c11 -Wall -Wextra -Werror -O2 -D_GNU_SOURCE
BUILD  := build

SRC     := landlock-guardian.c
HDR     := landlock-guardian.h
BIN     := $(BUILD)/harness-landlock-guardian
TEST_SRC := tests/test_payload.c
TEST_BIN := $(BUILD)/test_payload

.PHONY: all guardian test_payload test_process_supervisor clean test

all: guardian test_payload

guardian: $(BIN)

$(BIN): $(SRC) $(HDR) | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $(SRC)

test_payload: $(TEST_BIN)

# The test runner needs Linux lifetime operations unavailable in Node.
# Keep the primitive separate from the security guardian executable.
test_process_supervisor: $(BUILD)/test-process-supervisor

# Compiled to a private temporary and renamed into place: two concurrent
# makes (two suites starting at once) never leave a torn binary behind.
$(BUILD)/test-process-supervisor: test-process-supervisor.c | $(BUILD)
	$(CC) $(CFLAGS) -o $@.$$$$.tmp $< -lm && mv -f $@.$$$$.tmp $@

$(TEST_BIN): $(TEST_SRC) | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $(TEST_SRC)

$(BUILD):
	mkdir -p $(BUILD)

clean:
	rm -rf $(BUILD)

test: all
	bash tests/run-tests.sh
