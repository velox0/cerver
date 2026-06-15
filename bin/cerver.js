#!/usr/bin/env node

"use strict";

const { Command } = require("commander");
const pkg = require("../package.json");

const program = new Command();

function restoreTty() {
  const stdin = process.stdin;
  if (!stdin || !stdin.isTTY || typeof stdin.setRawMode !== "function") return;
  if (!stdin.isRaw) return;
  try {
    stdin.setRawMode(false);
  } catch (_) {}
}

process.on("exit", restoreTty);

program
  .name("cerver")
  .description("Compile restricted JavaScript into native C server binaries")
  .version(pkg.version);

program
  .command("new <name>")
  .description("Create a new cerver project")
  .action((name) => {
    const { newProject } = require("../lib/commands/new");
    newProject(name);
  });

program
  .command("build")
  .description("Compile the project into a native binary")
  .option("--embed", "Embed static assets into the binary", true)
  .option("--no-embed", "Serve static assets from the filesystem")
  .option("--static", "Produce a statically linked binary")
  .option("--no-minify", "Skip asset minification")
  .option(
    "--cc <compiler>",
    "C compiler to use (e.g., clang, x86_64-linux-gnu-gcc)",
  )
  .option("--target <triple>", "Target triple (e.g., x86_64-linux-gnu)")
  .option("--target-os <os>", "Target OS (e.g., linux, darwin)")
  .option("--target-arch <arch>", "Target architecture (e.g., x86_64, arm64)")
  .option("--sysroot <path>", "Sysroot path for cross-compiling")
  .option("--cflags <flags>", "Extra C compiler flags")
  .option("--ldflags <flags>", "Extra linker flags")
  .option("-o, --output <path>", "Output binary path (default: dist/server)")
  .option("--compile-info", "Print the compiler command")
  .action((opts) => {
    const { build } = require("../lib/commands/build");
    build(opts);
  });

program
  .command("dev")
  .description("Watch for changes, auto-rebuild, and restart the server")
  .option("-p, --port <port>", "Override the port")
  .option("--no-embed", "Serve static assets from the filesystem")
  .action((opts) => {
    const { dev } = require("../lib/commands/dev");
    dev(opts);
  });

program
  .command("run")
  .description("Run the compiled binary")
  .option("-p, --port <port>", "Override the port")
  .action((opts) => {
    const { run } = require("../lib/commands/run");
    run(opts);
  });

program
  .command("package")
  .description("Bundle the compiled binary and assets into a deployable package (dist/package/)")
  .option("-o, --output <path>", "Output directory (default: dist/package)")
  .action((opts) => {
    const { pkg } = require("../lib/commands/package");
    pkg(opts);
  });

program.parse();
