/*
 * server.c — Hybrid event-loop + thread-pool server for the cerver runtime.
 *
 * Architecture:
 *   - 1 acceptor thread per core with its own kqueue/epoll (accept only)
 *   - Shared connection thread pool (configurable size, default 128)
 *   - Acceptors never block — they push fds into a shared queue guarded by a mutex/condvar
 *   - Pool workers handle full request lifecycle including keep-alive
 *   - On Linux: SO_REUSEPORT per acceptor; on macOS: shared listener
 */

#include "cerver.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <fcntl.h>
#include <time.h>
#include <sys/mman.h>
#include <sys/time.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <pthread.h>

#if defined(__APPLE__) || defined(__FreeBSD__)
#define CERVER_USE_KQUEUE 1
#include <sys/event.h>
#elif defined(__linux__)
#define CERVER_USE_EPOLL 1
#include <sys/epoll.h>
#include <sys/sendfile.h>
#else
#define CERVER_USE_SELECT 1
#include <sys/select.h>
#endif

#ifdef __linux__
#include <sched.h>
#endif

/* Connection pool sizing */
#define CERVER_CONN_POOL_SIZE  128
#define CERVER_CONN_QUEUE_SIZE 4096

/* ------------------------------------------------------------------ */
/*  memmem fallback                                                   */
/* ------------------------------------------------------------------ */

#if !defined(__APPLE__) && !defined(__linux__) && !defined(_GNU_SOURCE)
static void* cerver_memmem(const void* hay, size_t haylen, const void* needle, size_t nlen) {
  if (nlen == 0) return (void*)hay;
  if (nlen > haylen) return NULL;
  const char* p   = (const char*)hay;
  const char* end = p + haylen - nlen;
  for (; p <= end; p++) {
    if (memcmp(p, needle, nlen) == 0) return (void*)p;
  }
  return NULL;
}
#define memmem cerver_memmem
#endif

/* Global for signal handler */
static cerver_server_t* g_srv = NULL;

static void signal_handler(int sig) {
  (void)sig;
  if (g_srv) g_srv->running = 0;
}

static int set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int get_cpu_count(void) {
  long n = sysconf(_SC_NPROCESSORS_ONLN);
  if (n < 1) n = 1;
  if (n > 64) n = 64;
  return (int)n;
}

static void best_effort_write(int fd, const char* buf, size_t len) {
  ssize_t written = write(fd, buf, len);
  (void)written;
}

/* ------------------------------------------------------------------ */
/*  Connection queue (shared between acceptors and pool workers)       */
/* ------------------------------------------------------------------ */

typedef struct {
  int             fds[CERVER_CONN_QUEUE_SIZE];
  int             head;
  int             tail;
  int             count;
  pthread_mutex_t lock;
  pthread_cond_t  not_empty;
} conn_queue_t;

static void cq_init(conn_queue_t* q) {
  memset(q->fds, -1, sizeof(q->fds));
  q->head = q->tail = q->count = 0;
  pthread_mutex_init(&q->lock, NULL);
  pthread_cond_init(&q->not_empty, NULL);
}

static void cq_destroy(conn_queue_t* q) {
  pthread_mutex_destroy(&q->lock);
  pthread_cond_destroy(&q->not_empty);
}

/* Returns 0 on success, -1 if queue is full (drop connection). */
static int cq_push(conn_queue_t* q, int fd) {
  pthread_mutex_lock(&q->lock);
  if (q->count >= CERVER_CONN_QUEUE_SIZE) {
    pthread_mutex_unlock(&q->lock);
    return -1;
  }
  q->fds[q->tail] = fd;
  q->tail         = (q->tail + 1) % CERVER_CONN_QUEUE_SIZE;
  q->count++;
  pthread_cond_signal(&q->not_empty);
  pthread_mutex_unlock(&q->lock);
  return 0;
}

/* Returns fd, or -1 on shutdown. */
static int cq_pop(conn_queue_t* q, volatile int* running) {
  pthread_mutex_lock(&q->lock);
  while (q->count == 0 && *running) {
    /* Timed wait so we can check running flag periodically */
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += 1;
    pthread_cond_timedwait(&q->not_empty, &q->lock, &ts);
  }
  if (q->count == 0) {
    pthread_mutex_unlock(&q->lock);
    return -1;
  }
  int fd  = q->fds[q->head];
  q->head = (q->head + 1) % CERVER_CONN_QUEUE_SIZE;
  q->count--;
  pthread_mutex_unlock(&q->lock);
  return fd;
}

/* Global connection queue */
static conn_queue_t g_conn_queue;

/* Global worker readiness tracking */
typedef struct {
  int             workers_ready;
  int             workers_expected;
  pthread_mutex_t lock;
  pthread_cond_t  ready_cv;
} worker_readiness_t;

static worker_readiness_t g_worker_readiness = {.workers_ready    = 0,
                                                .workers_expected = 0,
                                                .lock             = PTHREAD_MUTEX_INITIALIZER,
                                                .ready_cv         = PTHREAD_COND_INITIALIZER};

/* Global acceptor startup tracking */
typedef struct {
  int             acceptors_ready;
  int             start_accepting;
  pthread_mutex_t lock;
  pthread_cond_t  ready_cv;
  pthread_cond_t  start_cv;
} acceptor_readiness_t;

static acceptor_readiness_t g_acceptor_readiness = {.acceptors_ready = 0,
                                                    .start_accepting = 0,
                                                    .lock            = PTHREAD_MUTEX_INITIALIZER,
                                                    .ready_cv        = PTHREAD_COND_INITIALIZER,
                                                    .start_cv        = PTHREAD_COND_INITIALIZER};

/* ------------------------------------------------------------------ */
/*  Buffered read                                                     */
/* ------------------------------------------------------------------ */

static char* read_full_request(int fd, size_t* out_len) {
  size_t cap = CERVER_READ_BUF;
  size_t len = 0;
  char*  buf = malloc(cap + 1);
  if (!buf) return NULL;

  while (len < (size_t)CERVER_READ_BUF_MAX) {
    ssize_t n = read(fd, buf + len, cap - len);
    if (n <= 0) break;
    len += (size_t)n;
    if (len >= 4 && memmem(buf, len, "\r\n\r\n", 4)) break;
    if (len == cap) {
      size_t newcap = cap * 2;
      if (newcap > (size_t)CERVER_READ_BUF_MAX) newcap = (size_t)CERVER_READ_BUF_MAX;
      char* tmp = realloc(buf, newcap + 1);
      if (!tmp) {
        free(buf);
        return NULL;
      }
      buf = tmp;
      cap = newcap;
    }
  }

  if (len == 0) {
    free(buf);
    return NULL;
  }
  buf[len] = '\0';
  *out_len = len;
  return buf;
}

/* ------------------------------------------------------------------ */
/*  Handle connection with keep-alive                                 */
/* ------------------------------------------------------------------ */

static void handle_connection(cerver_server_t* srv, int client_fd) {
  int flags = fcntl(client_fd, F_GETFL, 0);
  if (flags >= 0 && (flags & O_NONBLOCK)) fcntl(client_fd, F_SETFL, flags & ~O_NONBLOCK);

  int nodelay = 1;
  setsockopt(client_fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));

  int request_count = 0;
  int keepalive     = 1;

  while (keepalive && srv->running && request_count < CERVER_KEEPALIVE_MAX) {
    struct timeval tv;
    tv.tv_sec  = (request_count == 0) ? 5 : CERVER_KEEPALIVE_TIMEOUT;
    tv.tv_usec = 0;
    setsockopt(client_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    size_t req_len = 0;
    char*  buf     = read_full_request(client_fd, &req_len);
    if (!buf || req_len == 0) {
      if (buf) free(buf);
      break;
    }

    cerver_request_t req;
    memset(&req, 0, sizeof(req));

    if (cerver_parse_request(buf, req_len, &req) < 0) {
      const char* resp =
          "HTTP/1.1 400 Bad Request\r\n"
          "Content-Length: 11\r\nConnection: close\r\n\r\nBad Request";
      best_effort_write(client_fd, resp, strlen(resp));
      free(buf);
      break;
    }

    request_count++;
    keepalive = !cerver_req_wants_close(&req);

    cerver_response_t res;
    memset(&res, 0, sizeof(res));

    if (cerver_serve_static(srv, &req, &res) < 0) {
      cerver_handler_fn handler = cerver_dispatch(srv, &req);
      if (handler) {
        handler(&req, &res);
      } else {
        cerver_res_text(&res, 404, "Not Found");
      }
    }

    if (res._force_close) keepalive = 0;

    int write_err = cerver_write_response(client_fd, &res, keepalive);

    if (res._body_owned == 1 && res.body)
      free((void*)res.body);
    else if (res._body_owned == 2 && res.body)
      munmap((void*)res.body, res.body_len);
    else if (res._body_owned == 3 && res._file_fd >= 0)
      close(res._file_fd);

    free(buf);
    if (write_err < 0) break;
  }

  close(client_fd);
}

/* ------------------------------------------------------------------ */
/*  Connection pool worker thread                                     */
/* ------------------------------------------------------------------ */

static void* conn_pool_worker(void* arg) {
  cerver_server_t* srv = (cerver_server_t*)arg;

  /* Signal that this worker is ready */
  pthread_mutex_lock(&g_worker_readiness.lock);
  g_worker_readiness.workers_ready++;
  pthread_cond_broadcast(&g_worker_readiness.ready_cv);
  pthread_mutex_unlock(&g_worker_readiness.lock);

  while (srv->running) {
    int fd = cq_pop(&g_conn_queue, &srv->running);
    if (fd < 0) continue;
    handle_connection(srv, fd);
  }
  return NULL;
}

static int wait_for_pool_workers_ready(cerver_server_t* srv, int expected) {
  pthread_mutex_lock(&g_worker_readiness.lock);
  while (g_worker_readiness.workers_ready < expected && srv->running) {
    pthread_cond_wait(&g_worker_readiness.ready_cv, &g_worker_readiness.lock);
  }
  int ready = (g_worker_readiness.workers_ready >= expected);
  pthread_mutex_unlock(&g_worker_readiness.lock);
  return ready;
}

static int wait_for_acceptors_ready(cerver_server_t* srv, int expected) {
  pthread_mutex_lock(&g_acceptor_readiness.lock);
  while (g_acceptor_readiness.acceptors_ready < expected && srv->running) {
    pthread_cond_wait(&g_acceptor_readiness.ready_cv, &g_acceptor_readiness.lock);
  }
  int ready = (g_acceptor_readiness.acceptors_ready >= expected);
  pthread_mutex_unlock(&g_acceptor_readiness.lock);
  return ready;
}

static void release_acceptors(void) {
  pthread_mutex_lock(&g_acceptor_readiness.lock);
  g_acceptor_readiness.start_accepting = 1;
  pthread_cond_broadcast(&g_acceptor_readiness.start_cv);
  pthread_mutex_unlock(&g_acceptor_readiness.lock);
}

/* ------------------------------------------------------------------ */
/*  Create a listening socket                                         */
/* ------------------------------------------------------------------ */

static int create_listener(int port, int reuseport) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    perror("cerver: socket");
    return -1;
  }

  int opt = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

#if defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__)
  if (reuseport) setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &opt, sizeof(opt));
#else
  (void)reuseport;
#endif

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family      = AF_INET;
  addr.sin_addr.s_addr = INADDR_ANY;
  addr.sin_port        = htons((uint16_t)port);

  if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
    perror("cerver: bind");
    close(fd);
    return -1;
  }
  if (listen(fd, CERVER_LISTEN_BACKLOG) < 0) {
    perror("cerver: listen");
    close(fd);
    return -1;
  }

  set_nonblocking(fd);
  return fd;
}

/* ------------------------------------------------------------------ */
/*  Accept helper                                                     */
/* ------------------------------------------------------------------ */

static int accept_connection(int listen_fd) {
  struct sockaddr_in ca;
  socklen_t          cl = sizeof(ca);
#ifdef __linux__
  return accept4(listen_fd, (struct sockaddr*)&ca, &cl, SOCK_CLOEXEC);
#else
  return accept(listen_fd, (struct sockaddr*)&ca, &cl);
#endif
}

/* ------------------------------------------------------------------ */
/*  Acceptor event loops (one per core, accept-only, never block)     */
/* ------------------------------------------------------------------ */

#if CERVER_USE_KQUEUE
static void* acceptor_loop(void* arg) {
  cerver_worker_t* w   = (cerver_worker_t*)arg;
  cerver_server_t* srv = w->srv;

  int kq = kqueue();
  if (kq < 0) {
    perror("cerver: kqueue");
    return NULL;
  }
  w->event_fd = kq;

  struct kevent change;
  EV_SET(&change, w->listen_fd, EVFILT_READ, EV_ADD, 0, 0, NULL);
  kevent(kq, &change, 1, NULL, 0, NULL);

  struct kevent events[CERVER_MAX_EVENTS];

  pthread_mutex_lock(&g_acceptor_readiness.lock);
  g_acceptor_readiness.acceptors_ready++;
  pthread_cond_broadcast(&g_acceptor_readiness.ready_cv);
  while (!g_acceptor_readiness.start_accepting && srv->running) {
    pthread_cond_wait(&g_acceptor_readiness.start_cv, &g_acceptor_readiness.lock);
  }
  pthread_mutex_unlock(&g_acceptor_readiness.lock);

  while (srv->running) {
    struct timespec ts  = {1, 0};
    int             nev = kevent(kq, NULL, 0, events, CERVER_MAX_EVENTS, &ts);
    if (nev < 0) {
      if (errno == EINTR) continue;
      break;
    }

    for (int i = 0; i < nev; i++) {
      if ((int)events[i].ident == w->listen_fd) {
        while (1) {
          int cfd = accept_connection(w->listen_fd);
          if (cfd < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            break;
          }
          if (cq_push(&g_conn_queue, cfd) < 0) {
            /* Queue full — send 503 and close */
            const char* r =
                "HTTP/1.1 503 Service Unavailable\r\n"
                "Content-Length: 19\r\nConnection: close\r\n\r\n"
                "Service Unavailable";
            best_effort_write(cfd, r, strlen(r));
            close(cfd);
          }
        }
      }
    }
  }

  close(kq);
  return NULL;
}

#elif CERVER_USE_EPOLL
static void* acceptor_loop(void* arg) {
  cerver_worker_t* w   = (cerver_worker_t*)arg;
  cerver_server_t* srv = w->srv;

  int ep = epoll_create1(EPOLL_CLOEXEC);
  if (ep < 0) {
    perror("cerver: epoll");
    return NULL;
  }
  w->event_fd = ep;

  struct epoll_event ev = {.events = EPOLLIN, .data.fd = w->listen_fd};
  epoll_ctl(ep, EPOLL_CTL_ADD, w->listen_fd, &ev);

  struct epoll_event events[CERVER_MAX_EVENTS];

  pthread_mutex_lock(&g_acceptor_readiness.lock);
  g_acceptor_readiness.acceptors_ready++;
  pthread_cond_broadcast(&g_acceptor_readiness.ready_cv);
  while (!g_acceptor_readiness.start_accepting && srv->running) {
    pthread_cond_wait(&g_acceptor_readiness.start_cv, &g_acceptor_readiness.lock);
  }
  pthread_mutex_unlock(&g_acceptor_readiness.lock);

  while (srv->running) {
    int nev = epoll_wait(ep, events, CERVER_MAX_EVENTS, 1000);
    if (nev < 0) {
      if (errno == EINTR) continue;
      break;
    }

    for (int i = 0; i < nev; i++) {
      if (events[i].data.fd == w->listen_fd) {
        while (1) {
          int cfd = accept_connection(w->listen_fd);
          if (cfd < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            break;
          }
          if (cq_push(&g_conn_queue, cfd) < 0) {
            const char* r =
                "HTTP/1.1 503 Service Unavailable\r\n"
                "Content-Length: 19\r\nConnection: close\r\n\r\n"
                "Service Unavailable";
            best_effort_write(cfd, r, strlen(r));
            close(cfd);
          }
        }
      }
    }
  }

  close(ep);
  return NULL;
}

#else /* SELECT */
static void* acceptor_loop(void* arg) {
  cerver_worker_t* w   = (cerver_worker_t*)arg;
  cerver_server_t* srv = w->srv;

  pthread_mutex_lock(&g_acceptor_readiness.lock);
  g_acceptor_readiness.acceptors_ready++;
  pthread_cond_broadcast(&g_acceptor_readiness.ready_cv);
  while (!g_acceptor_readiness.start_accepting && srv->running) {
    pthread_cond_wait(&g_acceptor_readiness.start_cv, &g_acceptor_readiness.lock);
  }
  pthread_mutex_unlock(&g_acceptor_readiness.lock);

  while (srv->running) {
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(w->listen_fd, &rfds);
    struct timeval tv  = {1, 0};
    int            ret = select(w->listen_fd + 1, &rfds, NULL, NULL, &tv);
    if (ret < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (ret > 0 && FD_ISSET(w->listen_fd, &rfds)) {
      int cfd = accept_connection(w->listen_fd);
      if (cfd >= 0) {
        if (cq_push(&g_conn_queue, cfd) < 0) {
          close(cfd);
        }
      }
    }
  }
  return NULL;
}
#endif

/* ------------------------------------------------------------------ */
/*  Stat cache                                                        */
/* ------------------------------------------------------------------ */

void cerver_stat_cache_init(cerver_stat_cache_t* cache) {
  memset(cache, 0, sizeof(*cache));
  pthread_mutex_init(&cache->lock, NULL);
}

int cerver_stat_cache_lookup(cerver_stat_cache_t* cache, const char* path, size_t* file_size) {
  time_t now = time(NULL);
  pthread_mutex_lock(&cache->lock);
  for (int i = 0; i < CERVER_STAT_CACHE_SIZE; i++) {
    cerver_stat_entry_t* e = &cache->entries[i];
    if (e->valid && strcmp(e->path, path) == 0) {
      if (now - e->cached_at < CERVER_STAT_CACHE_TTL) {
        *file_size = e->file_size;
        pthread_mutex_unlock(&cache->lock);
        return 0;
      }
      e->valid = 0;
      break;
    }
  }
  pthread_mutex_unlock(&cache->lock);
  return -1;
}

void cerver_stat_cache_store(cerver_stat_cache_t* cache, const char* path, size_t file_size,
                             time_t mtime) {
  time_t now = time(NULL);
  pthread_mutex_lock(&cache->lock);
  int    best   = 0;
  time_t oldest = cache->entries[0].cached_at;
  for (int i = 0; i < CERVER_STAT_CACHE_SIZE; i++) {
    cerver_stat_entry_t* e = &cache->entries[i];
    if (!e->valid) {
      best = i;
      break;
    }
    if (e->cached_at < oldest) {
      oldest = e->cached_at;
      best   = i;
    }
  }
  cerver_stat_entry_t* slot = &cache->entries[best];
  strncpy(slot->path, path, sizeof(slot->path) - 1);
  slot->path[sizeof(slot->path) - 1] = '\0';
  slot->file_size                    = file_size;
  slot->mtime                        = mtime;
  slot->cached_at                    = now;
  slot->valid                        = 1;
  pthread_mutex_unlock(&cache->lock);
}

/* ------------------------------------------------------------------ */
/*  Server init                                                       */
/* ------------------------------------------------------------------ */

int cerver_init(cerver_server_t* srv, int port, int threads) {
  memset(srv, 0, sizeof(*srv));
  srv->port              = port;
  srv->sock_fd           = -1;
  srv->running           = 0;
  srv->public_dir        = NULL;
  srv->dispatch_override = NULL;
  srv->worker_count      = (threads > 0) ? threads : get_cpu_count();
  srv->workers           = NULL;
  cerver_stat_cache_init(&srv->stat_cache);
  return 0;
}

int cerver_add_routes(cerver_server_t* srv, cerver_route_t* routes, int count) {
  srv->routes      = routes;
  srv->route_count = count;

  srv->route_trie = cerver_trie_create();
  if (srv->route_trie) {
    for (int i = 0; i < count; i++) {
      cerver_trie_insert(srv->route_trie, routes[i].pattern, routes[i].method, routes[i].handler);
    }
  }
  return 0;
}

int cerver_set_assets(cerver_server_t* srv, cerver_asset_t* assets, int count) {
  srv->assets      = assets;
  srv->asset_count = count;
  return 0;
}

void cerver_set_public_dir(cerver_server_t* srv, const char* dir) { srv->public_dir = dir; }

/* ------------------------------------------------------------------ */
/*  Server listen                                                     */
/* ------------------------------------------------------------------ */

int cerver_listen(cerver_server_t* srv) {
  g_srv = srv;
  signal(SIGINT, signal_handler);
  signal(SIGTERM, signal_handler);
  signal(SIGPIPE, SIG_IGN);

  srv->running        = 1;
  srv->acceptor_count = 0;

  /* Determine pool and acceptor counts.
   * Acceptors: min(worker_count, cpu_count) — one per core for accept.
   * Pool workers: worker_count * 16 — enough to cover concurrent keep-alive. */
  int cpu_count               = get_cpu_count();
  int configured_worker_count = srv->worker_count;
  int acceptor_count          = cpu_count;
  if (acceptor_count > configured_worker_count) acceptor_count = configured_worker_count;
  if (acceptor_count < 1) acceptor_count = 1;

  int pool_size = configured_worker_count * 16;
  if (pool_size < CERVER_CONN_POOL_SIZE) pool_size = CERVER_CONN_POOL_SIZE;
  if (pool_size > 1024) pool_size = 1024;

  /* Init shared connection queue */
  cq_init(&g_conn_queue);

  /* Initialize worker readiness tracking */
  pthread_mutex_lock(&g_worker_readiness.lock);
  g_worker_readiness.workers_ready    = 0;
  g_worker_readiness.workers_expected = pool_size;
  pthread_mutex_unlock(&g_worker_readiness.lock);

  pthread_mutex_lock(&g_acceptor_readiness.lock);
  g_acceptor_readiness.acceptors_ready = 0;
  g_acceptor_readiness.start_accepting = 0;
  pthread_mutex_unlock(&g_acceptor_readiness.lock);

  /* Start connection pool workers */
  pthread_t* pool_threads = calloc((size_t)pool_size, sizeof(pthread_t));
  if (!pool_threads) {
    perror("cerver: calloc pool");
    if (srv->sock_fd >= 0) close(srv->sock_fd);
    return -1;
  }

  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, 2 * 1024 * 1024);

  for (int i = 0; i < pool_size; i++) {
    if (pthread_create(&pool_threads[i], &attr, conn_pool_worker, srv) != 0) {
      perror("cerver: pool thread create");
      srv->running = 0;
      for (int j = 0; j < i; j++) pthread_join(pool_threads[j], NULL);
      free(pool_threads);
      if (srv->sock_fd >= 0) close(srv->sock_fd);
      pthread_attr_destroy(&attr);
      return -1;
    }
  }

  if (!wait_for_pool_workers_ready(srv, pool_size)) {
    srv->running = 0;
    for (int i = 0; i < pool_size; i++) pthread_join(pool_threads[i], NULL);
    free(pool_threads);
    pthread_attr_destroy(&attr);
    return -1;
  }

  srv->sock_fd = create_listener(srv->port, 1);
  if (srv->sock_fd < 0) {
    srv->running = 0;
    for (int i = 0; i < pool_size; i++) pthread_join(pool_threads[i], NULL);
    free(pool_threads);
    pthread_attr_destroy(&attr);
    return -1;
  }

  /* Start acceptor threads */
  srv->workers        = calloc((size_t)acceptor_count, sizeof(cerver_worker_t));
  srv->acceptor_count = acceptor_count;
  if (!srv->workers) {
    perror("cerver: calloc acceptors");
    srv->running = 0;
    pthread_cond_broadcast(&g_conn_queue.not_empty);
    for (int i = 0; i < pool_size; i++) pthread_join(pool_threads[i], NULL);
    free(pool_threads);
    close(srv->sock_fd);
    pthread_attr_destroy(&attr);
    return -1;
  }

  for (int i = 0; i < acceptor_count; i++) {
    cerver_worker_t* w = &srv->workers[i];
    w->id              = i;
    w->srv             = srv;
    w->event_fd        = -1;
#if defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__)
    if (i == 0) {
      w->listen_fd = srv->sock_fd;
    } else {
      w->listen_fd = create_listener(srv->port, 1);
      if (w->listen_fd < 0) w->listen_fd = srv->sock_fd;
    }
#else
    w->listen_fd = srv->sock_fd;
#endif
    if (pthread_create(&w->thread, &attr, acceptor_loop, w) != 0) {
      perror("cerver: acceptor create");
      srv->running = 0;
      for (int j = 0; j < i; j++) pthread_join(srv->workers[j].thread, NULL);
      break;
    }
  }

  if (!wait_for_acceptors_ready(srv, acceptor_count)) {
    srv->running = 0;
    release_acceptors();
    for (int i = 0; i < acceptor_count; i++) pthread_join(srv->workers[i].thread, NULL);
    for (int i = 0; i < pool_size; i++) pthread_join(pool_threads[i], NULL);
    free(pool_threads);
    pthread_attr_destroy(&attr);
    return -1;
  }

  printf("cerver: listening on http://localhost:%d\n", srv->port);
  printf("cerver: %d acceptor(s), %d connection workers, keep-alive max %d req/conn\n",
         acceptor_count, pool_size, CERVER_KEEPALIVE_MAX);

  for (int i = 0; i < srv->route_count; i++) {
    const char* method = srv->routes[i].method;
    const char* color  = "\x1B[35m";
    if (strcmp(method, "GET") == 0) {
      color = "\x1B[32m";
    } else if (strcmp(method, "POST") == 0) {
      color = "\x1B[33m";
    } else if (strcmp(method, "PUT") == 0) {
      color = "\x1B[36m";
    } else if (strcmp(method, "DELETE") == 0) {
      color = "\x1B[31m";
    }
    printf("  → Mapped {%s, %s%s\x1B[0m} route\n", srv->routes[i].pattern, color, method);
  }
  fflush(stdout);

  release_acceptors();

  pthread_attr_destroy(&attr);

  /* Main thread waits for shutdown */
  while (srv->running) sleep(1);

  /* Shutdown: stop acceptors first, then drain pool */
  srv->running = 0;

  for (int i = 0; i < acceptor_count; i++) pthread_join(srv->workers[i].thread, NULL);

  /* Wake all pool workers */
  pthread_mutex_lock(&g_conn_queue.lock);
  pthread_cond_broadcast(&g_conn_queue.not_empty);
  pthread_mutex_unlock(&g_conn_queue.lock);

  for (int i = 0; i < pool_size; i++) pthread_join(pool_threads[i], NULL);
  free(pool_threads);

  cerver_shutdown(srv);
  return 0;
}

/* ------------------------------------------------------------------ */
/*  Shutdown                                                          */
/* ------------------------------------------------------------------ */

void cerver_shutdown(cerver_server_t* srv) {
  srv->running = 0;

  if (srv->workers) {
    for (int i = 0; i < srv->acceptor_count; i++) {
#if defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__)
      if (srv->workers[i].listen_fd != srv->sock_fd && srv->workers[i].listen_fd >= 0)
        close(srv->workers[i].listen_fd);
#endif
      if (srv->workers[i].event_fd >= 0) close(srv->workers[i].event_fd);
    }
    free(srv->workers);
    srv->workers = NULL;
  }

  if (srv->route_trie) {
    cerver_trie_free(srv->route_trie);
    srv->route_trie = NULL;
  }

  if (srv->sock_fd >= 0) {
    close(srv->sock_fd);
    srv->sock_fd = -1;
  }

  cq_destroy(&g_conn_queue);
  pthread_mutex_destroy(&srv->stat_cache.lock);

  printf("\ncerver: server stopped\n");
}
