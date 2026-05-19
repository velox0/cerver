/*
 * http_writer.c — HTTP/1.1 response writer.
 *
 * Uses writev() for zero-copy header+body writes.
 * Supports keep-alive and Connection: close signaling.
 */

#include "cerver.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/uio.h>

/* ------------------------------------------------------------------ */
/*  Status text lookup                                                */
/* ------------------------------------------------------------------ */

static const char* status_text(int code) {
  switch (code) {
    case 200:
      return "OK";
    case 201:
      return "Created";
    case 204:
      return "No Content";
    case 301:
      return "Moved Permanently";
    case 302:
      return "Found";
    case 304:
      return "Not Modified";
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 500:
      return "Internal Server Error";
    case 503:
      return "Service Unavailable";
    default:
      return "Unknown";
  }
}

/* ------------------------------------------------------------------ */
/*  Write the full response to fd using writev                        */
/* ------------------------------------------------------------------ */

int cerver_write_response(int fd, const cerver_response_t* res, int keepalive) {
  /* Build the response header */
  char header[4096];
  int  hlen = 0;

  /* Status line */
  hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "HTTP/1.1 %d %s\r\n", res->status,
                   status_text(res->status));

  /* Content-Type */
  if (res->content_type) {
    hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "Content-Type: %s\r\n",
                     res->content_type);
  }

  /* Content-Length */
  hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "Content-Length: %zu\r\n",
                   res->body_len);

  /* Extra headers */
  for (int i = 0; i < res->header_count; i++) {
    hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "%s: %s\r\n",
                     res->headers[i].key, res->headers[i].value);
  }

  /* Connection header — honor keep-alive state */
  if (keepalive && !res->_force_close) {
    hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "Connection: keep-alive\r\n");
  } else {
    hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "Connection: close\r\n");
  }

  /* Server header */
  hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "Server: cerver\r\n");

  /* End of headers */
  hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "\r\n");

  /*
   * Use writev() to send header + body in a single syscall.
   * This avoids Nagle interaction and reduces context switches.
   */
  if (res->body && res->body_len > 0) {
    struct iovec iov[2];
    iov[0].iov_base = header;
    iov[0].iov_len  = (size_t)hlen;
    iov[1].iov_base = (void*)res->body;
    iov[1].iov_len  = res->body_len;

    size_t total   = iov[0].iov_len + iov[1].iov_len;
    size_t written = 0;

    while (written < total) {
      ssize_t n = writev(fd, iov, 2);
      if (n < 0) return -1;
      written += (size_t)n;

      /* Adjust iov for partial writes */
      size_t to_consume = (size_t)n;
      if (to_consume < iov[0].iov_len) {
        iov[0].iov_base = (char*)iov[0].iov_base + to_consume;
        iov[0].iov_len -= to_consume;
      } else {
        to_consume -= iov[0].iov_len;
        iov[0].iov_len  = 0;
        iov[1].iov_base = (char*)iov[1].iov_base + to_consume;
        iov[1].iov_len -= to_consume;
      }
    }
  } else {
    /* No body — just send header */
    ssize_t written = write(fd, header, (size_t)hlen);
    if (written < 0) return -1;
  }

  return 0;
}

/* ------------------------------------------------------------------ */
/*  Response helper functions                                         */
/* ------------------------------------------------------------------ */

void cerver_res_text(cerver_response_t* res, int status, const char* text) {
  res->status       = status;
  res->content_type = "text/plain; charset=utf-8";
  res->body         = text;
  res->body_len     = strlen(text);
  res->_body_owned  = 0;
}

void cerver_res_json(cerver_response_t* res, int status, const char* json) {
  res->status       = status;
  res->content_type = "application/json; charset=utf-8";
  res->body         = json;
  res->body_len     = strlen(json);
  res->_body_owned  = 0;
}

void cerver_res_html(cerver_response_t* res, int status, const char* html) {
  res->status       = status;
  res->content_type = "text/html; charset=utf-8";
  res->body         = html;
  res->body_len     = strlen(html);
  res->_body_owned  = 0;
}

void cerver_res_file(cerver_response_t* res, int status, const char* mime,
                     const unsigned char* data, size_t len) {
  res->status       = status;
  res->content_type = mime;
  res->body         = (const char*)data;
  res->body_len     = len;
  res->_body_owned  = 0;
}

void cerver_res_header(cerver_response_t* res, const char* key, const char* val) {
  if (res->header_count < CERVER_MAX_HEADERS) {
    res->headers[res->header_count].key   = key;
    res->headers[res->header_count].value = val;
    res->header_count++;
  }
}
