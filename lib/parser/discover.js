"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Discover route files under routes/ and map them to URL paths.
 *
 * File-based routing convention:
 *   routes/index.js      → /
 *   routes/page.js       → /page
 *   routes/group/item.js → /group/item
 *   routes/item/[id].js  → /item/:id
 *
 * @param {string} routesDir - Absolute path to routes/
 * @returns {Array<{ filePath: string, urlPath: string }>}
 */
function discoverRoutes(routesDir) {
  const routes = [];

  if (!fs.existsSync(routesDir)) {
    return routes;
  }

  function walk(dir, prefix) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath, prefix + "/" + entry.name);
        continue;
      }

      if (!entry.name.endsWith(".js")) continue;

      /* Build the URL path from the file path */
      let urlPath;
      const basename = entry.name.replace(/\.js$/, "");

      if (basename === "index") {
        urlPath = prefix || "/";
      } else {
        urlPath = prefix + "/" + basename;
      }

      /* Convert [param] to :param for dynamic segments */
      urlPath = urlPath.replace(/\[([^\]]+)\]/g, ":$1");

      /* Normalize double slashes */
      urlPath = urlPath.replace(/\/+/g, "/");

      routes.push({
        filePath: fullPath,
        urlPath,
      });
    }
  }

  walk(routesDir, "");

  /* Sort: static routes before dynamic ones for predictable matching */
  routes.sort((a, b) => {
    const aDynamic = a.urlPath.includes(":");
    const bDynamic = b.urlPath.includes(":");
    if (aDynamic !== bDynamic) return aDynamic ? 1 : -1;
    return a.urlPath.localeCompare(b.urlPath);
  });

  return routes;
}

module.exports = { discoverRoutes };
