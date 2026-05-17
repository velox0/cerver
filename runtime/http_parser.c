/*
 * http_parser.c — Minimal HTTP/1.1 request parser.
 *
 * Parses method, path, query string, and headers from a raw HTTP request.
 * No external dependencies.
 */

#include "cerver.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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

static void url_decode(char *str) {
    char *src = str;
    char *dst = str;

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
/*  Parse query string: "a=1&b=2" → key-value pairs                  */
/* ------------------------------------------------------------------ */

static void parse_query_string(char *qs, cerver_request_t *req) {
    if (!qs || !*qs) return;

    char *saveptr = NULL;
    char *pair = strtok_r(qs, "&", &saveptr);

    while (pair && req->query_count < CERVER_MAX_QUERY) {
        char *eq = strchr(pair, '=');
        if (eq) {
            *eq = '\0';
            req->query[req->query_count].key = pair;
            req->query[req->query_count].value = eq + 1;
            url_decode((char *)req->query[req->query_count].key);
            url_decode((char *)req->query[req->query_count].value);
        } else {
            req->query[req->query_count].key = pair;
            req->query[req->query_count].value = "";
        }
        req->query_count++;
        pair = strtok_r(NULL, "&", &saveptr);
    }
}

/* ------------------------------------------------------------------ */
/*  Parse the HTTP request                                            */
/* ------------------------------------------------------------------ */

int cerver_parse_request(const char *raw, size_t len, cerver_request_t *req) {
    if (!raw || len == 0) return -1;

    /* We need a mutable copy because we'll be inserting NUL terminators */
    char *buf = malloc(len + 1);
    if (!buf) return -1;
    memcpy(buf, raw, len);
    buf[len] = '\0';

    req->_raw_buf = buf;
    req->_raw_len = len;

    /* ---- Request line: METHOD PATH HTTP/1.x ---- */
    char *line_end = strstr(buf, "\r\n");
    if (!line_end) {
        free(buf);
        return -1;
    }
    *line_end = '\0';

    /* Method */
    char *sp1 = strchr(buf, ' ');
    if (!sp1) { free(buf); return -1; }
    *sp1 = '\0';

    size_t method_len = (size_t)(sp1 - buf);
    if (method_len >= sizeof(req->method)) method_len = sizeof(req->method) - 1;
    memcpy(req->method, buf, method_len);
    req->method[method_len] = '\0';

    /* Path (and maybe query string) */
    char *path_start = sp1 + 1;
    char *sp2 = strchr(path_start, ' ');
    if (sp2) *sp2 = '\0';

    /* Split path and query string */
    char *qmark = strchr(path_start, '?');
    if (qmark) {
        *qmark = '\0';
        strncpy(req->query_string, qmark + 1, sizeof(req->query_string) - 1);
        req->query_string[sizeof(req->query_string) - 1] = '\0';
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

    /* Parse query string */
    if (req->query_string[0]) {
        /* We need a mutable copy for strtok */
        char *qs_copy = strdup(req->query_string);
        if (qs_copy) {
            parse_query_string(qs_copy, req);
            /* Note: keys/values point into qs_copy which we leak intentionally
               since the request's lifetime is short (one connection). */
        }
    }

    /* ---- Headers ---- */
    char *hdr_start = line_end + 2; /* skip \r\n */
    size_t content_length = 0;

    while (hdr_start < buf + len) {
        char *hdr_end = strstr(hdr_start, "\r\n");
        if (!hdr_end) break;

        /* Empty line = end of headers */
        if (hdr_end == hdr_start) {
            hdr_start = hdr_end + 2;
            break;
        }

        *hdr_end = '\0';

        if (req->header_count < CERVER_MAX_HEADERS) {
            char *colon = strchr(hdr_start, ':');
            if (colon) {
                *colon = '\0';
                char *val = colon + 1;
                while (*val == ' ') val++;

                req->headers[req->header_count].key = hdr_start;
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
    if (content_length > 0 && hdr_start < buf + len) {
        req->body = hdr_start;
        req->body_len = content_length;
        /* Ensure we don't read past the buffer */
        size_t remaining = (size_t)(buf + len - hdr_start);
        if (req->body_len > remaining) {
            req->body_len = remaining;
        }
    }

    return 0;
}
