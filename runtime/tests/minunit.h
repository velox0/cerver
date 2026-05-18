#ifndef CERVER_MINUNIT_H
#define CERVER_MINUNIT_H

#include <stddef.h>
#include <stdio.h>
#include <string.h>

typedef void (*mu_test_fn)(void);

#define MU_SNIP_MAX 80

extern int mu_tests_run;
extern int mu_tests_failed;
extern int mu_test_failed;

void        mu_fail(const char* file, int line, const char* msg);
void        mu_run(const char* name, mu_test_fn fn);
int         mu_report(void);
const char* mu_snip(const char* s, char* buf, size_t cap);

#define MU_ASSERT(cond)                   \
  do {                                    \
    if (!(cond)) {                        \
      mu_fail(__FILE__, __LINE__, #cond); \
      return;                             \
    }                                     \
  } while (0)

#define MU_ASSERT_EQ_INT(a, b)                                                      \
  do {                                                                              \
    if ((a) != (b)) {                                                               \
      char _mu_buf[128];                                                            \
      snprintf(_mu_buf, sizeof(_mu_buf), "got %d expected %d", (int)(a), (int)(b)); \
      mu_fail(__FILE__, __LINE__, _mu_buf);                                         \
      return;                                                                       \
    }                                                                               \
  } while (0)

#define MU_ASSERT_EQ_SIZE(a, b)                                                             \
  do {                                                                                      \
    if ((a) != (b)) {                                                                       \
      char _mu_buf[128];                                                                    \
      snprintf(_mu_buf, sizeof(_mu_buf), "got %zu expected %zu", (size_t)(a), (size_t)(b)); \
      mu_fail(__FILE__, __LINE__, _mu_buf);                                                 \
      return;                                                                               \
    }                                                                                       \
  } while (0)

#define MU_ASSERT_STREQ(a, b)                                                       \
  do {                                                                              \
    if (((a) == NULL && (b) != NULL) || ((a) != NULL && (b) == NULL) ||             \
        ((a) != NULL && (b) != NULL && strcmp((a), (b)) != 0)) {                    \
      char        _mu_buf[256];                                                     \
      char        _mu_a[MU_SNIP_MAX];                                               \
      char        _mu_b[MU_SNIP_MAX];                                               \
      const char* _mu_as = mu_snip((a), _mu_a, sizeof(_mu_a));                      \
      const char* _mu_bs = mu_snip((b), _mu_b, sizeof(_mu_b));                      \
      snprintf(_mu_buf, sizeof(_mu_buf), "got '%s' expected '%s'", _mu_as, _mu_bs); \
      mu_fail(__FILE__, __LINE__, _mu_buf);                                         \
      return;                                                                       \
    }                                                                               \
  } while (0)

#endif
