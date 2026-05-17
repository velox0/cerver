/*
 * http_writer.c — HTTP/1.1 response writer.
 *
 * Formats a cerver_response_t into raw HTTP bytes and writes to a socket fd.
 */

#include "cerver.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* ------------------------------------------------------------------ */
/*  Status text lookup                                                */
/* ------------------------------------------------------------------ */

static const char *status_text(int code) {
    switch (code) {
        case 200: return "OK";
        case 201: return "Created";
        case 204: return "No Content";
        case 301: return "Moved Permanently";
        case 302: return "Found";
        case 304: return "Not Modified";
        case 400: return "Bad Request";
        case 401: return "Unauthorized";
        case 403: return "Forbidden";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 500: return "Internal Server Error";
        default:  return "Unknown";
    }
}

/* ------------------------------------------------------------------ */
/*  Write the full response to fd                                     */
/* ------------------------------------------------------------------ */

int cerver_write_response(int fd, const cerver_response_t *res) {
    /* Build the response header */
    char header[4096];
    int hlen = 0;

    /* Status line */
    hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen,
                     "HTTP/1.1 %d %s\r\n", res->status, status_text(res->status));

    /* Content-Type */
    if (res->content_type) {
        hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen,
                         "Content-Type: %s\r\n", res->content_type);
    }

    /* Content-Length */
    hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen,
                     "Content-Length: %zu\r\n", res->body_len);

    /* Extra headers */
    for (int i = 0; i < res->header_count; i++) {
        hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen,
                         "%s: %s\r\n",
                         res->headers[i].key, res->headers[i].value);
    }

    /* Connection: close (we don't do keep-alive in v0.1) */
    hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen,
                     "Connection: close\r\n");

    /* Server header */
    hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen,
                     "Server: cerver\r\n");

    /* End of headers */
    hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "\r\n");

    /* Write header */
    ssize_t written = write(fd, header, (size_t)hlen);
    if (written < 0) return -1;

    /* Write body */
    if (res->body && res->body_len > 0) {
        size_t total = 0;
        while (total < res->body_len) {
            ssize_t n = write(fd, res->body + total, res->body_len - total);
            if (n < 0) return -1;
            total += (size_t)n;
        }
    }

    return 0;
}

/* ------------------------------------------------------------------ */
/*  Response helper functions                                         */
/* ------------------------------------------------------------------ */

void cerver_res_text(cerver_response_t *res, int status, const char *text) {
    res->status = status;
    res->content_type = "text/plain; charset=utf-8";
    res->body = text;
    res->body_len = strlen(text);
    res->_body_owned = 0;
}

void cerver_res_json(cerver_response_t *res, int status, const char *json) {
    res->status = status;
    res->content_type = "application/json; charset=utf-8";
    res->body = json;
    res->body_len = strlen(json);
    res->_body_owned = 0;
}

void cerver_res_html(cerver_response_t *res, int status, const char *html) {
    res->status = status;
    res->content_type = "text/html; charset=utf-8";
    res->body = html;
    res->body_len = strlen(html);
    res->_body_owned = 0;
}

void cerver_res_file(cerver_response_t *res, int status, const char *mime,
                     const unsigned char *data, size_t len) {
    res->status = status;
    res->content_type = mime;
    res->body = (const char *)data;
    res->body_len = len;
    res->_body_owned = 0;
}

void cerver_res_header(cerver_response_t *res, const char *key, const char *val) {
    if (res->header_count < CERVER_MAX_HEADERS) {
        res->headers[res->header_count].key = key;
        res->headers[res->header_count].value = val;
        res->header_count++;
    }
}
