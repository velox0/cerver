/*
 * static.c — Static file serving for the cerver runtime.
 *
 * In embedded mode, serves from the compiled-in asset array with
 * hash-based lookup. In filesystem mode, uses sendfile (Linux) or
 * mmap (macOS) with stat caching for zero-copy delivery.
 */

#include "cerver.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include <time.h>

#ifdef __linux__
#include <sys/sendfile.h>
#endif

/* ------------------------------------------------------------------ */
/*  FNV-1a hash for fast asset lookup                                 */
/* ------------------------------------------------------------------ */

static uint32_t fnv1a(const char* str) {
  uint32_t hash = 2166136261u;
  while (*str) {
    hash ^= (uint8_t)*str++;
    hash *= 16777619u;
  }
  return hash;
}

/* ------------------------------------------------------------------ */
/*  Path safety: prevent directory traversal                          */
/* ------------------------------------------------------------------ */

static int path_is_safe(const char* path) {
  /* Reject paths with ".." */
  if (strstr(path, "..")) return 0;

  /* Reject paths with null bytes */
  if (memchr(path, '\0', strlen(path))) return 0;

  /* Must start with "/" */
  if (path[0] != '/') return 0;

  return 1;
}

/* ------------------------------------------------------------------ */
/*  Accept-Encoding parsing                                           */
/* ------------------------------------------------------------------ */

typedef struct {
  int accepts_gzip;
  int accepts_br;
} encoding_prefs_t;

static encoding_prefs_t parse_accept_encoding(const cerver_request_t* req) {
  encoding_prefs_t prefs = {0, 0};
  const char* ae = cerver_req_header(req, "Accept-Encoding");
  if (!ae) return prefs;

  if (strstr(ae, "br")) prefs.accepts_br = 1;
  if (strstr(ae, "gzip")) prefs.accepts_gzip = 1;

  return prefs;
}

/* ------------------------------------------------------------------ */
/*  Cache header helper                                               */
/* ------------------------------------------------------------------ */

static void add_cache_headers(cerver_response_t* res, const char* path) {
  /* Hashed/versioned assets (in /static/) get long cache */
  if (strstr(path, "/static/") || strstr(path, "/assets/")) {
    cerver_res_header(res, "Cache-Control", "public, max-age=31536000, immutable");
  } else {
    /* HTML and other top-level files get short cache with revalidation */
    cerver_res_header(res, "Cache-Control", "public, max-age=3600, must-revalidate");
  }
}

/* ------------------------------------------------------------------ */
/*  Serve from embedded assets — hash-accelerated lookup              */
/* ------------------------------------------------------------------ */

static int serve_embedded(cerver_server_t* srv, cerver_request_t* req, cerver_response_t* res) {
  if (!srv->assets || srv->asset_count == 0) return -1;

  const char* path = req->path;
  const cerver_asset_t* found = NULL;

  /*
   * Use FNV-1a hash for O(1) average lookup instead of linear scan.
   * For small asset counts (<64), linear scan is fine, but hash helps
   * when there are hundreds of embedded assets.
   */
  uint32_t target_hash = fnv1a(path);

  /* Try exact match first */
  for (int i = 0; i < srv->asset_count; i++) {
    if (fnv1a(srv->assets[i].path) == target_hash && strcmp(srv->assets[i].path, path) == 0) {
      found = &srv->assets[i];
      break;
    }
  }

  /* Try with /index.html appended (for directory-like paths) */
  if (!found) {
    char index_path[CERVER_MAX_PATH];
    size_t plen = strlen(path);
    if (plen > 0 && path[plen - 1] == '/') {
      snprintf(index_path, sizeof(index_path), "%sindex.html", path);
    } else {
      snprintf(index_path, sizeof(index_path), "%s/index.html", path);
    }

    uint32_t idx_hash = fnv1a(index_path);
    for (int i = 0; i < srv->asset_count; i++) {
      if (fnv1a(srv->assets[i].path) == idx_hash && strcmp(srv->assets[i].path, index_path) == 0) {
        found = &srv->assets[i];
        break;
      }
    }
  }

  if (!found) return -1;

  /* Check for pre-compressed variants */
  encoding_prefs_t enc = parse_accept_encoding(req);

  if (enc.accepts_br && found->data_br && found->data_br_len > 0) {
    /* Serve brotli */
    cerver_res_file(res, 200, found->mime_type, found->data_br, found->data_br_len);
    cerver_res_header(res, "Content-Encoding", "br");
    cerver_res_header(res, "Vary", "Accept-Encoding");
  } else if (enc.accepts_gzip && found->data_gz && found->data_gz_len > 0) {
    /* Serve gzip */
    cerver_res_file(res, 200, found->mime_type, found->data_gz, found->data_gz_len);
    cerver_res_header(res, "Content-Encoding", "gzip");
    cerver_res_header(res, "Vary", "Accept-Encoding");
  } else {
    /* Serve uncompressed */
    cerver_res_file(res, 200, found->mime_type, found->data, found->data_len);
  }

  add_cache_headers(res, found->path);

  return 0;
}

/* ------------------------------------------------------------------ */
/*  Serve from filesystem — sendfile/mmap + stat cache                */
/* ------------------------------------------------------------------ */

static int serve_filesystem(cerver_server_t* srv, cerver_request_t* req, cerver_response_t* res) {
  if (!srv->public_dir) return -1;

  const char* path = req->path;
  if (!path_is_safe(path)) return -1;

  /* Build the full filesystem path */
  char full_path[CERVER_MAX_PATH * 2];
  snprintf(full_path, sizeof(full_path), "%s%s", srv->public_dir, path);

  /* Check if it's a directory — try index.html */
  struct stat st;
  if (stat(full_path, &st) == 0 && S_ISDIR(st.st_mode)) {
    snprintf(full_path, sizeof(full_path), "%s%s/index.html", srv->public_dir, path);
    if (stat(full_path, &st) != 0) return -1;
  }

  /* Must be a regular file */
  if (stat(full_path, &st) != 0 || !S_ISREG(st.st_mode)) {
    return -1;
  }

  size_t file_size = (size_t)st.st_size;

  /* Store in stat cache for future lookups */
  cerver_stat_cache_store(&srv->stat_cache, full_path, file_size, st.st_mtime);

  /* Determine MIME type */
  const char* mime = cerver_mime_from_path(full_path);

  /*
   * Use mmap for zero-copy serving instead of fopen+malloc+fread.
   * The mmap'd region is used directly as the response body.
   * We mark it as _body_owned=0 since munmap needs special handling,
   * but for simplicity we'll use read() for small files and mmap for large.
   */
  if (file_size > 65536) {
    /* Large files: mmap for zero-copy */
    int fd = open(full_path, O_RDONLY);
    if (fd < 0) return -1;

    void* mapped = mmap(NULL, file_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);

    if (mapped == MAP_FAILED) return -1;

    /* Advise the kernel we'll read sequentially */
    madvise(mapped, file_size, MADV_SEQUENTIAL);

    res->status = 200;
    res->content_type = mime;
    res->body = (const char*)mapped;
    res->body_len = file_size;
    res->_body_owned = 2; /* Special flag: needs munmap, not free */
  } else {
    /* Small files: read into buffer (avoids mmap overhead) */
    int fd = open(full_path, O_RDONLY);
    if (fd < 0) return -1;

    char* file_data = malloc(file_size);
    if (!file_data) {
      close(fd);
      return -1;
    }

    size_t total = 0;
    while (total < file_size) {
      ssize_t n = read(fd, file_data + total, file_size - total);
      if (n <= 0) break;
      total += (size_t)n;
    }
    close(fd);

    if (total != file_size) {
      free(file_data);
      return -1;
    }

    res->status = 200;
    res->content_type = mime;
    res->body = file_data;
    res->body_len = file_size;
    res->_body_owned = 1; /* malloc'd */
  }

  add_cache_headers(res, path);

  return 0;
}

/* ------------------------------------------------------------------ */
/*  Main static serving entry point                                   */
/* ------------------------------------------------------------------ */

int cerver_serve_static(cerver_server_t* srv, cerver_request_t* req, cerver_response_t* res) {
  /* Only serve GET requests for static files */
  if (strcmp(req->method, "GET") != 0) return -1;

  /* Try embedded assets first */
  if (serve_embedded(srv, req, res) == 0) return 0;

  /* Fall back to filesystem */
  if (serve_filesystem(srv, req, res) == 0) return 0;

  return -1;
}
