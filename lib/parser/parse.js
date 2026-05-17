"use strict";

const acorn = require("acorn");
const fs = require("fs");

/**
 * Parse a JavaScript file into an ESTree AST using Acorn.
 *
 * @param {string} filePath - Absolute path to the .js file
 * @returns {{ ast: object, source: string }}
 */
function parseFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8");

  try {
    const ast = acorn.parse(source, {
      ecmaVersion: 2020,
      sourceType: "module",
      locations: true, /* line/column info for error reporting */
    });

    return { ast, source };
  } catch (err) {
    const loc = err.loc
      ? `${filePath}:${err.loc.line}:${err.loc.column}`
      : filePath;
    throw new Error(`cerver: parse error at ${loc} — ${err.message}`);
  }
}

/**
 * Parse a source string directly (for testing / config parsing).
 */
function parseSource(source, filename) {
  try {
    const ast = acorn.parse(source, {
      ecmaVersion: 2020,
      sourceType: "module",
      locations: true,
    });
    return { ast, source };
  } catch (err) {
    const loc = err.loc
      ? `${filename || "<source>"}:${err.loc.line}:${err.loc.column}`
      : filename || "<source>";
    throw new Error(`cerver: parse error at ${loc} — ${err.message}`);
  }
}

module.exports = { parseFile, parseSource };
