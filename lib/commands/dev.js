"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const chokidar = require("chokidar");
const { build } = require("./build");
const { findProjectRoot } = require("../config");

/**
 * Dev mode: watch for changes, auto-rebuild, auto-restart.
 */
async function dev(opts) {
  const projectDir = findProjectRoot();
  if (!projectDir) {
    console.log("Not a cerver project");
    process.exit(1);
  }
  process.chdir(projectDir);

  const binaryPath = path.join(projectDir, "dist", "server");

  let serverProcess = null;
  let building = false;
  let pendingRebuild = false;
  let shuttingDown = false;

  const port = opts.port || null;

  /* ---- Initial build ---- */
  async function rebuild() {
    if (building) {
      pendingRebuild = true;
      return;
    }

    building = true;

    /* Kill existing server */
    if (serverProcess) {
      console.log("\n  ↻ restarting...\n");
      const procToKill = serverProcess;
      serverProcess = null;
      procToKill.kill("SIGTERM");
      /* Wait for old process to fully exit so the port is released */
      await waitForExit(procToKill, 2000);
    }

    try {
      await build({
        embed: opts.embed !== undefined ? opts.embed : true,
        minify: false /* Skip minification in dev for speed */,
        static: false,
      });

      /* Start the server */
      startServer();
    } catch (err) {
      console.error(`\n  ✗ build failed: ${err.message}\n`);
    }

    building = false;

    /* If changes came in during build, rebuild again */
    if (pendingRebuild) {
      pendingRebuild = false;
      await rebuild();
    }
  }

  function startServer() {
    if (!fs.existsSync(binaryPath)) return;

    const env = { ...process.env };
    if (port) env.CERVER_PORT = port;

    const proc = spawn(binaryPath, [], {
      stdio: "inherit",
      env,
      cwd: projectDir,
    });

    serverProcess = proc;

    proc.on("error", (err) => {
      console.error(`  ✗ server error: ${err.message}`);
      if (serverProcess === proc) serverProcess = null;
    });

    proc.on("exit", (code, signal) => {
      /* Only warn on truly unexpected exits — not intentional kills */
      if (serverProcess === proc && signal !== "SIGTERM" && signal !== "SIGINT" && code !== 0) {
        console.error(`  ✗ server exited (code: ${code}, signal: ${signal})`);
      }
      if (serverProcess === proc) serverProcess = null;
    });
  }

  function waitForExit(proc, timeoutMs = 2000) {
    if (!proc) return Promise.resolve();
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (resolved) return;
        /* Process did not exit in time — force kill */
        try { proc.kill("SIGKILL"); } catch (_) {}
        done();
      }, timeoutMs);
      proc.once("exit", done);
      proc.once("close", done);
      proc.once("error", done);
    });
  }

  /* ---- Watch for changes ---- */
  const watchPaths = [
    path.join(projectDir, "routes"),
    path.join(projectDir, "public"),
    path.join(projectDir, "cerver.config.js"),
  ].filter((p) => fs.existsSync(p));

  const watcher = chokidar.watch(watchPaths, {
    ignored: [/(^|[\/\\])\./ /* dotfiles */, /node_modules/, /dist/],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  /* Debounce: collect changes for 300ms before rebuilding */
  let debounceTimer = null;

  function scheduleRebuild(changedPath) {
    const rel = path.relative(projectDir, changedPath);
    console.log(`  ⟐ changed: ${rel}`);

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      rebuild();
    }, 300);
  }

  watcher
    .on("change", scheduleRebuild)
    .on("add", scheduleRebuild)
    .on("unlink", scheduleRebuild);

  /* ---- Graceful shutdown ---- */
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n  cerver dev: shutting down...");
    watcher.close();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      await waitForExit(serverProcess);
    }
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  /* ---- Start ---- */
  console.log("\n  cerver dev — watching for changes\n");
  await rebuild();
}

module.exports = { dev };
