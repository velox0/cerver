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
#include <errno.h>

#ifdef __linux__
#include <sys/sendfile.h>
static ssize_t cerver_sendfile(int out_fd, int in_fd, off_t offset, size_t count) {
  off_t off = offset;
  return sendfile(out_fd, in_fd, &off, count);
}
#elif defined(__APPLE__)
#include <sys/types.h>
#include <sys/socket.h>
static ssize_t cerver_sendfile(int out_fd, int in_fd, off_t offset, size_t count) {
  off_t len = (off_t)count;
  int res = sendfile(in_fd, out_fd, offset, &len, NULL, 0);
  if (res == 0) {
    return (ssize_t)len;
  }
  if (len > 0) {
    return (ssize_t)len;
  }
  /* Fallback to read-write copy if not a socket or unsupported on this descriptor type */
  char buf[8192];
  if (lseek(in_fd, offset, SEEK_SET) == -1) return -1;
  size_t to_read = count > sizeof(buf) ? sizeof(buf) : count;
  ssize_t n_read = read(in_fd, buf, to_read);
  if (n_read <= 0) return n_read;

  size_t written = 0;
  while (written < (size_t)n_read) {
    ssize_t n_write = write(out_fd, buf + written, (size_t)n_read - written);
    if (n_write < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    written += (size_t)n_write;
  }
  return (ssize_t)written;
}
#else
static ssize_t cerver_sendfile(int out_fd, int in_fd, off_t offset, size_t count) {
  char buf[8192];
  if (lseek(in_fd, offset, SEEK_SET) == -1) return -1;
  size_t to_read = count > sizeof(buf) ? sizeof(buf) : count;
  ssize_t n_read = read(in_fd, buf, to_read);
  if (n_read <= 0) return n_read;

  size_t written = 0;
  while (written < (size_t)n_read) {
    ssize_t n_write = write(out_fd, buf + written, (size_t)n_read - written);
    if (n_write < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    written += (size_t)n_write;
  }
  return (ssize_t)written;
}
#endif

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
   * Use writev() or sendfile() to send response, or copy to contiguous
   * buffer if body is small to avoid writev round-trips.
   */
  if (res->_body_owned == 3) {
    /* Send header first */
    size_t header_total = (size_t)hlen;
    size_t header_written = 0;
    while (header_written < header_total) {
      ssize_t n = write(fd, header + header_written, header_total - header_written);
      if (n < 0) {
        if (errno == EINTR) continue;
        return -1;
      }
      header_written += (size_t)n;
    }

    /* Zero-copy body sending via sendfile(2) */
    size_t body_total = res->body_len;
    size_t body_sent = 0;
    while (body_sent < body_total) {
      ssize_t n = cerver_sendfile(fd, res->_file_fd, (off_t)body_sent, body_total - body_sent);
      if (n < 0) {
        if (errno == EINTR) continue;
        return -1;
      }
      if (n == 0) break; /* EOF */
      body_sent += (size_t)n;
    }
  } else if (res->body && res->body_len > 0) {
    if ((size_t)hlen + res->body_len <= sizeof(header)) {
      /* Small response optimization: copy body into header buffer and send in one syscall */
      memcpy(header + hlen, res->body, res->body_len);
      size_t total = (size_t)hlen + res->body_len;
      size_t written = 0;
      while (written < total) {
        ssize_t n = write(fd, header + written, total - written);
        if (n < 0) {
          if (errno == EINTR) continue;
          return -1;
        }
        written += (size_t)n;
      }
    } else {
      /* Large response: use writev to send header + body */
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
    }
  } else {
    /* No body — just send header */
    size_t total   = (size_t)hlen;
    size_t written = 0;
    while (written < total) {
      ssize_t n = write(fd, header + written, total - written);
      if (n < 0) {
        if (errno == EINTR) continue;
        return -1;
      }
      written += (size_t)n;
    }
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
