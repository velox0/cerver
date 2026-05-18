#include "minunit.h"

#include <stdio.h>
#include <string.h>
#include <unistd.h>

int mu_tests_run    = 0;
int mu_tests_failed = 0;
int mu_test_failed  = 0;

static int mu_is_tty(FILE* f) { return isatty(fileno(f)); }

static const char* mu_color(FILE* f, const char* code) { return mu_is_tty(f) ? code : ""; }

const char* mu_snip(const char* s, char* buf, size_t cap) {
  if (s == NULL) {
    return "(null)";
  }
  if (cap == 0) {
    return "";
  }

  size_t len = strlen(s);
  if (len < cap) {
    snprintf(buf, cap, "%s", s);
    return buf;
  }

  if (cap <= 4) {
    size_t keep = cap - 1;
    memcpy(buf, s, keep);
    buf[keep] = '\0';
    return buf;
  }

  size_t keep = cap - 4;
  memcpy(buf, s, keep);
  memcpy(buf + keep, "...", 3);
  buf[keep + 3] = '\0';
  return buf;
}

void mu_fail(const char* file, int line, const char* msg) {
  const char* red   = mu_color(stderr, "\x1b[31m");
  const char* reset = mu_color(stderr, "\x1b[0m");

  mu_test_failed = 1;
  fprintf(stderr, "%sFAIL%s %s:%d: %s\n", red, reset, file, line, msg);
}

void mu_run(const char* name, mu_test_fn fn) {
  mu_tests_run++;
  mu_test_failed = 0;
  fn();
  if (mu_test_failed) {
    mu_tests_failed++;
    fprintf(stderr, "  in %s\n", name);
  } else {
    const char* green = mu_color(stdout, "\x1b[32m");
    const char* reset = mu_color(stdout, "\x1b[0m");
    printf("%sok%s %s\n", green, reset, name);
  }
}

int mu_report(void) {
  const char* reset = mu_color(stdout, "\x1b[0m");
  if (mu_tests_failed) {
    const char* red = mu_color(stdout, "\x1b[31m");
    printf("%sSummary:%s %d tests, %s%d failures%s\n", red, reset, mu_tests_run, red,
           mu_tests_failed, reset);
  } else {
    const char* green = mu_color(stdout, "\x1b[32m");
    printf("%sSummary:%s %d tests, %s0 failures%s\n", green, reset, mu_tests_run, green, reset);
  }
  return mu_tests_failed ? 1 : 0;
}
