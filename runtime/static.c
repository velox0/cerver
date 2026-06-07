/*
 * static.c — Static file serving for the cerver runtime.
 *
 * In embedded mode, serves from the compiled-in asset array with
 * hash-based lookup. In filesystem mode, uses sendfile (Linux) or
 * mmap (macOS) with stat caching for zero-copy delivery.
 */

#include "win_compat.h"
#include "cerver.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/stat.h>

#if !CERVER_PLATFORM_WINDOWS
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>
#endif  // !CERVER_PLATFORM_WINDOWS

#ifdef __linux__
#include <sys/sendfile.h>
#endif  // __linux__

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
  /* Reject paths with ".." (literal traversal) */
  if (strstr(path, "..")) return 0;

  /* Reject paths with null bytes */
  if (memchr(path, '\0', strlen(path))) return 0;

  /* Must start with "/" */
  if (path[0] != '/') return 0;

  /* Reject encoded traversal sequences that survive url_decode:
   * url_decode runs before us, but double-encoding (%252e) and
   * mixed-case variants may slip through on some paths.  Reject any
   * remaining %XX sequences that decode to '.' or '/'. */
  const char* p = path;
  while (*p) {
    if (*p == '%' && p[1] && p[2]) {
      int hi = (p[1] >= '0' && p[1] <= '9')   ? p[1] - '0'
               : (p[1] >= 'a' && p[1] <= 'f') ? p[1] - 'a' + 10
               : (p[1] >= 'A' && p[1] <= 'F') ? p[1] - 'A' + 10
                                              : -1;
      int lo = (p[2] >= '0' && p[2] <= '9')   ? p[2] - '0'
               : (p[2] >= 'a' && p[2] <= 'f') ? p[2] - 'a' + 10
               : (p[2] >= 'A' && p[2] <= 'F') ? p[2] - 'A' + 10
                                              : -1;
      if (hi >= 0 && lo >= 0) {
        int decoded = (hi << 4) | lo;
        /* Reject if it would decode to '.' (0x2e), '/' (0x2f), or '\' (0x5c) */
        if (decoded == 0x2e || decoded == 0x2f || decoded == 0x5c) return 0;
      }
    }
#if CERVER_PLATFORM_WINDOWS
    /* Reject backslashes directly in the path */
    if (*p == '\\') return 0;
#endif  // CERVER_PLATFORM_WINDOWS
    p++;
  }

  return 1;
}

/* ------------------------------------------------------------------ */
/*  Accept-Encoding parsing                                           */
/* ------------------------------------------------------------------ */

typedef struct {
  int accepts_gzip;
  int accepts_br;
} encoding_prefs_t;

/*
 * Check whether `token` appears as a standalone comma-separated token in
 * the Accept-Encoding header value.  Using strstr() would produce false
 * positives (e.g. "br" matching inside "cobr" or "brotli").
 */
static int ae_has_token(const char* ae, const char* token) {
  size_t      tlen = strlen(token);
  const char* p    = ae;
  while (*p) {
    /* Skip whitespace and commas */
    while (*p == ' ' || *p == '\t' || *p == ',') p++;
    if (!*p) break;
    /* Find end of this token (stop at comma, semicolon, space, or NUL) */
    const char* start = p;
    while (*p && *p != ',' && *p != ';' && *p != ' ' && *p != '\t') p++;
    size_t len = (size_t)(p - start);
    if (len == tlen && memcmp(start, token, tlen) == 0) return 1;
    /* Skip quality value if present (;q=0.9) */
    while (*p && *p != ',') p++;
  }
  return 0;
}

static encoding_prefs_t parse_accept_encoding(const cerver_request_t* req) {
  encoding_prefs_t prefs = {0, 0};
  const char*      ae    = cerver_req_header(req, "Accept-Encoding");
  if (!ae) return prefs;

  if (ae_has_token(ae, "br")) prefs.accepts_br = 1;
  if (ae_has_token(ae, "gzip")) prefs.accepts_gzip = 1;

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
/*  Helper to resolve fallback paths for directory/clean-URL routes.  */
/*  - "/" -> "/index.html"                                            */
/*  - "/page" or "/page/" -> "/page/page.html"                        */
/* ------------------------------------------------------------------ */

static void get_fallback_path(const char* path, char* out, size_t out_len) {
  if (strcmp(path, "/") == 0 || strcmp(path, "") == 0) {
    snprintf(out, out_len, "/index.html");
    return;
  }

  size_t len = strlen(path);
  while (len > 0 && path[len - 1] == '/') {
    len--;
  }

  if (len == 0) {
    snprintf(out, out_len, "/index.html");
    return;
  }

  int last_slash = -1;
  for (int i = (int)len - 1; i >= 0; i--) {
    if (path[i] == '/') {
      last_slash = i;
      break;
    }
  }

  size_t segment_len = len - (last_slash + 1);
  if (segment_len == 0) {
    snprintf(out, out_len, "/index.html");
    return;
  }

  /* Extract the prefix and segment safely */
  char prefix[1024];
  if (len < sizeof(prefix)) {
    memcpy(prefix, path, len);
    prefix[len] = '\0';
  } else {
    snprintf(out, out_len, "/index.html");
    return;
  }

  char segment[256];
  if (segment_len < sizeof(segment)) {
    memcpy(segment, path + last_slash + 1, segment_len);
    segment[segment_len] = '\0';
  } else {
    snprintf(out, out_len, "/index.html");
    return;
  }

  snprintf(out, out_len, "%s/%s.html", prefix, segment);
}

/* ------------------------------------------------------------------ */
/*  Serve from embedded assets — hash-accelerated lookup              */
/* ------------------------------------------------------------------ */

static int serve_embedded(cerver_server_t* srv, cerver_request_t* req, cerver_response_t* res) {
  if (!srv->assets || srv->asset_count == 0) return -1;

  const char*           path  = req->path;
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

  /* Try with fallback path (for directory-like paths) */
  if (!found) {
    char fallback_path[CERVER_MAX_PATH];
    get_fallback_path(path, fallback_path, sizeof(fallback_path));

    uint32_t idx_hash = fnv1a(fallback_path);
    for (int i = 0; i < srv->asset_count; i++) {
      if (fnv1a(srv->assets[i].path) == idx_hash &&
          strcmp(srv->assets[i].path, fallback_path) == 0) {
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

  /* Build the full filesystem path — reject if it would overflow. */
  size_t dir_len  = strlen(srv->public_dir);
  size_t path_len = strlen(path);
  if (dir_len + path_len + 1 > sizeof(((struct { char b[CERVER_MAX_PATH * 2]; }){}).b)) return -1;

  char full_path[CERVER_MAX_PATH * 2];
  /* Bounds already verified above; silence -Wformat-truncation. */
#if defined(__GNUC__) && !defined(__clang__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wformat-truncation"
#endif  // __GNUC__ && !__clang__
  snprintf(full_path, sizeof(full_path), "%s%s", srv->public_dir, path);
#if defined(__GNUC__) && !defined(__clang__)
#pragma GCC diagnostic pop
#endif  // __GNUC__ && !__clang__

#if CERVER_PLATFORM_WINDOWS
  /* Normalize forward slashes to backslashes for native Windows APIs */
  for (char* p = full_path; *p; p++) {
    if (*p == '/') *p = '\\';
  }
#endif  // CERVER_PLATFORM_WINDOWS

  /* Check if it's a directory — try fallback path */
  struct stat st;
  if (stat(full_path, &st) == 0 && S_ISDIR(st.st_mode)) {
    char fallback_path[CERVER_MAX_PATH];
    get_fallback_path(path, fallback_path, sizeof(fallback_path));
    if (dir_len + strlen(fallback_path) + 1 > sizeof(full_path)) return -1;
    snprintf(full_path, sizeof(full_path), "%s%s", srv->public_dir, fallback_path);
#if CERVER_PLATFORM_WINDOWS
    for (char* p = full_path; *p; p++) {
      if (*p == '/') *p = '\\';
    }
#endif  // CERVER_PLATFORM_WINDOWS
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
   * Use sendfile for zero-copy filesystem static serving.
   * The file is opened and its descriptor is stored in the response structure
   * for streaming directly to the client socket in the writer.
   */
#if CERVER_PLATFORM_WINDOWS
  int fd = _open(full_path, _O_RDONLY | _O_BINARY);
#else
  int fd = open(full_path, O_RDONLY);
#endif  // CERVER_PLATFORM_WINDOWS
  if (fd < 0) return -1;

  res->status       = 200;
  res->content_type = mime;
  res->body         = NULL;
  res->body_len     = file_size;
  res->_body_owned  = 3; /* Special flag: sendfile, close fd */
  res->_file_fd     = fd;

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
