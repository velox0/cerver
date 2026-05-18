/*
 * router.c — Route matching and dispatch.
 *
 * Matches incoming requests against registered route patterns.
 * Supports static paths and dynamic segments (:param).
 * Supports dispatch override for compile-time generated dispatch.
 */

#include "cerver.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/*  Request accessor helpers                                          */
/* ------------------------------------------------------------------ */

const char* cerver_req_param(const cerver_request_t* req, const char* key) {
  for (int i = 0; i < req->params_count; i++) {
    if (strcmp(req->params[i].key, key) == 0) {
      return req->params[i].value;
    }
  }
  return "";
}

const char* cerver_req_query(const cerver_request_t* req, const char* key) {
  for (int i = 0; i < req->query_count; i++) {
    if (strcmp(req->query[i].key, key) == 0) {
      return req->query[i].value;
    }
  }
  return "";
}

const char* cerver_req_header(const cerver_request_t* req, const char* key) {
  for (int i = 0; i < req->header_count; i++) {
    if (strcasecmp(req->headers[i].key, key) == 0) {
      return req->headers[i].value;
    }
  }
  return NULL;
}

/* ------------------------------------------------------------------ */
/*  Connection lifecycle helpers                                      */
/* ------------------------------------------------------------------ */

/*
 * Returns 1 if the client sent "Connection: close" or is HTTP/1.0
 * without an explicit "Connection: keep-alive".
 */
int cerver_req_wants_close(const cerver_request_t* req) {
  const char* conn = cerver_req_header(req, "Connection");
  if (conn && strcasecmp(conn, "close") == 0) return 1;
  /* HTTP/1.0 without explicit keep-alive → close */
  /* (We don't track HTTP version separately, so default keep-alive for 1.1) */
  return 0;
}

/* ------------------------------------------------------------------ */
/*  Server configuration helpers                                      */
/* ------------------------------------------------------------------ */

void cerver_set_dispatch(cerver_server_t* srv, cerver_dispatch_fn fn) {
  srv->dispatch_override = fn;
}

/* ------------------------------------------------------------------ */
/*  Pattern matching with dynamic segment extraction                  */
/* ------------------------------------------------------------------ */

/*
 * Match a route pattern against a request path.
 * Pattern segments starting with ':' are dynamic and extract values.
 *
 * Uses manual segment iteration instead of strtok_r for speed.
 */
int cerver_route_match(const cerver_route_t* route, cerver_request_t* req) {
  /* Method must match */
  if (strcmp(route->method, req->method) != 0) {
    return 0;
  }

  const char* pattern = route->pattern;
  const char* path = req->path;

  /* Fast path: exact match */
  if (strcmp(pattern, path) == 0) {
    return 1;
  }

  /* No dynamic segments? Then the strcmp above was definitive */
  if (!strchr(pattern, ':')) {
    return 0;
  }

  /* Segment-by-segment matching without strtok_r */
  const char* pp = pattern; /* pattern pointer */
  const char* rp = path;    /* request path pointer */

  int saved_params = req->params_count;

  /* Skip leading '/' */
  if (*pp == '/') pp++;
  if (*rp == '/') rp++;

  while (*pp && *rp) {
    /* Extract pattern segment */
    const char* pp_seg = pp;
    while (*pp && *pp != '/') pp++;
    size_t pp_len = (size_t)(pp - pp_seg);

    /* Extract path segment */
    const char* rp_seg = rp;
    while (*rp && *rp != '/') rp++;
    size_t rp_len = (size_t)(rp - rp_seg);

    if (pp_seg[0] == ':') {
      /* Dynamic segment — extract parameter */
      if (req->params_count < CERVER_MAX_PARAMS) {
        req->params[req->params_count].key = pp_seg + 1;
        /* Temporarily NUL-terminate the key at the slash */
        /* The key points into the route pattern (static/const) */
        req->params[req->params_count].value = rp_seg;
        req->params_count++;
      }
    } else {
      /* Static segment — must match exactly */
      if (pp_len != rp_len || memcmp(pp_seg, rp_seg, pp_len) != 0) {
        req->params_count = saved_params;
        return 0;
      }
    }

    /* Skip '/' separator */
    if (*pp == '/') pp++;
    if (*rp == '/') rp++;
  }

  /* Both must be consumed */
  if (*pp || *rp) {
    req->params_count = saved_params;
    return 0;
  }

  return 1;
}

/* ------------------------------------------------------------------ */
/*  Dispatch: find and return the handler for a request               */
/* ------------------------------------------------------------------ */

cerver_handler_fn cerver_dispatch(cerver_server_t* srv, cerver_request_t* req) {
  /* Try the generated compile-time dispatch first */
  if (srv->dispatch_override) {
    cerver_handler_fn h = srv->dispatch_override(req);
    if (h) return h;
  }

  /* Fall back to generic route table scan */
  if (!srv->routes) return NULL;

  for (int i = 0; i < srv->route_count; i++) {
    if (cerver_route_match(&srv->routes[i], req)) {
      return srv->routes[i].handler;
    }
  }

  return NULL;
}
