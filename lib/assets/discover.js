"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Discover all static assets in the public/ directory.
 *
 * @param {string} publicDir - Absolute path to public/
 * @returns {Array<{ filePath: string, servePath: string, ext: string, size: number }>}
 */
function discoverAssets(publicDir) {
  const assets = [];

  if (!fs.existsSync(publicDir)) {
    return assets;
  }

  function walk(dir, prefix) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath, prefix + "/" + entry.name);
        continue;
      }

      if (entry.name.startsWith(".")) continue; /* skip dotfiles */

      const stat = fs.statSync(fullPath);
      const servePath = prefix + "/" + entry.name;
      const ext = path.extname(entry.name).toLowerCase();

      assets.push({
        filePath: fullPath,
        servePath,
        ext,
        size: stat.size,
      });
    }
  }

  walk(publicDir, "");

  return assets;
}

module.exports = { discoverAssets };
