# Cerver on Windows

Cerver compiles your routes to native C and links against pthreads and (optionally) libcurl.
On Windows you need a C toolchain that provides these.  Two easy options:

---

## Option A — MSYS2 + MinGW-w64 (recommended)

1. **Install MSYS2** from https://www.msys2.org/

2. Open the **MSYS2 UCRT64** or **MinGW64** terminal and install the toolchain:

   ```bash
   # MinGW-w64 (recommended for standalone .exe)
   pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-pthreads

   # If you want fetch() support (outbound HTTP):
   pacman -S mingw-w64-x86_64-curl
   ```

3. Add MinGW to your Windows `PATH` (usually `C:\msys64\mingw64\bin`).

4. Open a regular **Command Prompt** or **PowerShell** and verify:
   ```
   gcc --version
   ```

---

## Option B — LLVM/Clang for Windows + pthreads4w

1. Install Clang from https://releases.llvm.org/ (choose the Windows installer).

2. Download and install **pthreads4w** from https://sourceforge.net/projects/pthreads4w/
   (or clone + build from https://github.com/jwinarske/pthreads4w).

3. Place the pthreads4w headers and `.a` / `.lib` somewhere on your PATH / in a standard
   location (e.g. `C:\pthreads4w`).  Cerver's compiler probe will find them automatically.

4. If you want `fetch()` support, install libcurl for Windows from https://curl.se/windows/
   and add it to PATH / link path.

---

## Building & running

```powershell
npx @velox0/cerver@latest new my-api
cd my-api
npx @velox0/cerver@latest build
npx @velox0/cerver@latest run
```

The `build` command produces `dist\server.exe`.  The `run` command executes it directly.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no C compiler found` | Add `gcc` or `clang` to `PATH`; see Option A/B above |
| `undefined reference to pthread_*` | Install pthreads-win32 (MSYS2: `pacman -S mingw-w64-x86_64-pthreads`) |
| `undefined reference to curl_*` | Install libcurl and ensure `libcurl.a` / `libcurl.dll.a` are findable |
| `WSAStartup failed` | Should not happen; report a bug |
| `cerver build` passes but binary crashes | Run from the project root, not from `dist\` |

---

## Platform differences from Linux/macOS

| Feature | Linux/macOS | Windows |
|---|---|---|
| Event loop | epoll / kqueue | `select()` (single acceptor) |
| Acceptor threads | 1 per CPU core | 1 (select-based) |
| `sendfile` | ✅ zero-copy | read+send loop |
| Binary name | `dist/server` | `dist/server.exe` |
| `SIGPIPE` | ignored | n/a (no SIGPIPE on Windows) |
| Static linking (`--static`) | ✅ | not supported yet |
| `cerver dev` (watch + reload) | ✅ | ✅ (requires PowerShell or CMD) |

Performance on Windows is lower than Linux/macOS because `select()` does not scale as well
as `epoll`/`kqueue`, but it is fully functional for development and moderate production load.
IOCP support is planned for a future release.
