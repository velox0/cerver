/*
 * win_compat.h — Windows (Winsock2 / MSVC / MinGW) compatibility shim.
 *
 * Include BEFORE any system headers in files that use sockets, threads,
 * or POSIX I/O. On non-Windows platforms this exposes POSIX-backed
 * runtime aliases.
 */

#ifndef CERVER_WIN_COMPAT_H
#define CERVER_WIN_COMPAT_H

#if defined(_WIN32) || defined(_WIN64)
#define CERVER_PLATFORM_WINDOWS 1

/* ---- winsock / windows ------------------------------------------ */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif  // WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601 /* Windows 7+ */
#endif                      // _WIN32_WINNT
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <io.h>
#include <fcntl.h>
#include <process.h>
#include <time.h>

/* ---- native thread primitives ------------------------------------ */
/* Only the primitives actually used by cerver are exposed here. */

/* ---- POSIX socket aliases --------------------------------------- */
typedef SOCKET cerver_sock_t;
#define CERVER_INVALID_SOCK  INVALID_SOCKET
#define cerver_close_sock(s) closesocket(s)

/* ssize_t is missing on MSVC/older MinGW */
#if !defined(ssize_t) && !defined(_SSIZE_T_DEFINED)
typedef intptr_t ssize_t;
#define _SSIZE_T_DEFINED
#endif  // !ssize_t && !_SSIZE_T_DEFINED

/* read/write on a socket must go through recv/send on Windows */
static inline ssize_t cerver_sock_read(int fd, void* buf, size_t n) {
  return (ssize_t)recv((SOCKET)fd, (char*)buf, (int)n, 0);
}
static inline ssize_t cerver_sock_write(int fd, const void* buf, size_t n) {
  return (ssize_t)send((SOCKET)fd, (const char*)buf, (int)n, 0);
}

/* fcntl / O_NONBLOCK replacement */
static inline int cerver_set_nonblocking_win(SOCKET s) {
  u_long mode = 1;
  return ioctlsocket(s, FIONBIO, &mode) == 0 ? 0 : -1;
}

/* SO_RCVTIMEO on Windows takes DWORD milliseconds */
static inline void cerver_set_rcvtimeo_win(SOCKET s, int sec) {
  DWORD ms = (DWORD)(sec * 1000);
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&ms, sizeof(ms));
}

/* memmem is not in the Windows CRT */
static inline void* cerver_memmem_win(const void* hay, size_t hlen, const void* ned, size_t nlen) {
  if (nlen == 0) return (void*)hay;
  if (nlen > hlen) return NULL;
  const char* p   = (const char*)hay;
  const char* end = p + hlen - nlen;
  for (; p <= end; p++)
    if (memcmp(p, ned, nlen) == 0) return (void*)p;
  return NULL;
}
#ifndef memmem
#define memmem cerver_memmem_win
#endif  // memmem

/* POSIX case-insensitive string helpers are named differently by the Windows CRT. */
#ifndef strcasecmp
#define strcasecmp _stricmp
#endif  // strcasecmp

/* clock_gettime / CLOCK_REALTIME are missing from some Windows CRTs. */
#ifndef CLOCK_REALTIME
#define CLOCK_REALTIME 0
typedef struct cerver_timespec_t {
  long tv_sec;
  long tv_nsec;
} cerver_timespec_t;
#ifndef timespec
#define timespec cerver_timespec_t
#endif  // timespec
static inline int clock_gettime(int clk_id, cerver_timespec_t* ts) {
  (void)clk_id;
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULONGLONG t = ((ULONGLONG)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
  t -= 116444736000000000ULL;
  ts->tv_sec  = (long)(t / 10000000ULL);
  ts->tv_nsec = (long)((t % 10000000ULL) * 100);
  return 0;
}
#endif  // CLOCK_REALTIME

/* Windows socket error → errno translation for the few codes we check */
static inline int cerver_would_block_win(void) {
  int e = WSAGetLastError();
  return e == WSAEWOULDBLOCK || e == WSAEINPROGRESS;
}
#define CERVER_WOULD_BLOCK() cerver_would_block_win()

/* sysconf(_SC_NPROCESSORS_ONLN) replacement */
static inline long cerver_nproc_win(void) {
  SYSTEM_INFO si;
  GetSystemInfo(&si);
  return (long)si.dwNumberOfProcessors;
}

/* sleep(n) → Sleep(n*1000) */
#ifndef sleep
#define sleep(n) Sleep((DWORD)((n) * 1000))
#endif  // sleep

/* Signal shim — Windows has signal() but not SIGPIPE */
#ifndef SIGPIPE
#define SIGPIPE 13
#endif  // SIGPIPE
/* SIG_IGN is defined in <signal.h> on Windows */

/* ---- native Windows thread backend ------------------------------- */
typedef SRWLOCK            cerver_mutex_t;
typedef CONDITION_VARIABLE cerver_cond_t;
typedef INIT_ONCE          cerver_fetch_global_init_guard_t;
typedef HANDLE             cerver_connection_worker_thread_t;
typedef HANDLE             cerver_acceptor_thread_t;
typedef size_t             cerver_connection_worker_thread_attr_t;
typedef size_t             cerver_acceptor_thread_attr_t;

#define CERVER_MUTEX_INITIALIZER                   SRWLOCK_INIT
#define CERVER_COND_INITIALIZER                    CONDITION_VARIABLE_INIT
#define CERVER_FETCH_GLOBAL_INIT_GUARD_INITIALIZER INIT_ONCE_STATIC_INIT

static inline int cerver_mutex_init(cerver_mutex_t* m, void* attr) {
  (void)attr;
  InitializeSRWLock(m);
  return 0;
}
static inline int cerver_mutex_destroy(cerver_mutex_t* m) {
  (void)m;
  return 0;
}
static inline int cerver_mutex_lock(cerver_mutex_t* m) {
  AcquireSRWLockExclusive(m);
  return 0;
}
static inline int cerver_mutex_unlock(cerver_mutex_t* m) {
  ReleaseSRWLockExclusive(m);
  return 0;
}

static inline int cerver_cond_init(cerver_cond_t* c, void* attr) {
  (void)attr;
  InitializeConditionVariable(c);
  return 0;
}
static inline int cerver_cond_destroy(cerver_cond_t* c) {
  (void)c;
  return 0;
}
static inline int cerver_cond_wait(cerver_cond_t* c, cerver_mutex_t* m) {
  SleepConditionVariableSRW(c, m, INFINITE, 0);
  return 0;
}
static inline int cerver_cond_timedwait(cerver_cond_t* c, cerver_mutex_t* m,
                                        const struct timespec* ts) {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULONGLONG t = ((ULONGLONG)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
  t -= 116444736000000000ULL;
  long long now_sec  = (long long)(t / 10000000ULL);
  long long now_nsec = (long long)((t % 10000000ULL) * 100);

  long long ms = (ts->tv_sec - now_sec) * 1000 + (ts->tv_nsec - now_nsec) / 1000000;
  if (ms < 0) ms = 0;
  if (SleepConditionVariableSRW(c, m, (DWORD)ms, 0)) return 0;
  return 110; /* ETIMEDOUT */
}
static inline int cerver_cond_signal(cerver_cond_t* c) {
  WakeConditionVariable(c);
  return 0;
}
static inline int cerver_cond_broadcast(cerver_cond_t* c) {
  WakeAllConditionVariable(c);
  return 0;
}

static inline int cerver_connection_worker_thread_attr_init(
    cerver_connection_worker_thread_attr_t* attr) {
  *attr = 0;
  return 0;
}
static inline int cerver_connection_worker_thread_attr_destroy(
    cerver_connection_worker_thread_attr_t* attr) {
  *attr = 0;
  return 0;
}
static inline int cerver_connection_worker_thread_attr_setstacksize(
    cerver_connection_worker_thread_attr_t* attr, size_t stacksize) {
  *attr = stacksize;
  return 0;
}

static inline int cerver_acceptor_thread_attr_init(cerver_acceptor_thread_attr_t* attr) {
  *attr = 0;
  return 0;
}
static inline int cerver_acceptor_thread_attr_destroy(cerver_acceptor_thread_attr_t* attr) {
  *attr = 0;
  return 0;
}
static inline int cerver_acceptor_thread_attr_setstacksize(cerver_acceptor_thread_attr_t* attr,
                                                           size_t stacksize) {
  *attr = stacksize;
  return 0;
}

struct cerver_windows_thread_entry_args {
  void* (*func)(void*);
  void* arg;
};
static inline DWORD WINAPI cerver_windows_thread_entry(LPVOID lpParam) {
  struct cerver_windows_thread_entry_args* args = (struct cerver_windows_thread_entry_args*)lpParam;
  void* (*func)(void*)                          = args->func;
  void* arg                                     = args->arg;
  free(args);
  func(arg);
  return 0;
}

static inline int cerver_start_windows_native_thread(HANDLE* thread, size_t               stack,
                                                     void* (*start_routine)(void*), void* arg) {
  struct cerver_windows_thread_entry_args* args =
      (struct cerver_windows_thread_entry_args*)malloc(sizeof(*args));
  if (!args) return -1;
  args->func = start_routine;
  args->arg  = arg;
  *thread    = CreateThread(NULL, stack, cerver_windows_thread_entry, args, 0, NULL);
  if (!*thread) {
    free(args);
    return -1;
  }
  return 0;
}

static inline int cerver_connection_worker_thread_create(
    cerver_connection_worker_thread_t* thread, const cerver_connection_worker_thread_attr_t* attr,
    void* (*start_routine)(void*), void*                                                     arg) {
  return cerver_start_windows_native_thread(thread, attr ? *attr : 0, start_routine, arg);
}
static inline int cerver_acceptor_thread_create(cerver_acceptor_thread_t*            thread,
                                                const cerver_acceptor_thread_attr_t* attr,
                                                void* (*start_routine)(void*), void* arg) {
  return cerver_start_windows_native_thread(thread, attr ? *attr : 0, start_routine, arg);
}

static inline int cerver_connection_worker_thread_join(cerver_connection_worker_thread_t thread,
                                                       void**                            retval) {
  (void)retval;
  WaitForSingleObject(thread, INFINITE);
  CloseHandle(thread);
  return 0;
}
static inline int cerver_acceptor_thread_join(cerver_acceptor_thread_t thread, void** retval) {
  (void)retval;
  WaitForSingleObject(thread, INFINITE);
  CloseHandle(thread);
  return 0;
}

static inline BOOL CALLBACK cerver_fetch_global_init_guard_stub(PINIT_ONCE InitOnce,
                                                                PVOID Parameter, PVOID* Context) {
  (void)InitOnce;
  (void)Context;
  void (*func)(void) = (void (*)(void))Parameter;
  func();
  return TRUE;
}
static inline int cerver_fetch_global_init_guard_run(cerver_fetch_global_init_guard_t* guard,
                                                     void (*init_routine)(void)) {
  InitOnceExecuteOnce(guard, cerver_fetch_global_init_guard_stub, init_routine, NULL);
  return 0;
}

/* Winsock init/teardown helpers ----------------------------------- */
static inline int cerver_wsa_startup(void) {
  WSADATA wd;
  return WSAStartup(MAKEWORD(2, 2), &wd);
}
static inline void cerver_wsa_cleanup(void) { WSACleanup(); }

/* TCP_NODELAY setsockopt takes char* on Windows */
#define CERVER_SETSOCKOPT_CAST (const char*)

#else /* !Windows */

#include <errno.h>
#include <pthread.h>
#include <stddef.h>
#include <sys/types.h>
#include <unistd.h>

#define CERVER_PLATFORM_WINDOWS 0
typedef int           cerver_sock_t;
#define CERVER_INVALID_SOCK     (-1)
#define cerver_close_sock(s)    close(s)
static inline ssize_t cerver_sock_read(int fd, void* buf, size_t n) { return read(fd, buf, n); }
static inline ssize_t cerver_sock_write(int fd, const void* buf, size_t n) {
  return write(fd, buf, n);
}
#define CERVER_WOULD_BLOCK()    (errno == EAGAIN || errno == EWOULDBLOCK)
#define CERVER_SETSOCKOPT_CAST
static inline int  cerver_wsa_startup(void) { return 0; }
static inline void cerver_wsa_cleanup(void) {}

typedef pthread_mutex_t cerver_mutex_t;
typedef pthread_cond_t  cerver_cond_t;
typedef pthread_once_t  cerver_fetch_global_init_guard_t;
typedef pthread_t       cerver_connection_worker_thread_t;
typedef pthread_t       cerver_acceptor_thread_t;
typedef pthread_attr_t  cerver_connection_worker_thread_attr_t;
typedef pthread_attr_t  cerver_acceptor_thread_attr_t;

#define CERVER_MUTEX_INITIALIZER                   PTHREAD_MUTEX_INITIALIZER
#define CERVER_COND_INITIALIZER                    PTHREAD_COND_INITIALIZER
#define CERVER_FETCH_GLOBAL_INIT_GUARD_INITIALIZER PTHREAD_ONCE_INIT

static inline int cerver_mutex_init(cerver_mutex_t* m, void* attr) {
  return pthread_mutex_init(m, (const pthread_mutexattr_t*)attr);
}
static inline int cerver_mutex_destroy(cerver_mutex_t* m) { return pthread_mutex_destroy(m); }
static inline int cerver_mutex_lock(cerver_mutex_t* m) { return pthread_mutex_lock(m); }
static inline int cerver_mutex_unlock(cerver_mutex_t* m) { return pthread_mutex_unlock(m); }

static inline int cerver_cond_init(cerver_cond_t* c, void* attr) {
  return pthread_cond_init(c, (const pthread_condattr_t*)attr);
}
static inline int cerver_cond_destroy(cerver_cond_t* c) { return pthread_cond_destroy(c); }
static inline int cerver_cond_wait(cerver_cond_t* c, cerver_mutex_t* m) {
  return pthread_cond_wait(c, m);
}
static inline int cerver_cond_timedwait(cerver_cond_t* c, cerver_mutex_t* m,
                                        const struct timespec* ts) {
  return pthread_cond_timedwait(c, m, ts);
}
static inline int cerver_cond_signal(cerver_cond_t* c) { return pthread_cond_signal(c); }
static inline int cerver_cond_broadcast(cerver_cond_t* c) { return pthread_cond_broadcast(c); }

static inline int cerver_connection_worker_thread_attr_init(
    cerver_connection_worker_thread_attr_t* attr) {
  return pthread_attr_init(attr);
}
static inline int cerver_connection_worker_thread_attr_destroy(
    cerver_connection_worker_thread_attr_t* attr) {
  return pthread_attr_destroy(attr);
}
static inline int cerver_connection_worker_thread_attr_setstacksize(
    cerver_connection_worker_thread_attr_t* attr, size_t stacksize) {
  return pthread_attr_setstacksize(attr, stacksize);
}

static inline int cerver_acceptor_thread_attr_init(cerver_acceptor_thread_attr_t* attr) {
  return pthread_attr_init(attr);
}
static inline int cerver_acceptor_thread_attr_destroy(cerver_acceptor_thread_attr_t* attr) {
  return pthread_attr_destroy(attr);
}
static inline int cerver_acceptor_thread_attr_setstacksize(cerver_acceptor_thread_attr_t* attr,
                                                           size_t stacksize) {
  return pthread_attr_setstacksize(attr, stacksize);
}

static inline int cerver_connection_worker_thread_create(
    cerver_connection_worker_thread_t* thread, const cerver_connection_worker_thread_attr_t* attr,
    void* (*start_routine)(void*), void*                                                     arg) {
  return pthread_create(thread, attr, start_routine, arg);
}
static inline int cerver_acceptor_thread_create(cerver_acceptor_thread_t*            thread,
                                                const cerver_acceptor_thread_attr_t* attr,
                                                void* (*start_routine)(void*), void* arg) {
  return pthread_create(thread, attr, start_routine, arg);
}

static inline int cerver_connection_worker_thread_join(cerver_connection_worker_thread_t thread,
                                                       void**                            retval) {
  return pthread_join(thread, retval);
}
static inline int cerver_acceptor_thread_join(cerver_acceptor_thread_t thread, void** retval) {
  return pthread_join(thread, retval);
}

static inline int cerver_fetch_global_init_guard_run(cerver_fetch_global_init_guard_t* guard,
                                                     void (*init_routine)(void)) {
  return pthread_once(guard, init_routine);
}

#endif  // _WIN32 || _WIN64
#endif  // CERVER_WIN_COMPAT_H
