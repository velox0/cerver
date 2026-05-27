"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  port: 8080,
  embed: true,
  minify: true,
  compression: "none",
  threads: 4,
  compile: {
    cc: null,
    output: null,
    target: null,
    targetOs: null,
    targetArch: null,
    sysroot: null,
    cflags: "",
    ldflags: "",
    lto: true,
    marchNative: undefined,
    compileInfo: false,
  },
};

/**
 * Load cerver.config.js from the project root.
 * Falls back to defaults for any missing fields.
 */
function loadConfig(projectDir) {
  const configPath = path.join(projectDir, "cerver.config.js");
  let userConfig = {};

  if (fs.existsSync(configPath)) {
    // Read the config file and evaluate it
    const raw = fs.readFileSync(configPath, "utf8");

    // Support both `module.exports = { ... }` and `export default { ... }`
    // We transpile the export default form to module.exports for eval
    const normalized = raw.replace(/export\s+default\s+/, "module.exports = ");

    // Create a mini-module context to evaluate the config
    const mod = { exports: {} };
    const fn = new Function("module", "exports", normalized);
    fn(mod, mod.exports);
    userConfig = mod.exports;
  }

  if (
    userConfig.compile !== undefined &&
    (typeof userConfig.compile !== "object" ||
      userConfig.compile === null ||
      Array.isArray(userConfig.compile))
  ) {
    throw new Error("cerver: compile config must be an object");
  }

  const config = { ...DEFAULTS, ...userConfig };
  if (userConfig.compile) {
    config.compile = { ...DEFAULTS.compile, ...userConfig.compile };
  }

  // Validate
  if (
    typeof config.port !== "number" ||
    config.port < 1 ||
    config.port > 65535
  ) {
    throw new Error(`cerver: invalid port ${config.port}`);
  }
  if (!["none", "gzip", "brotli", "both"].includes(config.compression)) {
    throw new Error(`cerver: unsupported compression "${config.compression}"`);
  }
  if (
    !Number.isInteger(config.threads) ||
    config.threads < 1 ||
    config.threads > 64
  ) {
    throw new Error(
      `cerver: invalid thread count ${config.threads} (must be 1-64)`,
    );
  }

  const compile = config.compile || {};
  if (
    compile.cc !== null &&
    compile.cc !== undefined &&
    typeof compile.cc !== "string"
  ) {
    throw new Error("cerver: compile.cc must be a string");
  }
  if (
    compile.output !== null &&
    compile.output !== undefined &&
    typeof compile.output !== "string"
  ) {
    throw new Error("cerver: compile.output must be a string");
  }
  if (typeof compile.output === "string" && !compile.output.trim()) {
    throw new Error("cerver: compile.output must be a non-empty string");
  }
  if (
    compile.target !== null &&
    compile.target !== undefined &&
    typeof compile.target !== "string"
  ) {
    throw new Error("cerver: compile.target must be a string");
  }
  if (
    compile.targetOs !== null &&
    compile.targetOs !== undefined &&
    typeof compile.targetOs !== "string"
  ) {
    throw new Error("cerver: compile.targetOs must be a string");
  }
  if (
    compile.targetArch !== null &&
    compile.targetArch !== undefined &&
    typeof compile.targetArch !== "string"
  ) {
    throw new Error("cerver: compile.targetArch must be a string");
  }
  if (
    compile.sysroot !== null &&
    compile.sysroot !== undefined &&
    typeof compile.sysroot !== "string"
  ) {
    throw new Error("cerver: compile.sysroot must be a string");
  }
  if (
    compile.cflags !== null &&
    compile.cflags !== undefined &&
    typeof compile.cflags !== "string" &&
    !Array.isArray(compile.cflags)
  ) {
    throw new Error("cerver: compile.cflags must be a string or array");
  }
  if (
    compile.ldflags !== null &&
    compile.ldflags !== undefined &&
    typeof compile.ldflags !== "string" &&
    !Array.isArray(compile.ldflags)
  ) {
    throw new Error("cerver: compile.ldflags must be a string or array");
  }
  if (compile.lto !== undefined && typeof compile.lto !== "boolean") {
    throw new Error("cerver: compile.lto must be a boolean");
  }
  if (
    compile.marchNative !== undefined &&
    typeof compile.marchNative !== "boolean"
  ) {
    throw new Error("cerver: compile.marchNative must be a boolean");
  }
  if (
    compile.compileInfo !== undefined &&
    typeof compile.compileInfo !== "boolean"
  ) {
    throw new Error("cerver: compile.compileInfo must be a boolean");
  }

  return config;
}

function findProjectRoot(startDir = process.cwd()) {
  let currentDir = startDir;

  while (true) {
    if (fs.existsSync(path.join(currentDir, "cerver.config.js"))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

module.exports = { loadConfig, findProjectRoot, DEFAULTS };
