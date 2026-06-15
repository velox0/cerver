"use strict";

const fs   = require("fs");
const path = require("path");
const { findProjectRoot, loadConfig } = require("../config");

const IS_WINDOWS = process.platform === "win32";

/**
 * Recursively copy a directory tree from src to dst.
 * @param {string} src
 * @param {string} dst
 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

/**
 * `cerver package` — bundle the compiled binary (and dist/public/ when
 * embed:false) into a self-contained package directory at dist/package/.
 *
 * Layout:
 *   dist/package/
 *   ├── server          (or server.exe on Windows)
 *   └── public/         (only present when embed: false)
 *
 * When finished the command reports the output path and total size.
 */
function pkg(opts) {
  const projectDir = findProjectRoot();
  if (!projectDir) {
    console.error("cerver: not a cerver project");
    process.exit(1);
  }
  process.chdir(projectDir);

  const config  = loadConfig(projectDir);
  const distDir = path.join(projectDir, "dist");

  /* Locate compiled binary */
  const binaryName = IS_WINDOWS ? "server.exe" : "server";
  const binaryPath = path.join(distDir, binaryName);

  if (!fs.existsSync(binaryPath)) {
    console.error("cerver: no compiled binary found in dist/. Run `cerver build` first.");
    process.exit(1);
  }

  /* Determine output directory */
  const packageDir = opts.output
    ? path.resolve(opts.output)
    : path.join(distDir, "package");

  /* Clean and recreate */
  if (fs.existsSync(packageDir)) {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
  fs.mkdirSync(packageDir, { recursive: true });

  console.log("\n  cerver package\n");

  /* 1. Copy binary */
  const destBin = path.join(packageDir, binaryName);
  fs.copyFileSync(binaryPath, destBin);
  if (!IS_WINDOWS) {
    fs.chmodSync(destBin, 0o755);
  }
  const binSize = fs.statSync(destBin).size;
  console.log(`  ✓ binary  → ${path.relative(projectDir, destBin)} (${(binSize / 1024).toFixed(1)} KB)`);

  /* 2. Copy dist/public/ if it exists (embed: false mode) */
  const srcPublic  = path.join(distDir, "public");
  const destPublic = path.join(packageDir, "public");

  if (fs.existsSync(srcPublic)) {
    copyDir(srcPublic, destPublic);
    const assetCount = countFiles(destPublic);
    console.log(`  ✓ public/ → ${path.relative(projectDir, destPublic)} (${assetCount} file(s))`);
  } else if (!config.embed) {
    console.warn("  ⚠ embed is false but no dist/public/ found — run `cerver build` first.");
  }

  /* 3. Summary */
  const totalSize = dirSize(packageDir);
  const relOut    = path.relative(projectDir, packageDir);
  console.log(`\n  ✓ package ready: ${relOut}/  (${(totalSize / 1024).toFixed(1)} KB total)`);
  console.log(`    deploy by copying ${relOut}/ to your server and running ./${binaryName}\n`);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      n += countFiles(path.join(dir, entry.name));
    } else {
      n++;
    }
  }
  return n;
}

function dirSize(dir) {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += dirSize(full);
    } else {
      size += fs.statSync(full).size;
    }
  }
  return size;
}

module.exports = { pkg };
