"use strict";

const zlib = require("zlib");

/**
 * Compress content using gzip or brotli.
 *
 * Uses Node.js built-in zlib — no external dependencies needed.
 *
 * @param {Buffer} content - Raw content to compress
 * @param {"gzip"|"brotli"} algorithm - Compression algorithm
 * @returns {Promise<Buffer>} - Compressed content
 */
function compressContent(content, algorithm) {
  return new Promise((resolve, reject) => {
    if (algorithm === "gzip") {
      zlib.gzip(content, { level: 9 }, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    } else if (algorithm === "brotli") {
      zlib.brotliCompress(
        content,
        {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]:
              zlib.constants.BROTLI_MAX_QUALITY,
          },
        },
        (err, result) => {
          if (err) reject(err);
          else resolve(result);
        }
      );
    } else {
      resolve(content);
    }
  });
}

/**
 * Check if a MIME type is worth compressing.
 * Binary formats like PNG, JPEG, WOFF2 are already compressed.
 */
function isCompressible(mime) {
  return (
    mime.startsWith("text/") ||
    mime.includes("javascript") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    mime.includes("svg")
  );
}

module.exports = { compressContent, isCompressible };
