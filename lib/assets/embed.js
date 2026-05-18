"use strict";

const fs = require("fs");
const path = require("path");
const { minifyContent } = require("./minify");
const { compressContent, isCompressible } = require("./compress");

/**
 * MIME type lookup for embedding.
 */
const MIME_MAP = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".xml": "application/xml",
  ".md": "text/markdown; charset=utf-8",
};

function mimeFromExt(ext) {
  return MIME_MAP[ext] || "application/octet-stream";
}

/**
 * Convert a serve path to a C-safe variable name.
 * e.g. "/static/styles.css" → "asset_static_styles_css"
 */
function varName(servePath) {
  return (
    "asset_" +
    servePath
      .replace(/^\//, "")
      .replace(/[^a-zA-Z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/_$/, "")
  );
}

/**
 * Convert a buffer to a C hex byte array string.
 * e.g. { 0x3c, 0x21, 0x44, ... }
 */
function bufferToHexArray(buf) {
  const lines = [];
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.slice(i, Math.min(i + 16, buf.length));
    const hex = Array.from(slice)
      .map((b) => "0x" + b.toString(16).padStart(2, "0"))
      .join(", ");
    lines.push("  " + hex + ",");
  }
  return lines.join("\n");
}

/**
 * Generate C source code for embedded assets.
 *
 * @param {Array<{ filePath: string, servePath: string, ext: string }>} assets
 * @param {boolean} shouldMinify - Whether to minify text assets
 * @param {string} compression - "none" | "gzip" | "brotli" | "both"
 * @returns {Promise<string>} - C source code
 */
async function generateEmbeddedAssets(assets, shouldMinify, compression) {
  const lines = [];
  const algo = compression || "none";

  lines.push("/* Auto-generated embedded assets — do not edit */");
  lines.push("");

  const assetEntries = [];

  for (const asset of assets) {
    let content = fs.readFileSync(asset.filePath);

    /* Minify if applicable */
    if (shouldMinify) {
      content = await minifyContent(content, asset.ext);
    }

    const name = varName(asset.servePath);
    const mime = mimeFromExt(asset.ext);

    /* Generate the raw byte array */
    lines.push(`static const unsigned char ${name}[] = {`);
    lines.push(bufferToHexArray(content));
    lines.push("};");
    lines.push(
      `static const unsigned int ${name}_len = ${content.length};`
    );
    lines.push("");

    /* Generate compressed variants if the content is compressible */
    let gzName = "NULL";
    let gzLen = "0";
    let brName = "NULL";
    let brLen = "0";

    if (isCompressible(mime) && algo !== "none" && content.length > 256) {
      if (algo === "gzip" || algo === "both") {
        const gzData = await compressContent(content, "gzip");
        /* Only embed if compression actually saves space */
        if (gzData.length < content.length * 0.9) {
          gzName = `${name}_gz`;
          gzLen = `${name}_gz_len`;
          lines.push(`static const unsigned char ${gzName}[] = {`);
          lines.push(bufferToHexArray(gzData));
          lines.push("};");
          lines.push(
            `static const unsigned int ${gzLen} = ${gzData.length};`
          );
          lines.push("");
        }
      }

      if (algo === "brotli" || algo === "both") {
        const brData = await compressContent(content, "brotli");
        if (brData.length < content.length * 0.9) {
          brName = `${name}_br`;
          brLen = `${name}_br_len`;
          lines.push(`static const unsigned char ${brName}[] = {`);
          lines.push(bufferToHexArray(brData));
          lines.push("};");
          lines.push(
            `static const unsigned int ${brLen} = ${brData.length};`
          );
          lines.push("");
        }
      }
    }

    assetEntries.push({
      name,
      servePath: asset.servePath,
      mime,
      gzName,
      gzLen,
      brName,
      brLen,
    });

    /* Auto-alias: /any/path/index.html → /any/path */
    if (asset.servePath.endsWith("/index.html")) {
      const dirPath = asset.servePath === "/index.html"
        ? "/"
        : asset.servePath.slice(0, -"/index.html".length);
      assetEntries.push({
        name,
        servePath: dirPath,
        mime,
        gzName,
        gzLen,
        brName,
        brLen,
      });
    }
  }

  /* Generate the asset table */
  lines.push("static cerver_asset_t cerver_embedded_assets[] = {");
  for (const entry of assetEntries) {
    lines.push(
      `    { "${entry.servePath}", "${entry.mime}", ` +
        `${entry.name}, ${entry.name}_len, ` +
        `${entry.gzName}, ${entry.gzLen}, ` +
        `${entry.brName}, ${entry.brLen}, ` +
        `NULL, 0 },`
    );
  }
  lines.push("};");
  lines.push(
    `static const int cerver_embedded_asset_count = ${assetEntries.length};`
  );

  return lines.join("\n");
}

module.exports = { generateEmbeddedAssets, varName, mimeFromExt };
