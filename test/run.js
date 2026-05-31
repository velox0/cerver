"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const { discoverAssets } = require("../lib/assets/discover");
const { compressContent, isCompressible } = require("../lib/assets/compress");
const {
  generateEmbeddedAssets,
  mimeFromExt,
  varName,
} = require("../lib/assets/embed");
const { minifyContent } = require("../lib/assets/minify");
const {
  cString,
  emitExpression,
  emitStatement,
  handlerName,
} = require("../lib/codegen/emit");
const { generateRouteTable } = require("../lib/codegen/route_table");
const { loadConfig, findProjectRoot } = require("../lib/config");
const IR = require("../lib/ir/types");
const { transformFile } = require("../lib/ir/transform");
const { discoverRoutes } = require("../lib/parser/discover");
const { parseSource } = require("../lib/parser/parse");
const { validate } = require("../lib/validator/validate");

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cerver-test-"));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function parseAndValidate(source, filename = "route.js") {
  const { ast } = parseSource(source, filename);
  validate(ast, filename, source);
  return ast;
}

test("discoverRoutes maps file routes and sorts dynamic routes last", () => {
  const dir = tempDir();
  try {
    const routesDir = path.join(dir, "routes");
    writeFile(
      path.join(routesDir, "index.js"),
      "export function GET(req, res) {}",
    );
    writeFile(
      path.join(routesDir, "about.js"),
      "export function GET(req, res) {}",
    );
    writeFile(
      path.join(routesDir, "blog", "index.js"),
      "export function GET(req, res) {}",
    );
    writeFile(
      path.join(routesDir, "blog", "[slug].js"),
      "export function GET(req, res) {}",
    );
    writeFile(path.join(routesDir, "blog", "draft.txt"), "ignored");

    const routes = discoverRoutes(routesDir).map((route) => ({
      filePath: path.relative(routesDir, route.filePath),
      urlPath: route.urlPath,
    }));

    assert.deepEqual(routes, [
      { filePath: "index.js", urlPath: "/" },
      { filePath: "about.js", urlPath: "/about" },
      { filePath: path.join("blog", "index.js"), urlPath: "/blog" },
      { filePath: path.join("blog", "[slug].js"), urlPath: "/blog/:slug" },
    ]);
  } finally {
    cleanup(dir);
  }
});

test("discoverRoutes returns an empty list when the routes directory is missing", () => {
  const dir = tempDir();
  try {
    assert.deepEqual(discoverRoutes(path.join(dir, "missing")), []);
  } finally {
    cleanup(dir);
  }
});

test("validate accepts supported handler syntax", () => {
  const source = `
export function GET(req, res) {
  const id = req.params.id;
  if (id === "42") {
    return res.json(200, '{"ok":true}');
  }
  return res.text(404, "missing");
}
`;

  assert.doesNotThrow(() => parseAndValidate(source));
});

test("validate rejects unsupported HTTP methods and async handlers", () => {
  const badMethod = parseSource(
    "export function PUT(req, res) { return res.text(200, 'no'); }",
    "bad-method.js",
  );
  assert.throws(
    () => validate(badMethod.ast, "bad-method.js", badMethod.source),
    /exported function "PUT" is not a valid HTTP method/,
  );

  const asyncHandler = parseSource(
    "export async function GET(req, res) { await work(); return res.text(200, 'ok'); }",
    "async-route.js",
  );
  assert.throws(
    () => validate(asyncHandler.ast, "async-route.js", asyncHandler.source),
    /async functions are not supported[\s\S]*async\/await is not supported/,
  );
});

test("validate rejects multi-declarator variable declarations", () => {
  const source = parseSource(
    "export function GET(req, res) { const a = 1, b = 2; return res.text(200, 'ok'); }",
    "multi-decl.js",
  );

  assert.throws(
    () => validate(source.ast, "multi-decl.js", source.source),
    /multiple declarations in one statement are not supported/,
  );
});

test("transformFile produces route IR for params, query, headers, and template returns", () => {
  const source = `
export function GET(req, res) {
  const userId = req.params.id;
  if (req.query.preview === "true" && req.headers["x-mode"] !== "off") {
    return res.html(200, \`<h1>\${userId}</h1>\`);
  }
  return res.text(404, "missing");
}
`;
  const ast = parseAndValidate(source, "users.js");
  const routes = transformFile(ast, "/users/:id");

  assert.equal(routes.length, 1);
  assert.equal(routes[0].method, "GET");
  assert.equal(routes[0].urlPath, "/users/:id");
  assert.deepEqual(routes[0].params, ["id"]);

  const variable = routes[0].handler.variables[0];
  assert.equal(variable.name, "userId");
  assert.equal(variable.initExpr.type, "ParamAccess");
  assert.equal(variable.initExpr.paramName, "id");

  const [ifStmt, fallback] = routes[0].handler.body;
  assert.equal(ifStmt.type, "If");
  assert.equal(ifStmt.condition.type, "Logical");
  assert.equal(ifStmt.condition.left.left.type, "QueryAccess");
  assert.equal(ifStmt.condition.right.left.type, "HeaderAccess");
  assert.equal(ifStmt.thenBody[0].responseType, "html");
  assert.equal(ifStmt.thenBody[0].value.type, "Concat");
  assert.equal(fallback.status, 404);
});

test("transformFile preserves ternary alternate branches and request fields", () => {
  const source = `
export function GET(req, res) {
  const method = req.method;
  const ok = method === "GET" ? 1 : 0;
  return res.text(200, ok ? req.path : "other");
}
`;
  const ast = parseAndValidate(source, "ternary.js");
  const routes = transformFile(ast, "/ternary");

  const variable = routes[0].handler.variables[0];
  assert.equal(variable.initExpr.type, "RequestField");
  assert.equal(variable.initExpr.fieldName, "method");

  const numericTernary = routes[0].handler.variables[1];
  assert.equal(numericTernary.valueType, "number");
  assert.equal(numericTernary.initExpr.type, "Conditional");
  assert.equal(numericTernary.initExpr.alternate.value, 0);

  const returnValue = routes[0].handler.body[0].value;
  assert.equal(returnValue.type, "Conditional");
  assert.equal(returnValue.test.type, "Identifier");
  assert.equal(returnValue.consequent.type, "RequestField");
  assert.equal(returnValue.consequent.fieldName, "path");
  assert.equal(returnValue.alternate.type, "StringLiteral");
  assert.equal(returnValue.alternate.value, "other");
});

test("emit helpers escape C strings and map IR expressions", () => {
  assert.equal(cString('a"b\\c\n'), '"a\\"b\\\\c\\n"');
  assert.equal(handlerName("GET", "/"), "handle_GET_index");
  assert.equal(handlerName("POST", "/users/:id"), "handle_POST_users_id");

  const comparison = IR.IRComparison(
    "===",
    IR.IRParamAccess("id"),
    IR.IRStringLiteral("42"),
  );
  assert.equal(
    emitExpression(comparison),
    '(strcmp(cerver_req_param(req, "id"), "42") == 0)',
  );

  assert.deepEqual(
    emitStatement(IR.IRReturn("text", 201, IR.IRStringLiteral("created")), 1),
    ['    cerver_res_text(res, 201, "created");', "    return;"],
  );

  assert.equal(
    emitExpression(
      IR.IRConditional(
        IR.IRNumberLiteral(1),
        IR.IRStringLiteral("yes"),
        IR.IRStringLiteral("no"),
      ),
    ),
    '(1 ? "yes" : "no")',
  );
});

test("emit handles direct concat returns and rejects nested statement-only expressions", () => {
  const concatReturn = IR.IRReturn(
    "text",
    200,
    IR.IRConcat([IR.IRStringLiteral("hello "), IR.IRIdentifier("name")]),
  );
  const lines = emitStatement(concatReturn, 1);
  const joined = lines.join("\n");

  assert.doesNotMatch(joined, /__concat_/);
  assert.match(joined, /malloc\(1024\)/);
  assert.match(joined, /snprintf\(_concat_res_0, 1024, "hello %s", name\);/);
  assert.match(joined, /res->_body_owned = 1/);

  assert.throws(
    () =>
      emitExpression(
        IR.IRConcat([IR.IRStringLiteral("x"), IR.IRIdentifier("y")]),
      ),
    /template literal interpolation must be emitted in statement context/,
  );
});

test("generateRouteTable emits forward declarations, entries, and count", () => {
  const routes = [
    IR.IRRoute("GET", "/", [], IR.IRHandler([], [])),
    IR.IRRoute("POST", "/users/:id", ["id"], IR.IRHandler([], [])),
  ];

  const code = generateRouteTable(routes);

  assert.match(
    code,
    /static void handle_GET_index\(cerver_request_t \*req, cerver_response_t \*res\);/,
  );
  assert.match(code, /cerver_route_t cerver_routes\[\] = \{/);
  assert.match(code, /\{ "GET", "\/", handle_GET_index \},/);
  assert.match(code, /\{ "POST", "\/users\/:id", handle_POST_users_id \},/);
  assert.match(code, /const int cerver_route_count = 2;/);
});

test("generateDispatch generates correct parameter extraction and termination", () => {
  const { generateDispatch } = require("../lib/codegen/dispatch_gen");
  const routes = [
    IR.IRRoute("GET", "/users/:id/profile", ["id"], IR.IRHandler([], [])),
  ];
  const code = generateDispatch(routes);
  assert.match(code, /req->params\[req->params_count\]\.key = "id";/);
  assert.match(code, /req->params\[req->params_count\]\.value = seg1_start;/);
  assert.match(code, /\(\(char\*\)seg1_start\)\[seg1_len\] = '\\0';/);
  assert.doesNotMatch(code, /\btrue\b|\bfalse\b/);
  assert.match(code, /if \(match && \*p == '\/'\) p\+\+; else match = 0;/);
});

test("loadConfig merges defaults and supports export default configs", () => {
  const dir = tempDir();
  try {
    assert.deepEqual(loadConfig(dir), {
      port: 8080,
      embed: true,
      minify: true,
      compression: "none",
      threads: 4,
      compile: {
        cc: null,
        output: null,
        target: null,
        targetOs: null,
        targetArch: null,
        sysroot: null,
        cflags: "",
        ldflags: "",
        lto: true,
        marchNative: undefined,
        compileInfo: false,
      },
    });

    writeFile(
      path.join(dir, "cerver.config.js"),
      'export default { port: 3001, embed: false, minify: false, compression: "gzip" };\n',
    );

    assert.deepEqual(loadConfig(dir), {
      port: 3001,
      embed: false,
      minify: false,
      compression: "gzip",
      threads: 4,
      compile: {
        cc: null,
        output: null,
        target: null,
        targetOs: null,
        targetArch: null,
        sysroot: null,
        cflags: "",
        ldflags: "",
        lto: true,
        marchNative: undefined,
        compileInfo: false,
      },
    });
  } finally {
    cleanup(dir);
  }
});

test("findProjectRoot traverses up and locates project root correctly", () => {
  const rootDir = tempDir();
  try {
    const subDir = path.join(rootDir, "routes", "sub");
    fs.mkdirSync(subDir, { recursive: true });

    // With no configuration, findProjectRoot should return null
    assert.equal(findProjectRoot(subDir), null);

    // If cerver.config.js is in rootDir, it should find it
    writeFile(path.join(rootDir, "cerver.config.js"), "module.exports = {};");
    assert.equal(findProjectRoot(subDir), rootDir);
  } finally {
    cleanup(rootDir);
  }
});

test("loadConfig rejects invalid ports and compression values", () => {
  const dir = tempDir();
  try {
    writeFile(
      path.join(dir, "cerver.config.js"),
      "module.exports = { port: 70000 };\n",
    );
    assert.throws(() => loadConfig(dir), /invalid port 70000/);

    writeFile(
      path.join(dir, "cerver.config.js"),
      'module.exports = { compression: "zip" };\n',
    );
    assert.throws(() => loadConfig(dir), /unsupported compression "zip"/);
  } finally {
    cleanup(dir);
  }
});

test("discoverAssets maps public files and skips dotfiles", () => {
  const dir = tempDir();
  try {
    const publicDir = path.join(dir, "public");
    writeFile(path.join(publicDir, "index.html"), "<h1>Hello</h1>");
    writeFile(path.join(publicDir, ".secret"), "ignore me");
    writeFile(path.join(publicDir, "css", "app.css"), "body { color: red; }");

    const assets = discoverAssets(publicDir)
      .map((asset) => ({
        servePath: asset.servePath,
        ext: asset.ext,
        size: asset.size,
      }))
      .sort((a, b) => a.servePath.localeCompare(b.servePath));

    assert.deepEqual(assets, [
      {
        servePath: "/css/app.css",
        ext: ".css",
        size: Buffer.byteLength("body { color: red; }"),
      },
      {
        servePath: "/index.html",
        ext: ".html",
        size: Buffer.byteLength("<h1>Hello</h1>"),
      },
    ]);
  } finally {
    cleanup(dir);
  }
});

test("asset helpers generate stable names and MIME types", () => {
  assert.equal(varName("/static/app.min.css"), "asset_static_app_min_css");
  assert.equal(mimeFromExt(".json"), "application/json; charset=utf-8");
  assert.equal(mimeFromExt(".unknown"), "application/octet-stream");
});

test("minifyContent minifies CSS content", async () => {
  const source = Buffer.from(
    "/* comment */\nbody { color: red; margin: 0; }\n",
    "utf8",
  );
  const minified = await minifyContent(source, ".css");
  const text = minified.toString("utf8");

  assert.ok(text.length < source.length);
  assert.doesNotMatch(text, /comment/);
  assert.match(text, /color:red/);
});

test("compression helpers identify compressible MIME types and round-trip gzip", async () => {
  const source = Buffer.from("hello cerver ".repeat(80), "utf8");

  assert.equal(isCompressible("text/css; charset=utf-8"), true);
  assert.equal(isCompressible("application/json; charset=utf-8"), true);
  assert.equal(isCompressible("image/png"), false);

  const compressed = await compressContent(source, "gzip");
  assert.ok(compressed.length < source.length);
  assert.equal(
    zlib.gunzipSync(compressed).toString("utf8"),
    source.toString("utf8"),
  );
});

test("generateEmbeddedAssets emits C arrays and asset table entries", async () => {
  const dir = tempDir();
  try {
    const filePath = path.join(dir, "public", "css", "app.css");
    const content = "body { color: red; }";
    writeFile(filePath, content);

    const code = await generateEmbeddedAssets(
      [{ filePath, servePath: "/css/app.css", ext: ".css" }],
      false,
    );

    assert.match(code, /static const unsigned char asset_css_app_css\[\] = \{/);
    assert.match(
      code,
      new RegExp(
        `static const unsigned int asset_css_app_css_len = ${Buffer.byteLength(content)};`,
      ),
    );
    assert.match(
      code,
      /\{ "\/css\/app\.css", "text\/css; charset=utf-8", asset_css_app_css, asset_css_app_css_len, .* \},/,
    );
    assert.match(code, /const int cerver_embedded_asset_count = 1;/);
  } finally {
    cleanup(dir);
  }
});

test("generateEmbeddedAssets can emit gzip variants for compressible assets", async () => {
  const dir = tempDir();
  try {
    const filePath = path.join(dir, "public", "css", "app.css");
    const content = "body { color: red; }\n".repeat(80);
    writeFile(filePath, content);

    const code = await generateEmbeddedAssets(
      [{ filePath, servePath: "/css/app.css", ext: ".css" }],
      false,
      "gzip",
    );

    assert.match(
      code,
      /static const unsigned char asset_css_app_css_gz\[\] = \{/,
    );
    assert.match(
      code,
      /static const unsigned int asset_css_app_css_gz_len = \d+;/,
    );
    assert.match(
      code,
      /\{ "\/css\/app\.css", "text\/css; charset=utf-8", asset_css_app_css, asset_css_app_css_len, asset_css_app_css_gz, asset_css_app_css_gz_len, NULL, 0, NULL, 0 \},/,
    );
  } finally {
    cleanup(dir);
  }
});

test("generateEmbeddedAssets maps aliases according to the new convention", async () => {
  const dir = tempDir();
  try {
    const assets = [
      {
        filePath: path.join(dir, "public", "index.html"),
        servePath: "/index.html",
        ext: ".html",
      },
      {
        filePath: path.join(dir, "public", "abcd", "index.html"),
        servePath: "/abcd/index.html",
        ext: ".html",
      },
      {
        filePath: path.join(dir, "public", "page", "page.html"),
        servePath: "/page/page.html",
        ext: ".html",
      },
      {
        filePath: path.join(dir, "public", "foo", "bar", "bar.html"),
        servePath: "/foo/bar/bar.html",
        ext: ".html",
      },
      {
        filePath: path.join(dir, "public", "foo", "bar", "baz.html"),
        servePath: "/foo/bar/baz.html",
        ext: ".html",
      },
    ];

    for (const a of assets) {
      writeFile(a.filePath, `content for ${a.servePath}`);
    }

    const code = await generateEmbeddedAssets(assets, false);

    // /index.html should alias to /
    assert.match(
      code,
      /\{ "\/", "text\/html; charset=utf-8", asset_index_html, asset_index_html_len, .* \},/,
    );

    // /abcd/index.html should NOT alias to /abcd
    assert.doesNotMatch(
      code,
      /\{ "\/abcd", "text\/html; charset=utf-8", asset_abcd_index_html, asset_abcd_index_html_len, .* \},/,
    );
    // but the original should be there
    assert.match(
      code,
      /\{ "\/abcd\/index\.html", "text\/html; charset=utf-8", asset_abcd_index_html, asset_abcd_index_html_len, .* \},/,
    );

    // /page/page.html should alias to /page
    assert.match(
      code,
      /\{ "\/page", "text\/html; charset=utf-8", asset_page_page_html, asset_page_page_html_len, .* \},/,
    );
    // and the original should be there
    assert.match(
      code,
      /\{ "\/page\/page\.html", "text\/html; charset=utf-8", asset_page_page_html, asset_page_page_html_len, .* \},/,
    );

    // /foo/bar/bar.html should alias to /foo/bar
    assert.match(
      code,
      /\{ "\/foo\/bar", "text\/html; charset=utf-8", asset_foo_bar_bar_html, asset_foo_bar_bar_html_len, .* \},/,
    );

    // /foo/bar/baz.html should NOT alias to /foo/bar/baz (since it's baz.html in bar/)
    assert.doesNotMatch(
      code,
      /\{ "\/foo\/bar\/baz", "text\/html; charset=utf-8", asset_foo_bar_baz_html, .* \},/,
    );
  } finally {
    cleanup(dir);
  }
});

/* ---- Fetch API tests ---- */

test("validate accepts fetch() calls in route handlers", () => {
  const source = `
export function GET(req, res) {
  const data = fetch("https://api.example.com/data");
  return res.json(200, data);
}
`;
  assert.doesNotThrow(() => parseAndValidate(source));
});

test("transformFile produces IRFetch nodes for fetch() calls", () => {
  const source = `
export function POST(req, res) {
  const data = fetch("https://api.example.com/items", {
    method: "POST",
    body: "hello",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token123"
    }
  });
  return res.json(200, data);
}
`;
  const ast = parseAndValidate(source, "fetch-route.js");
  const routes = transformFile(ast, "/api/proxy");

  assert.equal(routes.length, 1);
  assert.equal(routes[0].method, "POST");

  const variable = routes[0].handler.variables[0];
  assert.equal(variable.name, "data");
  assert.equal(variable.initExpr.type, "Fetch");
  assert.equal(variable.initExpr.url.type, "StringLiteral");
  assert.equal(variable.initExpr.url.value, "https://api.example.com/items");
  assert.equal(variable.initExpr.method.type, "StringLiteral");
  assert.equal(variable.initExpr.method.value, "POST");
  assert.equal(variable.initExpr.body.type, "StringLiteral");
  assert.equal(variable.initExpr.body.value, "hello");
  assert.equal(variable.initExpr.headers.length, 2);
  assert.equal(variable.initExpr.headers[0].key.value, "Content-Type");
  assert.equal(variable.initExpr.headers[1].key.value, "Authorization");
});

test("emit generates cerver_fetch calls for simple and complex fetch expressions", () => {
  /* Simple GET fetch as variable init */
  const simpleFetch = IR.IRVariable(
    "data",
    "string",
    IR.IRFetch(
      IR.IRStringLiteral("https://api.example.com/data"),
      null,
      null,
      null,
    ),
  );

  const simpleLines = emitStatement(simpleFetch, 1);
  assert.ok(
    simpleLines.some((l) =>
      l.includes(
        'cerver_fetch("https://api.example.com/data", NULL, NULL, NULL)',
      ),
    ),
  );

  /* Fetch with headers in a Return */
  const fetchWithHeaders = IR.IRReturn(
    "json",
    200,
    IR.IRFetch(
      IR.IRStringLiteral("https://api.example.com"),
      IR.IRStringLiteral("POST"),
      IR.IRStringLiteral('{"key":"val"}'),
      [
        {
          key: IR.IRStringLiteral("Content-Type"),
          value: IR.IRStringLiteral("application/json"),
        },
      ],
    ),
  );

  const headerLines = emitStatement(fetchWithHeaders, 1);
  const joined = headerLines.join("\n");
  assert.ok(
    joined.includes("snprintf"),
    "should use snprintf for header formatting",
  );
  assert.ok(joined.includes("cerver_fetch"), "should call cerver_fetch");
  assert.ok(
    joined.includes("res->_body_owned = 1"),
    "should transfer fetch result ownership to response",
  );
  assert.ok(
    joined.includes("cerver_res_json"),
    "should call the json response helper",
  );
});

(async () => {
  let passed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`ok ${passed} - ${name}`);
    } catch (err) {
      console.error(`not ok ${passed + 1} - ${name}`);
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`\n${passed} test(s) passed`);
})();
