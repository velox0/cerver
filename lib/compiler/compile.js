"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Detect available C compiler.
 */
function detectCompiler() {
  const candidates = ["cc", "gcc", "clang"];
  for (const cc of candidates) {
    try {
      execFileSync("which", [cc], { stdio: "ignore" });
      return cc;
    } catch {
      continue;
    }
  }
  throw new Error("cerver: no C compiler found. Install gcc or clang.");
}

/**
 * Normalize a flag list from string/array into a flat array.
 */
function normalizeFlagList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeFlagList(item)).filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    return trimmed.split(/\s+/).filter(Boolean);
  }
  return [];
}

/**
 * Check if a compiler supports a given set of flags.
 */
function supportsFlags(cc, flags) {
  try {
    execFileSync(cc, [...flags, "-x", "c", "-o", os.devNull, "-"], {
      input: "int main(){}\n",
      stdio: ["pipe", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compile the generated C source into a binary.
 *
 * @param {string} distDir - Output directory (dist/)
 * @param {string} runtimeDir - Path to runtime/ C sources
 * @param {object} opts - { static: bool }
 */
function compile(distDir, runtimeDir, opts) {
  const cc = (opts && opts.cc) || process.env.CC || detectCompiler();
  let outputBin = path.join(distDir, "server");
  if (opts && opts.output) {
    outputBin = path.isAbsolute(opts.output)
      ? opts.output
      : path.join(distDir, opts.output);
  }

  /* Collect all generated source files from distDir */
  const generatedSources = fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith(".c"))
    .map((f) => path.join(distDir, f));

  if (generatedSources.length === 0) {
    throw new Error(`cerver: no generated C source files found in ${distDir}`);
  }

  fs.mkdirSync(path.dirname(outputBin), { recursive: true });

  /* Collect all runtime .c files */
  const runtimeSources = fs
    .readdirSync(runtimeDir)
    .filter((f) => f.endsWith(".c"))
    /* Exclude fetch.c when not used — avoids libcurl dependency */
    .filter((f) => f !== "fetch.c" || (opts && opts.usesFetch))
    .map((f) => path.join(runtimeDir, f));

  const extraCFlags = normalizeFlagList(opts && opts.cflags);
  const extraLdFlags = normalizeFlagList(opts && opts.ldflags);

  const target = opts && opts.target ? String(opts.target) : null;
  const targetFlags = [];
  if (target) {
    if (supportsFlags(cc, ["-target", target])) {
      targetFlags.push("-target", target);
    } else if (supportsFlags(cc, [`--target=${target}`])) {
      targetFlags.push(`--target=${target}`);
    } else {
      console.warn(
        `  cerver: compiler does not support -target/--target; ignoring target ${target}`,
      );
    }
  }

  const sysroot = opts && opts.sysroot ? String(opts.sysroot) : null;
  const sysrootFlags = sysroot ? [`--sysroot=${sysroot}`] : [];

  /* Build the compiler command with aggressive optimization */
  const args = [
    ...targetFlags,
    ...sysrootFlags,
    "-O3",
    "-Wall",
    "-Wextra",
    "-Wno-unused-parameter",
  ];

  /* Add LTO if supported */
  if (opts ? opts.lto !== false : true) {
    if (supportsFlags(cc, ["-flto"])) {
      args.push("-flto");
    }
  }

  /* Add march=native if supported (for SIMD/hardware-specific opts) */
  if (opts ? opts.marchNative !== false : true) {
    if (supportsFlags(cc, ["-march=native"])) {
      args.push("-march=native");
    }
  }

  /* On macOS, we need to define _GNU_SOURCE for some functions */
  args.push("-D_GNU_SOURCE");

  args.push(...extraCFlags);

  args.push(
    "-o",
    outputBin,
    ...generatedSources,
    ...runtimeSources,
    `-I${runtimeDir}`,
  );

  if (opts && opts.static) {
    args.push("-static");
  }

  /* Link libcurl only when fetch() is used */
  if (opts && opts.usesFetch) {
    args.push("-lcurl");
  }

  args.push("-lpthread");
  args.push(...extraLdFlags);

  /* Debug mode */
  if (opts && opts.compileInfo) {
    console.log(`  ${cc} ${args.join(" ")}`);
  }

  const start = Date.now();

  try {
    execFileSync(cc, args, {
      stdio: "inherit",
      cwd: distDir,
    });
  } catch (err) {
    throw new Error(`cerver: compilation failed (exit code ${err.status})`);
  }

  const elapsed = Date.now() - start;
  const stat = fs.statSync(outputBin);
  const sizeKB = (stat.size / 1024).toFixed(1);

  console.log(`  compiled in ${elapsed}ms — ${sizeKB} KB`);

  return outputBin;
}

module.exports = { compile, detectCompiler };
