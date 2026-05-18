"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const chokidar = require("chokidar");
const { build } = require("./build");

/**
 * Dev mode: watch for changes, auto-rebuild, auto-restart.
 */
async function dev(opts) {
  const projectDir = process.cwd();
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
      serverProcess.kill("SIGTERM");
      serverProcess = null;
      /* Small delay for port release */
      await new Promise((r) => setTimeout(r, 200));
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

    serverProcess = spawn(binaryPath, [], {
      stdio: "inherit",
      env,
      cwd: projectDir,
    });

    serverProcess.on("error", (err) => {
      console.error(`  ✗ server error: ${err.message}`);
      serverProcess = null;
    });

    serverProcess.on("exit", (code, signal) => {
      if (signal !== "SIGTERM" && signal !== "SIGINT") {
        console.error(`  ✗ server exited (code: ${code}, signal: ${signal})`);
      }
      serverProcess = null;
    });
  }

  function waitForExit(proc) {
    if (!proc) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      proc.once("exit", done);
      proc.once("close", done);
      proc.once("error", done);
    });
  }

  /* ---- Watch for changes ---- */
  const watchPaths = [
    path.join(projectDir, "app"),
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
