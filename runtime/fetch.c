/*
 * fetch.c — HTTP client for outbound API calls using libcurl.
 *
 * Provides cerver_fetch() which performs synchronous HTTP requests
 * from within generated handler code. Supports GET/POST/PUT/DELETE,
 * custom headers, and request bodies.
 *
 * The returned string is heap-allocated and must be freed by the caller.
 */

#include "cerver.h"

#if !CERVER_PLATFORM_WINDOWS || defined(CERVER_ENABLE_FETCH)
#include <curl/curl.h>
#endif
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#if !CERVER_PLATFORM_WINDOWS || defined(CERVER_ENABLE_FETCH)
/* ------------------------------------------------------------------ */
/*  Internal write callback for curl                                  */
/* ------------------------------------------------------------------ */

typedef struct {
  char*  data;
  size_t len;
  size_t cap;
} cerver_fetch_buf_t;

static size_t fetch_write_cb(void* contents, size_t size, size_t nmemb, void* userp) {
  size_t              realsize = size * nmemb;
  cerver_fetch_buf_t* buf      = (cerver_fetch_buf_t*)userp;

  /* Grow buffer if needed */
  while (buf->len + realsize + 1 > buf->cap) {
    size_t newcap = buf->cap * 2;
    if (newcap < 4096) newcap = 4096;
    char* tmp = realloc(buf->data, newcap);
    if (!tmp) return 0; /* signal error to curl */
    buf->data = tmp;
    buf->cap  = newcap;
  }

  memcpy(buf->data + buf->len, contents, realsize);
  buf->len += realsize;
  buf->data[buf->len] = '\0';

  return realsize;
}

/* ------------------------------------------------------------------ */
/*  Global curl init (thread-safe, called once)                       */
/* ------------------------------------------------------------------ */

static pthread_once_t curl_init_once = PTHREAD_ONCE_INIT;

static void curl_global_init_once(void) { curl_global_init(CURL_GLOBAL_DEFAULT); }
#endif

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * cerver_fetch — Perform a synchronous HTTP request.
 *
 * @param url     The URL to request (required).
 * @param method  HTTP method: "GET", "POST", "PUT", "DELETE" (NULL = "GET").
 * @param body    Request body for POST/PUT (NULL for none).
 * @param headers Array of "Key: Value" header strings (NULL-terminated, or NULL for none).
 *
 * @return Heap-allocated response body string (caller must free), or
 *         empty string "" (heap-allocated) on error.
 */
char* cerver_fetch(const char* url, const char* method, const char* body, const char** headers) {
  if (!url) {
    char* empty = malloc(1);
    if (empty) empty[0] = '\0';
    return empty;
  }

#if !CERVER_PLATFORM_WINDOWS || defined(CERVER_ENABLE_FETCH)
  /* Ensure global curl init */
  pthread_once(&curl_init_once, curl_global_init_once);

  CURL* curl = curl_easy_init();
  if (!curl) {
    char* empty = malloc(1);
    if (empty) empty[0] = '\0';
    return empty;
  }

  /* Response buffer */
  cerver_fetch_buf_t buf;
  buf.data = malloc(4096);
  buf.len  = 0;
  buf.cap  = 4096;
  if (!buf.data) {
    curl_easy_cleanup(curl);
    char* empty = malloc(1);
    if (empty) empty[0] = '\0';
    return empty;
  }
  buf.data[0] = '\0';

  /* Configure request */
  curl_easy_setopt(curl, CURLOPT_URL, url);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, fetch_write_cb);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, (void*)&buf);
  curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L); /* thread-safe */
  curl_easy_setopt(curl, CURLOPT_USERAGENT, "cerver/1.0");

  /* Set HTTP method */
  if (method) {
    if (strcmp(method, "POST") == 0) {
      curl_easy_setopt(curl, CURLOPT_POST, 1L);
    } else if (strcmp(method, "PUT") == 0) {
      curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PUT");
    } else if (strcmp(method, "DELETE") == 0) {
      curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "DELETE");
    } else if (strcmp(method, "PATCH") == 0) {
      curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PATCH");
    }
    /* GET is the default — no action needed */
  }

  /* Set request body */
  if (body) {
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(body));
  }

  /* Set custom headers */
  struct curl_slist* header_list = NULL;
  if (headers) {
    for (int i = 0; headers[i] != NULL; i++) {
      header_list = curl_slist_append(header_list, headers[i]);
    }
    if (header_list) {
      curl_easy_setopt(curl, CURLOPT_HTTPHEADER, header_list);
    }
  }

  /* Perform the request */
  CURLcode res = curl_easy_perform(curl);

  if (res != CURLE_OK) {
    fprintf(stderr, "cerver: fetch error: %s (url: %s)\n", curl_easy_strerror(res), url);
    /* Return empty string on error */
    buf.data[0] = '\0';
    buf.len     = 0;
  }

  /* Cleanup */
  if (header_list) curl_slist_free_all(header_list);
  curl_easy_cleanup(curl);

  return buf.data;
#else
  (void)method;
  (void)body;
  (void)headers;
  fprintf(stderr, "cerver: fetch not enabled in this build (url: %s)\n", url);
  char* empty = malloc(1);
  if (empty) empty[0] = '\0';
  return empty;
#endif
}
