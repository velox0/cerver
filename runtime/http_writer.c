/*
 * http_writer.c — HTTP/1.1 response writer.
 *
 * Cross-platform: writev on POSIX, manual loop on Windows.
 * sendfile falls back to read-write copy on non-Linux/macOS.
 */

#include "win_compat.h"
#include "cerver.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

/* Size formatting uses %zu with unsigned long long cast to avoid MinGW warnings */

#if !CERVER_PLATFORM_WINDOWS
#include <unistd.h>
#include <sys/uio.h>
#endif  // !CERVER_PLATFORM_WINDOWS

/* ------------------------------------------------------------------ */
/*  sendfile — read-write fallback everywhere                         */
/* ------------------------------------------------------------------ */

#if defined(__linux__) && !CERVER_PLATFORM_WINDOWS
#include <sys/sendfile.h>
static ssize_t do_sendfile(cerver_sock_t out_fd, int in_fd, off_t offset, size_t count) {
  off_t off = offset;
  return sendfile(out_fd, in_fd, &off, count);
}
#elif defined(__APPLE__) && !CERVER_PLATFORM_WINDOWS
#include <sys/types.h>
#include <sys/socket.h>
static ssize_t do_sendfile(cerver_sock_t out_fd, int in_fd, off_t offset, size_t count) {
  off_t len = (off_t)count;
  int   res = sendfile(in_fd, out_fd, offset, &len, NULL, 0);
  if (res == 0 || len > 0) return (ssize_t)len;
  /* fallthrough to read-write */
  char buf[8192];
  if (lseek(in_fd, offset, SEEK_SET) == -1) return -1;
  size_t  to_read = count > sizeof(buf) ? sizeof(buf) : count;
  ssize_t n_read  = read(in_fd, buf, to_read);
  if (n_read <= 0) return n_read;
  size_t written = 0;
  while (written < (size_t)n_read) {
    ssize_t n = write(out_fd, buf + written, (size_t)n_read - written);
    if (n < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    written += (size_t)n;
  }
  return (ssize_t)written;
}
#else
/* Windows or other: read from file, send via socket API */
static ssize_t do_sendfile(cerver_sock_t out_fd, int in_fd, off_t offset, size_t count) {
  char buf[8192];
#if CERVER_PLATFORM_WINDOWS
  if (_lseeki64(in_fd, offset, SEEK_SET) == -1) return -1;
  int to_read = (int)(count > sizeof(buf) ? sizeof(buf) : count);
  int n_read  = _read(in_fd, buf, to_read);
#else
  if (lseek(in_fd, offset, SEEK_SET) == -1) return -1;
  size_t  to_read = count > sizeof(buf) ? sizeof(buf) : count;
  ssize_t n_read  = read(in_fd, buf, to_read);
#endif  // CERVER_PLATFORM_WINDOWS
  if (n_read <= 0) return (ssize_t)n_read;
  size_t written = 0;
  while (written < (size_t)n_read) {
    ssize_t n = cerver_sock_write(out_fd, buf + written, (size_t)n_read - written);
    if (n < 0) return -1;
    written += (size_t)n;
  }
  return (ssize_t)written;
}
#endif  // __linux__ && !CERVER_PLATFORM_WINDOWS
        // !CERVER_PLATFORM_WINDOWS, else

/* ------------------------------------------------------------------ */
/*  Portable full-write helper (send all bytes)                       */
/* ------------------------------------------------------------------ */

static int send_all(cerver_sock_t fd, const char* buf, size_t len) {
  size_t sent = 0;
  while (sent < len) {
    ssize_t n = cerver_sock_write(fd, buf + sent, len - sent);
    if (n < 0) {
#if !CERVER_PLATFORM_WINDOWS
      if (errno == EINTR) continue;
#endif  // !CERVER_PLATFORM_WINDOWS
      return -1;
    }
    sent += (size_t)n;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/*  Status text                                                       */
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
/*  Write the full response                                           */
/* ------------------------------------------------------------------ */

int cerver_write_response(int fd, const cerver_response_t* res, int keepalive) {
  cerver_sock_t sfd = (cerver_sock_t)fd;

  char header[4096];
  int  hlen = 0;

  hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "HTTP/1.1 %d %s\r\n", res->status,
                   status_text(res->status));
  if (res->content_type)
    hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "Content-Type: %s\r\n",
                     res->content_type);
  hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "Content-Length: %zu\r\n",
                   res->body_len);
  for (int i = 0; i < res->header_count; i++)
    hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "%s: %s\r\n",
                     res->headers[i].key, res->headers[i].value);
  if (keepalive && !res->_force_close)
    hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "Connection: keep-alive\r\n");
  else
    hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "Connection: close\r\n");
  hlen += snprintf(header + hlen, sizeof(header) - (size_t)hlen, "Server: cerver\r\n\r\n");

  if (res->_body_owned == 3) {
    /* File-descriptor sendfile path */
    if (send_all(sfd, header, (size_t)hlen) < 0) return -1;
    size_t total = res->body_len, sent = 0;
    while (sent < total) {
      ssize_t n = do_sendfile(sfd, res->_file_fd, (off_t)sent, total - sent);
      if (n < 0) {
#if !CERVER_PLATFORM_WINDOWS
        if (errno == EINTR) continue;
#endif  // !CERVER_PLATFORM_WINDOWS
        return -1;
      }
      if (n == 0) break;
      sent += (size_t)n;
    }
  } else if (res->body && res->body_len > 0) {
    if ((size_t)hlen + res->body_len <= sizeof(header)) {
      /* Small response: one syscall */
      memcpy(header + hlen, res->body, res->body_len);
      if (send_all(sfd, header, (size_t)hlen + res->body_len) < 0) return -1;
    } else {
      /* Large response: header then body */
      if (send_all(sfd, header, (size_t)hlen) < 0) return -1;
      if (send_all(sfd, res->body, res->body_len) < 0) return -1;
    }
  } else {
    if (send_all(sfd, header, (size_t)hlen) < 0) return -1;
  }

  return 0;
}

/* ------------------------------------------------------------------ */
/*  Response helpers                                                  */
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
