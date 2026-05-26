"use strict";

/**
 * emit.js — Low-level C code emission helpers.
 *
 * Builds C source strings from IR nodes with proper formatting,
 * escaping, and indentation.
 */

/**
 * Escape a string for use as a C string literal.
 */
function escapeC(str) {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\0/g, "\\0");
}

/**
 * Generate a C string literal from a JS string.
 */
function cString(str) {
  return `"${escapeC(str)}"`;
}

/**
 * Generate an indented line.
 */
function indent(level) {
  return "    ".repeat(level);
}

/**
 * Convert a URL path + method into a C-safe function name.
 * e.g. "GET", "/item/:id" → "handle_GET_item_id"
 */
function handlerName(method, urlPath) {
  const safe = urlPath
    .replace(/^\//, "")           /* remove leading slash */
    .replace(/\//g, "_")          /* / → _ */
    .replace(/:/g, "")            /* remove : from params */
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")          /* collapse multiple underscores */
    .replace(/_$/, "");           /* remove trailing underscore */

  if (!safe) return `handle_${method}_index`;
  return `handle_${method}_${safe}`;
}

/**
 * Emit a C expression from an IR expression node.
 */
function emitExpression(expr) {
  if (!expr) return '""';

  switch (expr.type) {
    case "StringLiteral":
      return cString(expr.value);

    case "NumberLiteral":
      return String(expr.value);

    case "Identifier":
      return expr.name;

    case "RequestField":
      if (expr.fieldName === "method") return "req->method";
      if (expr.fieldName === "path") return "req->path";
      return '""';

    case "ParamAccess":
      return `cerver_req_param(req, ${cString(expr.paramName)})`;

    case "QueryAccess":
      return `cerver_req_query(req, ${cString(expr.queryName)})`;

    case "HeaderAccess":
      return `cerver_req_header(req, ${cString(expr.headerName)})`;

    case "Comparison": {
      const left = emitExpression(expr.left);
      const right = emitExpression(expr.right);

      /* String comparisons use strcmp */
      if (isStringExpr(expr.left) || isStringExpr(expr.right)) {
        if (expr.operator === "===" || expr.operator === "==") {
          return `(strcmp(${left}, ${right}) == 0)`;
        }
        if (expr.operator === "!==" || expr.operator === "!=") {
          return `(strcmp(${left}, ${right}) != 0)`;
        }
      }

      /* Numeric comparisons */
      const cOp = expr.operator === "===" ? "==" : expr.operator === "!==" ? "!=" : expr.operator;
      return `(${left} ${cOp} ${right})`;
    }

    case "Conditional": {
      const test = emitExpression(expr.test);
      const consequent = emitExpression(expr.consequent);
      const alternate = emitExpression(expr.alternate);
      return `(${test} ? ${consequent} : ${alternate})`;
    }

    case "Logical": {
      const left = emitExpression(expr.left);
      const right = emitExpression(expr.right);
      return `(${left} ${expr.operator} ${right})`;
    }

    case "Unary": {
      const arg = emitExpression(expr.argument);
      return `(${expr.operator}${arg})`;
    }

    case "Concat": {
      /* Interpolated template literals need statement-level snprintf setup. */
      /* This is handled specially in emitStatement when part of a return */
      /* For simple cases, just concatenate literals */
      /* If all parts are string literals, we can concatenate at compile time */
      const allLiteral = expr.parts.every((p) => p.type === "StringLiteral");
      if (allLiteral) {
        return cString(expr.parts.map((p) => p.value).join(""));
      }
      throw new Error(
        "cerver: template literal interpolation must be emitted in statement context"
      );
    }

    case "Call": {
      /* res.text(status, body) etc. */
      if (expr.object === "res") {
        const fnName = `cerver_res_${expr.method}`;
        const args = expr.args.map(emitExpression);
        return `${fnName}(res, ${args.join(", ")})`;
      }

      /* String method calls — map to C equivalents */
      if (expr.method === "toLowerCase" || expr.method === "toUpperCase") {
        /* These would need a helper — for now return the object as-is */
        return emitExpression(expr.object);
      }
      if (expr.method === "includes") {
        const haystack = emitExpression(expr.object);
        const needle = expr.args[0] ? emitExpression(expr.args[0]) : '""';
        return `(strstr(${haystack}, ${needle}) != NULL)`;
      }

      return '""';
    }

    case "Fetch": {
      /*
       * Fetch is a special expression — it returns a call to cerver_fetch().
       * The generated code will be: cerver_fetch(url, method, body, headers)
       * where headers is either NULL or a stack-allocated array.
       *
       * Because the actual headers array setup requires multiple statements,
       * simple inline expressions won't work for headers. We handle headers
       * at the statement level in emitStatement instead.
       * Inline expression contexts cannot represent that safely, so the
       * statement emitter must handle the full form.
       */
      const urlCode = emitExpression(expr.url);
      const methodCode = expr.method ? emitExpression(expr.method) : "NULL";
      const bodyCode = expr.body ? emitExpression(expr.body) : "NULL";

      if (expr.headers && expr.headers.length > 0) {
        throw new Error(
          "cerver: fetch() with headers must be emitted in statement context"
        );
      }

      return `cerver_fetch(${urlCode}, ${methodCode}, ${bodyCode}, NULL)`;
    }

    default:
      return '""';
  }
}

/**
 * Check if an IR expression evaluates to a string type.
 */
function isStringExpr(expr) {
  if (!expr) return false;
  return (
    expr.type === "StringLiteral" ||
    expr.type === "ParamAccess" ||
    expr.type === "QueryAccess" ||
    expr.type === "HeaderAccess" ||
    expr.type === "Concat" ||
    expr.type === "Identifier" ||
    expr.type === "RequestField" ||
    (expr.type === "Conditional" &&
      (isStringExpr(expr.consequent) || isStringExpr(expr.alternate)))
  );
}

/**
 * Emit a statement into C code lines.
 * Returns an array of C source lines.
 */

function createEmitContext() {
  return {
    concatVarCounter: 0,
    fetchVarCounter: 0,
    ownedStrings: new Set(),
  };
}

function ensureEmitContext(ctx) {
  if (!ctx) return createEmitContext();
  if (typeof ctx.concatVarCounter !== "number") ctx.concatVarCounter = 0;
  if (typeof ctx.fetchVarCounter !== "number") ctx.fetchVarCounter = 0;
  if (!ctx.ownedStrings) ctx.ownedStrings = new Set();
  return ctx;
}

function allLiteralConcat(expr) {
  return expr && expr.type === "Concat" &&
    expr.parts.every((p) => p.type === "StringLiteral");
}

function containsExpr(expr, predicate) {
  if (!expr || typeof expr !== "object") return false;
  if (predicate(expr)) return true;
  for (const key of Object.keys(expr)) {
    const val = expr[key];
    if (Array.isArray(val)) {
      if (val.some((item) => containsExpr(item, predicate))) return true;
    } else if (val && typeof val === "object") {
      if (containsExpr(val, predicate)) return true;
    }
  }
  return false;
}

function assertInlineExpression(expr) {
  if (
    containsExpr(
      expr,
      (node) => node.type === "Concat" && !allLiteralConcat(node)
    )
  ) {
    throw new Error(
      "cerver: template literal interpolation is only supported as a direct return value or variable initializer"
    );
  }

  if (containsExpr(expr, (node) => node.type === "Fetch")) {
    throw new Error(
      "cerver: fetch() is only supported as a direct return value or variable initializer"
    );
  }
}

function isNumberFormatExpr(expr) {
  return (
    expr &&
    (expr.type === "NumberLiteral" ||
      expr.type === "Comparison" ||
      expr.type === "Logical")
  );
}

/**
 * Emit a heap-backed string buffer for an interpolated template literal.
 * The response writer runs after handlers return, so response-bound strings
 * cannot live on the stack.
 */
function emitConcatBlock(concatExpr, pad, varName) {
  const lines = [];
  const formatParts = [];
  const args = [];

  for (const part of concatExpr.parts) {
    if (part.type === "StringLiteral") {
      formatParts.push(part.value.replace(/%/g, "%%"));
    } else {
      assertInlineExpression(part);
      formatParts.push(isNumberFormatExpr(part) ? "%d" : "%s");
      args.push(emitExpression(part));
    }
  }

  const format = cString(formatParts.join(""));
  const argList = args.length > 0 ? `, ${args.join(", ")}` : "";

  lines.push(`${pad}char *${varName} = malloc(1024);`);
  lines.push(`${pad}int ${varName}_owned = (${varName} != NULL);`);
  lines.push(`${pad}if (${varName}) {`);
  lines.push(`${pad}    snprintf(${varName}, 1024, ${format}${argList});`);
  lines.push(`${pad}} else {`);
  lines.push(`${pad}    ${varName} = "";`);
  lines.push(`${pad}}`);

  return lines;
}

/**
 * Emit the headers array and cerver_fetch call for a Fetch expression.
 * Returns { lines: string[], varName: string } where varName holds the result.
 */
function emitFetchBlock(fetchExpr, pad, varName) {
  const lines = [];
  assertInlineExpression(fetchExpr.url);
  if (fetchExpr.method) assertInlineExpression(fetchExpr.method);
  if (fetchExpr.body) assertInlineExpression(fetchExpr.body);
  const urlCode = emitExpression(fetchExpr.url);
  const methodCode = fetchExpr.method ? emitExpression(fetchExpr.method) : "NULL";
  const bodyCode = fetchExpr.body ? emitExpression(fetchExpr.body) : "NULL";

  if (fetchExpr.headers && fetchExpr.headers.length > 0) {
    const count = fetchExpr.headers.length;
    /* Build the headers array on the stack */
    for (let i = 0; i < count; i++) {
      assertInlineExpression(fetchExpr.headers[i].key);
      assertInlineExpression(fetchExpr.headers[i].value);
      const hKey = emitExpression(fetchExpr.headers[i].key);
      const hVal = emitExpression(fetchExpr.headers[i].value);
      /* Format: "Key: Value" */
      lines.push(`${pad}char ${varName}_h${i}[512];`);
      lines.push(`${pad}snprintf(${varName}_h${i}, sizeof(${varName}_h${i}), "%s: %s", ${hKey}, ${hVal});`);
    }
    /* NULL-terminated array */
    lines.push(`${pad}const char *${varName}_hdrs[] = {`);
    for (let i = 0; i < count; i++) {
      lines.push(`${pad}    ${varName}_h${i},`);
    }
    lines.push(`${pad}    NULL`);
    lines.push(`${pad}};`);
    lines.push(`${pad}char *${varName} = cerver_fetch(${urlCode}, ${methodCode}, ${bodyCode}, ${varName}_hdrs);`);
  } else {
    lines.push(`${pad}char *${varName} = cerver_fetch(${urlCode}, ${methodCode}, ${bodyCode}, NULL);`);
  }

  return { lines, varName };
}

function emitStatement(stmt, level, ctx) {
  ctx = ensureEmitContext(ctx);
  if (!stmt) return [];
  const pad = indent(level);
  const lines = [];

  switch (stmt.type) {
    case "Return": {
      const fnName = `cerver_res_${stmt.responseType}`;

      /* Check if the return value involves a fetch() call */
      if (stmt.value && stmt.value.type === "Fetch") {
        const tempName = `_fetch_res_${ctx.fetchVarCounter++}`;
        const fetchBlock = emitFetchBlock(stmt.value, pad, tempName);
        lines.push(...fetchBlock.lines);
        lines.push(`${pad}${fnName}(res, ${stmt.status}, ${tempName});`);
        lines.push(`${pad}res->_body_owned = 1;`);
        lines.push(`${pad}return;`);
      } else if (stmt.value && stmt.value.type === "Concat" && !allLiteralConcat(stmt.value)) {
        const tempName = `_concat_res_${ctx.concatVarCounter++}`;
        lines.push(...emitConcatBlock(stmt.value, pad, tempName));
        lines.push(`${pad}${fnName}(res, ${stmt.status}, ${tempName});`);
        lines.push(`${pad}if (${tempName}_owned) res->_body_owned = 1;`);
        lines.push(`${pad}return;`);
      } else {
        assertInlineExpression(stmt.value);
        const valueCode = emitExpression(stmt.value);
        lines.push(`${pad}${fnName}(res, ${stmt.status}, ${valueCode});`);
        if (
          stmt.value &&
          stmt.value.type === "Identifier" &&
          ctx.ownedStrings.has(stmt.value.name)
        ) {
          lines.push(`${pad}res->_body_owned = 1;`);
        }
        lines.push(`${pad}return;`);
      }
      break;
    }

    case "If": {
      assertInlineExpression(stmt.condition);
      const cond = emitExpression(stmt.condition);
      lines.push(`${pad}if (${cond}) {`);

      if (stmt.thenBody) {
        for (const s of stmt.thenBody) {
          lines.push(...emitStatement(s, level + 1, ctx));
        }
      }

      if (stmt.elseBody && stmt.elseBody.length > 0) {
        /* Check if it's an else-if */
        if (stmt.elseBody.length === 1 && stmt.elseBody[0].type === "If") {
          lines.push(`${pad}} else `);
          /* Emit the else-if inline */
          const elseIfLines = emitStatement(stmt.elseBody[0], level, ctx);
          /* Remove leading whitespace from first line to make it "} else if" */
          if (elseIfLines.length > 0) {
            elseIfLines[0] = elseIfLines[0].trimStart();
            lines[lines.length - 1] += elseIfLines[0];
            lines.push(...elseIfLines.slice(1));
          }
        } else {
          lines.push(`${pad}} else {`);
          for (const s of stmt.elseBody) {
            lines.push(...emitStatement(s, level + 1, ctx));
          }
          lines.push(`${pad}}`);
        }
      } else {
        lines.push(`${pad}}`);
      }
      break;
    }

    case "Variable": {
      /* Check if the variable is initialized with a fetch() call */
      if (stmt.initExpr && stmt.initExpr.type === "Fetch") {
        const fetchBlock = emitFetchBlock(stmt.initExpr, pad, stmt.name);
        lines.push(...fetchBlock.lines);
        ctx.ownedStrings.add(stmt.name);
      } else if (stmt.initExpr && stmt.initExpr.type === "Concat" && !allLiteralConcat(stmt.initExpr)) {
        lines.push(...emitConcatBlock(stmt.initExpr, pad, stmt.name));
        ctx.ownedStrings.add(stmt.name);
      } else {
        assertInlineExpression(stmt.initExpr);
        const val = emitExpression(stmt.initExpr);
        if (stmt.valueType === "number") {
          lines.push(`${pad}int ${stmt.name} = ${val};`);
        } else {
          lines.push(`${pad}const char *${stmt.name} = ${val};`);
        }
      }
      break;
    }

    case "Call": {
      assertInlineExpression(stmt);
      lines.push(`${pad}${emitExpression(stmt)};`);
      break;
    }

    default:
      break;
  }

  return lines;
}

module.exports = {
  escapeC,
  cString,
  indent,
  handlerName,
  createEmitContext,
  emitExpression,
  emitStatement,
  isStringExpr,
};
