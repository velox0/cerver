"use strict";

const { cString, handlerName } = require("./emit");

/**
 * Generate a compile-time dispatch function that avoids the generic router.
 *
 * For static routes: method check → length check → memcmp (known lengths).
 * For dynamic routes: segment-count check → per-segment inline comparisons.
 *
 * Falls through to generic router for unmatched paths.
 *
 * @param {IRRoute[]} routes - All IR routes
 * @returns {string} - C source for cerver_generated_dispatch()
 */
function generateDispatch(routes) {
  const lines = [];

  /* Separate static and dynamic routes */
  const staticRoutes = routes.filter((r) => !r.urlPath.includes(":"));
  const dynamicRoutes = routes.filter((r) => r.urlPath.includes(":"));

  /* Forward declarations for handler functions */
  lines.push("/* ---- Generated Fast Dispatch ---- */");
  lines.push("");

  /* Group static routes by method */
  const byMethod = {};
  for (const route of staticRoutes) {
    if (!byMethod[route.method]) byMethod[route.method] = [];
    byMethod[route.method].push(route);
  }

  /* Group dynamic routes by method */
  const dynByMethod = {};
  for (const route of dynamicRoutes) {
    if (!dynByMethod[route.method]) dynByMethod[route.method] = [];
    dynByMethod[route.method].push(route);
  }

  /* Generate the dispatch function */
  lines.push(
    "cerver_handler_fn cerver_generated_dispatch(cerver_request_t *req) {"
  );
  lines.push("    const char *path = req->path;");
  if (staticRoutes.length > 0) {
    lines.push("    size_t path_len = 0;");
    lines.push("    { const char *p = path; while (*p) { path_len++; p++; } }");
  }
  lines.push("");

  const allMethods = new Set([
    ...Object.keys(byMethod),
    ...Object.keys(dynByMethod),
  ]);

  let firstMethod = true;
  for (const method of allMethods) {
    const methodStatic = byMethod[method] || [];
    const methodDynamic = dynByMethod[method] || [];

    /* Method check */
    const methodLen = method.length;
    lines.push(
      `    ${firstMethod ? "" : "} else "}if (req->method[0] == '${method[0]}' && memcmp(req->method, ${cString(method)}, ${methodLen + 1}) == 0) {`
    );
    firstMethod = false;

    /* ---- Static routes: group by path length for fast rejection ---- */
    if (methodStatic.length > 0) {
      /* Group by length */
      const byLength = {};
      for (const route of methodStatic) {
        const len = route.urlPath.length;
        if (!byLength[len]) byLength[len] = [];
        byLength[len].push(route);
      }

      lines.push("        /* Static routes */");

      const lengths = Object.keys(byLength)
        .map(Number)
        .sort((a, b) => a - b);

      for (const len of lengths) {
        const routesAtLen = byLength[len];

        lines.push(`        if (path_len == ${len}) {`);

        for (const route of routesAtLen) {
          const name = handlerName(route.method, route.urlPath);
          if (route.urlPath === "/") {
            lines.push(
              `            if (path[0] == '/' && path[1] == '\\0') return ${name};`
            );
          } else {
            lines.push(
              `            if (memcmp(path, ${cString(route.urlPath)}, ${len}) == 0) return ${name};`
            );
          }
        }

        lines.push("        }");
      }
    }

    /* ---- Dynamic routes: inline segment matching ---- */
    if (methodDynamic.length > 0) {
      lines.push("");
      lines.push("        /* Dynamic routes */");

      for (const route of methodDynamic) {
        const segments = route.urlPath.split("/").filter(Boolean);
        const name = handlerName(route.method, route.urlPath);

        lines.push("        {");
        lines.push(`            /* ${route.urlPath} */`);
        lines.push(`            const char *p = path;`);
        lines.push(`            if (*p == '/') p++;`);
        lines.push(`            int match = 1;`);

        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i];
          const isLast = i === segments.length - 1;

          if (seg.startsWith(":")) {
            const paramName = seg.slice(1);
            /* Dynamic segment: find the segment boundaries */
            lines.push(`            const char *seg${i}_start = p;`);
            lines.push(`            while (*p && *p != '/') p++;`);
            lines.push(`            size_t seg${i}_len = (size_t)(p - seg${i}_start);`);
            lines.push(`            if (seg${i}_len == 0) match = 0;`);

            if (!isLast) {
              lines.push(`            if (match && *p == '/') p++; else match = 0;`);
            }
          } else {
            /* Static segment: compare directly */
            const segLen = seg.length;
            lines.push(
              `            if (match && memcmp(p, ${cString(seg)}, ${segLen}) == 0 && (p[${segLen}] == '/' || p[${segLen}] == '\\0')) {`
            );
            lines.push(`                p += ${segLen};`);
            lines.push(`                if (*p == '/') p++;`);
            lines.push(`            } else { match = 0; }`);
          }
        }

        /* Ensure path is fully consumed */
        lines.push(`            if (match && *p != '\\0') match = 0;`);

        /* Extract params on match */
        lines.push(`            if (match) {`);

        /* Re-iterate to set params */
        let paramIdx = 0;
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i];
          if (seg.startsWith(":")) {
            const paramName = seg.slice(1);
            lines.push(
              `                req->params[req->params_count].key = ${cString(paramName)};`
            );
            lines.push(
              `                req->params[req->params_count].value = seg${i}_start;`
            );
            lines.push(
              `                ((char*)seg${i}_start)[seg${i}_len] = '\\0';`
            );
            lines.push(`                req->params_count++;`);
            paramIdx++;
          }
        }

        lines.push(`                return ${name};`);
        lines.push(`            }`);
        lines.push(`        }`);
      }
    }
  }

  if (!firstMethod) {
    lines.push("    }");
  }

  lines.push("");
  lines.push("    return NULL; /* No match — fall through to generic router */");
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

module.exports = { generateDispatch };
