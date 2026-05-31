/*
 * win_compat.h — Windows (Winsock2 / MSVC / MinGW) compatibility shim.
 *
 * Include BEFORE any system headers in files that use sockets, threads,
 * or POSIX I/O.  On non-Windows platforms this header is a no-op.
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
#include <io.h>
#include <process.h>
#include <time.h>

/* ---- pthread shim via Windows threads --------------------------- */
/* We bundle a minimal pthreads-win32 surface so the rest of the code
   can stay unchanged.  Only the primitives actually used by cerver are
   mapped; this is NOT a general replacement.                          */

#include <pthread.h>

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

/* clock_gettime is missing before MSVC 2019 / older MinGW */
#if defined(_MSC_VER) && _MSC_VER < 1900
#include <windows.h>
#ifndef CLOCK_REALTIME
#define CLOCK_REALTIME 0
typedef struct {
  long tv_sec;
  long tv_nsec;
} timespec_t;
#define timespec timespec_t
static inline int clock_gettime(int, struct timespec* ts) {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULONGLONG t = ((ULONGLONG)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
  t -= 116444736000000000ULL;
  ts->tv_sec  = (long)(t / 10000000ULL);
  ts->tv_nsec = (long)((t % 10000000ULL) * 100);
  return 0;
}
#endif  // CLOCK_REALTIME
#endif  // _MSC_VER && _MSC_VER < 1900

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

/* Winsock init/teardown helpers ----------------------------------- */
static inline int cerver_wsa_startup(void) {
  WSADATA wd;
  return WSAStartup(MAKEWORD(2, 2), &wd);
}
static inline void cerver_wsa_cleanup(void) { WSACleanup(); }

/* TCP_NODELAY setsockopt takes char* on Windows */
#define CERVER_SETSOCKOPT_CAST (const char*)

#else /* !Windows */

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

#endif  // _WIN32 || _WIN64
#endif  // CERVER_WIN_COMPAT_H
