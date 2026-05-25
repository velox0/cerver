"use strict";

const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Detect available C compiler.
 */
function detectCompiler() {
  const candidates = ["cc", "gcc", "clang"];
  for (const cc of candidates) {
    try {
      execSync(`which ${cc}`, { stdio: "ignore" });
      return cc;
    } catch {
      continue;
    }
  }
  throw new Error(
    "cerver: no C compiler found. Install gcc or clang."
  );
}

/**
 * Check if a compiler supports a given flag.
 */
function supportsFlag(cc, flag) {
  try {
    execSync(`echo 'int main(){}' | ${cc} ${flag} -x c -o /dev/null - 2>/dev/null`, {
      stdio: "ignore",
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
  const cc = detectCompiler();
  const outputBin = path.join(distDir, "server");

  /* Collect all generated source files from distDir */
  const generatedSources = fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith(".c"))
    .map((f) => path.join(distDir, f));

  if (generatedSources.length === 0) {
    throw new Error(
      `cerver: no generated C source files found in ${distDir}`
    );
  }

  /* Collect all runtime .c files */
  const runtimeSources = fs
    .readdirSync(runtimeDir)
    .filter((f) => f.endsWith(".c"))
    /* Exclude fetch.c when not used — avoids libcurl dependency */
    .filter((f) => f !== "fetch.c" || (opts && opts.usesFetch))
    .map((f) => path.join(runtimeDir, f));

  /* Build the compiler command with aggressive optimization */
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
    "-lpthread",
  ];

  /* Link libcurl only when fetch() is used */
  if (opts && opts.usesFetch) {
    args.push("-lcurl");
  }

  /* Add LTO if supported */
  if (supportsFlag(cc, "-flto")) {
    args.splice(1, 0, "-flto");
  }

  /* Add march=native if supported (for SIMD/hardware-specific opts) */
  if (supportsFlag(cc, "-march=native")) {
    args.push("-march=native");
  }

  if (opts && opts.static) {
    args.push("-static");
  }

  /* On macOS, we need to define _GNU_SOURCE for some functions */
  args.push("-D_GNU_SOURCE");

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
    throw new Error(
      `cerver: compilation failed (exit code ${err.status})`
    );
  }

  const elapsed = Date.now() - start;
  const stat = fs.statSync(outputBin);
  const sizeKB = (stat.size / 1024).toFixed(1);

  console.log(`  compiled in ${elapsed}ms — ${sizeKB} KB`);

  return outputBin;
}

module.exports = { compile, detectCompiler };
