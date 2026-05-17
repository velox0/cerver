"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  port: 8080,
  embed: true,
  minify: true,
  compression: "none",
  threads: 4,
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
    const normalized = raw.replace(
      /export\s+default\s+/,
      "module.exports = "
    );

    // Create a mini-module context to evaluate the config
    const mod = { exports: {} };
    const fn = new Function("module", "exports", normalized);
    fn(mod, mod.exports);
    userConfig = mod.exports;
  }

  const config = { ...DEFAULTS, ...userConfig };

  // Validate
  if (typeof config.port !== "number" || config.port < 1 || config.port > 65535) {
    throw new Error(`cerver: invalid port ${config.port}`);
  }
  if (!["none", "gzip", "brotli", "both"].includes(config.compression)) {
    throw new Error(`cerver: unsupported compression "${config.compression}"`);
  }
  if (!Number.isInteger(config.threads) || config.threads < 1 || config.threads > 64) {
    throw new Error(`cerver: invalid thread count ${config.threads} (must be 1-64)`);
  }

  return config;
}

module.exports = { loadConfig, DEFAULTS };
