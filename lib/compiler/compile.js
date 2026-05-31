"use strict";

const { execFileSync, execSync } = require("child_process");
const fs   = require("fs");
const os   = require("os");
const path = require("path");

const IS_WINDOWS = process.platform === "win32";

/* ------------------------------------------------------------------ */
/*  Compiler detection                                                */
/* ------------------------------------------------------------------ */

function detectCompiler() {
  const candidates = IS_WINDOWS
    ? ["clang", "gcc", "cc", "x86_64-w64-mingw32-gcc"]
    : ["cc", "gcc", "clang"];

  for (const cc of candidates) {
    try {
      if (IS_WINDOWS) {
        execFileSync("where", [cc], { stdio: "ignore", shell: false });
      } else {
        execFileSync("which", [cc], { stdio: "ignore" });
      }
      return cc;
    } catch {
      continue;
    }
  }

  const msg = IS_WINDOWS
    ? "cerver: no C compiler found.\n" +
      "  Install one of:\n" +
      "    • LLVM/Clang for Windows: https://releases.llvm.org/\n" +
      "    • MinGW-w64 via MSYS2:    pacman -S mingw-w64-x86_64-gcc\n" +
      "    • WinLibs standalone:     https://winlibs.com/\n" +
      "  Then make sure it is on your PATH."
    : "cerver: no C compiler found. Install gcc or clang.";
  throw new Error(msg);
}

/* ------------------------------------------------------------------ */
/*  Flag probing                                                      */
/* ------------------------------------------------------------------ */

function supportsFlag(cc, flag) {
  try {
    execFileSync(
      cc,
      [flag, "-x", "c", "-o", os.devNull, "-"],
      {
        input: "int main(){}\n",
        stdio: ["pipe", "ignore", "ignore"],
        shell: IS_WINDOWS,
      }
    );
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Main compile function                                             */
/* ------------------------------------------------------------------ */

/**
 * Compile the generated C source into a binary.
 *
 * @param {string} distDir    - Output directory (dist/)
 * @param {string} runtimeDir - Path to runtime/ C sources
 * @param {object} opts       - { static: bool, usesFetch: bool, compile: config.compile }
 */
function compile(distDir, runtimeDir, opts) {
  const cfg = (opts && opts.compile) || {};

  /* Compiler: explicit override > auto-detect */
  const cc = cfg.cc || detectCompiler();

  /* Output binary: explicit override > default */
  const defaultBin = IS_WINDOWS
    ? path.join(distDir, "server.exe")
    : path.join(distDir, "server");
  const outputBin = cfg.output || defaultBin;

  /* Collect generated source files */
  const generatedSources = fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith(".c"))
    .map((f) => path.join(distDir, f));

  if (generatedSources.length === 0) {
    throw new Error(`cerver: no generated C source files found in ${distDir}`);
  }

  /* Collect runtime .c files */
  const runtimeSources = fs
    .readdirSync(runtimeDir)
    .filter((f) => f.endsWith(".c"))
    .filter((f) => f !== "fetch.c" || (opts && opts.usesFetch))
    .map((f) => path.join(runtimeDir, f));

  /* Build args */
  const args = [
    "-O3",
    "-Wall",
    "-Wextra",
    "-Wno-unused-parameter",
    "-o",
    outputBin,
    ...generatedSources,
    ...runtimeSources,
    `-I${runtimeDir}`,
  ];

  /* Cross-compilation: target triple and sysroot */
  if (cfg.target) {
    args.push(`-target`, cfg.target);
  }
  if (cfg.sysroot) {
    args.push(`--sysroot=${cfg.sysroot}`);
  }

  if (IS_WINDOWS) {
    /* Windows: link Winsock2, ws2_32 required for socket API */
    args.push("-lws2_32");

    /* libcurl for fetch() */
    if (opts && opts.usesFetch) {
      args.push("-lcurl");
    }

    /* Windows-specific defines */
    args.push("-D_WIN32_WINNT=0x0601");
    args.push("-DWIN32_LEAN_AND_MEAN");

    /* Produce a console binary (not a GUI window) */
    args.push("-mconsole");
  } else {
    /* POSIX: thread support + optional libcurl */
    args.push("-lpthread");
    if (opts && opts.usesFetch) {
      args.push("-lcurl");
    }

    /* GNU_SOURCE for memmem, accept4, etc. */
    args.push("-D_GNU_SOURCE");

    if (opts && opts.static) {
      args.push("-static");
    }
  }

  /* LTO: controlled by cfg.lto (default true); probe first so we don't pass
   * an unsupported flag on MSVC-based clang-cl or older compilers. */
  const useLto = cfg.lto !== false; // true when undefined (default on)
  if (useLto && supportsFlag(cc, "-flto")) {
    args.splice(1, 0, "-flto");
  }

  /* -march=native: explicit true/false, or undefined = auto-probe */
  if (cfg.marchNative === true) {
    args.push("-march=native");
  } else if (cfg.marchNative === undefined) {
    if (supportsFlag(cc, "-march=native")) {
      args.push("-march=native");
    }
  }
  /* cfg.marchNative === false → skip entirely */

  /* Extra user-supplied flags (split on whitespace to avoid shell-quoting
   * issues when using execFileSync without a shell). */
  if (cfg.cflags) {
    args.push(...cfg.cflags.trim().split(/\s+/));
  }
  if (cfg.ldflags) {
    args.push(...cfg.ldflags.trim().split(/\s+/));
  }

  const compileInfo = cfg.compileInfo || (opts && opts.compileInfo);
  if (compileInfo) {
    console.log(`  ${cc} ${args.join(" ")}`);
  }

  const start = Date.now();

  try {
    execFileSync(cc, args, {
      stdio: "inherit",
      cwd:   distDir,
      shell: IS_WINDOWS,
    });
  } catch (err) {
    throw new Error(
      `cerver: compilation failed (exit code ${err.status})\n` +
      (IS_WINDOWS
        ? "  Tip: ensure gcc/clang and (if using fetch) libcurl are installed."
        : "")
    );
  }

  const elapsed = Date.now() - start;
  const stat    = fs.statSync(outputBin);
  const sizeKB  = (stat.size / 1024).toFixed(1);

  console.log(`  compiled in ${elapsed}ms — ${sizeKB} KB`);

  return outputBin;
}

module.exports = { compile, detectCompiler };
