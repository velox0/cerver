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
 * Compile the generated C source into a binary.
 *
 * @param {string} distDir - Output directory (dist/)
 * @param {string} runtimeDir - Path to runtime/ C sources
 * @param {object} opts - { static: bool }
 */
function compile(distDir, runtimeDir, opts) {
  const cc = detectCompiler();
  const serverC = path.join(distDir, "server.c");
  const outputBin = path.join(distDir, "server");

  if (!fs.existsSync(serverC)) {
    throw new Error(
      `cerver: generated source not found at ${serverC}`
    );
  }

  /* Collect all runtime .c files */
  const runtimeSources = fs
    .readdirSync(runtimeDir)
    .filter((f) => f.endsWith(".c"))
    .map((f) => path.join(runtimeDir, f));

  /* Build the compiler command */
  const args = [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Wno-unused-parameter",
    "-o",
    outputBin,
    serverC,
    ...runtimeSources,
    `-I${runtimeDir}`,
    "-lpthread",
  ];

  if (opts && opts.static) {
    args.push("-static");
  }

  console.log(`  compiling with ${cc}...`);
  console.log(`  ${cc} ${args.join(" ")}`);

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
