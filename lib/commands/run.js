"use strict";

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { findProjectRoot } = require("../config");

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

  const binaryPath = path.join(projectDir, "dist", "server");

  if (!fs.existsSync(binaryPath)) {
    console.error("cerver: no compiled binary found. Run `cerver build` first.");
    process.exit(1);
  }

  // Make sure it's executable
  try {
    fs.chmodSync(binaryPath, 0o755);
  } catch (_) {
    // Ignore — may already be executable
  }

  const env = { ...process.env };
  if (opts.port) {
    env.CERVER_PORT = opts.port;
  }

  console.log(`cerver: starting server from ${binaryPath}`);

  try {
    execFileSync(binaryPath, [], {
      stdio: "inherit",
      env,
      cwd: projectDir,
    });
  } catch (err) {
    if (err.status !== null) {
      process.exit(err.status);
    }
    throw err;
  }
}

module.exports = { run };
