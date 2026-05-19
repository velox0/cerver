#include "cerver.h"
#include "minunit.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static const char* res_header(const cerver_response_t* res, const char* key) {
  for (int i = 0; i < res->header_count; i++) {
    if (strcmp(res->headers[i].key, key) == 0) {
      return res->headers[i].value;
    }
  }
  return NULL;
}

static void req_add_header(cerver_request_t* req, const char* key, const char* value) {
  req->headers[req->header_count].key   = key;
  req->headers[req->header_count].value = value;
  req->header_count++;
}

static int write_file(const char* path, const void* data, size_t len) {
  int fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0600);
  if (fd < 0) {
    return -1;
  }
  const unsigned char* p   = (const unsigned char*)data;
  size_t               off = 0;
  while (off < len) {
    ssize_t n = write(fd, p + off, len - off);
    if (n <= 0) {
      close(fd);
      return -1;
    }
    off += (size_t)n;
  }
  close(fd);
  return 0;
}

static ssize_t read_all(int fd, char* buf, size_t cap) {
  size_t off = 0;
  while (off + 1 < cap) {
    ssize_t n = read(fd, buf + off, cap - off - 1);
    if (n < 0) {
      return -1;
    }
    if (n == 0) {
      break;
    }
    off += (size_t)n;
  }
  buf[off] = '\0';
  return (ssize_t)off;
}

static void test_parse_request_basic(void) {
  const char* raw =
      "POST /files/hello%20world?foo=bar&name=Bob+Smith HTTP/1.1\r\n"
      "Host: example.com\r\n"
      "Content-Length: 5\r\n"
      "Connection: keep-alive\r\n"
      "\r\n"
      "hello";
  const size_t len = strlen(raw);
  char*        buf = (char*)malloc(len + 1);
  MU_ASSERT(buf != NULL);
  memcpy(buf, raw, len);

  cerver_request_t req;
  memset(&req, 0, sizeof(req));

  MU_ASSERT_EQ_INT(0, cerver_parse_request(buf, len, &req));
  MU_ASSERT_STREQ("POST", req.method);
  MU_ASSERT_STREQ("/files/hello world", req.path);
  MU_ASSERT_EQ_INT(2, req.query_count);
  MU_ASSERT_STREQ("foo", req.query[0].key);
  MU_ASSERT_STREQ("bar", req.query[0].value);
  MU_ASSERT_STREQ("name", req.query[1].key);
  MU_ASSERT_STREQ("Bob Smith", req.query[1].value);
  MU_ASSERT_STREQ("example.com", cerver_req_header(&req, "host"));
  MU_ASSERT_EQ_SIZE(5, req.body_len);
  MU_ASSERT(memcmp(req.body, "hello", 5) == 0);

  free(buf);
}

static void test_parse_request_trailing_slash(void) {
  const char*  raw = "GET /about/ HTTP/1.1\r\n\r\n";
  const size_t len = strlen(raw);
  char*        buf = (char*)malloc(len + 1);
  MU_ASSERT(buf != NULL);
  memcpy(buf, raw, len);

  cerver_request_t req;
  memset(&req, 0, sizeof(req));

  MU_ASSERT_EQ_INT(0, cerver_parse_request(buf, len, &req));
  MU_ASSERT_STREQ("GET", req.method);
  MU_ASSERT_STREQ("/about", req.path);
  MU_ASSERT_EQ_INT(0, req.query_count);

  free(buf);
}

static void test_write_response_keepalive(void) {
  int fds[2];
  MU_ASSERT(pipe(fds) == 0);

  cerver_response_t res;
  memset(&res, 0, sizeof(res));
  cerver_res_text(&res, 200, "ok");
  cerver_res_header(&res, "X-Test", "1");

  MU_ASSERT_EQ_INT(0, cerver_write_response(fds[1], &res, 1));
  close(fds[1]);

  char out[1024];
  MU_ASSERT(read_all(fds[0], out, sizeof(out)) > 0);
  close(fds[0]);

  MU_ASSERT(strstr(out, "HTTP/1.1 200 OK\r\n") != NULL);
  MU_ASSERT(strstr(out, "Content-Type: text/plain; charset=utf-8\r\n") != NULL);
  MU_ASSERT(strstr(out, "Content-Length: 2\r\n") != NULL);
  MU_ASSERT(strstr(out, "X-Test: 1\r\n") != NULL);
  MU_ASSERT(strstr(out, "Connection: keep-alive\r\n") != NULL);
  MU_ASSERT(strstr(out, "Server: cerver\r\n") != NULL);
  MU_ASSERT(strstr(out, "\r\nok") != NULL);
}

static void test_write_response_force_close(void) {
  int fds[2];
  MU_ASSERT(pipe(fds) == 0);

  cerver_response_t res;
  memset(&res, 0, sizeof(res));
  cerver_res_text(&res, 200, "ok");
  res._force_close = 1;

  MU_ASSERT_EQ_INT(0, cerver_write_response(fds[1], &res, 1));
  close(fds[1]);

  char out[512];
  MU_ASSERT(read_all(fds[0], out, sizeof(out)) > 0);
  close(fds[0]);

  MU_ASSERT(strstr(out, "Connection: close\r\n") != NULL);
}

static void handler_a(cerver_request_t* req, cerver_response_t* res) {
  (void)req;
  (void)res;
}

static void handler_b(cerver_request_t* req, cerver_response_t* res) {
  (void)req;
  (void)res;
}

static cerver_handler_fn dispatch_override(cerver_request_t* req) {
  if (strcmp(req->path, "/override") == 0) {
    return handler_a;
  }
  return NULL;
}

static void test_route_match_and_dispatch(void) {
  cerver_server_t srv;
  cerver_init(&srv, 8080, 1);

  cerver_route_t routes[2];
  routes[0].method  = "GET";
  routes[0].pattern = "/users/:id";
  routes[0].handler = handler_b;
  routes[1].method  = "GET";
  routes[1].pattern = "/about";
  routes[1].handler = handler_a;
  cerver_add_routes(&srv, routes, 2);
  cerver_set_dispatch(&srv, dispatch_override);

  cerver_request_t req;
  memset(&req, 0, sizeof(req));
  strcpy(req.method, "GET");
  strcpy(req.path, "/users/123");

  MU_ASSERT(cerver_route_match(&routes[0], &req) == 1);
  MU_ASSERT_EQ_INT(1, req.params_count);
  MU_ASSERT_STREQ("123", cerver_req_param(&req, "id"));

  memset(&req, 0, sizeof(req));
  strcpy(req.method, "GET");
  strcpy(req.path, "/override");

  MU_ASSERT(cerver_dispatch(&srv, &req) == handler_a);

  memset(&req, 0, sizeof(req));
  strcpy(req.method, "GET");
  strcpy(req.path, "/about");

  MU_ASSERT(cerver_dispatch(&srv, &req) == handler_a);
}

static void test_route_match_mismatch_resets_params(void) {
  cerver_route_t route;
  route.method  = "GET";
  route.pattern = "/users/:id/profile";
  route.handler = handler_a;

  cerver_request_t req;
  memset(&req, 0, sizeof(req));
  strcpy(req.method, "GET");
  strcpy(req.path, "/users/123/settings");

  MU_ASSERT(cerver_route_match(&route, &req) == 0);
  MU_ASSERT_EQ_INT(0, req.params_count);
}

static void test_route_match_multi_segment(void) {
  cerver_route_t route;
  route.method  = "GET";
  route.pattern = "/users/:id/profile";
  route.handler = handler_a;

  cerver_request_t req;
  memset(&req, 0, sizeof(req));
  strcpy(req.method, "GET");
  strcpy(req.path, "/users/123/profile");

  MU_ASSERT(cerver_route_match(&route, &req) == 1);
  MU_ASSERT_EQ_INT(1, req.params_count);
  MU_ASSERT_STREQ("123", cerver_req_param(&req, "id"));
}

static void test_request_header_helpers(void) {
  cerver_request_t req;
  memset(&req, 0, sizeof(req));
  req_add_header(&req, "Connection", "close");
  req_add_header(&req, "X-Test", "value");

  MU_ASSERT_STREQ("value", cerver_req_header(&req, "x-test"));
  MU_ASSERT_EQ_INT(1, cerver_req_wants_close(&req));
}

static void test_static_embedded_prefers_br(void) {
  cerver_server_t srv;
  cerver_init(&srv, 8080, 1);

  static const unsigned char data[]    = "hello";
  static const unsigned char data_br[] = "brdata";
  static const unsigned char data_gz[] = "gzdata";

  cerver_asset_t assets[1];
  assets[0].path        = "/index.html";
  assets[0].mime_type   = "text/html";
  assets[0].data        = data;
  assets[0].data_len    = sizeof(data) - 1;
  assets[0].data_br     = data_br;
  assets[0].data_br_len = sizeof(data_br) - 1;
  assets[0].data_gz     = data_gz;
  assets[0].data_gz_len = sizeof(data_gz) - 1;
  cerver_set_assets(&srv, assets, 1);

  cerver_request_t  req;
  cerver_response_t res;
  memset(&req, 0, sizeof(req));
  memset(&res, 0, sizeof(res));
  strcpy(req.method, "GET");
  strcpy(req.path, "/index.html");
  req_add_header(&req, "Accept-Encoding", "br, gzip");

  MU_ASSERT_EQ_INT(0, cerver_serve_static(&srv, &req, &res));
  MU_ASSERT(res.body == (const char*)data_br);
  MU_ASSERT_STREQ("br", res_header(&res, "Content-Encoding"));
  MU_ASSERT_STREQ("Accept-Encoding", res_header(&res, "Vary"));
  MU_ASSERT(res_header(&res, "Cache-Control") != NULL);
}

static void test_static_embedded_index_fallback(void) {
  cerver_server_t srv;
  cerver_init(&srv, 8080, 1);

  static const unsigned char data[] = "docs";
  cerver_asset_t             assets[1];
  assets[0].path        = "/docs/index.html";
  assets[0].mime_type   = "text/html";
  assets[0].data        = data;
  assets[0].data_len    = sizeof(data) - 1;
  assets[0].data_br     = NULL;
  assets[0].data_br_len = 0;
  assets[0].data_gz     = NULL;
  assets[0].data_gz_len = 0;
  cerver_set_assets(&srv, assets, 1);

  cerver_request_t  req;
  cerver_response_t res;
  memset(&req, 0, sizeof(req));
  memset(&res, 0, sizeof(res));
  strcpy(req.method, "GET");
  strcpy(req.path, "/docs/");

  MU_ASSERT_EQ_INT(0, cerver_serve_static(&srv, &req, &res));
  MU_ASSERT(res.body == (const char*)data);
  MU_ASSERT_STREQ("text/html", res.content_type);
}

static void test_static_filesystem_small(void) {
  char  dir_template[] = "/tmp/cerver-test-XXXXXX";
  char* dir            = mkdtemp(dir_template);
  MU_ASSERT(dir != NULL);

  char file_path[PATH_MAX];
  snprintf(file_path, sizeof(file_path), "%s/index.html", dir);
  MU_ASSERT_EQ_INT(0, write_file(file_path, "small", 5));

  cerver_server_t srv;
  cerver_init(&srv, 8080, 1);
  cerver_set_public_dir(&srv, dir);

  cerver_request_t  req;
  cerver_response_t res;
  memset(&req, 0, sizeof(req));
  memset(&res, 0, sizeof(res));
  strcpy(req.method, "GET");
  strcpy(req.path, "/index.html");

  MU_ASSERT_EQ_INT(0, cerver_serve_static(&srv, &req, &res));
  MU_ASSERT_EQ_SIZE(5, res.body_len);
  MU_ASSERT(res.body == NULL);
  MU_ASSERT_EQ_INT(3, res._body_owned);
  MU_ASSERT(res._file_fd >= 0);

  int fds[2];
  MU_ASSERT(pipe(fds) == 0);
  MU_ASSERT_EQ_INT(0, cerver_write_response(fds[1], &res, 1));
  close(fds[1]);

  char out[1024];
  ssize_t n = read_all(fds[0], out, sizeof(out));
  MU_ASSERT(n > 0);
  close(fds[0]);

  MU_ASSERT(strstr(out, "HTTP/1.1 200 OK\r\n") != NULL);
  MU_ASSERT(strstr(out, "Content-Length: 5\r\n") != NULL);
  MU_ASSERT(strstr(out, "\r\nsmall") != NULL);

  if (res._body_owned == 3 && res._file_fd >= 0) {
    close(res._file_fd);
  }
  unlink(file_path);
  rmdir(dir);
}

static void test_static_filesystem_large(void) {
  char  dir_template[] = "/tmp/cerver-test-XXXXXX";
  char* dir            = mkdtemp(dir_template);
  MU_ASSERT(dir != NULL);

  char file_path[PATH_MAX];
  snprintf(file_path, sizeof(file_path), "%s/large.bin", dir);

  char* payload = (char*)malloc(32000);
  MU_ASSERT(payload != NULL);
  memset(payload, 'a', 32000);
  MU_ASSERT_EQ_INT(0, write_file(file_path, payload, 32000));
  free(payload);

  cerver_server_t srv;
  cerver_init(&srv, 8080, 1);
  cerver_set_public_dir(&srv, dir);

  cerver_request_t  req;
  cerver_response_t res;
  memset(&req, 0, sizeof(req));
  memset(&res, 0, sizeof(res));
  strcpy(req.method, "GET");
  strcpy(req.path, "/large.bin");

  MU_ASSERT_EQ_INT(0, cerver_serve_static(&srv, &req, &res));
  MU_ASSERT_EQ_SIZE(32000, res.body_len);
  MU_ASSERT(res.body == NULL);
  MU_ASSERT_EQ_INT(3, res._body_owned);
  MU_ASSERT(res._file_fd >= 0);

  int fds[2];
  MU_ASSERT(pipe(fds) == 0);
  MU_ASSERT_EQ_INT(0, cerver_write_response(fds[1], &res, 1));
  close(fds[1]);

  char out[35000];
  ssize_t n = read_all(fds[0], out, sizeof(out));
  MU_ASSERT(n > 0);
  close(fds[0]);

  MU_ASSERT(strstr(out, "HTTP/1.1 200 OK\r\n") != NULL);
  MU_ASSERT(strstr(out, "Content-Length: 32000\r\n") != NULL);

  if (res._body_owned == 3 && res._file_fd >= 0) {
    close(res._file_fd);
  }
  unlink(file_path);
  rmdir(dir);
}

static void test_static_rejects_unsafe_path(void) {
  cerver_server_t srv;
  cerver_init(&srv, 8080, 1);

  cerver_request_t  req;
  cerver_response_t res;
  memset(&req, 0, sizeof(req));
  memset(&res, 0, sizeof(res));
  strcpy(req.method, "GET");
  strcpy(req.path, "/../secret");

  MU_ASSERT_EQ_INT(-1, cerver_serve_static(&srv, &req, &res));
}

static void test_stat_cache_store_lookup(void) {
  cerver_stat_cache_t cache;
  cerver_stat_cache_init(&cache);

  size_t out_size = 0;
  MU_ASSERT_EQ_INT(-1, cerver_stat_cache_lookup(&cache, "/tmp/none", &out_size));
  cerver_stat_cache_store(&cache, "/tmp/file", 123, time(NULL));
  MU_ASSERT_EQ_INT(0, cerver_stat_cache_lookup(&cache, "/tmp/file", &out_size));
  MU_ASSERT_EQ_SIZE(123, out_size);
}

static void test_cerver_init_fields(void) {
  cerver_server_t srv;
  cerver_init(&srv, 9090, 3);
  MU_ASSERT_EQ_INT(9090, srv.port);
  MU_ASSERT_EQ_INT(3, srv.worker_count);
  MU_ASSERT_EQ_INT(-1, srv.sock_fd);
  MU_ASSERT_EQ_INT(0, srv.running);
}

int main(void) {
  mu_run("parse_request_basic", test_parse_request_basic);
  mu_run("parse_request_trailing_slash", test_parse_request_trailing_slash);
  mu_run("write_response_keepalive", test_write_response_keepalive);
  mu_run("write_response_force_close", test_write_response_force_close);
  mu_run("route_match_and_dispatch", test_route_match_and_dispatch);
  mu_run("route_match_mismatch_resets_params", test_route_match_mismatch_resets_params);
  mu_run("route_match_multi_segment", test_route_match_multi_segment);
  mu_run("request_header_helpers", test_request_header_helpers);
  mu_run("static_embedded_prefers_br", test_static_embedded_prefers_br);
  mu_run("static_embedded_index_fallback", test_static_embedded_index_fallback);
  mu_run("static_filesystem_small", test_static_filesystem_small);
  mu_run("static_filesystem_large", test_static_filesystem_large);
  mu_run("static_rejects_unsafe_path", test_static_rejects_unsafe_path);
  mu_run("stat_cache_store_lookup", test_stat_cache_store_lookup);
  mu_run("cerver_init_fields", test_cerver_init_fields);
  return mu_report();
}
