"use strict";

const { cString, handlerName } = require("./emit");

/**
 * Generate the static route dispatch table as C source.
 *
 * @param {IRRoute[]} routes - All routes to include
 * @returns {string} - C source for the route table
 */
function generateRouteTable(routes) {
  const lines = [];

  lines.push("/* Auto-generated route table — do not edit */");
  lines.push("");

  /* Forward declarations */
  for (const route of routes) {
    const name = handlerName(route.method, route.urlPath);
    lines.push(
      `static void ${name}(cerver_request_t *req, cerver_response_t *res);`
    );
  }

  lines.push("");

  /* Route table array */
  lines.push("cerver_route_t cerver_routes[] = {");
  for (const route of routes) {
    const name = handlerName(route.method, route.urlPath);
    lines.push(
      `    { ${cString(route.method)}, ${cString(route.urlPath)}, ${name} },`
    );
  }
  lines.push("};");
  lines.push(
    `const int cerver_route_count = ${routes.length};`
  );
  lines.push("");

  return lines.join("\n");
}

module.exports = { generateRouteTable };
