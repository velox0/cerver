/*
 * str_ops.c — String operation helpers for cerver generated code.
 *
 * These functions provide the C implementations for JavaScript string
 * methods compiled by cerver. All functions that return strings return
 * heap-allocated buffers (malloc). Callers are responsible for freeing
 * the returned pointer — the generated code tracks ownership via the
 * _body_owned flag on cerver_response_t.
 *
 * Functions that return int are safe to call inline.
 */

#include <ctype.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/*  Case conversion                                                    */
/* ------------------------------------------------------------------ */

/**
 * Return a malloc'd copy of `s` with all ASCII characters lowercased.
 * Returns NULL on allocation failure.
 */
char *cerver_str_tolower(const char *s) {
  if (!s) return NULL;
  size_t len = strlen(s);
  char  *out = (char *)malloc(len + 1);
  if (!out) return NULL;
  for (size_t i = 0; i <= len; i++) {
    out[i] = (char)tolower((unsigned char)s[i]);
  }
  return out;
}

/**
 * Return a malloc'd copy of `s` with all ASCII characters uppercased.
 * Returns NULL on allocation failure.
 */
char *cerver_str_toupper(const char *s) {
  if (!s) return NULL;
  size_t len = strlen(s);
  char  *out = (char *)malloc(len + 1);
  if (!out) return NULL;
  for (size_t i = 0; i <= len; i++) {
    out[i] = (char)toupper((unsigned char)s[i]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Trim                                                               */
/* ------------------------------------------------------------------ */

/**
 * Return a malloc'd copy of `s` with leading and trailing ASCII
 * whitespace removed. Returns NULL on allocation failure.
 */
char *cerver_str_trim(const char *s) {
  if (!s) return NULL;

  /* Skip leading whitespace */
  while (*s && isspace((unsigned char)*s)) s++;

  const char *end = s + strlen(s);
  /* Skip trailing whitespace */
  while (end > s && isspace((unsigned char)*(end - 1))) end--;

  size_t len = (size_t)(end - s);
  char  *out = (char *)malloc(len + 1);
  if (!out) return NULL;
  memcpy(out, s, len);
  out[len] = '\0';
  return out;
}

/* ------------------------------------------------------------------ */
/*  Slice                                                              */
/* ------------------------------------------------------------------ */

/**
 * Return a malloc'd substring of `s` from byte index `start` (inclusive)
 * to `end` (exclusive), mirroring JS Array/String.prototype.slice().
 *
 * Negative indices count from the end of the string.
 * Pass end = -1 to mean "to the end of the string".
 *
 * Returns NULL on allocation failure.
 */
char *cerver_str_slice(const char *s, int start, int end) {
  if (!s) return NULL;
  int len = (int)strlen(s);

  /* Resolve negative indices */
  if (start < 0) start = len + start;
  if (end < 0)   end   = (end == -1) ? len : len + end;

  /* Clamp */
  if (start < 0)   start = 0;
  if (start > len) start = len;
  if (end   < 0)   end   = 0;
  if (end   > len) end   = len;
  if (start > end) { int t = start; start = end; end = t; }

  int    out_len = end - start;
  char  *out     = (char *)malloc((size_t)out_len + 1);
  if (!out) return NULL;
  memcpy(out, s + start, (size_t)out_len);
  out[out_len] = '\0';
  return out;
}

/* ------------------------------------------------------------------ */
/*  Replace (first occurrence)                                        */
/* ------------------------------------------------------------------ */

/**
 * Return a malloc'd copy of `s` with the first occurrence of `needle`
 * replaced by `replacement`. If `needle` is not found, returns a copy
 * of `s`. Returns NULL on allocation failure.
 */
char *cerver_str_replace(const char *s, const char *needle,
                         const char *replacement) {
  if (!s) return NULL;
  if (!needle || *needle == '\0') {
    /* Empty needle — return a copy */
    size_t len = strlen(s);
    char  *out = (char *)malloc(len + 1);
    if (!out) return NULL;
    memcpy(out, s, len + 1);
    return out;
  }

  const char *pos = strstr(s, needle);
  if (!pos) {
    /* Needle not found — return a copy of s */
    size_t len = strlen(s);
    char  *out = (char *)malloc(len + 1);
    if (!out) return NULL;
    memcpy(out, s, len + 1);
    return out;
  }

  size_t needle_len      = strlen(needle);
  size_t replacement_len = replacement ? strlen(replacement) : 0;
  size_t before_len      = (size_t)(pos - s);
  size_t after_len       = strlen(pos + needle_len);
  size_t total           = before_len + replacement_len + after_len + 1;

  char *out = (char *)malloc(total);
  if (!out) return NULL;

  char *p = out;
  memcpy(p, s, before_len);
  p += before_len;
  if (replacement_len) {
    memcpy(p, replacement, replacement_len);
    p += replacement_len;
  }
  memcpy(p, pos + needle_len, after_len + 1); /* +1 for NUL */
  return out;
}

/* ------------------------------------------------------------------ */
/*  Predicate helpers (return int, safe for inline expression)        */
/* ------------------------------------------------------------------ */

/**
 * Return 1 if `s` ends with `suffix`, 0 otherwise.
 * Mirrors JS String.prototype.endsWith().
 */
int cerver_str_endswith(const char *s, const char *suffix) {
  if (!s || !suffix) return 0;
  size_t slen      = strlen(s);
  size_t suffixlen = strlen(suffix);
  if (suffixlen > slen) return 0;
  return memcmp(s + slen - suffixlen, suffix, suffixlen) == 0;
}

/**
 * Return the byte index of the first occurrence of `needle` in `s`,
 * or -1 if not found. Mirrors JS String.prototype.indexOf().
 */
int cerver_str_indexof(const char *s, const char *needle) {
  if (!s || !needle) return -1;
  const char *pos = strstr(s, needle);
  if (!pos) return -1;
  return (int)(pos - s);
}
