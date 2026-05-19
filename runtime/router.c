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
#include <strings.h>

/* ------------------------------------------------------------------ */
/*  Request accessor helpers                                          */
/* ------------------------------------------------------------------ */

const char* cerver_req_param(const cerver_request_t* req, const char* key) {
  for (int i = 0; i < req->params_count; i++) {
    const char* pkey = req->params[i].key;
    if (pkey && pkey[0] == key[0]) {
      int j = 0;
      while (key[j] && pkey[j] == key[j]) {
        j++;
      }
      if (key[j] == '\0' && (pkey[j] == '\0' || pkey[j] == '/')) {
        return req->params[i].value;
      }
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
  const char* path    = req->path;

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

  int   saved_params = req->params_count;
  char* param_slashes[CERVER_MAX_PARAMS];
  int   param_slash_count = 0;

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
        /* The key points into the route pattern (static/const, not NUL-terminated) */
        req->params[req->params_count].value = rp_seg;
        req->params_count++;
        if (*rp == '/') {
          param_slashes[param_slash_count++] = (char*)rp;
        }
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

  /* Match succeeded, NUL-terminate extracted values in-place inside req->path */
  for (int i = 0; i < param_slash_count; i++) {
    *param_slashes[i] = '\0';
  }

  return 1;
}

/* ------------------------------------------------------------------ */
/*  Dispatch: find and return the handler for a request               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Trie/Radix Route Router                                           */
/* ------------------------------------------------------------------ */

static char* trie_strndup(const char* s, size_t n) {
  char* p = malloc(n + 1);
  if (p) {
    memcpy(p, s, n);
    p[n] = '\0';
  }
  return p;
}

typedef struct trie_node trie_node_t;

struct trie_node {
  char* segment;
  int   is_param;
  char* param_name;

  struct {
    const char*       method;
    cerver_handler_fn handler;
  } handlers[16];
  int handler_count;

  trie_node_t** children;
  int           children_count;
  int           children_cap;
};

void* cerver_trie_create(void) {
  trie_node_t* node = calloc(1, sizeof(trie_node_t));
  return node;
}

static trie_node_t* trie_create_node(const char* segment, size_t len) {
  trie_node_t* node = calloc(1, sizeof(trie_node_t));
  if (node && segment) {
    node->segment = trie_strndup(segment, len);
    if (node->segment[0] == ':') {
      node->is_param   = 1;
      node->param_name = trie_strndup(node->segment + 1, len - 1);
    }
  }
  return node;
}

void cerver_trie_insert(void* trie, const char* pattern, const char* method,
                        cerver_handler_fn handler) {
  if (!trie) return;
  trie_node_t* curr = (trie_node_t*)trie;
  const char*  p    = pattern;
  while (*p == '/') p++;

  while (*p) {
    const char* seg_start = p;
    while (*p && *p != '/') p++;
    size_t len = (size_t)(p - seg_start);
    if (len == 0) {
      while (*p == '/') p++;
      continue;
    }

    // Find if child exists
    trie_node_t* child = NULL;
    for (int i = 0; i < curr->children_count; i++) {
      trie_node_t* c = curr->children[i];
      if (strlen(c->segment) == len && memcmp(c->segment, seg_start, len) == 0) {
        child = c;
        break;
      }
    }

    if (!child) {
      child = trie_create_node(seg_start, len);
      if (curr->children_count >= curr->children_cap) {
        curr->children_cap = curr->children_cap == 0 ? 4 : curr->children_cap * 2;
        curr->children     = realloc(curr->children, curr->children_cap * sizeof(trie_node_t*));
      }
      curr->children[curr->children_count++] = child;
    }

    curr = child;
    while (*p == '/') p++;
  }

  // Add handler to leaf
  if (curr->handler_count < 16) {
    curr->handlers[curr->handler_count].method  = method;
    curr->handlers[curr->handler_count].handler = handler;
    curr->handler_count++;
  }
}

void cerver_trie_free(void* trie) {
  if (!trie) return;
  trie_node_t* node = (trie_node_t*)trie;
  for (int i = 0; i < node->children_count; i++) {
    cerver_trie_free(node->children[i]);
  }
  free(node->children);
  free(node->segment);
  free(node->param_name);
  free(node);
}

static int trie_match_recursive(trie_node_t* node, const char* path, cerver_request_t* req,
                                cerver_handler_fn* out_handler, int param_start_idx) {
  // Skip leading slashes
  while (*path == '/') path++;

  if (*path == '\0') {
    // Check if node has a handler for req->method
    for (int i = 0; i < node->handler_count; i++) {
      if (strcmp(node->handlers[i].method, req->method) == 0) {
        *out_handler      = node->handlers[i].handler;
        req->params_count = param_start_idx;
        return 1;
      }
    }
    return 0;
  }

  // Extract next segment from path
  const char* seg_start = path;
  while (*path && *path != '/') path++;
  size_t seg_len = (size_t)(path - seg_start);

  // Try static children first
  for (int i = 0; i < node->children_count; i++) {
    trie_node_t* child = node->children[i];
    if (!child->is_param) {
      if (strlen(child->segment) == seg_len && memcmp(child->segment, seg_start, seg_len) == 0) {
        if (trie_match_recursive(child, path, req, out_handler, param_start_idx)) {
          return 1;
        }
      }
    }
  }

  // Try parameter/dynamic children next
  for (int i = 0; i < node->children_count; i++) {
    trie_node_t* child = node->children[i];
    if (child->is_param) {
      if (param_start_idx < CERVER_MAX_PARAMS) {
        req->params[param_start_idx].key   = child->param_name;
        req->params[param_start_idx].value = seg_start;
      }
      if (trie_match_recursive(child, path, req, out_handler, param_start_idx + 1)) {
        return 1;
      }
    }
  }

  return 0;
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

  /* Fall back to generic route table scan via Trie */
  if (!srv->route_trie) return NULL;

  cerver_handler_fn handler = NULL;
  req->params_count         = 0;
  if (trie_match_recursive((trie_node_t*)srv->route_trie, req->path, req, &handler, 0)) {
    // NUL-terminate extracted values in-place inside req->path
    for (int i = 0; i < req->params_count; i++) {
      char* val = (char*)req->params[i].value;
      while (*val && *val != '/') val++;
      if (*val == '/') *val = '\0';
    }
    return handler;
  }

  return NULL;
}
