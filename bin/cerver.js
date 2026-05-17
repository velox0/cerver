#!/usr/bin/env node

"use strict";

const { Command } = require("commander");
const pkg = require("../package.json");

const program = new Command();

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

program.parse();
