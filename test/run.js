"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const { discoverAssets } = require("../lib/assets/discover");
const { compressContent, isCompressible } = require("../lib/assets/compress");
const { generateEmbeddedAssets, mimeFromExt, varName } = require("../lib/assets/embed");
const { minifyContent } = require("../lib/assets/minify");
const {
  cString,
  emitExpression,
  emitStatement,
  handlerName,
} = require("../lib/codegen/emit");
const { generateRouteTable } = require("../lib/codegen/route_table");
const { loadConfig } = require("../lib/config");
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
    writeFile(path.join(routesDir, "index.js"), "export function GET(req, res) {}");
    writeFile(path.join(routesDir, "about.js"), "export function GET(req, res) {}");
    writeFile(path.join(routesDir, "blog", "index.js"), "export function GET(req, res) {}");
    writeFile(path.join(routesDir, "blog", "[slug].js"), "export function GET(req, res) {}");
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
    "bad-method.js"
  );
  assert.throws(
    () => validate(badMethod.ast, "bad-method.js", badMethod.source),
    /exported function "PUT" is not a valid HTTP method/
  );

  const asyncHandler = parseSource(
    "export async function GET(req, res) { await work(); return res.text(200, 'ok'); }",
    "async-route.js"
  );
  assert.throws(
    () => validate(asyncHandler.ast, "async-route.js", asyncHandler.source),
    /async functions are not supported[\s\S]*async\/await is not supported/
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

test("emit helpers escape C strings and map IR expressions", () => {
  assert.equal(cString('a"b\\c\n'), '"a\\"b\\\\c\\n"');
  assert.equal(handlerName("GET", "/"), "handle_GET_index");
  assert.equal(handlerName("POST", "/users/:id"), "handle_POST_users_id");

  const comparison = IR.IRComparison(
    "===",
    IR.IRParamAccess("id"),
    IR.IRStringLiteral("42")
  );
  assert.equal(
    emitExpression(comparison),
    '(strcmp(cerver_req_param(req, "id"), "42") == 0)'
  );

  assert.deepEqual(
    emitStatement(IR.IRReturn("text", 201, IR.IRStringLiteral("created")), 1),
    [
      '    cerver_res_text(res, 201, "created");',
      "    return;",
    ]
  );
});

test("generateRouteTable emits forward declarations, entries, and count", () => {
  const routes = [
    IR.IRRoute("GET", "/", [], IR.IRHandler([], [])),
    IR.IRRoute("POST", "/users/:id", ["id"], IR.IRHandler([], [])),
  ];

  const code = generateRouteTable(routes);

  assert.match(code, /static void handle_GET_index\(cerver_request_t \*req, cerver_response_t \*res\);/);
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
    });

    writeFile(
      path.join(dir, "cerver.config.js"),
      'export default { port: 3001, embed: false, minify: false, compression: "gzip" };\n'
    );

    assert.deepEqual(loadConfig(dir), {
      port: 3001,
      embed: false,
      minify: false,
      compression: "gzip",
      threads: 4,
    });
  } finally {
    cleanup(dir);
  }
});

test("loadConfig rejects invalid ports and compression values", () => {
  const dir = tempDir();
  try {
    writeFile(path.join(dir, "cerver.config.js"), "module.exports = { port: 70000 };\n");
    assert.throws(() => loadConfig(dir), /invalid port 70000/);

    writeFile(path.join(dir, "cerver.config.js"), 'module.exports = { compression: "zip" };\n');
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
      { servePath: "/css/app.css", ext: ".css", size: Buffer.byteLength("body { color: red; }") },
      { servePath: "/index.html", ext: ".html", size: Buffer.byteLength("<h1>Hello</h1>") },
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
  const source = Buffer.from("/* comment */\nbody { color: red; margin: 0; }\n", "utf8");
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
  assert.equal(zlib.gunzipSync(compressed).toString("utf8"), source.toString("utf8"));
});

test("generateEmbeddedAssets emits C arrays and asset table entries", async () => {
  const dir = tempDir();
  try {
    const filePath = path.join(dir, "public", "css", "app.css");
    const content = "body { color: red; }";
    writeFile(filePath, content);

    const code = await generateEmbeddedAssets(
      [{ filePath, servePath: "/css/app.css", ext: ".css" }],
      false
    );

    assert.match(code, /static const unsigned char asset_css_app_css\[\] = \{/);
    assert.match(
      code,
      new RegExp(`static const unsigned int asset_css_app_css_len = ${Buffer.byteLength(content)};`)
    );
    assert.match(
      code,
      /\{ "\/css\/app\.css", "text\/css; charset=utf-8", asset_css_app_css, asset_css_app_css_len, .* \},/
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
      "gzip"
    );

    assert.match(code, /static const unsigned char asset_css_app_css_gz\[\] = \{/);
    assert.match(code, /static const unsigned int asset_css_app_css_gz_len = \d+;/);
    assert.match(
      code,
      /\{ "\/css\/app\.css", "text\/css; charset=utf-8", asset_css_app_css, asset_css_app_css_len, asset_css_app_css_gz, asset_css_app_css_gz_len, NULL, 0, NULL, 0 \},/
    );
  } finally {
    cleanup(dir);
  }
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
