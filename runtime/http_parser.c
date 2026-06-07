/*
 * http_parser.c — Minimal HTTP/1.1 request parser.
 *
 * Parses method, path, query string, and headers from a raw HTTP request.
 * All parsing is done IN-PLACE on the caller's buffer — no copies are made.
 * The caller must keep the buffer alive for the lifetime of the request.
 */

#include "win_compat.h"
#include "cerver.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if !CERVER_PLATFORM_WINDOWS
#include <strings.h>
#endif  // !CERVER_PLATFORM_WINDOWS

#include <ctype.h>

/* ------------------------------------------------------------------ */
/*  URL-decode a string in-place                                      */
/* ------------------------------------------------------------------ */

static int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static void url_decode(char* str) {
  char* src = str;
  char* dst = str;

  while (*src) {
    if (*src == '%' && src[1] && src[2]) {
      int hi = hex_val(src[1]);
      int lo = hex_val(src[2]);
      if (hi >= 0 && lo >= 0) {
        *dst++ = (char)((hi << 4) | lo);
        src += 3;
        continue;
      }
    }
    if (*src == '+') {
      *dst++ = ' ';
      src++;
      continue;
    }
    *dst++ = *src++;
  }
  *dst = '\0';
}

/* ------------------------------------------------------------------ */
/*  Parse query string IN-PLACE: "a=1&b=2" → key-value pairs         */
/* ------------------------------------------------------------------ */

static void parse_query_string(char* qs, cerver_request_t* req) {
  if (!qs || !*qs) return;

  /* Parse directly on the buffer — no strdup needed */
  char* p = qs;

  while (*p && req->query_count < CERVER_MAX_QUERY) {
    char* pair_start = p;

    /* Find end of pair (& or NUL) */
    while (*p && *p != '&') p++;
    if (*p == '&') *p++ = '\0';

    char* eq = strchr(pair_start, '=');
    if (eq) {
      *eq                                = '\0';
      req->query[req->query_count].key   = pair_start;
      req->query[req->query_count].value = eq + 1;
      url_decode((char*)req->query[req->query_count].key);
      url_decode((char*)req->query[req->query_count].value);
    } else {
      req->query[req->query_count].key   = pair_start;
      req->query[req->query_count].value = "";
    }
    req->query_count++;
  }
}

/* ------------------------------------------------------------------ */
/*  Parse the HTTP request IN-PLACE                                   */
/* ------------------------------------------------------------------ */

int cerver_parse_request(const char* raw, size_t len, cerver_request_t* req) {
  if (!raw || len == 0) return -1;

  /*
   * We parse in-place: the caller gives us a mutable buffer (cast away
   * const — the caller's read_full_request already owns a mutable buffer).
   * All internal pointers (headers, query, body) reference this buffer.
   * The caller must keep it alive for the request's lifetime.
   */
  char* buf = (char*)raw;
  buf[len]  = '\0'; /* caller ensures buf has capacity for len+1 */

  /* We no longer allocate _raw_buf — the read buffer IS the raw buffer */
  req->_raw_buf = NULL;
  req->_raw_len = len;

  /* ---- Request line: METHOD PATH HTTP/1.x ---- */
  char* line_end = strstr(buf, "\r\n");
  if (!line_end) return -1;
  *line_end = '\0';

  /* Method */
  char* sp1 = strchr(buf, ' ');
  if (!sp1) return -1;
  *sp1 = '\0';

  size_t method_len = (size_t)(sp1 - buf);
  if (method_len >= sizeof(req->method)) method_len = sizeof(req->method) - 1;
  memcpy(req->method, buf, method_len);
  req->method[method_len] = '\0';

  /* Path (and maybe query string) */
  char* path_start = sp1 + 1;
  char* sp2        = strchr(path_start, ' ');
  if (sp2) *sp2 = '\0';

  /* Split path and query string */
  char* qmark = strchr(path_start, '?');
  if (qmark) {
    *qmark = '\0';
    /* Point query_string directly into the buffer */
    char*  qs_start = qmark + 1;
    size_t qs_len   = strlen(qs_start);
    if (qs_len >= sizeof(req->query_string)) qs_len = sizeof(req->query_string) - 1;
    memcpy(req->query_string, qs_start, qs_len);
    req->query_string[qs_len] = '\0';

    /* Parse query params in-place from query_string
     * (we copied to req->query_string so params point into req memory) */
    parse_query_string(req->query_string, req);
  }

  /* Decode and store path */
  url_decode(path_start);
  strncpy(req->path, path_start, sizeof(req->path) - 1);
  req->path[sizeof(req->path) - 1] = '\0';

  /* Normalize trailing slash: "/foo/" → "/foo" (but keep "/" as is) */
  size_t plen = strlen(req->path);
  if (plen > 1 && req->path[plen - 1] == '/') {
    req->path[plen - 1] = '\0';
  }

  /* ---- Headers ---- */
  char*  hdr_start      = line_end + 2; /* skip \r\n */
  size_t content_length = 0;

  while (hdr_start < buf + len) {
    char* hdr_end = strstr(hdr_start, "\r\n");
    if (!hdr_end) break;

    /* Empty line = end of headers */
    if (hdr_end == hdr_start) {
      hdr_start = hdr_end + 2;
      break;
    }

    *hdr_end = '\0';

    if (req->header_count < CERVER_MAX_HEADERS) {
      char* colon = strchr(hdr_start, ':');
      if (colon) {
        *colon    = '\0';
        char* val = colon + 1;
        while (*val == ' ') val++;

        req->headers[req->header_count].key   = hdr_start;
        req->headers[req->header_count].value = val;
        req->header_count++;

        /* Track content-length */
        if (strcasecmp(hdr_start, "Content-Length") == 0) {
          content_length = (size_t)atol(val);
        }
      }
    }

    hdr_start = hdr_end + 2;
  }

  /* ---- Body (for POST etc.) ---- */
  if (content_length > 0 && hdr_start < buf + len && strcmp(req->method, "GET") != 0 &&
      strcmp(req->method, "HEAD") != 0) {
    req->body     = hdr_start;
    req->body_len = content_length;
    /* Ensure we don't read past the buffer */
    size_t remaining = (size_t)(buf + len - hdr_start);
    if (req->body_len > remaining) {
      req->body_len = remaining;
    }
  }

  return 0;
}
