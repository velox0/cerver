/*
 * server.c — Socket setup, thread pool, and event loop for the cerver runtime.
 *
 * Uses kqueue on macOS, epoll on Linux, with a select() fallback.
 * Requests are dispatched to a fixed-size thread pool via a ring-buffer
 * task queue protected by a mutex + condition variable.
 */

#include "cerver.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <pthread.h>

/* Platform-specific event API */
#if defined(__APPLE__) || defined(__FreeBSD__)
  #define CERVER_USE_KQUEUE 1
  #include <sys/event.h>
#elif defined(__linux__)
  #define CERVER_USE_EPOLL 1
  #include <sys/epoll.h>
#else
  #define CERVER_USE_SELECT 1
  #include <sys/select.h>
#endif

#define MAX_EVENTS 64

/* Global server pointer for signal handler */
static cerver_server_t *g_srv = NULL;

static void signal_handler(int sig) {
    (void)sig;
    if (g_srv) {
        g_srv->running = 0;
    }
}

static int set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/* ------------------------------------------------------------------ */
/*  memmem fallback for systems that lack it                          */
/* ------------------------------------------------------------------ */

#if !defined(__APPLE__) && !defined(__linux__) && !defined(_GNU_SOURCE)
static void *cerver_memmem(const void *hay, size_t haylen,
                           const void *needle, size_t nlen) {
    if (nlen == 0) return (void *)hay;
    if (nlen > haylen) return NULL;
    const char *p = (const char *)hay;
    const char *end = p + haylen - nlen;
    for (; p <= end; p++) {
        if (memcmp(p, needle, nlen) == 0) return (void *)p;
    }
    return NULL;
}
#define memmem cerver_memmem
#endif

/* ------------------------------------------------------------------ */
/*  Buffered read — accumulates until \r\n\r\n or limit reached       */
/* ------------------------------------------------------------------ */

static char *read_full_request(int fd, size_t *out_len) {
    size_t cap = CERVER_READ_BUF;
    size_t len = 0;
    char *buf = malloc(cap + 1); /* +1 for null terminator */
    if (!buf) return NULL;

    while (len < (size_t)CERVER_READ_BUF_MAX) {
        ssize_t n = read(fd, buf + len, cap - len);
        if (n <= 0) break;
        len += (size_t)n;

        /* Check for end of headers */
        if (len >= 4 && memmem(buf, len, "\r\n\r\n", 4)) break;

        /* Grow buffer if full */
        if (len == cap) {
            size_t newcap = cap * 2;
            if (newcap > (size_t)CERVER_READ_BUF_MAX)
                newcap = (size_t)CERVER_READ_BUF_MAX;
            char *tmp = realloc(buf, newcap + 1);
            if (!tmp) { free(buf); return NULL; }
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
/*  Handle a single connection: read, parse, dispatch, respond        */
/* ------------------------------------------------------------------ */

static void handle_connection(cerver_server_t *srv, int client_fd) {
    /* Ensure the client socket is in blocking mode for reads.
       Some platforms inherit O_NONBLOCK from the listening socket. */
    int flags = fcntl(client_fd, F_GETFL, 0);
    if (flags >= 0 && (flags & O_NONBLOCK)) {
        fcntl(client_fd, F_SETFL, flags & ~O_NONBLOCK);
    }

    /* Set a read timeout so workers don't block on stale connections */
    struct timeval tv = { 5, 0 }; /* 5 seconds */
    setsockopt(client_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    /* Read the full request with buffering */
    size_t req_len = 0;
    char *buf = read_full_request(client_fd, &req_len);

    if (!buf || req_len == 0) {
        if (buf) free(buf);
        close(client_fd);
        return;
    }

    /* Parse HTTP request */
    cerver_request_t req;
    memset(&req, 0, sizeof(req));

    if (cerver_parse_request(buf, req_len, &req) < 0) {
        /* Bad request — send 400 */
        const char *resp = "HTTP/1.1 400 Bad Request\r\nContent-Length: 11\r\nConnection: close\r\n\r\nBad Request";
        write(client_fd, resp, strlen(resp));
        free(buf);
        close(client_fd);
        return;
    }

    /*
     * The parser malloc'd its own mutable copy (req._raw_buf) and all
     * internal pointers (path, headers, etc.) reference that copy.
     * We can now free our original read buffer.
     */
    free(buf);

    /* Prepare response */
    cerver_response_t res;
    memset(&res, 0, sizeof(res));

    /* Try static assets first — files take priority over route handlers */
    if (cerver_serve_static(srv, &req, &res) < 0) {
        /* No static file found — try route handlers */
        cerver_handler_fn handler = cerver_dispatch(srv, &req);

        if (handler) {
            handler(&req, &res);
        } else {
            /* 404 */
            cerver_res_text(&res, 404, "Not Found");
        }
    }

    /* Write response */
    cerver_write_response(client_fd, &res);

    /* Cleanup */
    if (res._body_owned && res.body) {
        free((void *)res.body);
    }
    if (req._raw_buf) {
        free(req._raw_buf);
    }

    close(client_fd);
}

/* ------------------------------------------------------------------ */
/*  Thread pool — task queue (ring buffer)                             */
/* ------------------------------------------------------------------ */

static int enqueue_task(cerver_server_t *srv, int client_fd) {
    pthread_mutex_lock(&srv->tq_mutex);

    if (srv->tq_count >= CERVER_TASK_QUEUE_SIZE) {
        /* Queue full — drop connection */
        pthread_mutex_unlock(&srv->tq_mutex);
        const char *resp = "HTTP/1.1 503 Service Unavailable\r\n"
                           "Content-Length: 19\r\nConnection: close\r\n\r\n"
                           "Service Unavailable";
        write(client_fd, resp, strlen(resp));
        close(client_fd);
        return -1;
    }

    srv->task_queue[srv->tq_tail] = client_fd;
    srv->tq_tail = (srv->tq_tail + 1) % CERVER_TASK_QUEUE_SIZE;
    srv->tq_count++;

    pthread_cond_signal(&srv->tq_cond);
    pthread_mutex_unlock(&srv->tq_mutex);
    return 0;
}

static int dequeue_task(cerver_server_t *srv) {
    pthread_mutex_lock(&srv->tq_mutex);

    while (srv->tq_count == 0 && srv->running) {
        pthread_cond_wait(&srv->tq_cond, &srv->tq_mutex);
    }

    if (!srv->running && srv->tq_count == 0) {
        pthread_mutex_unlock(&srv->tq_mutex);
        return -1; /* shutdown signal */
    }

    int fd = srv->task_queue[srv->tq_head];
    srv->tq_head = (srv->tq_head + 1) % CERVER_TASK_QUEUE_SIZE;
    srv->tq_count--;

    pthread_mutex_unlock(&srv->tq_mutex);
    return fd;
}

/* ------------------------------------------------------------------ */
/*  Worker thread entry point                                         */
/* ------------------------------------------------------------------ */

static void *worker_thread(void *arg) {
    cerver_server_t *srv = (cerver_server_t *)arg;

    while (srv->running) {
        int client_fd = dequeue_task(srv);
        if (client_fd < 0) break; /* shutdown */

        handle_connection(srv, client_fd);
    }

    return NULL;
}

/* ------------------------------------------------------------------ */
/*  Server init                                                       */
/* ------------------------------------------------------------------ */

int cerver_init(cerver_server_t *srv, int port, int threads) {
    memset(srv, 0, sizeof(*srv));
    srv->port = port;
    srv->sock_fd = -1;
    srv->running = 0;
    srv->public_dir = NULL;

    /* Thread pool config */
    srv->thread_count = (threads > 0) ? threads : CERVER_THREAD_POOL_DEFAULT;
    srv->threads = NULL;
    srv->tq_head = 0;
    srv->tq_tail = 0;
    srv->tq_count = 0;

    pthread_mutex_init(&srv->tq_mutex, NULL);
    pthread_cond_init(&srv->tq_cond, NULL);

    return 0;
}

int cerver_add_routes(cerver_server_t *srv, cerver_route_t *routes, int count) {
    srv->routes = routes;
    srv->route_count = count;
    return 0;
}

int cerver_set_assets(cerver_server_t *srv, cerver_asset_t *assets, int count) {
    srv->assets = assets;
    srv->asset_count = count;
    return 0;
}

void cerver_set_public_dir(cerver_server_t *srv, const char *dir) {
    srv->public_dir = dir;
}

/* ------------------------------------------------------------------ */
/*  Start thread pool                                                 */
/* ------------------------------------------------------------------ */

static int start_thread_pool(cerver_server_t *srv) {
    srv->threads = malloc(sizeof(pthread_t) * (size_t)srv->thread_count);
    if (!srv->threads) {
        perror("cerver: malloc threads");
        return -1;
    }

    /* Use 2 MB stack per worker (handles deep call chains with large buffers) */
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 2 * 1024 * 1024);

    for (int i = 0; i < srv->thread_count; i++) {
        if (pthread_create(&srv->threads[i], &attr, worker_thread, srv) != 0) {
            perror("cerver: pthread_create");
            /* Clean up already-created threads */
            srv->running = 0;
            pthread_cond_broadcast(&srv->tq_cond);
            for (int j = 0; j < i; j++) {
                pthread_join(srv->threads[j], NULL);
            }
            free(srv->threads);
            srv->threads = NULL;
            return -1;
        }
    }

    pthread_attr_destroy(&attr);

    printf("cerver: started %d worker thread(s)\n", srv->thread_count);
    return 0;
}

/* ------------------------------------------------------------------ */
/*  Server listen — event loop                                        */
/* ------------------------------------------------------------------ */

int cerver_listen(cerver_server_t *srv) {
    /* Create socket */
    srv->sock_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (srv->sock_fd < 0) {
        perror("cerver: socket");
        return -1;
    }

    /* SO_REUSEADDR so we can restart quickly */
    int opt = 1;
    setsockopt(srv->sock_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    /* Bind */
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons((uint16_t)srv->port);

    if (bind(srv->sock_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("cerver: bind");
        close(srv->sock_fd);
        return -1;
    }

    /* Listen */
    if (listen(srv->sock_fd, 128) < 0) {
        perror("cerver: listen");
        close(srv->sock_fd);
        return -1;
    }

    set_nonblocking(srv->sock_fd);

    /* Install signal handlers */
    g_srv = srv;
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    signal(SIGPIPE, SIG_IGN);

    srv->running = 1;

    printf("cerver: listening on http://localhost:%d\n", srv->port);

    /* Start the thread pool */
    if (start_thread_pool(srv) < 0) {
        close(srv->sock_fd);
        return -1;
    }

/* ================================================================== */
/*  kqueue event loop (macOS / FreeBSD)                               */
/* ================================================================== */
#if CERVER_USE_KQUEUE

    int kq = kqueue();
    if (kq < 0) {
        perror("cerver: kqueue");
        close(srv->sock_fd);
        return -1;
    }

    struct kevent change;
    EV_SET(&change, srv->sock_fd, EVFILT_READ, EV_ADD, 0, 0, NULL);
    kevent(kq, &change, 1, NULL, 0, NULL);

    struct kevent events[MAX_EVENTS];

    while (srv->running) {
        struct timespec timeout = { 1, 0 }; /* 1 second */
        int nev = kevent(kq, NULL, 0, events, MAX_EVENTS, &timeout);

        if (nev < 0) {
            if (errno == EINTR) continue;
            perror("cerver: kevent");
            break;
        }

        for (int i = 0; i < nev; i++) {
            int fd = (int)events[i].ident;

            if (fd == srv->sock_fd) {
                /* Accept new connections */
                while (1) {
                    struct sockaddr_in client_addr;
                    socklen_t client_len = sizeof(client_addr);
                    int client_fd = accept(srv->sock_fd,
                                           (struct sockaddr *)&client_addr,
                                           &client_len);
                    if (client_fd < 0) {
                        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                        perror("cerver: accept");
                        break;
                    }
                    enqueue_task(srv, client_fd);
                }
            }
        }
    }

    close(kq);

/* ================================================================== */
/*  epoll event loop (Linux)                                          */
/* ================================================================== */
#elif CERVER_USE_EPOLL

    int ep = epoll_create1(0);
    if (ep < 0) {
        perror("cerver: epoll_create1");
        close(srv->sock_fd);
        return -1;
    }

    struct epoll_event ev;
    ev.events = EPOLLIN;
    ev.data.fd = srv->sock_fd;
    epoll_ctl(ep, EPOLL_CTL_ADD, srv->sock_fd, &ev);

    struct epoll_event events[MAX_EVENTS];

    while (srv->running) {
        int nev = epoll_wait(ep, events, MAX_EVENTS, 1000);

        if (nev < 0) {
            if (errno == EINTR) continue;
            perror("cerver: epoll_wait");
            break;
        }

        for (int i = 0; i < nev; i++) {
            if (events[i].data.fd == srv->sock_fd) {
                while (1) {
                    struct sockaddr_in client_addr;
                    socklen_t client_len = sizeof(client_addr);
                    int client_fd = accept(srv->sock_fd,
                                           (struct sockaddr *)&client_addr,
                                           &client_len);
                    if (client_fd < 0) {
                        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                        perror("cerver: accept");
                        break;
                    }
                    enqueue_task(srv, client_fd);
                }
            }
        }
    }

    close(ep);

/* ================================================================== */
/*  select() fallback                                                 */
/* ================================================================== */
#elif CERVER_USE_SELECT

    while (srv->running) {
        fd_set readfds;
        FD_ZERO(&readfds);
        FD_SET(srv->sock_fd, &readfds);

        struct timeval timeout = { 1, 0 };
        int ret = select(srv->sock_fd + 1, &readfds, NULL, NULL, &timeout);

        if (ret < 0) {
            if (errno == EINTR) continue;
            perror("cerver: select");
            break;
        }

        if (ret > 0 && FD_ISSET(srv->sock_fd, &readfds)) {
            struct sockaddr_in client_addr;
            socklen_t client_len = sizeof(client_addr);
            int client_fd = accept(srv->sock_fd,
                                   (struct sockaddr *)&client_addr,
                                   &client_len);
            if (client_fd >= 0) {
                enqueue_task(srv, client_fd);
            }
        }
    }

#endif

    cerver_shutdown(srv);
    return 0;
}

/* ------------------------------------------------------------------ */
/*  Shutdown                                                          */
/* ------------------------------------------------------------------ */

void cerver_shutdown(cerver_server_t *srv) {
    srv->running = 0;

    /* Wake all worker threads so they can exit */
    pthread_mutex_lock(&srv->tq_mutex);
    pthread_cond_broadcast(&srv->tq_cond);
    pthread_mutex_unlock(&srv->tq_mutex);

    /* Join all worker threads */
    if (srv->threads) {
        for (int i = 0; i < srv->thread_count; i++) {
            pthread_join(srv->threads[i], NULL);
        }
        free(srv->threads);
        srv->threads = NULL;
    }

    /* Close listener socket */
    if (srv->sock_fd >= 0) {
        close(srv->sock_fd);
        srv->sock_fd = -1;
    }

    /* Destroy synchronization primitives */
    pthread_mutex_destroy(&srv->tq_mutex);
    pthread_cond_destroy(&srv->tq_cond);

    printf("\ncerver: server stopped\n");
}
