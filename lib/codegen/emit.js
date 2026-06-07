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
    .replace(/^\//, "") /* remove leading slash */
    .replace(/\//g, "_") /* / → _ */
    .replace(/:/g, "") /* remove : from params */
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_") /* collapse multiple underscores */
    .replace(/_$/, ""); /* remove trailing underscore */

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
      const cOp =
        expr.operator === "==="
          ? "=="
          : expr.operator === "!=="
            ? "!="
            : expr.operator;
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

    case "Assignment": {
      const rhs = emitExpression(expr.value);
      return `(${expr.name} ${expr.operator} ${rhs})`;
    }

    case "Update": {
      const op = expr.operator;
      return expr.prefix ? `(${op}${expr.name})` : `(${expr.name}${op})`;
    }

    case "Arithmetic": {
      /* Numeric C arithmetic — both sides are known numeric */
      const left = emitExpression(expr.left);
      const right = emitExpression(expr.right);
      return `(${left} ${expr.operator} ${right})`;
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
        "cerver: template literal interpolation must be emitted in statement context",
      );
    }

    case "StringOp": {
      /*
       * String-returning ops must be emitted at statement level (need a buffer).
       * Number-returning ops can be emitted inline.
       */
      if (expr.returnType === "number") {
        return emitStringOpInline(expr);
      }
      throw new Error(
        `cerver: string.${expr.method}() returns a string and must be used as a ` +
        `direct variable initializer or return value, not inside a larger expression.`,
      );
    }

    case "Call": {
      /* res.text(status, body) etc. */
      if (expr.object === "res") {
        const fnName = `cerver_res_${expr.method}`;
        const args = expr.args.map(emitExpression);
        return `${fnName}(res, ${args.join(", ")})`;
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
          "cerver: fetch() with headers must be emitted in statement context",
        );
      }

      return `cerver_fetch(${urlCode}, ${methodCode}, ${bodyCode}, NULL)`;
    }

    default:
      return '""';
  }
}

function emitAssignmentExpression(expr) {
  const rhs = emitExpression(expr.value);
  return `${expr.name} ${expr.operator} ${rhs}`;
}

function emitUpdateExpression(expr) {
  const op = expr.operator;
  return expr.prefix ? `${op}${expr.name}` : `${expr.name}${op}`;
}

function emitForClause(node, ctx) {
  if (!node) return "";

  if (node.type === "Variable") {
    if (node.initExpr) {
      assertInlineExpression(node.initExpr);
    }
    const val = node.initExpr ? emitExpression(node.initExpr) : "0";
    if (node.valueType === "number") {
      return `int ${node.name} = ${val}`;
    }
    return `const char *${node.name} = ${val}`;
  }

  if (node.type === "Assignment") {
    assertInlineExpression(node.value);
    return emitAssignmentExpression(node);
  }

  if (node.type === "Update") {
    return emitUpdateExpression(node);
  }

  assertInlineExpression(node);
  return emitExpression(node);
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
  return (
    expr &&
    expr.type === "Concat" &&
    expr.parts.every((p) => p.type === "StringLiteral")
  );
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
      (node) => node.type === "Concat" && !allLiteralConcat(node),
    )
  ) {
    throw new Error(
      "cerver: template literal interpolation is only supported as a direct return value or variable initializer",
    );
  }

  if (containsExpr(expr, (node) => node.type === "Fetch")) {
    throw new Error(
      "cerver: fetch() is only supported as a direct return value or variable initializer",
    );
  }

  if (
    containsExpr(
      expr,
      (node) => node.type === "StringOp" && node.returnType === "string",
    )
  ) {
    throw new Error(
      "cerver: string-returning methods (toLowerCase, toUpperCase, trim, slice, replace) " +
      "are only supported as a direct return value or variable initializer",
    );
  }

  if (
    containsExpr(
      expr,
      (node) => node.type === "Assignment" || node.type === "Update",
    )
  ) {
    throw new Error(
      "cerver: assignments are only supported as standalone statements or for-loop clauses",
    );
  }
}

function isNumberFormatExpr(expr) {
  return (
    expr &&
    (expr.type === "NumberLiteral" ||
      expr.type === "Comparison" ||
      expr.type === "Logical" ||
      expr.type === "Arithmetic" ||
      (expr.type === "StringOp" && expr.returnType === "number"))
  );
}

/**
 * Emit a number-returning string operation inline (safe for expression context).
 * Covers: includes, startsWith, endsWith, indexOf, length.
 */
function emitStringOpInline(expr) {
  const obj = emitExpression(expr.object);
  const arg0 = expr.args[0] ? emitExpression(expr.args[0]) : '""';
  const arg1 = expr.args[1] ? emitExpression(expr.args[1]) : null;

  switch (expr.method) {
    case "includes":
      return `(strstr(${obj}, ${arg0}) != NULL)`;

    case "startsWith":
      return `(strncmp(${obj}, ${arg0}, strlen(${arg0})) == 0)`;

    case "endsWith":
      return `cerver_str_endswith(${obj}, ${arg0})`;

    case "indexOf":
      return `cerver_str_indexof(${obj}, ${arg0})`;

    case "length":
      return `((int)strlen(${obj}))`;

    default:
      return "0";
  }
}

/**
 * Emit a heap-allocated string op result into a named buffer.
 * Covers: toLowerCase, toUpperCase, trim, slice, replace.
 * Returns lines of C code; varName receives the result pointer.
 */
function emitStringOpBlock(expr, pad, varName) {
  const obj = emitExpression(expr.object);
  const arg0 = expr.args[0] ? emitExpression(expr.args[0]) : null;
  const arg1 = expr.args[1] ? emitExpression(expr.args[1]) : null;

  let call;
  switch (expr.method) {
    case "toLowerCase":
      call = `cerver_str_tolower(${obj})`;
      break;
    case "toUpperCase":
      call = `cerver_str_toupper(${obj})`;
      break;
    case "trim":
      call = `cerver_str_trim(${obj})`;
      break;
    case "slice":
      call = `cerver_str_slice(${obj}, ${arg0 || "0"}, ${arg1 !== null ? arg1 : "-1"})`;
      break;
    case "replace":
      call = `cerver_str_replace(${obj}, ${arg0 || '""'}, ${arg1 || '""'})`;
      break;
    default:
      call = `""` ;
  }

  return [`${pad}char *${varName} = ${call};`];
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

  const lenVarName = `${varName}_len`;
  lines.push(`${pad}int ${lenVarName} = snprintf(NULL, 0, ${format}${argList});`);
  lines.push(`${pad}char *${varName} = malloc(${lenVarName} + 1);`);
  lines.push(`${pad}int ${varName}_owned = (${varName} != NULL);`);
  lines.push(`${pad}if (${varName}) {`);
  lines.push(`${pad}    snprintf(${varName}, ${lenVarName} + 1, ${format}${argList});`);
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
  const methodCode = fetchExpr.method
    ? emitExpression(fetchExpr.method)
    : "NULL";
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
      lines.push(
        `${pad}snprintf(${varName}_h${i}, sizeof(${varName}_h${i}), "%s: %s", ${hKey}, ${hVal});`,
      );
    }
    /* NULL-terminated array */
    lines.push(`${pad}const char *${varName}_hdrs[] = {`);
    for (let i = 0; i < count; i++) {
      lines.push(`${pad}    ${varName}_h${i},`);
    }
    lines.push(`${pad}    NULL`);
    lines.push(`${pad}};`);
    lines.push(
      `${pad}char *${varName} = cerver_fetch(${urlCode}, ${methodCode}, ${bodyCode}, ${varName}_hdrs);`,
    );
  } else {
    lines.push(
      `${pad}char *${varName} = cerver_fetch(${urlCode}, ${methodCode}, ${bodyCode}, NULL);`,
    );
  }

  return { lines, varName };
}

function emitStatement(stmt, level, ctx) {
  ctx = ensureEmitContext(ctx);
  if (!stmt) return [];
  const pad = indent(level);
  const lines = [];

  const genCleanup = (padStr, skipVar = null) => {
    const cl = [];
    for (const ownedVar of ctx.ownedStrings) {
      if (ownedVar !== skipVar) {
        cl.push(`${padStr}if (${ownedVar}_owned) free((void *)${ownedVar});`);
      }
    }
    return cl;
  };

  const genOomCheck = (varName) => {
    const oomPad = pad + "    ";
    return [
      `${pad}if (!${varName}) {`,
      `${oomPad}cerver_res_text(res, 500, "Internal Server Error (OOM)");`,
      ...genCleanup(oomPad, varName),
      `${oomPad}return;`,
      `${pad}}`
    ];
  };

  switch (stmt.type) {
    case "Return": {
      const fnName = `cerver_res_${stmt.responseType}`;
      const returnedVarName = (stmt.value && stmt.value.type === "Identifier") ? stmt.value.name : null;

      /* Check if the return value involves a fetch() call */
      if (stmt.value && stmt.value.type === "Fetch") {
        const tempName = `_fetch_res_${ctx.fetchVarCounter++}`;
        const fetchBlock = emitFetchBlock(stmt.value, pad, tempName);
        lines.push(...fetchBlock.lines);
        lines.push(...genOomCheck(tempName));
        lines.push(`${pad}${fnName}(res, ${stmt.status}, ${tempName});`);
        lines.push(`${pad}res->_body_owned = 1;`);
        lines.push(...genCleanup(pad, tempName));
        lines.push(`${pad}return;`);
      } else if (
        stmt.value &&
        stmt.value.type === "Concat" &&
        !allLiteralConcat(stmt.value)
      ) {
        const tempName = `_concat_res_${ctx.concatVarCounter++}`;
        lines.push(...emitConcatBlock(stmt.value, pad, tempName));
        lines.push(...genOomCheck(tempName));
        lines.push(`${pad}${fnName}(res, ${stmt.status}, ${tempName});`);
        lines.push(`${pad}if (${tempName}_owned) res->_body_owned = 1;`);
        lines.push(...genCleanup(pad, tempName));
        lines.push(`${pad}return;`);
      } else if (
        stmt.value &&
        stmt.value.type === "StringOp" &&
        stmt.value.returnType === "string"
      ) {
        /* Heap-allocated string op (tolower, toupper, trim, slice, replace) */
        const tempName = `_strop_res_${ctx.concatVarCounter++}`;
        lines.push(...emitStringOpBlock(stmt.value, pad, tempName));
        lines.push(...genOomCheck(tempName));
        lines.push(`${pad}${fnName}(res, ${stmt.status}, ${tempName});`);
        lines.push(`${pad}if (${tempName}_owned) res->_body_owned = 1;`);
        lines.push(...genCleanup(pad, tempName));
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
        lines.push(...genCleanup(pad, returnedVarName));
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

    case "While": {
      assertInlineExpression(stmt.condition);
      const cond = emitExpression(stmt.condition);
      lines.push(`${pad}while (${cond}) {`);
      if (stmt.body) {
        for (const s of stmt.body) {
          lines.push(...emitStatement(s, level + 1, ctx));
        }
      }
      lines.push(`${pad}}`);
      break;
    }

    case "For": {
      if (stmt.condition) {
        assertInlineExpression(stmt.condition);
      }
      const initCode = emitForClause(stmt.init, ctx);
      const condCode = stmt.condition ? emitExpression(stmt.condition) : "";
      const updateCode = emitForClause(stmt.update, ctx);
      lines.push(`${pad}for (${initCode}; ${condCode}; ${updateCode}) {`);
      if (stmt.body) {
        for (const s of stmt.body) {
          lines.push(...emitStatement(s, level + 1, ctx));
        }
      }
      lines.push(`${pad}}`);
      break;
    }

    case "Variable": {
      /* Check if the variable is initialized with a fetch() call */
      if (stmt.initExpr && stmt.initExpr.type === "Fetch") {
        const fetchBlock = emitFetchBlock(stmt.initExpr, pad, stmt.name);
        lines.push(...fetchBlock.lines);
        lines.push(...genOomCheck(stmt.name));
        ctx.ownedStrings.add(stmt.name);
      } else if (
        stmt.initExpr &&
        stmt.initExpr.type === "Concat" &&
        !allLiteralConcat(stmt.initExpr)
      ) {
        lines.push(...emitConcatBlock(stmt.initExpr, pad, stmt.name));
        lines.push(...genOomCheck(stmt.name));
        ctx.ownedStrings.add(stmt.name);
      } else if (
        stmt.initExpr &&
        stmt.initExpr.type === "StringOp" &&
        stmt.initExpr.returnType === "string"
      ) {
        /* Heap-allocated string op result stored in a mutable char * */
        lines.push(...emitStringOpBlock(stmt.initExpr, pad, stmt.name));
        lines.push(...genOomCheck(stmt.name));
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

    case "Assignment": {
      assertInlineExpression(stmt.value);
      lines.push(`${pad}${emitAssignmentExpression(stmt)};`);
      break;
    }

    case "Update": {
      lines.push(`${pad}${emitUpdateExpression(stmt)};`);
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
