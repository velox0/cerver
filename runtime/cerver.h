/*
 * cerver.h — Core header for the cerver HTTP runtime.
 *
 * This is the only header needed by generated server code.
 * It defines request/response types, server lifecycle, and
 * the route dispatch interface.
 */

#ifndef CERVER_H
#define CERVER_H

#include <stddef.h>
#include <stdint.h>
#include <pthread.h>

/* ------------------------------------------------------------------ */
/*  Limits                                                            */
/* ------------------------------------------------------------------ */

#define CERVER_MAX_HEADERS     64
#define CERVER_MAX_PARAMS      16
#define CERVER_MAX_QUERY       32
#define CERVER_MAX_PATH        2048
#define CERVER_MAX_HEADER_VAL  4096
#define CERVER_READ_BUF        8192
#define CERVER_READ_BUF_MAX    (1 << 20)   /* 1 MB hard limit */
#define CERVER_MAX_ROUTES      256

#define CERVER_THREAD_POOL_DEFAULT  4
#define CERVER_TASK_QUEUE_SIZE      256

/* ------------------------------------------------------------------ */
/*  Key-value pair (used for headers, query params, route params)     */
/* ------------------------------------------------------------------ */

typedef struct {
    const char *key;
    const char *value;
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
    const char *body;
    size_t      body_len;

    /* Internal: raw buffer ownership */
    char       *_raw_buf;
    size_t      _raw_len;
} cerver_request_t;

/* ------------------------------------------------------------------ */
/*  Response                                                          */
/* ------------------------------------------------------------------ */

typedef struct {
    int         status;
    const char *content_type;

    /* Response body — can be heap-allocated or static */
    const char *body;
    size_t      body_len;

    /* Extra headers */
    cerver_kv_t headers[CERVER_MAX_HEADERS];
    int         header_count;

    /* Internal flag: was body malloc'd? */
    int         _body_owned;
} cerver_response_t;

/* Response helpers — called by generated handler code */
void cerver_res_text(cerver_response_t *res, int status, const char *text);
void cerver_res_json(cerver_response_t *res, int status, const char *json);
void cerver_res_html(cerver_response_t *res, int status, const char *html);
void cerver_res_file(cerver_response_t *res, int status, const char *mime,
                     const unsigned char *data, size_t len);
void cerver_res_header(cerver_response_t *res, const char *key, const char *val);

/* ------------------------------------------------------------------ */
/*  Request helpers                                                   */
/* ------------------------------------------------------------------ */

const char *cerver_req_param(const cerver_request_t *req, const char *key);
const char *cerver_req_query(const cerver_request_t *req, const char *key);
const char *cerver_req_header(const cerver_request_t *req, const char *key);

/* ------------------------------------------------------------------ */
/*  Route definition                                                  */
/* ------------------------------------------------------------------ */

typedef void (*cerver_handler_fn)(cerver_request_t *req, cerver_response_t *res);

typedef struct {
    const char       *method;   /* "GET", "POST" */
    const char       *pattern;  /* "/", "/art/:key", "/api/projects" */
    cerver_handler_fn handler;
} cerver_route_t;

/* ------------------------------------------------------------------ */
/*  Embedded asset (for --embed builds)                               */
/* ------------------------------------------------------------------ */

typedef struct {
    const char          *path;      /* e.g. "/index.html" */
    const char          *mime_type; /* e.g. "text/html" */
    const unsigned char *data;
    size_t               data_len;

    /* Pre-compressed variants (NULL if not available) */
    const unsigned char *data_gz;
    size_t               data_gz_len;
    const unsigned char *data_br;
    size_t               data_br_len;
} cerver_asset_t;

/* ------------------------------------------------------------------ */
/*  Server                                                            */
/* ------------------------------------------------------------------ */

typedef struct {
    int              port;
    int              sock_fd;
    cerver_route_t  *routes;
    int              route_count;
    cerver_asset_t  *assets;
    int              asset_count;
    const char      *public_dir;   /* NULL if embedded mode */
    volatile int     running;

    /* Thread pool */
    int              thread_count;
    pthread_t       *threads;
    int              task_queue[CERVER_TASK_QUEUE_SIZE];
    int              tq_head;
    int              tq_tail;
    int              tq_count;
    pthread_mutex_t  tq_mutex;
    pthread_cond_t   tq_cond;
} cerver_server_t;

/* Server lifecycle */
int  cerver_init(cerver_server_t *srv, int port, int threads);
int  cerver_add_routes(cerver_server_t *srv, cerver_route_t *routes, int count);
int  cerver_set_assets(cerver_server_t *srv, cerver_asset_t *assets, int count);
void cerver_set_public_dir(cerver_server_t *srv, const char *dir);
int  cerver_listen(cerver_server_t *srv);
void cerver_shutdown(cerver_server_t *srv);

/* ------------------------------------------------------------------ */
/*  HTTP parser (internal)                                            */
/* ------------------------------------------------------------------ */

int cerver_parse_request(const char *raw, size_t len, cerver_request_t *req);

/* ------------------------------------------------------------------ */
/*  HTTP writer (internal)                                            */
/* ------------------------------------------------------------------ */

int cerver_write_response(int fd, const cerver_response_t *res);

/* ------------------------------------------------------------------ */
/*  Router (internal)                                                 */
/* ------------------------------------------------------------------ */

int cerver_route_match(const cerver_route_t *route, cerver_request_t *req);
cerver_handler_fn cerver_dispatch(cerver_server_t *srv, cerver_request_t *req);

/* ------------------------------------------------------------------ */
/*  MIME (internal)                                                   */
/* ------------------------------------------------------------------ */

const char *cerver_mime_from_path(const char *path);

/* ------------------------------------------------------------------ */
/*  Static file serving (internal)                                    */
/* ------------------------------------------------------------------ */

int cerver_serve_static(cerver_server_t *srv, cerver_request_t *req,
                        cerver_response_t *res);

#endif /* CERVER_H */
