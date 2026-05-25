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
      /* For template literals, we generate snprintf into a stack buffer */
      /* This is handled specially in emitStatement when part of a return */
      /* For simple cases, just concatenate literals */
      const parts = expr.parts.map(emitExpression);
      /* If all parts are string literals, we can concatenate at compile time */
      const allLiteral = expr.parts.every((p) => p.type === "StringLiteral");
      if (allLiteral) {
        return cString(expr.parts.map((p) => p.value).join(""));
      }
      /* Otherwise, we'll need a runtime sprintf — return a placeholder */
      /* The generator will handle this at the statement level */
      return `__concat_${parts.length}__`;
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
       * For inline expression contexts (like variable init), we emit without
       * custom headers when headers are present — the statement emitter
       * will handle the full form.
       */
      const urlCode = emitExpression(expr.url);
      const methodCode = expr.method ? emitExpression(expr.method) : "NULL";
      const bodyCode = expr.body ? emitExpression(expr.body) : "NULL";

      if (expr.headers && expr.headers.length > 0) {
        /* Flag that this needs statement-level emission */
        return `__fetch_with_headers__`;
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
    expr.type === "Identifier"
  );
}

/**
 * Emit a statement into C code lines.
 * Returns an array of C source lines.
 */

/* Counter for unique fetch variable names */
let fetchVarCounter = 0;

/**
 * Emit the headers array and cerver_fetch call for a Fetch expression.
 * Returns { lines: string[], varName: string } where varName holds the result.
 */
function emitFetchBlock(fetchExpr, pad, varName) {
  const lines = [];
  const urlCode = emitExpression(fetchExpr.url);
  const methodCode = fetchExpr.method ? emitExpression(fetchExpr.method) : "NULL";
  const bodyCode = fetchExpr.body ? emitExpression(fetchExpr.body) : "NULL";

  if (fetchExpr.headers && fetchExpr.headers.length > 0) {
    const count = fetchExpr.headers.length;
    /* Build the headers array on the stack */
    for (let i = 0; i < count; i++) {
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

function emitStatement(stmt, level) {
  if (!stmt) return [];
  const pad = indent(level);
  const lines = [];

  switch (stmt.type) {
    case "Return": {
      const fnName = `cerver_res_${stmt.responseType}`;

      /* Check if the return value involves a fetch() call */
      if (stmt.value && stmt.value.type === "Fetch") {
        const tempName = `_fetch_res_${fetchVarCounter++}`;
        const fetchBlock = emitFetchBlock(stmt.value, pad, tempName);
        lines.push(...fetchBlock.lines);
        lines.push(`${pad}${fnName}(res, ${stmt.status}, ${tempName});`);
        lines.push(`${pad}free(${tempName});`);
        lines.push(`${pad}return;`);
      } else {
        const valueCode = emitExpression(stmt.value);
        lines.push(`${pad}${fnName}(res, ${stmt.status}, ${valueCode});`);
        lines.push(`${pad}return;`);
      }
      break;
    }

    case "If": {
      const cond = emitExpression(stmt.condition);
      lines.push(`${pad}if (${cond}) {`);

      if (stmt.thenBody) {
        for (const s of stmt.thenBody) {
          lines.push(...emitStatement(s, level + 1));
        }
      }

      if (stmt.elseBody && stmt.elseBody.length > 0) {
        /* Check if it's an else-if */
        if (stmt.elseBody.length === 1 && stmt.elseBody[0].type === "If") {
          lines.push(`${pad}} else `);
          /* Emit the else-if inline */
          const elseIfLines = emitStatement(stmt.elseBody[0], level);
          /* Remove leading whitespace from first line to make it "} else if" */
          if (elseIfLines.length > 0) {
            elseIfLines[0] = elseIfLines[0].trimStart();
            lines[lines.length - 1] += elseIfLines[0];
            lines.push(...elseIfLines.slice(1));
          }
        } else {
          lines.push(`${pad}} else {`);
          for (const s of stmt.elseBody) {
            lines.push(...emitStatement(s, level + 1));
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
      } else {
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
  emitExpression,
  emitStatement,
  isStringExpr,
};
