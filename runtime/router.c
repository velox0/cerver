/*
 * router.c — Route matching and dispatch.
 *
 * Matches incoming requests against registered route patterns.
 * Supports static paths and dynamic segments (:param).
 */

#include "cerver.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/*  Request accessor helpers                                          */
/* ------------------------------------------------------------------ */

const char *cerver_req_param(const cerver_request_t *req, const char *key) {
    for (int i = 0; i < req->params_count; i++) {
        if (strcmp(req->params[i].key, key) == 0) {
            return req->params[i].value;
        }
    }
    return "";
}

const char *cerver_req_query(const cerver_request_t *req, const char *key) {
    for (int i = 0; i < req->query_count; i++) {
        if (strcmp(req->query[i].key, key) == 0) {
            return req->query[i].value;
        }
    }
    return "";
}

const char *cerver_req_header(const cerver_request_t *req, const char *key) {
    for (int i = 0; i < req->header_count; i++) {
        if (strcasecmp(req->headers[i].key, key) == 0) {
            return req->headers[i].value;
        }
    }
    return NULL;
}

/* ------------------------------------------------------------------ */
/*  Pattern matching with dynamic segment extraction                  */
/* ------------------------------------------------------------------ */

/*
 * Match a route pattern against a request path.
 * Pattern segments starting with ':' are dynamic and extract values.
 *
 * Examples:
 *   pattern="/items/:id"  path="/items/123"  → match, id="123"
 *   pattern="/"          path="/"             → match
 *   pattern="/api/data"  path="/api/data"     → match
 *   pattern="/api/data"  path="/api/other"    → no match
 */
int cerver_route_match(const cerver_route_t *route, cerver_request_t *req) {
    /* Method must match */
    if (strcmp(route->method, req->method) != 0) {
        return 0;
    }

    const char *pattern = route->pattern;
    const char *path = req->path;

    /* Fast path: exact match */
    if (strcmp(pattern, path) == 0) {
        return 1;
    }

    /* Segment-by-segment matching */
    /* We'll work with copies so we can tokenize */
    char pat_buf[CERVER_MAX_PATH];
    char path_buf[CERVER_MAX_PATH];
    strncpy(pat_buf, pattern, sizeof(pat_buf) - 1);
    pat_buf[sizeof(pat_buf) - 1] = '\0';
    strncpy(path_buf, path, sizeof(path_buf) - 1);
    path_buf[sizeof(path_buf) - 1] = '\0';

    /* Split into segments */
    char *pat_segments[64];
    char *path_segments[64];
    int pat_count = 0;
    int path_count = 0;

    char *saveptr;
    char *tok;

    tok = strtok_r(pat_buf, "/", &saveptr);
    while (tok && pat_count < 64) {
        pat_segments[pat_count++] = tok;
        tok = strtok_r(NULL, "/", &saveptr);
    }

    tok = strtok_r(path_buf, "/", &saveptr);
    while (tok && path_count < 64) {
        path_segments[path_count++] = tok;
        tok = strtok_r(NULL, "/", &saveptr);
    }

    /* Segment counts must match */
    if (pat_count != path_count) {
        return 0;
    }

    /* Match each segment */
    /* Reset params before populating */
    int saved_params = req->params_count;

    for (int i = 0; i < pat_count; i++) {
        if (pat_segments[i][0] == ':') {
            /* Dynamic segment — extract parameter */
            if (req->params_count < CERVER_MAX_PARAMS) {
                /* The key is the segment name without ':' */
                /* We need stable storage — use the request's internal structures.
                   Since we're in the request's lifetime, we can use strdup. */
                req->params[req->params_count].key = pat_segments[i] + 1;
                req->params[req->params_count].value = path_segments[i];
                req->params_count++;
            }
        } else {
            /* Static segment — must match exactly */
            if (strcmp(pat_segments[i], path_segments[i]) != 0) {
                /* Restore params on mismatch */
                req->params_count = saved_params;
                return 0;
            }
        }
    }

    return 1;
}

/* ------------------------------------------------------------------ */
/*  Dispatch: find and return the handler for a request               */
/* ------------------------------------------------------------------ */

cerver_handler_fn cerver_dispatch(cerver_server_t *srv, cerver_request_t *req) {
    if (!srv->routes) return NULL;

    for (int i = 0; i < srv->route_count; i++) {
        if (cerver_route_match(&srv->routes[i], req)) {
            return srv->routes[i].handler;
        }
    }

    return NULL;
}
