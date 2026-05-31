/*
 * server.c — Hybrid event-loop + connection-worker server for the cerver runtime.
 *
 * Cross-platform: Linux (epoll), macOS/BSD (kqueue), Windows (select/IOCP-ready),
 * and any other POSIX platform (select fallback).
 *
 * Architecture:
 *   - 1 acceptor thread per core with its own kqueue/epoll (accept only)
 *   - Shared connection worker pool (configurable size, default 128)
 *   - Acceptors never block — they push fds into a shared queue guarded by a mutex/condvar
 *   - Connection workers handle full request lifecycle including keep-alive
 *   - On Linux: SO_REUSEPORT per acceptor; on macOS: shared listener
 *   - On Windows: Winsock2, select-based acceptor, native Windows threads
 */

#include "win_compat.h" /* Must come first on Windows */
#include "cerver.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <signal.h>
#include <time.h>

#if !CERVER_PLATFORM_WINDOWS
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/time.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#endif  // !CERVER_PLATFORM_WINDOWS

#if defined(__APPLE__) || defined(__FreeBSD__)
#define CERVER_USE_KQUEUE 1
#include <sys/event.h>
#elif defined(__linux__)
#define CERVER_USE_EPOLL 1
#include <sys/epoll.h>
#include <sys/sendfile.h>
#elif CERVER_PLATFORM_WINDOWS
#define CERVER_USE_SELECT 1
/* select() is in winsock2.h, already included via win_compat.h */
#else
#define CERVER_USE_SELECT 1
#include <sys/select.h>
#endif  // __APPLE__ || __FreeBSD__
        // CERVER_PLATFORM_WINDOWS, else

#ifdef __linux__
#include <sched.h>
#endif  // __linux__

/* Connection worker sizing */
#define CERVER_CONNECTION_WORKER_POOL_MIN 128
#define CERVER_CONN_QUEUE_SIZE            4096

/* ------------------------------------------------------------------ */
/*  memmem fallback (also defined in win_compat.h for Windows)        */
/* ------------------------------------------------------------------ */

#if !CERVER_PLATFORM_WINDOWS && !defined(__APPLE__) && !defined(_GNU_SOURCE)
static void* cerver_memmem(const void* hay, size_t haylen, const void* needle, size_t nlen) {
  if (nlen == 0) return (void*)hay;
  if (nlen > haylen) return NULL;
  const char* p   = (const char*)hay;
  const char* end = p + haylen - nlen;
  for (; p <= end; p++)
    if (memcmp(p, needle, nlen) == 0) return (void*)p;
  return NULL;
}
#define memmem cerver_memmem
#endif  // !CERVER_PLATFORM_WINDOWS && !__APPLE__ && !_GNU_SOURCE

/* Global for signal handler */
static cerver_server_t* g_srv = NULL;

static void signal_handler(int sig) {
  (void)sig;
  if (g_srv) g_srv->running = 0;
}

/* ------------------------------------------------------------------ */
/*  Platform-neutral helpers                                          */
/* ------------------------------------------------------------------ */

static int set_nonblocking(cerver_sock_t fd) {
#if CERVER_PLATFORM_WINDOWS
  return cerver_set_nonblocking_win(fd);
#else
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
#endif  // CERVER_PLATFORM_WINDOWS
}

static int get_cpu_count(void) {
#if CERVER_PLATFORM_WINDOWS
  long n = cerver_nproc_win();
#else
  long n = sysconf(_SC_NPROCESSORS_ONLN);
#endif  // CERVER_PLATFORM_WINDOWS
  if (n < 1) n = 1;
  if (n > 64) n = 64;
  return (int)n;
}

static void best_effort_write(cerver_sock_t fd, const char* buf, size_t len) {
  cerver_sock_write(fd, buf, len);
}

static void cerver_platform_close(cerver_sock_t fd) { cerver_close_sock(fd); }

/* ------------------------------------------------------------------ */
/*  Connection queue (shared between acceptors and connection workers) */
/* ------------------------------------------------------------------ */

typedef struct {
  cerver_sock_t  fds[CERVER_CONN_QUEUE_SIZE];
  int            head;
  int            tail;
  int            count;
  cerver_mutex_t lock;
  cerver_cond_t  not_empty;
} conn_queue_t;

static void cq_init(conn_queue_t* q) {
  for (int i = 0; i < CERVER_CONN_QUEUE_SIZE; i++) q->fds[i] = CERVER_INVALID_SOCK;
  q->head = q->tail = q->count = 0;
  cerver_mutex_init(&q->lock, NULL);
  cerver_cond_init(&q->not_empty, NULL);
}

static void cq_destroy(conn_queue_t* q) {
  cerver_mutex_destroy(&q->lock);
  cerver_cond_destroy(&q->not_empty);
}

/* Returns 0 on success, -1 if queue is full. */
static int cq_push(conn_queue_t* q, cerver_sock_t fd) {
  cerver_mutex_lock(&q->lock);
  if (q->count >= CERVER_CONN_QUEUE_SIZE) {
    cerver_mutex_unlock(&q->lock);
    return -1;
  }
  q->fds[q->tail] = fd;
  q->tail         = (q->tail + 1) % CERVER_CONN_QUEUE_SIZE;
  q->count++;
  cerver_cond_signal(&q->not_empty);
  cerver_mutex_unlock(&q->lock);
  return 0;
}

/* Returns fd, or CERVER_INVALID_SOCK on shutdown. */
static cerver_sock_t cq_pop(conn_queue_t* q, volatile int* running) {
  cerver_mutex_lock(&q->lock);
  while (q->count == 0 && *running) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += 1;
    cerver_cond_timedwait(&q->not_empty, &q->lock, &ts);
  }
  if (q->count == 0) {
    cerver_mutex_unlock(&q->lock);
    return CERVER_INVALID_SOCK;
  }
  cerver_sock_t fd = q->fds[q->head];
  q->head          = (q->head + 1) % CERVER_CONN_QUEUE_SIZE;
  q->count--;
  cerver_mutex_unlock(&q->lock);
  return fd;
}

static conn_queue_t g_conn_queue;

/* Connection worker / acceptor readiness tracking */
typedef struct {
  int            connection_workers_ready;
  int            connection_workers_expected;
  cerver_mutex_t lock;
  cerver_cond_t  ready_cv;
} connection_worker_readiness_t;

static connection_worker_readiness_t g_connection_worker_readiness = {
    0, 0, CERVER_MUTEX_INITIALIZER, CERVER_COND_INITIALIZER};

typedef struct {
  int            acceptors_ready;
  int            start_accepting;
  cerver_mutex_t lock;
  cerver_cond_t  ready_cv;
  cerver_cond_t  start_cv;
} acceptor_readiness_t;

static acceptor_readiness_t g_acceptor_readiness = {
    0, 0, CERVER_MUTEX_INITIALIZER, CERVER_COND_INITIALIZER, CERVER_COND_INITIALIZER};

/* ------------------------------------------------------------------ */
/*  Buffered read                                                     */
/* ------------------------------------------------------------------ */

static char* read_full_request(cerver_sock_t fd, size_t* out_len) {
  size_t cap = CERVER_READ_BUF;
  size_t len = 0;
  char*  buf = malloc(cap + 1);
  if (!buf) return NULL;

#if CERVER_PLATFORM_WINDOWS
  /* On Windows set a blocking recv timeout via SO_RCVTIMEO (already set
     per-connection in handle_connection).  Just read normally. */
#endif  // CERVER_PLATFORM_WINDOWS

  while (len < (size_t)CERVER_READ_BUF_MAX) {
    ssize_t n = (ssize_t)cerver_sock_read(fd, buf + len, cap - len);
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

static void handle_connection(cerver_server_t* srv, cerver_sock_t client_fd) {
  /* Switch to blocking mode for this worker */
#if !CERVER_PLATFORM_WINDOWS
  {
    int flags = fcntl(client_fd, F_GETFL, 0);
    if (flags >= 0 && (flags & O_NONBLOCK)) fcntl(client_fd, F_SETFL, flags & ~O_NONBLOCK);
  }
#endif  // !CERVER_PLATFORM_WINDOWS

  /* TCP_NODELAY */
  {
    int nodelay = 1;
    setsockopt((cerver_sock_t)client_fd, IPPROTO_TCP, TCP_NODELAY, CERVER_SETSOCKOPT_CAST & nodelay,
               sizeof(nodelay));
  }

  int request_count = 0;
  int keepalive     = 1;

  while (keepalive && srv->running && request_count < CERVER_KEEPALIVE_MAX) {
    int timeout_sec = (request_count == 0) ? 5 : CERVER_KEEPALIVE_TIMEOUT;

#if CERVER_PLATFORM_WINDOWS
    cerver_set_rcvtimeo_win((SOCKET)client_fd, timeout_sec);
#else
    struct timeval tv = {timeout_sec, 0};
    setsockopt(client_fd, SOL_SOCKET, SO_RCVTIMEO, CERVER_SETSOCKOPT_CAST & tv, sizeof(tv));
#endif  // CERVER_PLATFORM_WINDOWS

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
#if !CERVER_PLATFORM_WINDOWS
    res._file_fd = -1;
#endif  // !CERVER_PLATFORM_WINDOWS

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

    if (res._body_owned == 1 && res.body) free((void*)res.body);
#if !CERVER_PLATFORM_WINDOWS
    else if (res._body_owned == 2 && res.body)
      munmap((void*)res.body, res.body_len);
    else if (res._body_owned == 3 && res._file_fd >= 0)
      close(res._file_fd);
#endif  // !CERVER_PLATFORM_WINDOWS

    free(buf);
    if (write_err < 0) break;
  }

  cerver_platform_close(client_fd);
}

/* ------------------------------------------------------------------ */
/*  Connection worker thread                                          */
/* ------------------------------------------------------------------ */

static void* connection_worker_loop(void* arg) {
  cerver_server_t* srv = (cerver_server_t*)arg;

  cerver_mutex_lock(&g_connection_worker_readiness.lock);
  g_connection_worker_readiness.connection_workers_ready++;
  cerver_cond_broadcast(&g_connection_worker_readiness.ready_cv);
  cerver_mutex_unlock(&g_connection_worker_readiness.lock);

  while (srv->running) {
    cerver_sock_t fd = cq_pop(&g_conn_queue, &srv->running);
    if (fd == CERVER_INVALID_SOCK) continue;
    handle_connection(srv, fd);
  }
  return NULL;
}

static int wait_for_connection_workers_ready(cerver_server_t* srv, int expected) {
  cerver_mutex_lock(&g_connection_worker_readiness.lock);
  while (g_connection_worker_readiness.connection_workers_ready < expected && srv->running)
    cerver_cond_wait(&g_connection_worker_readiness.ready_cv, &g_connection_worker_readiness.lock);
  int ready = (g_connection_worker_readiness.connection_workers_ready >= expected);
  cerver_mutex_unlock(&g_connection_worker_readiness.lock);
  return ready;
}

static int wait_for_acceptors_ready(cerver_server_t* srv, int expected) {
  cerver_mutex_lock(&g_acceptor_readiness.lock);
  while (g_acceptor_readiness.acceptors_ready < expected && srv->running)
    cerver_cond_wait(&g_acceptor_readiness.ready_cv, &g_acceptor_readiness.lock);
  int ready = (g_acceptor_readiness.acceptors_ready >= expected);
  cerver_mutex_unlock(&g_acceptor_readiness.lock);
  return ready;
}

static void release_acceptors(void) {
  cerver_mutex_lock(&g_acceptor_readiness.lock);
  g_acceptor_readiness.start_accepting = 1;
  cerver_cond_broadcast(&g_acceptor_readiness.start_cv);
  cerver_mutex_unlock(&g_acceptor_readiness.lock);
}

/* ------------------------------------------------------------------ */
/*  Create a listening socket                                         */
/* ------------------------------------------------------------------ */

static cerver_sock_t create_listener(int port, int reuseport) {
  cerver_sock_t fd = socket(AF_INET, SOCK_STREAM, 0);
#if CERVER_PLATFORM_WINDOWS
  if (fd == INVALID_SOCKET) {
    perror("cerver: socket");
    return CERVER_INVALID_SOCK;
  }
#else
  if (fd < 0) {
    perror("cerver: socket");
    return CERVER_INVALID_SOCK;
  }
#endif  // CERVER_PLATFORM_WINDOWS

  int opt = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, CERVER_SETSOCKOPT_CAST & opt, sizeof(opt));

#if defined(SO_REUSEPORT)
  if (reuseport) setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &opt, sizeof(opt));
#else
  (void)reuseport;
#endif  // SO_REUSEPORT

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family      = AF_INET;
  addr.sin_addr.s_addr = INADDR_ANY;
  addr.sin_port        = htons((uint16_t)port);

  if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
    perror("cerver: bind");
    cerver_platform_close(fd);
    return CERVER_INVALID_SOCK;
  }
  if (listen(fd, CERVER_LISTEN_BACKLOG) < 0) {
    perror("cerver: listen");
    cerver_platform_close(fd);
    return CERVER_INVALID_SOCK;
  }

  set_nonblocking(fd);
  return fd;
}

/* ------------------------------------------------------------------ */
/*  Accept helper                                                     */
/* ------------------------------------------------------------------ */

static cerver_sock_t accept_connection(cerver_sock_t listen_fd) {
  struct sockaddr_in ca;
  socklen_t          cl = sizeof(ca);
  cerver_sock_t      fd = accept(listen_fd, (struct sockaddr*)&ca, &cl);
#if !CERVER_PLATFORM_WINDOWS
#if defined(FD_CLOEXEC)
  if (fd >= 0) {
    int flags = fcntl(fd, F_GETFD, 0);
    if (flags >= 0) fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
  }
#endif  // FD_CLOEXEC
#endif  // !CERVER_PLATFORM_WINDOWS
  return fd;
}

/* ------------------------------------------------------------------ */
/*  Acceptor event loops                                              */
/* ------------------------------------------------------------------ */

#if defined(CERVER_USE_KQUEUE)

static void* acceptor_loop(void* arg) {
  cerver_acceptor_t* acceptor = (cerver_acceptor_t*)arg;
  cerver_server_t*   srv      = acceptor->srv;

  int kq = kqueue();
  if (kq < 0) {
    perror("cerver: kqueue");
    return NULL;
  }
  acceptor->event_fd = kq;

  struct kevent change;
  EV_SET(&change, acceptor->listen_fd, EVFILT_READ, EV_ADD, 0, 0, NULL);
  kevent(kq, &change, 1, NULL, 0, NULL);

  struct kevent events[CERVER_MAX_EVENTS];

  cerver_mutex_lock(&g_acceptor_readiness.lock);
  g_acceptor_readiness.acceptors_ready++;
  cerver_cond_broadcast(&g_acceptor_readiness.ready_cv);
  while (!g_acceptor_readiness.start_accepting && srv->running)
    cerver_cond_wait(&g_acceptor_readiness.start_cv, &g_acceptor_readiness.lock);
  cerver_mutex_unlock(&g_acceptor_readiness.lock);

  while (srv->running) {
    struct timespec ts  = {1, 0};
    int             nev = kevent(kq, NULL, 0, events, CERVER_MAX_EVENTS, &ts);
    if (nev < 0) {
      if (errno == EINTR) continue;
      break;
    }
    for (int i = 0; i < nev; i++) {
      if ((int)events[i].ident == acceptor->listen_fd) {
        while (1) {
          cerver_sock_t cfd = accept_connection(acceptor->listen_fd);
          if (cfd == CERVER_INVALID_SOCK) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            break;
          }
          if (cq_push(&g_conn_queue, cfd) < 0) {
            const char* r =
                "HTTP/1.1 503 Service Unavailable\r\n"
                "Content-Length: 19\r\nConnection: close\r\n\r\n"
                "Service Unavailable";
            best_effort_write(cfd, r, strlen(r));
            cerver_platform_close(cfd);
          }
        }
      }
    }
  }
  close(kq);
  return NULL;
}

#elif defined(CERVER_USE_EPOLL)

static void* acceptor_loop(void* arg) {
  cerver_acceptor_t* acceptor = (cerver_acceptor_t*)arg;
  cerver_server_t*   srv      = acceptor->srv;

  int ep = epoll_create1(EPOLL_CLOEXEC);
  if (ep < 0) {
    perror("cerver: epoll");
    return NULL;
  }
  acceptor->event_fd = ep;

  struct epoll_event ev = {.events = EPOLLIN, .data.fd = acceptor->listen_fd};
  epoll_ctl(ep, EPOLL_CTL_ADD, acceptor->listen_fd, &ev);

  struct epoll_event events[CERVER_MAX_EVENTS];

  cerver_mutex_lock(&g_acceptor_readiness.lock);
  g_acceptor_readiness.acceptors_ready++;
  cerver_cond_broadcast(&g_acceptor_readiness.ready_cv);
  while (!g_acceptor_readiness.start_accepting && srv->running)
    cerver_cond_wait(&g_acceptor_readiness.start_cv, &g_acceptor_readiness.lock);
  cerver_mutex_unlock(&g_acceptor_readiness.lock);

  while (srv->running) {
    int nev = epoll_wait(ep, events, CERVER_MAX_EVENTS, 1000);
    if (nev < 0) {
      if (errno == EINTR) continue;
      break;
    }
    for (int i = 0; i < nev; i++) {
      if (events[i].data.fd == acceptor->listen_fd) {
        while (1) {
          cerver_sock_t cfd = accept_connection(acceptor->listen_fd);
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
            cerver_platform_close(cfd);
          }
        }
      }
    }
  }
  close(ep);
  return NULL;
}

#else /* SELECT — used on Windows and other POSIX platforms */

static void* acceptor_loop(void* arg) {
  cerver_acceptor_t* acceptor = (cerver_acceptor_t*)arg;
  cerver_server_t*   srv      = acceptor->srv;

  cerver_mutex_lock(&g_acceptor_readiness.lock);
  g_acceptor_readiness.acceptors_ready++;
  cerver_cond_broadcast(&g_acceptor_readiness.ready_cv);
  while (!g_acceptor_readiness.start_accepting && srv->running)
    cerver_cond_wait(&g_acceptor_readiness.start_cv, &g_acceptor_readiness.lock);
  cerver_mutex_unlock(&g_acceptor_readiness.lock);

  while (srv->running) {
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(acceptor->listen_fd, &rfds);

#if CERVER_PLATFORM_WINDOWS
    /* Windows select takes (nfds, ...) but ignores the first arg for sockets */
    struct timeval tv  = {1, 0};
    int            ret = select(0, &rfds, NULL, NULL, &tv);
#else
    struct timeval tv  = {1, 0};
    int            ret = select((int)acceptor->listen_fd + 1, &rfds, NULL, NULL, &tv);
#endif  // CERVER_PLATFORM_WINDOWS
    if (ret < 0) {
#if CERVER_PLATFORM_WINDOWS
      if (WSAGetLastError() == WSAEINTR) continue;
#else
      if (errno == EINTR) continue;
#endif  // CERVER_PLATFORM_WINDOWS
      break;
    }
    if (ret > 0 && FD_ISSET(acceptor->listen_fd, &rfds)) {
      while (1) {
        cerver_sock_t cfd = accept_connection(acceptor->listen_fd);
        if (cfd == CERVER_INVALID_SOCK) {
#if CERVER_PLATFORM_WINDOWS
          if (cerver_would_block_win()) break;
#else
          if (errno == EAGAIN || errno == EWOULDBLOCK) break;
#endif  // CERVER_PLATFORM_WINDOWS
          break;
        }
        if (cq_push(&g_conn_queue, cfd) < 0) {
          cerver_platform_close(cfd);
        }
      }
    }
  }
  return NULL;
}
#endif  // CERVER_USE_KQUEUE

/* ------------------------------------------------------------------ */
/*  Stat cache                                                        */
/* ------------------------------------------------------------------ */

void cerver_stat_cache_init(cerver_stat_cache_t* cache) {
  memset(cache, 0, sizeof(*cache));
  cerver_mutex_init(&cache->lock, NULL);
}

int cerver_stat_cache_lookup(cerver_stat_cache_t* cache, const char* path, size_t* file_size) {
  time_t now = time(NULL);
  cerver_mutex_lock(&cache->lock);
  for (int i = 0; i < CERVER_STAT_CACHE_SIZE; i++) {
    cerver_stat_entry_t* e = &cache->entries[i];
    if (e->valid && strcmp(e->path, path) == 0) {
      if (now - e->cached_at < CERVER_STAT_CACHE_TTL) {
        *file_size = e->file_size;
        cerver_mutex_unlock(&cache->lock);
        return 0;
      }
      e->valid = 0;
      break;
    }
  }
  cerver_mutex_unlock(&cache->lock);
  return -1;
}

void cerver_stat_cache_store(cerver_stat_cache_t* cache, const char* path, size_t file_size,
                             time_t mtime) {
  time_t now = time(NULL);
  cerver_mutex_lock(&cache->lock);
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
  cerver_mutex_unlock(&cache->lock);
}

/* ------------------------------------------------------------------ */
/*  Server init                                                       */
/* ------------------------------------------------------------------ */

int cerver_init(cerver_server_t* srv, int port, int threads) {
  memset(srv, 0, sizeof(*srv));
  srv->port                    = port;
  srv->sock_fd                 = CERVER_INVALID_SOCK;
  srv->running                 = 0;
  srv->connection_worker_count = (threads > 0) ? threads : get_cpu_count();
  cerver_stat_cache_init(&srv->stat_cache);
#if CERVER_PLATFORM_WINDOWS
  cerver_wsa_startup();
#endif  // CERVER_PLATFORM_WINDOWS
  return 0;
}

int cerver_add_routes(cerver_server_t* srv, cerver_route_t* routes, int count) {
  srv->routes      = routes;
  srv->route_count = count;
  srv->route_trie  = cerver_trie_create();
  if (srv->route_trie) {
    for (int i = 0; i < count; i++)
      cerver_trie_insert(srv->route_trie, routes[i].pattern, routes[i].method, routes[i].handler);
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
#if !CERVER_PLATFORM_WINDOWS
  signal(SIGPIPE, SIG_IGN);
#endif  // !CERVER_PLATFORM_WINDOWS

  srv->running        = 1;
  srv->acceptor_count = 0;

  int cpu_count                          = get_cpu_count();
  int configured_connection_worker_count = srv->connection_worker_count;
  int acceptor_count                     = cpu_count;
  if (acceptor_count > configured_connection_worker_count)
    acceptor_count = configured_connection_worker_count;
  if (acceptor_count < 1) acceptor_count = 1;

  /* Windows select-based acceptor: limit to 1 until IOCP is wired */
#if CERVER_PLATFORM_WINDOWS
  acceptor_count = 1;
#endif  // CERVER_PLATFORM_WINDOWS

  int connection_worker_thread_count = configured_connection_worker_count * 16;
  if (connection_worker_thread_count < CERVER_CONNECTION_WORKER_POOL_MIN)
    connection_worker_thread_count = CERVER_CONNECTION_WORKER_POOL_MIN;
  if (connection_worker_thread_count > 1024) connection_worker_thread_count = 1024;

  cq_init(&g_conn_queue);

  cerver_mutex_lock(&g_connection_worker_readiness.lock);
  g_connection_worker_readiness.connection_workers_ready    = 0;
  g_connection_worker_readiness.connection_workers_expected = connection_worker_thread_count;
  cerver_mutex_unlock(&g_connection_worker_readiness.lock);

  cerver_mutex_lock(&g_acceptor_readiness.lock);
  g_acceptor_readiness.acceptors_ready = 0;
  g_acceptor_readiness.start_accepting = 0;
  cerver_mutex_unlock(&g_acceptor_readiness.lock);

  cerver_connection_worker_thread_t* connection_workers =
      calloc((size_t)connection_worker_thread_count, sizeof(cerver_connection_worker_thread_t));
  if (!connection_workers) {
    perror("cerver: calloc connection workers");
    return -1;
  }

  cerver_connection_worker_thread_attr_t worker_attr;
  cerver_acceptor_thread_attr_t          acceptor_attr;
  cerver_connection_worker_thread_attr_init(&worker_attr);
  cerver_acceptor_thread_attr_init(&acceptor_attr);
  cerver_connection_worker_thread_attr_setstacksize(&worker_attr, 2 * 1024 * 1024);
  cerver_acceptor_thread_attr_setstacksize(&acceptor_attr, 2 * 1024 * 1024);

  for (int i = 0; i < connection_worker_thread_count; i++) {
    if (cerver_connection_worker_thread_create(&connection_workers[i], &worker_attr,
                                               connection_worker_loop, srv) != 0) {
      perror("cerver: connection worker thread create");
      srv->running = 0;
      for (int j = 0; j < i; j++) cerver_connection_worker_thread_join(connection_workers[j], NULL);
      free(connection_workers);
      cerver_connection_worker_thread_attr_destroy(&worker_attr);
      cerver_acceptor_thread_attr_destroy(&acceptor_attr);
      return -1;
    }
  }

  if (!wait_for_connection_workers_ready(srv, connection_worker_thread_count)) {
    srv->running = 0;
    for (int i = 0; i < connection_worker_thread_count; i++)
      cerver_connection_worker_thread_join(connection_workers[i], NULL);
    free(connection_workers);
    cerver_connection_worker_thread_attr_destroy(&worker_attr);
    cerver_acceptor_thread_attr_destroy(&acceptor_attr);
    return -1;
  }

  srv->sock_fd = create_listener(srv->port, 1);
  if (srv->sock_fd == CERVER_INVALID_SOCK) {
    srv->running = 0;
    for (int i = 0; i < connection_worker_thread_count; i++)
      cerver_connection_worker_thread_join(connection_workers[i], NULL);
    free(connection_workers);
    cerver_connection_worker_thread_attr_destroy(&worker_attr);
    cerver_acceptor_thread_attr_destroy(&acceptor_attr);
    return -1;
  }

  srv->acceptors      = calloc((size_t)acceptor_count, sizeof(cerver_acceptor_t));
  srv->acceptor_count = acceptor_count;
  if (!srv->acceptors) {
    perror("cerver: calloc acceptors");
    srv->running = 0;
    cerver_cond_broadcast(&g_conn_queue.not_empty);
    for (int i = 0; i < connection_worker_thread_count; i++)
      cerver_connection_worker_thread_join(connection_workers[i], NULL);
    free(connection_workers);
    cerver_platform_close(srv->sock_fd);
    cerver_connection_worker_thread_attr_destroy(&worker_attr);
    cerver_acceptor_thread_attr_destroy(&acceptor_attr);
    return -1;
  }

  for (int i = 0; i < acceptor_count; i++) {
    cerver_acceptor_t* acceptor = &srv->acceptors[i];
    acceptor->id                = i;
    acceptor->srv               = srv;
    acceptor->event_fd          = -1;
#if defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__)
    acceptor->listen_fd = (i == 0) ? srv->sock_fd : create_listener(srv->port, 1);
    if (acceptor->listen_fd == CERVER_INVALID_SOCK) acceptor->listen_fd = srv->sock_fd;
#else
    acceptor->listen_fd = srv->sock_fd;
#endif  // __linux__ || __APPLE__ || __FreeBSD__
    if (cerver_acceptor_thread_create(&acceptor->thread, &acceptor_attr, acceptor_loop, acceptor) !=
        0) {
      perror("cerver: acceptor create");
      srv->running = 0;
      for (int j = 0; j < i; j++) cerver_acceptor_thread_join(srv->acceptors[j].thread, NULL);
      break;
    }
  }

  if (!wait_for_acceptors_ready(srv, acceptor_count)) {
    srv->running = 0;
    release_acceptors();
    for (int i = 0; i < acceptor_count; i++)
      cerver_acceptor_thread_join(srv->acceptors[i].thread, NULL);
    for (int i = 0; i < connection_worker_thread_count; i++)
      cerver_connection_worker_thread_join(connection_workers[i], NULL);
    free(connection_workers);
    cerver_connection_worker_thread_attr_destroy(&worker_attr);
    cerver_acceptor_thread_attr_destroy(&acceptor_attr);
    return -1;
  }

  printf("cerver: listening on http://localhost:%d\n", srv->port);
  printf("cerver: %d acceptor(s), %d connection workers, keep-alive max %d req/conn\n",
         acceptor_count, connection_worker_thread_count, CERVER_KEEPALIVE_MAX);

  for (int i = 0; i < srv->route_count; i++) {
    const char* method = srv->routes[i].method;
    const char* color  = "\x1B[35m";
    if (strcmp(method, "GET") == 0)
      color = "\x1B[32m";
    else if (strcmp(method, "POST") == 0)
      color = "\x1B[33m";
    else if (strcmp(method, "PUT") == 0)
      color = "\x1B[36m";
    else if (strcmp(method, "DELETE") == 0)
      color = "\x1B[31m";
    printf("  \xe2\x86\x92 Mapped {%s, %s%s\x1B[0m} route\n", srv->routes[i].pattern, color,
           method);
  }
  fflush(stdout);

  release_acceptors();
  cerver_connection_worker_thread_attr_destroy(&worker_attr);
  cerver_acceptor_thread_attr_destroy(&acceptor_attr);

  /* Main thread spin — sleep(1) works on all platforms via win_compat.h macro */
  while (srv->running) sleep(1);

  /* Shutdown */
  srv->running = 0;
  for (int i = 0; i < acceptor_count; i++)
    cerver_acceptor_thread_join(srv->acceptors[i].thread, NULL);

  cerver_mutex_lock(&g_conn_queue.lock);
  cerver_cond_broadcast(&g_conn_queue.not_empty);
  cerver_mutex_unlock(&g_conn_queue.lock);

  for (int i = 0; i < connection_worker_thread_count; i++)
    cerver_connection_worker_thread_join(connection_workers[i], NULL);
  free(connection_workers);

  cerver_shutdown(srv);
  return 0;
}

/* ------------------------------------------------------------------ */
/*  Shutdown                                                          */
/* ------------------------------------------------------------------ */

void cerver_shutdown(cerver_server_t* srv) {
  srv->running = 0;

  if (srv->acceptors) {
    for (int i = 0; i < srv->acceptor_count; i++) {
#if defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__)
      if (srv->acceptors[i].listen_fd != srv->sock_fd &&
          srv->acceptors[i].listen_fd != CERVER_INVALID_SOCK)
        cerver_platform_close(srv->acceptors[i].listen_fd);
#endif  // __linux__ || __APPLE__ || __FreeBSD__
      if (srv->acceptors[i].event_fd >= 0)
#if !CERVER_PLATFORM_WINDOWS
        close(srv->acceptors[i].event_fd);
#else
        closesocket((SOCKET)srv->acceptors[i].event_fd);
#endif  // !CERVER_PLATFORM_WINDOWS
    }
    free(srv->acceptors);
    srv->acceptors = NULL;
  }

  if (srv->route_trie) {
    cerver_trie_free(srv->route_trie);
    srv->route_trie = NULL;
  }

  if (srv->sock_fd != CERVER_INVALID_SOCK) {
    cerver_platform_close(srv->sock_fd);
    srv->sock_fd = CERVER_INVALID_SOCK;
  }

  cq_destroy(&g_conn_queue);
  cerver_mutex_destroy(&srv->stat_cache.lock);

#if CERVER_PLATFORM_WINDOWS
  cerver_wsa_cleanup();
#endif  // CERVER_PLATFORM_WINDOWS

  printf("\ncerver: server stopped\n");
}
