"use strict";

const fs   = require("fs");
const path = require("path");
const { minifyContent } = require("./minify");

/**
 * Copy all static assets from publicDir to destDir, preserving directory
 * structure. If shouldMinify is true, HTML/CSS/JS files are minified
 * in-memory before writing (original files are untouched).
 *
 * @param {string} publicDir   - Absolute path to public/
 * @param {string} destDir     - Absolute path to the destination (dist/public/)
 * @param {boolean} shouldMinify - Whether to minify text assets
 * @returns {Promise<number>}  - Number of files copied
 */
async function copyAssets(publicDir, destDir, shouldMinify) {
  if (!fs.existsSync(publicDir)) {
    return 0;
  }

  fs.mkdirSync(destDir, { recursive: true });

  let count = 0;

  async function walk(srcDir, dstDir) {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; /* skip dotfiles */

      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);

      if (entry.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true });
        await walk(srcPath, dstPath);
        continue;
      }

      const ext     = path.extname(entry.name).toLowerCase();
      let   content = fs.readFileSync(srcPath);

      if (shouldMinify) {
        content = await minifyContent(content, ext);
      }

      fs.writeFileSync(dstPath, content);
      count++;
    }
  }

  await walk(publicDir, destDir);
  return count;
}

module.exports = { copyAssets };
