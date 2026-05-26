"use strict";

const IR = require("./types");

/**
 * Transform a validated AST into an IR route descriptor.
 *
 * @param {object} ast - ESTree AST (validated)
 * @param {string} urlPath - The route path (e.g. "/groups/:group_id")
 * @returns {IRRoute[]} — one IRRoute per exported handler (GET, POST)
 */
function transformFile(ast, urlPath) {
  const routes = [];

  /* Extract dynamic segment names from the URL pattern */
  const params = [];
  const paramRegex = /:([^/]+)/g;
  let match;
  while ((match = paramRegex.exec(urlPath)) !== null) {
    params.push(match[1]);
  }

  for (const node of ast.body) {
    if (
      node.type === "ExportNamedDeclaration" &&
      node.declaration &&
      node.declaration.type === "FunctionDeclaration"
    ) {
      const funcDecl = node.declaration;
      const method = funcDecl.id.name; /* "GET" or "POST" */

      /* Get the parameter names (req, res) */
      const reqName =
        funcDecl.params[0] && funcDecl.params[0].type === "Identifier"
          ? funcDecl.params[0].name
          : "req";
      const resName =
        funcDecl.params[1] && funcDecl.params[1].type === "Identifier"
          ? funcDecl.params[1].name
          : "res";

      /* Transform the function body */
      const ctx = { reqName, resName };
      const { variables, body } = transformBlock(funcDecl.body, ctx);

      const handler = IR.IRHandler(variables, body);
      routes.push(IR.IRRoute(method, urlPath, params, handler));
    }
  }

  return routes;
}

/**
 * Transform a block statement into IR variables and statements.
 */
function transformBlock(blockNode, ctx) {
  const variables = [];
  const body = [];

  for (const stmt of blockNode.body) {
    const result = transformStatement(stmt, ctx);
    if (result) {
      if (result.type === "Variable") {
        variables.push(result);
      } else {
        body.push(result);
      }
    }
  }

  return { variables, body };
}

/**
 * Transform a single statement.
 */
function transformStatement(node, ctx) {
  switch (node.type) {
    case "ReturnStatement":
      return transformReturn(node, ctx);

    case "IfStatement":
      return transformIf(node, ctx);

    case "VariableDeclaration":
      return transformVariableDecl(node, ctx);

    case "ExpressionStatement":
      /* Likely a standalone res.text() call or similar */
      return transformExpression(node.expression, ctx);

    default:
      return null;
  }
}

/**
 * Transform a return statement.
 *
 * Expected forms:
 *   return res.text(200, "hello")
 *   return res.json(200, '{"ok": true}')
 *   return res.html(200, "<h1>hi</h1>")
 */
function transformReturn(node, ctx) {
  if (!node.argument) {
    return IR.IRReturn("text", 200, IR.IRStringLiteral(""));
  }

  const arg = node.argument;

  /* res.text(status, body) */
  if (
    arg.type === "CallExpression" &&
    arg.callee.type === "MemberExpression" &&
    arg.callee.object.type === "Identifier" &&
    arg.callee.object.name === ctx.resName
  ) {
    const method = arg.callee.property.name; /* "text", "json", "html" */
    const responseType = ["text", "json", "html"].includes(method)
      ? method
      : "text";

    const status =
      arg.arguments[0] && arg.arguments[0].type === "Literal"
        ? arg.arguments[0].value
        : 200;

    const bodyExpr = arg.arguments[1]
      ? transformExpression(arg.arguments[1], ctx)
      : IR.IRStringLiteral("");

    return IR.IRReturn(responseType, status, bodyExpr);
  }

  /* Plain expression return — treat as text */
  return IR.IRReturn("text", 200, transformExpression(arg, ctx));
}

/**
 * Transform an if statement.
 */
function transformIf(node, ctx) {
  const condition = transformExpression(node.test, ctx);

  const thenBlock =
    node.consequent.type === "BlockStatement"
      ? transformBlock(node.consequent, ctx)
      : {
          variables: [],
          body: [transformStatement(node.consequent, ctx)].filter(Boolean),
        };

  let elseBody = null;
  if (node.alternate) {
    if (node.alternate.type === "IfStatement") {
      /* else if → nested If */
      elseBody = [transformStatement(node.alternate, ctx)];
    } else if (node.alternate.type === "BlockStatement") {
      const elseBlock = transformBlock(node.alternate, ctx);
      elseBody = elseBlock.body;
    } else {
      elseBody = [transformStatement(node.alternate, ctx)].filter(Boolean);
    }
  }

  return IR.IRIf(condition, thenBlock.body, elseBody);
}

/**
 * Transform a variable declaration.
 */
function transformVariableDecl(node, ctx) {
  /* For simplicity, handle the first declarator */
  const decl = node.declarations[0];
  if (!decl) return null;

  const name = decl.id.name;
  const initExpr = decl.init
    ? transformExpression(decl.init, ctx)
    : IR.IRStringLiteral("");

  const valueType = inferValueType(initExpr);

  return IR.IRVariable(name, valueType, initExpr);
}

function inferValueType(expr) {
  if (!expr) return "string";

  if (
    expr.type === "NumberLiteral" ||
    expr.type === "Comparison" ||
    expr.type === "Logical"
  ) {
    return "number";
  }

  if (expr.type === "Unary") {
    return expr.operator === "!" || expr.operator === "-" ? "number" : "string";
  }

  if (expr.type === "Conditional") {
    const consequentType = inferValueType(expr.consequent);
    const alternateType = inferValueType(expr.alternate);
    return consequentType === "number" && alternateType === "number"
      ? "number"
      : "string";
  }

  return "string";
}

/**
 * Transform an expression into an IR expression node.
 */
function transformExpression(node, ctx) {
  switch (node.type) {
    case "Literal":
      if (typeof node.value === "number") {
        return IR.IRNumberLiteral(node.value);
      }
      return IR.IRStringLiteral(String(node.value || ""));

    case "Identifier":
      return IR.IRIdentifier(node.name);

    case "BinaryExpression":
      return IR.IRComparison(
        node.operator,
        transformExpression(node.left, ctx),
        transformExpression(node.right, ctx),
      );

    case "LogicalExpression":
      return IR.IRLogical(
        node.operator,
        transformExpression(node.left, ctx),
        transformExpression(node.right, ctx),
      );

    case "UnaryExpression":
      return IR.IRUnary(node.operator, transformExpression(node.argument, ctx));

    case "ConditionalExpression":
      return IR.IRConditional(
        transformExpression(node.test, ctx),
        transformExpression(node.consequent, ctx),
        transformExpression(node.alternate, ctx),
      );

    case "MemberExpression":
      return transformMemberExpr(node, ctx);

    case "CallExpression":
      return transformCallExpr(node, ctx);

    case "TemplateLiteral":
      return transformTemplateLiteral(node, ctx);

    case "AssignmentExpression":
      /* Treat as a variable update — just return the right side for now */
      return transformExpression(node.right, ctx);

    default:
      return IR.IRStringLiteral("");
  }
}

/**
 * Transform member expressions.
 *
 * Handles:
 *   req.params.key  → IRParamAccess("key")
 *   req.query.x     → IRQueryAccess("x")
 *   req.headers.x   → IRHeaderAccess("x")
 */
function transformMemberExpr(node, ctx) {
  /* req.params.key or req.query.key */
  if (
    node.object.type === "MemberExpression" &&
    node.object.object.type === "Identifier" &&
    node.object.object.name === ctx.reqName
  ) {
    const group = node.object.property.name || node.object.property.value;
    const key = node.property.name || node.property.value;

    if (group === "params") return IR.IRParamAccess(key);
    if (group === "query") return IR.IRQueryAccess(key);
    if (group === "headers") return IR.IRHeaderAccess(key);
  }

  /* req.method, req.path */
  if (node.object.type === "Identifier" && node.object.name === ctx.reqName) {
    const prop = node.property.name || node.property.value;
    if (prop === "method") return IR.IRRequestField("method");
    if (prop === "path") return IR.IRRequestField("path");
  }

  return IR.IRStringLiteral("");
}

/**
 * Transform call expressions.
 */
function transformCallExpr(node, ctx) {
  /* res.text(status, body), res.json(...), res.html(...) */
  if (
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === ctx.resName
  ) {
    const method = node.callee.property.name;
    const args = node.arguments.map((a) => transformExpression(a, ctx));
    return IR.IRCall("res", method, args);
  }

  /* fetch(url) or fetch(url, { method, body, headers }) */
  if (
    node.callee.type === "Identifier" &&
    node.callee.name === "fetch"
  ) {
    const urlExpr = node.arguments[0]
      ? transformExpression(node.arguments[0], ctx)
      : IR.IRStringLiteral("");

    let methodExpr = null;
    let bodyExpr = null;
    let headersArr = null;

    /* Parse options object if present: fetch(url, { method, body, headers }) */
    if (node.arguments[1] && node.arguments[1].type === "ObjectExpression") {
      const opts = node.arguments[1];
      for (const prop of opts.properties) {
        const key = prop.key.name || prop.key.value;
        if (key === "method") {
          methodExpr = transformExpression(prop.value, ctx);
        } else if (key === "body") {
          bodyExpr = transformExpression(prop.value, ctx);
        } else if (key === "headers" && prop.value.type === "ObjectExpression") {
          headersArr = [];
          for (const hProp of prop.value.properties) {
            const hKey = hProp.key.name || hProp.key.value;
            headersArr.push({
              key: IR.IRStringLiteral(hKey),
              value: transformExpression(hProp.value, ctx),
            });
          }
        }
      }
    }

    return IR.IRFetch(urlExpr, methodExpr, bodyExpr, headersArr);
  }

  /* String methods like str.toLowerCase(), includes() etc. — return as-is */
  if (node.callee.type === "MemberExpression") {
    const obj = transformExpression(node.callee.object, ctx);
    const method = node.callee.property.name;
    const args = node.arguments.map((a) => transformExpression(a, ctx));
    return IR.IRCall(obj, method, args);
  }

  return IR.IRStringLiteral("");
}

/**
 * Transform template literals into concatenation.
 */
function transformTemplateLiteral(node, ctx) {
  const parts = [];

  for (let i = 0; i < node.quasis.length; i++) {
    const quasi = node.quasis[i];
    if (quasi.value.cooked) {
      parts.push(IR.IRStringLiteral(quasi.value.cooked));
    }
    if (i < node.expressions.length) {
      parts.push(transformExpression(node.expressions[i], ctx));
    }
  }

  if (parts.length === 1) return parts[0];
  return IR.IRConcat(parts);
}

module.exports = { transformFile };
