"use strict";

const fs = require("fs");
const path = require("path");
const { minifyContent } = require("./minify");

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
 * @returns {Promise<string>} - C source code
 */
async function generateEmbeddedAssets(assets, shouldMinify) {
  const lines = [];

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

    /* Generate the byte array */
    lines.push(`static const unsigned char ${name}[] = {`);
    lines.push(bufferToHexArray(content));
    lines.push("};");
    lines.push(
      `static const unsigned int ${name}_len = ${content.length};`
    );
    lines.push("");

    assetEntries.push({ name, servePath: asset.servePath, mime });
  }

  /* Generate the asset table */
  lines.push("static cerver_asset_t cerver_embedded_assets[] = {");
  for (const entry of assetEntries) {
    lines.push(
      `    { "${entry.servePath}", "${entry.mime}", ${entry.name}, ${entry.name}_len },`
    );
  }
  lines.push("};");
  lines.push(
    `static const int cerver_embedded_asset_count = ${assetEntries.length};`
  );

  return lines.join("\n");
}

module.exports = { generateEmbeddedAssets, varName, mimeFromExt };
