/*
 * cerver.h — Core header for the cerver HTTP runtime.
 *
 * This is the only header needed by generated server code.
 * It defines request/response types, server lifecycle, and
 * the route dispatch interface.
 */

#include "win_compat.h"

#ifndef CERVER_H
#define CERVER_H

#include <stddef.h>
#include <stdint.h>
#include <pthread.h>

/* ------------------------------------------------------------------ */
/*  Limits                                                            */
/* ------------------------------------------------------------------ */

#define CERVER_MAX_HEADERS    64
#define CERVER_MAX_PARAMS     16
#define CERVER_MAX_QUERY      32
#define CERVER_MAX_PATH       2048
#define CERVER_MAX_HEADER_VAL 4096
#define CERVER_READ_BUF       8192
#define CERVER_READ_BUF_MAX   (1 << 20) /* 1 MB hard limit */
#define CERVER_MAX_ROUTES     256

/* Keep-alive settings */
#define CERVER_KEEPALIVE_MAX     2000000000 /* max requests per connection */
#define CERVER_KEEPALIVE_TIMEOUT 5          /* seconds idle between requests */

/* Event loop tuning */
#define CERVER_MAX_EVENTS     256
#define CERVER_LISTEN_BACKLOG 4096

/* Worker architecture */
#define CERVER_THREAD_POOL_DEFAULT 4
#define CERVER_TASK_QUEUE_SIZE     1024

/* Stat cache for filesystem serving */
#define CERVER_STAT_CACHE_SIZE 256
#define CERVER_STAT_CACHE_TTL  60 /* seconds */

/* ------------------------------------------------------------------ */
/*  Key-value pair (used for headers, query params, route params)     */
/* ------------------------------------------------------------------ */

typedef struct {
  const char* key;
  const char* value;
} cerver_kv_t;

/* ------------------------------------------------------------------ */
/*  Request                                                           */
/* ------------------------------------------------------------------ */

typedef struct {
  /* HTTP method: "GET", "POST", etc. */
  char method[16];

  /* Decoded path (no query string) */
  char path[CERVER_MAX_PATH];

  /* Raw query string (after '?') */
  char query_string[CERVER_MAX_PATH];

  /* Parsed query parameters */
  cerver_kv_t query[CERVER_MAX_QUERY];
  int         query_count;

  /* Route parameters (from dynamic segments like :key) */
  cerver_kv_t params[CERVER_MAX_PARAMS];
  int         params_count;

  /* Request headers */
  cerver_kv_t headers[CERVER_MAX_HEADERS];
  int         header_count;

  /* Request body (for POST) */
  const char* body;
  size_t      body_len;

  /* Internal: raw buffer ownership (NULL if in-place parsing used) */
  char*  _raw_buf;
  size_t _raw_len;
} cerver_request_t;

/* ------------------------------------------------------------------ */
/*  Response                                                          */
/* ------------------------------------------------------------------ */

typedef struct {
  int         status;
  const char* content_type;

  /* Response body — can be heap-allocated or static */
  const char* body;
  size_t      body_len;

  /* Extra headers */
  cerver_kv_t headers[CERVER_MAX_HEADERS];
  int         header_count;

  /* Internal flag: was body malloc'd? */
  int _body_owned;

  /* Keep-alive control: set to 1 to force close after response */
  int _force_close;

  /* Internal file descriptor for sendfile serving */
  int _file_fd;
} cerver_response_t;

/* Response helpers — called by generated handler code */
void cerver_res_text(cerver_response_t* res, int status, const char* text);
void cerver_res_json(cerver_response_t* res, int status, const char* json);
void cerver_res_html(cerver_response_t* res, int status, const char* html);
void cerver_res_file(cerver_response_t* res, int status, const char* mime,
                     const unsigned char* data, size_t len);
void cerver_res_header(cerver_response_t* res, const char* key, const char* val);

/* ------------------------------------------------------------------ */
/*  Request helpers                                                   */
/* ------------------------------------------------------------------ */

const char* cerver_req_param(const cerver_request_t* req, const char* key);
const char* cerver_req_query(const cerver_request_t* req, const char* key);
const char* cerver_req_header(const cerver_request_t* req, const char* key);

/* Check if client wants to close after this request */
int cerver_req_wants_close(const cerver_request_t* req);

/* ------------------------------------------------------------------ */
/*  Route definition                                                  */
/* ------------------------------------------------------------------ */

typedef void (*cerver_handler_fn)(cerver_request_t* req, cerver_response_t* res);

typedef struct {
  const char*       method;  /* "GET", "POST" */
  const char*       pattern; /* "/", "/groups/:group_id", "/api/items" */
  cerver_handler_fn handler;
} cerver_route_t;

/* ------------------------------------------------------------------ */
/*  Embedded asset (for --embed builds)                               */
/* ------------------------------------------------------------------ */

typedef struct {
  const char*          path;      /* e.g. "/index.html" */
  const char*          mime_type; /* e.g. "text/html" */
  const unsigned char* data;
  size_t               data_len;

  /* Pre-compressed variants (NULL if not available) */
  const unsigned char* data_gz;
  size_t               data_gz_len;
  const unsigned char* data_br;
  size_t               data_br_len;

  /* Pre-computed response header (NULL if not generated) */
  const char* prebuilt_header;
  size_t      prebuilt_header_len;
} cerver_asset_t;

/* ------------------------------------------------------------------ */
/*  Stat cache for filesystem serving                                 */
/* ------------------------------------------------------------------ */

typedef struct {
  char   path[CERVER_MAX_PATH];
  size_t file_size;
  time_t mtime;
  time_t cached_at;
  int    valid;
} cerver_stat_entry_t;

typedef struct {
  cerver_stat_entry_t entries[CERVER_STAT_CACHE_SIZE];
  pthread_mutex_t     lock;
} cerver_stat_cache_t;

/* ------------------------------------------------------------------ */
/*  Generated dispatch (compile-time route optimization)              */
/* ------------------------------------------------------------------ */

typedef cerver_handler_fn (*cerver_dispatch_fn)(cerver_request_t* req);

/* ------------------------------------------------------------------ */
/*  Worker state (per-core event loop)                                */
/* ------------------------------------------------------------------ */

typedef struct cerver_server cerver_server_t;

typedef struct {
  int              id;
  int              event_fd;  /* kqueue or epoll fd */
  int              listen_fd; /* per-worker on Linux, shared on macOS */
  cerver_server_t* srv;
  pthread_t        thread;
} cerver_worker_t;

/* ------------------------------------------------------------------ */
/*  Server                                                            */
/* ------------------------------------------------------------------ */

struct cerver_server {
  int             port;
  int             sock_fd;
  cerver_route_t* routes;
  int             route_count;
  cerver_asset_t* assets;
  int             asset_count;
  const char*     public_dir; /* NULL if embedded mode */
  volatile int    running;

  /* Generated dispatch override (faster than generic router) */
  cerver_dispatch_fn dispatch_override;

  /* Stat cache for filesystem serving */
  cerver_stat_cache_t stat_cache;

  /* Worker pool */
  int              worker_count;   /* configured connection worker count */
  int              acceptor_count; /* actual acceptor thread count */
  cerver_worker_t* workers;

  /* Route trie for radix/trie-based routing */
  void* route_trie;
};

/* Server lifecycle */
int  cerver_init(cerver_server_t* srv, int port, int threads);
int  cerver_add_routes(cerver_server_t* srv, cerver_route_t* routes, int count);
int  cerver_set_assets(cerver_server_t* srv, cerver_asset_t* assets, int count);
void cerver_set_public_dir(cerver_server_t* srv, const char* dir);
void cerver_set_dispatch(cerver_server_t* srv, cerver_dispatch_fn fn);
int  cerver_listen(cerver_server_t* srv);
void cerver_shutdown(cerver_server_t* srv);

/* ------------------------------------------------------------------ */
/*  HTTP parser (internal)                                            */
/* ------------------------------------------------------------------ */

int cerver_parse_request(const char* raw, size_t len, cerver_request_t* req);

/* ------------------------------------------------------------------ */
/*  HTTP writer (internal)                                            */
/* ------------------------------------------------------------------ */

int cerver_write_response(int fd, const cerver_response_t* res, int keepalive);

/* ------------------------------------------------------------------ */
/*  Router (internal)                                                 */
/* ------------------------------------------------------------------ */

int               cerver_route_match(const cerver_route_t* route, cerver_request_t* req);
cerver_handler_fn cerver_dispatch(cerver_server_t* srv, cerver_request_t* req);
void*             cerver_trie_create(void);
void              cerver_trie_insert(void* trie, const char* pattern, const char* method,
                                     cerver_handler_fn handler);
void              cerver_trie_free(void* trie);

/* ------------------------------------------------------------------ */
/*  Fetch — outbound HTTP client (libcurl)                            */
/* ------------------------------------------------------------------ */

/**
 * Perform a synchronous HTTP request.
 *
 * @param url     Request URL (required).
 * @param method  HTTP method: "GET", "POST", "PUT", "DELETE", "PATCH"
 *                (NULL defaults to "GET").
 * @param body    Request body string (NULL for none).
 * @param headers NULL-terminated array of "Key: Value" header strings,
 *                or NULL for no custom headers.
 *
 * @return Heap-allocated response body (caller must free()), or
 *         empty heap-allocated string on error.
 */
char* cerver_fetch(const char* url, const char* method, const char* body, const char** headers);

/* ------------------------------------------------------------------ */
/*  MIME (internal)                                                   */
/* ------------------------------------------------------------------ */

const char* cerver_mime_from_path(const char* path);

/* ------------------------------------------------------------------ */
/*  Static file serving (internal)                                    */
/* ------------------------------------------------------------------ */

int cerver_serve_static(cerver_server_t* srv, cerver_request_t* req, cerver_response_t* res);

/* ------------------------------------------------------------------ */
/*  Stat cache (internal)                                             */
/* ------------------------------------------------------------------ */

void cerver_stat_cache_init(cerver_stat_cache_t* cache);
int  cerver_stat_cache_lookup(cerver_stat_cache_t* cache, const char* path, size_t* file_size);
void cerver_stat_cache_store(cerver_stat_cache_t* cache, const char* path, size_t file_size,
                             time_t mtime);

#endif  // CERVER_H
