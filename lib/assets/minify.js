"use strict";

const fs = require("fs");

/**
 * Minify assets using available tools.
 *
 * Falls back gracefully if minification packages aren't installed.
 * Minification is done in-memory — original files are not modified.
 *
 * @param {Buffer} content - File content
 * @param {string} ext - File extension (e.g. ".html", ".css", ".js")
 * @returns {Buffer} - Minified content (or original if minification unavailable)
 */
async function minifyContent(content, ext) {
  const source = content.toString("utf8");

  try {
    switch (ext) {
      case ".html":
      case ".htm": {
        try {
          const { minify } = require("html-minifier-terser");
          const result = await minify(source, {
            collapseWhitespace: true,
            removeComments: true,
            removeRedundantAttributes: true,
            removeEmptyAttributes: true,
            minifyCSS: true,
            minifyJS: true,
          });
          return Buffer.from(result, "utf8");
        } catch {
          /* html-minifier-terser not installed — skip */
          return content;
        }
      }

      case ".css": {
        try {
          const { transform } = require("lightningcss");
          const result = transform({
            filename: "style.css",
            code: content,
            minify: true,
          });
          return Buffer.from(result.code);
        } catch {
          /* lightningcss not installed — try basic minification */
          const minified = source
            .replace(/\/\*[\s\S]*?\*\//g, "")  /* remove comments */
            .replace(/\s+/g, " ")               /* collapse whitespace */
            .replace(/\s*([{}:;,])\s*/g, "$1")  /* remove space around symbols */
            .trim();
          return Buffer.from(minified, "utf8");
        }
      }

      case ".js":
      case ".mjs": {
        try {
          const { minify } = require("terser");
          const result = await minify(source);
          if (result.code) {
            return Buffer.from(result.code, "utf8");
          }
          return content;
        } catch {
          /* terser not installed — skip */
          return content;
        }
      }

      default:
        return content;
    }
  } catch {
    /* If minification fails for any reason, return original */
    return content;
  }
}

module.exports = { minifyContent };
