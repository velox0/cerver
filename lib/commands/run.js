"use strict";

const { execFileSync } = require("child_process");
const path = require("path");
const fs   = require("fs");
const { findProjectRoot } = require("../config");

const IS_WINDOWS = process.platform === "win32";

/**
 * Run the compiled binary from dist/.
 */
function run(opts) {
  const projectDir = findProjectRoot();
  if (!projectDir) {
    console.log("Not a cerver project");
    process.exit(1);
  }
  process.chdir(projectDir);

  // Prefer .exe on Windows, fall back to plain "server" for compat
  const binaryName  = IS_WINDOWS ? "server.exe" : "server";
  const binaryPath  = path.join(projectDir, "dist", binaryName);
  const legacyPath  = path.join(projectDir, "dist", "server");

  const resolvedBin = fs.existsSync(binaryPath)
    ? binaryPath
    : fs.existsSync(legacyPath)
      ? legacyPath
      : null;

  if (!resolvedBin) {
    console.error("cerver: no compiled binary found. Run `cerver build` first.");
    process.exit(1);
  }

  // Make sure it's executable on POSIX
  if (!IS_WINDOWS) {
    try { fs.chmodSync(resolvedBin, 0o755); } catch (_) {}
  }

  const env = { ...process.env };
  if (opts.port) env.CERVER_PORT = opts.port;

  console.log(`cerver: starting server from ${resolvedBin}`);

  try {
    execFileSync(resolvedBin, [], {
      stdio: "inherit",
      env,
      cwd:   projectDir,
      shell: IS_WINDOWS, // On Windows, .exe may need shell resolution
    });
  } catch (err) {
    if (err.status !== null) {
      process.exit(err.status);
    }
    throw err;
  }
}

module.exports = { run };
