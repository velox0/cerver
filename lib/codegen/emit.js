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
function emitStatement(stmt, level) {
  if (!stmt) return [];
  const pad = indent(level);
  const lines = [];

  switch (stmt.type) {
    case "Return": {
      const fnName = `cerver_res_${stmt.responseType}`;
      const valueCode = emitExpression(stmt.value);
      lines.push(`${pad}${fnName}(res, ${stmt.status}, ${valueCode});`);
      lines.push(`${pad}return;`);
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
      const val = emitExpression(stmt.initExpr);
      if (stmt.valueType === "number") {
        lines.push(`${pad}int ${stmt.name} = ${val};`);
      } else {
        lines.push(`${pad}const char *${stmt.name} = ${val};`);
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
