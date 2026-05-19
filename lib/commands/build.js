"use strict";

const fs = require("fs");
const path = require("path");

const { loadConfig } = require("../config");
const { discoverRoutes } = require("../parser/discover");
const { parseFile } = require("../parser/parse");
const { validate } = require("../validator/validate");
const { transformFile } = require("../ir/transform");
const { generateServer } = require("../codegen/generator");
const { discoverAssets } = require("../assets/discover");
const { generateEmbeddedAssets } = require("../assets/embed");
const { compile: compileC } = require("../compiler/compile");

/**
 * Full build pipeline: parse → validate → IR → codegen → compile
 */
async function build(opts) {
  const projectDir = process.cwd();
  const startTime = Date.now();

  console.log("\n  cerver build\n");

  /* ---- 1. Load config ---- */
  console.log("  → loading config...");
  const config = loadConfig(projectDir);

  /* CLI overrides */
  if (opts.embed !== undefined) config.embed = opts.embed;
  if (opts.minify === false) config.minify = false;

  console.log(
    `    port: ${config.port}, embed: ${config.embed}, minify: ${config.minify}`
  );

  /* ---- 2. Discover routes ---- */
  let routesDir = path.join(projectDir, "routes");
  if (!fs.existsSync(routesDir)) {
    routesDir = path.join(projectDir, "app", "routes");
  }
  console.log("  → discovering routes...");
  const routeFiles = discoverRoutes(routesDir);

  if (routeFiles.length === 0) {
    console.warn(`  ⚠ no route files found in ${path.relative(projectDir, routesDir)}/`);
  } else {
    for (const r of routeFiles) {
      console.log(`    ${r.urlPath} ← ${path.relative(projectDir, r.filePath)}`);
    }
  }

  /* ---- 3. Parse & validate ---- */
  console.log("  → parsing and validating...");
  const allRoutes = [];

  for (const routeFile of routeFiles) {
    const { ast, source } = parseFile(routeFile.filePath);
    validate(ast, routeFile.filePath, source);

    const irRoutes = transformFile(ast, routeFile.urlPath);
    allRoutes.push(...irRoutes);
  }

  console.log(`    ${allRoutes.length} handler(s) compiled`);

  /* ---- 4. Asset pipeline ---- */
  let assetsCode = null;

  if (config.embed) {
    const publicDir = path.join(projectDir, "public");
    console.log("  → embedding assets...");
    const assets = discoverAssets(publicDir);

    if (assets.length > 0) {
      let totalSize = 0;
      for (const a of assets) {
        totalSize += a.size;
        console.log(
          `    ${a.servePath} (${(a.size / 1024).toFixed(1)} KB)`
        );
      }

      assetsCode = await generateEmbeddedAssets(assets, config.minify, config.compression);
      console.log(
        `    ${assets.length} asset(s), ${(totalSize / 1024).toFixed(1)} KB total` +
          (config.compression !== "none" ? ` (${config.compression} compressed)` : "")
      );
    } else {
      console.log("    no assets found in public/");
    }
  }

  /* ---- 5. Generate C source ---- */
  console.log("  → generating C source...");
  const { serverC, routesC } = generateServer(allRoutes, config, !!assetsCode);

  /* Write to dist/ */
  const distDir = path.join(projectDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });

  const serverCPath = path.join(distDir, "server.c");
  fs.writeFileSync(serverCPath, serverC);
  console.log(`    wrote ${(serverC.length / 1024).toFixed(1)} KB → dist/server.c`);

  const routesCPath = path.join(distDir, "routes.c");
  fs.writeFileSync(routesCPath, routesC);
  console.log(`    wrote ${(routesC.length / 1024).toFixed(1)} KB → dist/routes.c`);

  const assetsCPath = path.join(distDir, "assets.c");
  if (assetsCode) {
    fs.writeFileSync(assetsCPath, assetsCode);
    console.log(`    wrote ${(assetsCode.length / 1024).toFixed(1)} KB → dist/assets.c`);
  } else {
    if (fs.existsSync(assetsCPath)) {
      fs.unlinkSync(assetsCPath);
    }
  }

  /* ---- 6. Copy runtime headers ---- */
  const runtimeDir = path.join(__dirname, "..", "..", "runtime");

  /* Copy cerver.h to dist/ so the generated server.c can include it */
  fs.copyFileSync(
    path.join(runtimeDir, "cerver.h"),
    path.join(distDir, "cerver.h")
  );

  /* ---- 7. Compile ---- */
  console.log("  → compiling...");
  const binaryPath = compileC(distDir, runtimeDir, { static: opts.static });

  /* ---- Done ---- */
  const elapsed = Date.now() - startTime;
  console.log(`\n  ✓ build complete in ${elapsed}ms`);
  console.log(`    binary: ${path.relative(projectDir, binaryPath)}`);
  console.log(`    run with: cerver run\n`);
}

module.exports = { build };
