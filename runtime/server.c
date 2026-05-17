/*
 * server.c — Socket setup and event loop for the cerver runtime.
 *
 * Uses kqueue on macOS, epoll on Linux, with a select() fallback.
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
/*  Handle a single connection: read, parse, dispatch, respond        */
/* ------------------------------------------------------------------ */

static int set_blocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);
}

static void handle_connection(cerver_server_t *srv, int client_fd) {
    /* Client sockets may inherit non-blocking mode from listener.
       Set to blocking so read() waits for data. */
    set_blocking(client_fd);

    char buf[CERVER_READ_BUF];
    ssize_t n = read(client_fd, buf, sizeof(buf) - 1);

    if (n <= 0) {
        close(client_fd);
        return;
    }
    buf[n] = '\0';

    /* Parse HTTP request */
    cerver_request_t req;
    memset(&req, 0, sizeof(req));

    if (cerver_parse_request(buf, (size_t)n, &req) < 0) {
        /* Bad request — send 400 */
        const char *resp = "HTTP/1.1 400 Bad Request\r\nContent-Length: 11\r\nConnection: close\r\n\r\nBad Request";
        write(client_fd, resp, strlen(resp));
        close(client_fd);
        return;
    }

    /* Prepare response */
    cerver_response_t res;
    memset(&res, 0, sizeof(res));

    /* Try to dispatch to a route handler */
    cerver_handler_fn handler = cerver_dispatch(srv, &req);

    if (handler) {
        handler(&req, &res);
    } else {
        /* Try static assets */
        if (cerver_serve_static(srv, &req, &res) < 0) {
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
/*  Server init                                                       */
/* ------------------------------------------------------------------ */

int cerver_init(cerver_server_t *srv, int port) {
    memset(srv, 0, sizeof(*srv));
    srv->port = port;
    srv->sock_fd = -1;
    srv->running = 0;
    srv->public_dir = NULL;
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

    printf("cerver: listening on http://0.0.0.0:%d\n", srv->port);

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
                    handle_connection(srv, client_fd);
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
                    handle_connection(srv, client_fd);
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
                handle_connection(srv, client_fd);
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
    if (srv->sock_fd >= 0) {
        close(srv->sock_fd);
        srv->sock_fd = -1;
    }
    srv->running = 0;
    printf("\ncerver: server stopped\n");
}
