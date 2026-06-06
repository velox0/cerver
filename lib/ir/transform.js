"use strict";

const IR = require("./types");

/* ------------------------------------------------------------------ */
/*  String method metadata                                             */
/* ------------------------------------------------------------------ */

/**
 * Supported string methods.
 * returnType:
 *   "string"  → heap-allocated result, emitted at statement level
 *   "number"  → int, safe to emit inline
 */
const STRING_METHODS = {
  toLowerCase:  { returnType: "string", minArgs: 0, maxArgs: 0 },
  toUpperCase:  { returnType: "string", minArgs: 0, maxArgs: 0 },
  trim:         { returnType: "string", minArgs: 0, maxArgs: 0 },
  slice:        { returnType: "string", minArgs: 1, maxArgs: 2 },
  replace:      { returnType: "string", minArgs: 2, maxArgs: 2 },
  includes:     { returnType: "number", minArgs: 1, maxArgs: 1 },
  startsWith:   { returnType: "number", minArgs: 1, maxArgs: 1 },
  endsWith:     { returnType: "number", minArgs: 1, maxArgs: 1 },
  indexOf:      { returnType: "number", minArgs: 1, maxArgs: 1 },
};

/* ------------------------------------------------------------------ */
/*  Type inference helpers                                             */
/* ------------------------------------------------------------------ */

/**
 * Infer the C type of an IR expression.
 * Returns "string" | "number" | "unknown".
 * The symbol table (Map<name, type>) is threaded through ctx.types.
 */
function inferIRType(expr, types) {
  if (!expr) return "string";

  switch (expr.type) {
    case "StringLiteral":
    case "ParamAccess":
    case "QueryAccess":
    case "HeaderAccess":
    case "RequestField":
    case "Concat":
      return "string";

    case "NumberLiteral":
      return "number";

    case "Comparison":
    case "Logical":
    case "Arithmetic":
      return "number";

    case "Unary":
      return expr.operator === "!" || expr.operator === "-" ? "number" : "string";

    case "Conditional": {
      const c = inferIRType(expr.consequent, types);
      const a = inferIRType(expr.alternate, types);
      return c === "number" && a === "number" ? "number" : "string";
    }

    case "Identifier":
      return types && types.has(expr.name) ? types.get(expr.name) : "unknown";

    case "StringOp":
      return expr.returnType;

    case "Call":
      /* fetch result is a string */
      return "string";

    case "Fetch":
      return "string";

    default:
      return "unknown";
  }
}

/**
 * Quick check: is an AST node provably numeric at transform time?
 * Used by transformBinaryExpression to decide before the symbol table.
 */
function isNumericAST(node) {
  if (!node) return false;
  if (node.type === "Literal" && typeof node.value === "number") return true;
  if (
    node.type === "BinaryExpression" &&
    ["+", "-", "*", "/", "%"].includes(node.operator) &&
    !(node.type === "BinaryExpression" &&
      ["===", "!==", "==", "!=", "<", ">", "<=", ">="].includes(node.operator))
  ) {
    return isNumericAST(node.left) && isNumericAST(node.right);
  }
  if (node.type === "UnaryExpression" && node.operator === "-") {
    return isNumericAST(node.argument);
  }
  return false;
}

/**
 * Quick check: is an AST node provably string at transform time?
 */
function isStringAST(node) {
  if (!node) return false;
  if (node.type === "Literal" && typeof node.value === "string") return true;
  if (node.type === "TemplateLiteral") return true;
  /* Member expressions like req.params.x, req.query.x are always strings */
  if (node.type === "MemberExpression") return true;
  return false;
}

/* ------------------------------------------------------------------ */
/*  Top-level file transform                                           */
/* ------------------------------------------------------------------ */

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

      /*
       * ctx carries:
       *   reqName, resName — parameter names in scope
       *   types           — symbol table: Map<varName, "string"|"number">
       */
      const ctx = { reqName, resName, types: new Map() };
      const { variables, body } = transformBlock(funcDecl.body, ctx, {
        hoistVariables: true,
      });

      const handler = IR.IRHandler(variables, body);
      routes.push(IR.IRRoute(method, urlPath, params, handler));
    }
  }

  return routes;
}

/* ------------------------------------------------------------------ */
/*  Block / statement transform                                        */
/* ------------------------------------------------------------------ */

/**
 * Transform a block statement into IR variables and statements.
 */
function transformBlock(blockNode, ctx, options) {
  const opts = options || {};
  const hoistVariables = !!opts.hoistVariables;
  const variables = [];
  const body = [];

  for (const stmt of blockNode.body) {
    const result = transformStatement(stmt, ctx, opts);
    if (result) {
      if (result.type === "Variable" && hoistVariables) {
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
function transformStatement(node, ctx, options) {
  switch (node.type) {
    case "ReturnStatement":
      return transformReturn(node, ctx);

    case "IfStatement":
      return transformIf(node, ctx);

    case "WhileStatement":
      return transformWhile(node, ctx);

    case "ForStatement":
      return transformFor(node, ctx);

    case "VariableDeclaration":
      return transformVariableDecl(node, ctx);

    case "ExpressionStatement":
      /* Likely a standalone res.text() call or similar */
      return transformExpression(node.expression, ctx);

    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Statement-level transforms                                         */
/* ------------------------------------------------------------------ */

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
      ? transformBlock(node.consequent, ctx, { hoistVariables: false })
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
      const elseBlock = transformBlock(node.alternate, ctx, {
        hoistVariables: false,
      });
      elseBody = elseBlock.body;
    } else {
      elseBody = [transformStatement(node.alternate, ctx)].filter(Boolean);
    }
  }

  return IR.IRIf(condition, thenBlock.body, elseBody);
}

/**
 * Transform a while statement.
 */
function transformWhile(node, ctx) {
  const condition = transformExpression(node.test, ctx);
  const bodyBlock =
    node.body.type === "BlockStatement"
      ? transformBlock(node.body, ctx, { hoistVariables: false })
      : {
          variables: [],
          body: [transformStatement(node.body, ctx)].filter(Boolean),
        };

  return IR.IRWhile(condition, bodyBlock.body);
}

/**
 * Transform a for statement.
 */
function transformFor(node, ctx) {
  let init = null;
  let update = null;

  if (node.init) {
    if (node.init.type === "VariableDeclaration") {
      init = transformVariableDecl(node.init, ctx);
    } else {
      init = transformExpression(node.init, ctx);
    }
  }

  if (node.update) {
    update = transformExpression(node.update, ctx);
  }

  const condition = node.test ? transformExpression(node.test, ctx) : null;

  const bodyBlock =
    node.body.type === "BlockStatement"
      ? transformBlock(node.body, ctx, { hoistVariables: false })
      : {
          variables: [],
          body: [transformStatement(node.body, ctx)].filter(Boolean),
        };

  return IR.IRFor(init, condition, update, bodyBlock.body);
}

/**
 * Transform a variable declaration.
 * Registers the inferred type in ctx.types for later use.
 */
function transformVariableDecl(node, ctx) {
  /* For simplicity, handle the first declarator */
  const decl = node.declarations[0];
  if (!decl) return null;

  const name = decl.id.name;
  const initExpr = decl.init
    ? transformExpression(decl.init, ctx)
    : IR.IRStringLiteral("");

  const valueType = inferIRType(initExpr, ctx.types);
  const resolvedType = valueType === "unknown" ? "string" : valueType;

  /* Register so subsequent expressions can look up this variable's type */
  ctx.types.set(name, resolvedType);

  return IR.IRVariable(name, resolvedType, initExpr);
}

/* ------------------------------------------------------------------ */
/*  Expression transform                                               */
/* ------------------------------------------------------------------ */

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
      return transformBinaryExpression(node, ctx);

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
      return transformAssignmentExpr(node, ctx);

    case "UpdateExpression":
      return transformUpdateExpr(node, ctx);

    default:
      return IR.IRStringLiteral("");
  }
}

/* ------------------------------------------------------------------ */
/*  Binary expression: +, -, *, /, %, comparisons                     */
/* ------------------------------------------------------------------ */

/**
 * Transform a binary expression.
 *
 * For arithmetic operators (+, -, *, /, %):
 *   - Both sides provably numeric → IRArithmetic
 *   - Either side provably string → IRConcat (snprintf path, same as template literal)
 *   - Still ambiguous after symbol table → throw compile-time error
 *
 * For comparison/relational operators (===, !==, ==, !=, <, >, <=, >=):
 *   - Delegate to IRComparison (the emitter handles strcmp vs numeric).
 */
function transformBinaryExpression(node, ctx) {
  const arithmeticOps = new Set(["+", "-", "*", "/", "%"]);
  const comparisonOps = new Set(["===", "!==", "==", "!=", "<", ">", "<=", ">="]);

  if (comparisonOps.has(node.operator)) {
    return IR.IRComparison(
      node.operator,
      transformExpression(node.left, ctx),
      transformExpression(node.right, ctx),
    );
  }

  if (!arithmeticOps.has(node.operator)) {
    /* Bitwise or other operators — not supported, fall back */
    return IR.IRStringLiteral("");
  }

  /* --- Arithmetic operator (+, -, *, /, %) --- */

  /* Only "+" can be string concatenation in JS; -, *, /, % are always numeric */
  if (node.operator !== "+") {
    /* These are unambiguously numeric arithmetic */
    return IR.IRArithmetic(
      node.operator,
      transformExpression(node.left, ctx),
      transformExpression(node.right, ctx),
    );
  }

  /* --- "+" operator: needs type resolution --- */

  /* Step 1: try to resolve types from AST shape alone */
  const leftIsNumericAST = isNumericAST(node.left);
  const rightIsNumericAST = isNumericAST(node.right);
  const leftIsStringAST = isStringAST(node.left);
  const rightIsStringAST = isStringAST(node.right);

  /* Step 2: transform both sides so we can consult the symbol table */
  const leftIR = transformExpression(node.left, ctx);
  const rightIR = transformExpression(node.right, ctx);

  const leftType = inferIRType(leftIR, ctx.types);
  const rightType = inferIRType(rightIR, ctx.types);

  /* Both sides are definitively numeric → emit C integer arithmetic */
  if (
    (leftIsNumericAST || leftType === "number") &&
    (rightIsNumericAST || rightType === "number")
  ) {
    return IR.IRArithmetic("+", leftIR, rightIR);
  }

  /* At least one side is definitively a string → string concatenation */
  if (
    leftIsStringAST || rightIsStringAST ||
    leftType === "string" || rightType === "string"
  ) {
    /* Rewrite as IRConcat — same code path as template literals → snprintf */
    return IR.IRConcat([leftIR, rightIR]);
  }

  /* Both sides have unknown types (e.g. two unresolved identifiers) */
  throw new Error(
    `cerver: '+' with operands of unknown type — cannot determine whether this is ` +
    `numeric addition or string concatenation. ` +
    `Declare variables with explicit initial values so the type can be inferred, ` +
    `or use a template literal (\`...\${expression}...\`) for string concatenation.`,
  );
}

/* ------------------------------------------------------------------ */
/*  Assignment / Update                                                */
/* ------------------------------------------------------------------ */

function transformAssignmentExpr(node, ctx) {
  if (!node.left || node.left.type !== "Identifier") {
    return IR.IRStringLiteral("");
  }
  const value = transformExpression(node.right, ctx);

  /* Keep the symbol table consistent for += on string variables */
  if (node.operator === "=" && ctx.types) {
    const t = inferIRType(value, ctx.types);
    if (t !== "unknown") ctx.types.set(node.left.name, t);
  }

  return IR.IRAssignment(node.left.name, node.operator, value);
}

function transformUpdateExpr(node) {
  if (!node.argument || node.argument.type !== "Identifier") {
    return IR.IRStringLiteral("");
  }
  return IR.IRUpdate(node.argument.name, node.operator, node.prefix);
}

/* ------------------------------------------------------------------ */
/*  Member expressions                                                 */
/* ------------------------------------------------------------------ */

/**
 * Transform member expressions.
 *
 * Handles:
 *   req.params.key  → IRParamAccess("key")
 *   req.query.x     → IRQueryAccess("x")
 *   req.headers.x   → IRHeaderAccess("x")
 *   str.length      → IRStringOp("length", str, [], "number")
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

  /* str.length — property access, not a call */
  if (!node.computed) {
    const prop = node.property.name;
    if (prop === "length") {
      const obj = transformExpression(node.object, ctx);
      return IR.IRStringOp("length", obj, [], "number");
    }
  }

  return IR.IRStringLiteral("");
}

/* ------------------------------------------------------------------ */
/*  Call expressions                                                   */
/* ------------------------------------------------------------------ */

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
  if (node.callee.type === "Identifier" && node.callee.name === "fetch") {
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
        } else if (
          key === "headers" &&
          prop.value.type === "ObjectExpression"
        ) {
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

  /* String method calls: str.toLowerCase(), str.includes(n), etc. */
  if (
    node.callee.type === "MemberExpression" &&
    !node.callee.computed
  ) {
    const methodName = node.callee.property.name;
    const meta = STRING_METHODS[methodName];

    if (meta) {
      const obj = transformExpression(node.callee.object, ctx);
      const args = node.arguments.map((a) => transformExpression(a, ctx));
      return IR.IRStringOp(methodName, obj, args, meta.returnType);
    }

    /* Generic method call — pass through as IRCall (for res.* etc.) */
    const obj = transformExpression(node.callee.object, ctx);
    const args = node.arguments.map((a) => transformExpression(a, ctx));
    return IR.IRCall(obj, methodName, args);
  }

  return IR.IRStringLiteral("");
}

/* ------------------------------------------------------------------ */
/*  Template literals                                                  */
/* ------------------------------------------------------------------ */

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
