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
    "export function TRACE(req, res) { return res.text(200, 'no'); }",
    "bad-method.js",
  );
  assert.throws(
    () => validate(badMethod.ast, "bad-method.js", badMethod.source),
    /exported function "TRACE" is not a valid HTTP method/,
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

test("string literal + identifier is rewritten to IRConcat by the transform pass", () => {
  /* "Hello, " + id — string literal + identifier.
     The validator now defers this to transform (which has the symbol table).
     id is a known string (from req.params), so it becomes IRConcat → snprintf. */
  const source = `
export function GET(req, res) {
  const id = req.params.id;
  return res.text(200, "Hello, " + id);
}
`;
  /* Validator should pass */
  const ast = parseAndValidate(source, "concat-route.js");
  /* Transform should produce Concat (not throw) */
  const routes = transformFile(ast, "/item/:id");
  const returnVal = routes[0].handler.body[0].value;
  assert.equal(returnVal.type, "Concat");
  assert.equal(returnVal.parts[0].type, "StringLiteral");
  assert.equal(returnVal.parts[0].value, "Hello, ");
  assert.equal(returnVal.parts[1].type, "Identifier");
});

test("string literal + string literal compiles to a single merged C string literal", () => {
  /* Now that the validator no longer blocks literal+literal, the transform
     produces IRConcat([StringLiteral, StringLiteral]) which the emitter
     collapses to a single compile-time string. */
  const ast = parseAndValidate(
    'export function GET(req, res) { return res.text(200, "Hello, " + "world"); }',
    "literal-concat.js",
  );
  const routes = transformFile(ast, "/greet");
  const returnVal = routes[0].handler.body[0].value;
  /* The transform phase's createConcat now collapses adjacent string literals immediately. */
  assert.equal(returnVal.type, "StringLiteral");
  assert.equal(returnVal.value, "Hello, world");
  /* Verify the emitter outputs the correct C string literal */
  assert.equal(emitExpression(returnVal), '"Hello, world"');
});

test("validate allows + with identifier operands (type resolved by transform pass)", () => {
  /* After type-inference was added, identifier + identifier is deferred to transform.
     Two known-number vars: allowed. Two known-string vars: rewritten to IRConcat. */
  const source = parseSource(
    "export function GET(req, res) { const a = 1; const b = 2; return res.text(200, \"ok\"); }",
    "id-add.js",
  );
  assert.doesNotThrow(() => validate(source.ast, "id-add.js", source.source));
});

test("validate allows pure numeric + (integer addition)", () => {
  const source = parseSource(
    "export function GET(req, res) { const n = 1 + 2; return res.text(200, \"ok\"); }",
    "numeric-add.js",
  );
  assert.doesNotThrow(() => validate(source.ast, "numeric-add.js", source.source));
});

test("template literal + string literal becomes a Concat with flattened parts", () => {
  /* `Hello ${id}` + "!" — the transform produces IRConcat from the template,
     then IRConcat([that, StringLiteral]) for the outer +. The emitter handles
     this as a single snprintf with all parts. */
  const ast = parseAndValidate(
    'export function GET(req, res) { const id = req.params.id; return res.text(200, `Hello ${id}` + "!"); }',
    "template-plus.js",
  );
  const routes = transformFile(ast, "/test/:id");
  const returnVal = routes[0].handler.body[0].value;
  /* The outer + sees left=Concat (string type) → rewrites to Concat */
  assert.equal(returnVal.type, "Concat");
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

/* ---- Type inference + "+" operator tests ---- */

test("transformFile: numeric var + numeric var emits IRArithmetic via symbol table", () => {
  const source = `
export function GET(req, res) {
  const a = 10;
  const b = 5;
  const sum = a + b;
  return res.text(200, "ok");
}
`;
  const ast = parseAndValidate(source, "num-add.js");
  const routes = transformFile(ast, "/num-add");

  const sumVar = routes[0].handler.variables[2];
  assert.equal(sumVar.name, "sum");
  assert.equal(sumVar.initExpr.type, "Arithmetic");
  assert.equal(sumVar.initExpr.operator, "+");
  assert.equal(sumVar.initExpr.left.type, "Identifier");
  assert.equal(sumVar.initExpr.right.type, "Identifier");
  assert.equal(sumVar.valueType, "number");
});

test("transformFile: string var + string literal auto-rewrites to IRConcat", () => {
  const source = `
export function GET(req, res) {
  const name = req.params.name;
  const greeting = name + "!";
  return res.text(200, greeting);
}
`;
  const ast = parseAndValidate(source, "str-concat.js");
  const routes = transformFile(ast, "/greet/:name");

  const greetingVar = routes[0].handler.variables[1];
  assert.equal(greetingVar.name, "greeting");
  assert.equal(greetingVar.initExpr.type, "Concat");
  assert.equal(greetingVar.initExpr.parts.length, 2);
  assert.equal(greetingVar.initExpr.parts[0].type, "Identifier");
  assert.equal(greetingVar.initExpr.parts[1].type, "StringLiteral");
});

test("transformFile: string param + string param auto-rewrites to IRConcat", () => {
  /* Both x and y are params — they're strings — should become Concat */
  const ast = parseAndValidate(
    `export function GET(req, res) {
  let x = req.params.x;
  let y = req.params.y;
  const result = x + y;
  return res.text(200, result);
}`,
    "str-param-concat.js",
  );
  const routes = transformFile(ast, "/test/:x/:y");
  const resultVar = routes[0].handler.variables[2];
  assert.equal(resultVar.initExpr.type, "Concat");
});

test("emitExpression: IRArithmetic emits C arithmetic expression", () => {
  const arith = IR.IRArithmetic("+", IR.IRNumberLiteral(3), IR.IRNumberLiteral(4));
  assert.equal(emitExpression(arith), "(3 + 4)");

  const mul = IR.IRArithmetic("*", IR.IRIdentifier("a"), IR.IRNumberLiteral(2));
  assert.equal(emitExpression(mul), "(a * 2)");
});

/* ---- String.prototype.concat() tests ---- */

test("transformFile: str.concat(a, b) produces IRConcat with receiver + args", () => {
  const source = `
export function GET(req, res) {
  const first = req.params.first;
  const last = req.params.last;
  const full = first.concat(" ", last);
  return res.text(200, full);
}
`;
  const ast = parseAndValidate(source, "concat-method.js");
  const routes = transformFile(ast, "/name/:first/:last");
  const fullVar = routes[0].handler.variables[2];

  assert.equal(fullVar.name, "full");
  assert.equal(fullVar.initExpr.type, "Concat");
  assert.equal(fullVar.initExpr.parts.length, 3);
  assert.equal(fullVar.initExpr.parts[0].type, "Identifier");
  assert.equal(fullVar.initExpr.parts[0].name, "first");
  assert.equal(fullVar.initExpr.parts[1].type, "StringLiteral");
  assert.equal(fullVar.initExpr.parts[1].value, " ");
  assert.equal(fullVar.initExpr.parts[2].type, "Identifier");
  assert.equal(fullVar.initExpr.parts[2].name, "last");
});

test("transformFile: str.concat() with single arg returns IRConcat with 2 parts", () => {
  const ast = parseAndValidate(
    'export function GET(req, res) { const a = req.params.a; const b = a.concat("!"); return res.text(200, b); }',
    "concat-single.js",
  );
  const routes = transformFile(ast, "/test/:a");
  const bVar = routes[0].handler.variables[1];

  assert.equal(bVar.initExpr.type, "Concat");
  assert.equal(bVar.initExpr.parts.length, 2);
  assert.equal(bVar.initExpr.parts[0].type, "Identifier");
  assert.equal(bVar.initExpr.parts[1].type, "StringLiteral");
});

test("transformFile: str.concat() with no args returns the receiver directly", () => {
  const ast = parseAndValidate(
    'export function GET(req, res) { const a = req.params.a; const b = a.concat(); return res.text(200, b); }',
    "concat-none.js",
  );
  const routes = transformFile(ast, "/test/:a");
  const bVar = routes[0].handler.variables[1];

  /* No args → parts has only the receiver → returns the receiver itself */
  assert.equal(bVar.initExpr.type, "Identifier");
  assert.equal(bVar.initExpr.name, "a");
});

test("emit: str.concat() as variable initializer emits snprintf block", () => {
  const ctx = { concatVarCounter: 0, fetchVarCounter: 0, ownedStrings: new Set() };
  const concatVar = IR.IRVariable("full", "string",
    IR.IRConcat([IR.IRIdentifier("first"), IR.IRStringLiteral(" "), IR.IRIdentifier("last")]));
  const lines = emitStatement(concatVar, 1, ctx);
  const joined = lines.join("\n");

  assert.match(joined, /snprintf\(NULL, 0, "%s %s", first, last\)/);
  assert.match(joined, /malloc\(full_len \+ 1\)/);
  assert.match(joined, /snprintf\(full, full_len \+ 1, "%s %s", first, last\)/);
  assert.ok(ctx.ownedStrings.has("full"), "concat result should be tracked as owned");
});

/* ---- String operations tests ---- */

test("transformFile: string methods produce IRStringOp nodes", () => {
  const source = `
export function GET(req, res) {
  const name = req.params.name;
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();
  const trimmed = name.trim();
  const sub = name.slice(0, 5);
  const replaced = name.replace("a", "b");
  return res.text(200, lower);
}
`;
  const ast = parseAndValidate(source, "strops.js");
  const routes = transformFile(ast, "/strops/:name");
  const vars = routes[0].handler.variables;

  assert.equal(vars[1].initExpr.type, "StringOp");
  assert.equal(vars[1].initExpr.method, "toLowerCase");
  assert.equal(vars[1].initExpr.returnType, "string");

  assert.equal(vars[2].initExpr.type, "StringOp");
  assert.equal(vars[2].initExpr.method, "toUpperCase");

  assert.equal(vars[3].initExpr.type, "StringOp");
  assert.equal(vars[3].initExpr.method, "trim");

  assert.equal(vars[4].initExpr.type, "StringOp");
  assert.equal(vars[4].initExpr.method, "slice");
  assert.equal(vars[4].initExpr.args[0].value, 0);
  assert.equal(vars[4].initExpr.args[1].value, 5);

  assert.equal(vars[5].initExpr.type, "StringOp");
  assert.equal(vars[5].initExpr.method, "replace");
  assert.equal(vars[5].initExpr.args[0].value, "a");
  assert.equal(vars[5].initExpr.args[1].value, "b");
});

test("transformFile: predicate string methods produce number-typed IRStringOp", () => {
  const source = `
export function GET(req, res) {
  const s = req.params.s;
  const hasA = s.includes("a");
  const startsA = s.startsWith("a");
  const endsA = s.endsWith("a");
  const idx = s.indexOf("a");
  const len = s.length;
  return res.text(200, "ok");
}
`;
  const ast = parseAndValidate(source, "predicates.js");
  const routes = transformFile(ast, "/pred/:s");
  const vars = routes[0].handler.variables;

  assert.equal(vars[1].initExpr.type, "StringOp");
  assert.equal(vars[1].initExpr.method, "includes");
  assert.equal(vars[1].initExpr.returnType, "number");
  assert.equal(vars[1].valueType, "number");

  assert.equal(vars[2].initExpr.method, "startsWith");
  assert.equal(vars[2].initExpr.returnType, "number");

  assert.equal(vars[3].initExpr.method, "endsWith");
  assert.equal(vars[4].initExpr.method, "indexOf");

  assert.equal(vars[5].initExpr.type, "StringOp");
  assert.equal(vars[5].initExpr.method, "length");
  assert.equal(vars[5].initExpr.returnType, "number");
});

test("emit: string predicate ops emit correct inline C expressions", () => {
  const includes = IR.IRStringOp("includes", IR.IRIdentifier("s"), [IR.IRStringLiteral("hello")], "number");
  assert.equal(emitExpression(includes), '(strstr(s, "hello") != NULL)');

  const startsWith = IR.IRStringOp("startsWith", IR.IRIdentifier("s"), [IR.IRStringLiteral("hi")], "number");
  assert.equal(emitExpression(startsWith), '(strncmp(s, "hi", strlen("hi")) == 0)');

  const endsWith = IR.IRStringOp("endsWith", IR.IRIdentifier("s"), [IR.IRStringLiteral("end")], "number");
  assert.equal(emitExpression(endsWith), 'cerver_str_endswith(s, "end")');

  const indexOf = IR.IRStringOp("indexOf", IR.IRIdentifier("s"), [IR.IRStringLiteral("x")], "number");
  assert.equal(emitExpression(indexOf), 'cerver_str_indexof(s, "x")');

  const length = IR.IRStringOp("length", IR.IRIdentifier("s"), [], "number");
  assert.equal(emitExpression(length), "((int)strlen(s))");
});

test("emit: string-returning ops emit correct statement-level C code", () => {
  const ctx = { concatVarCounter: 0, fetchVarCounter: 0, ownedStrings: new Set() };

  const toLower = IR.IRVariable("result", "string",
    IR.IRStringOp("toLowerCase", IR.IRIdentifier("name"), [], "string"));
  const lines = emitStatement(toLower, 1, ctx);
  assert.ok(lines.some((l) => l.includes("cerver_str_tolower(name)")));

  const toUpper = IR.IRVariable("result2", "string",
    IR.IRStringOp("toUpperCase", IR.IRIdentifier("name"), [], "string"));
  const lines2 = emitStatement(toUpper, 1, ctx);
  assert.ok(lines2.some((l) => l.includes("cerver_str_toupper(name)")));

  const trim = IR.IRVariable("trimmed", "string",
    IR.IRStringOp("trim", IR.IRIdentifier("s"), [], "string"));
  const lines3 = emitStatement(trim, 1, ctx);
  assert.ok(lines3.some((l) => l.includes("cerver_str_trim(s)")));

  const slice = IR.IRVariable("sub", "string",
    IR.IRStringOp("slice", IR.IRIdentifier("s"), [IR.IRNumberLiteral(0), IR.IRNumberLiteral(5)], "string"));
  const lines4 = emitStatement(slice, 1, ctx);
  assert.ok(lines4.some((l) => l.includes("cerver_str_slice(s, 0, 5)")));

  const replace = IR.IRVariable("rep", "string",
    IR.IRStringOp("replace", IR.IRIdentifier("s"),
      [IR.IRStringLiteral("foo"), IR.IRStringLiteral("bar")], "string"));
  const lines5 = emitStatement(replace, 1, ctx);
  assert.ok(lines5.some((l) => l.includes('cerver_str_replace(s, "foo", "bar")')));
});

test("emit: string-returning op as Return emits buffer and _body_owned", () => {
  const ret = IR.IRReturn("text", 200,
    IR.IRStringOp("toLowerCase", IR.IRIdentifier("name"), [], "string"));
  const lines = emitStatement(ret, 1);
  const joined = lines.join("\n");
  assert.match(joined, /cerver_str_tolower\(name\)/);
  assert.match(joined, /res->_body_owned = 1/);
  assert.match(joined, /cerver_res_text/);
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
  assert.match(joined, /snprintf\(NULL, 0, "hello %s", name\)/);
  assert.match(joined, /malloc\(_concat_res_0_len \+ 1\)/);
  assert.match(joined, /snprintf\(_concat_res_0, _concat_res_0_len \+ 1, "hello %s", name\);/);
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
