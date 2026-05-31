CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -O2 -D_GNU_SOURCE

RUNTIME_SRCS = \
	runtime/http_parser.c \
	runtime/http_writer.c \
	runtime/router.c \
	runtime/static.c \
	runtime/mime.c \
	runtime/server.c \
	runtime/fetch.c

TEST_SRCS = runtime/tests/runtime_tests.c \
	runtime/tests/minunit.c
TEST_BIN = build/runtime_tests

.PHONY: test-runtime clean

test-runtime: $(TEST_BIN)
	./$(TEST_BIN)

$(TEST_BIN): $(RUNTIME_SRCS) $(TEST_SRCS) runtime/cerver.h
	mkdir -p build
	$(CC) $(CFLAGS) -Iruntime -o $(TEST_BIN) $(RUNTIME_SRCS) $(TEST_SRCS) -pthread -lcurl

clean:
	rm -rf build
