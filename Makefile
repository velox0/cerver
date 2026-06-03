CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -O2
WIN_CC ?= x86_64-w64-mingw32-gcc
WIN_CFLAGS ?= -std=c11 -Wall -Wextra -O2 -D_WIN32_WINNT=0x0601 -DWIN32_LEAN_AND_MEAN -DCERVER_NO_CURL
WIN_LDFLAGS ?= -lws2_32 -lmswsock -ladvapi32 -static

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
WIN_TEST_BIN = build/runtime_tests.exe
WIN_OBJ = build/server.win.o

.PHONY: test tests test-runtime test-windows clean

test: test-runtime test-windows

tests: test

test-runtime: $(TEST_BIN)
	./$(TEST_BIN)

$(TEST_BIN): $(RUNTIME_SRCS) $(TEST_SRCS) runtime/cerver.h
	mkdir -p build
	$(CC) $(CFLAGS) -Iruntime -o $(TEST_BIN) $(RUNTIME_SRCS) $(TEST_SRCS) -pthread -lcurl

test-windows: $(WIN_TEST_BIN) $(WIN_OBJ)
	@if [ "$$(uname -s)" = "Darwin" ]; then \
		wine $(WIN_TEST_BIN); \
	else \
		./$(WIN_TEST_BIN); \
	fi

$(WIN_TEST_BIN): $(RUNTIME_SRCS) $(TEST_SRCS) runtime/cerver.h
	mkdir -p build
	$(WIN_CC) $(WIN_CFLAGS) -Iruntime -o $(WIN_TEST_BIN) $(RUNTIME_SRCS) $(TEST_SRCS) $(WIN_LDFLAGS)

$(WIN_OBJ): runtime/server.c runtime/cerver.h
	mkdir -p build
	$(WIN_CC) $(WIN_CFLAGS) -Iruntime -c runtime/server.c -o $(WIN_OBJ)

clean:
	rm -rf build
