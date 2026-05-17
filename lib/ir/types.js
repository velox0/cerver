"use strict";

/**
 * IR type definitions for the cerver compiler.
 *
 * These are plain object constructors for the intermediate representation
 * that sits between the AST and C code generation.
 */

/**
 * A complete route definition.
 */
function IRRoute(method, urlPath, params, handler) {
  return {
    type: "Route",
    method,     /* "GET" | "POST" */
    urlPath,    /* "/item/:id" */
    params,     /* ["id"] — extracted from dynamic segments */
    handler,    /* IRHandler */
  };
}

/**
 * A route handler function body.
 */
function IRHandler(variables, body) {
  return {
    type: "Handler",
    variables,  /* IRVariable[] */
    body,       /* IRStatement[] */
  };
}

/**
 * A local variable declaration.
 */
function IRVariable(name, valueType, initExpr) {
  return {
    type: "Variable",
    name,       /* C-safe variable name */
    valueType,  /* "string" | "number" */
    initExpr,   /* IRExpression — the initializer */
  };
}

/**
 * An if/else statement.
 */
function IRIf(condition, thenBody, elseBody) {
  return {
    type: "If",
    condition,  /* IRExpression */
    thenBody,   /* IRStatement[] */
    elseBody,   /* IRStatement[] | null */
  };
}

/**
 * A return statement that sends an HTTP response.
 */
function IRReturn(responseType, status, value) {
  return {
    type: "Return",
    responseType, /* "text" | "json" | "html" */
    status,       /* number */
    value,        /* IRExpression — the response body */
  };
}

/**
 * A string literal.
 */
function IRStringLiteral(value) {
  return {
    type: "StringLiteral",
    value,
  };
}

/**
 * A number literal.
 */
function IRNumberLiteral(value) {
  return {
    type: "NumberLiteral",
    value,
  };
}

/**
 * A comparison expression.
 */
function IRComparison(operator, left, right) {
  return {
    type: "Comparison",
    operator, /* "==" | "!=" | "===" | "!==" */
    left,     /* IRExpression */
    right,    /* IRExpression */
  };
}

/**
 * A logical expression (&&, ||).
 */
function IRLogical(operator, left, right) {
  return {
    type: "Logical",
    operator, /* "&&" | "||" */
    left,
    right,
  };
}

/**
 * A unary expression (!, -).
 */
function IRUnary(operator, argument) {
  return {
    type: "Unary",
    operator,
    argument,
  };
}

/**
 * Access to a request parameter: req.params.key
 */
function IRParamAccess(paramName) {
  return {
    type: "ParamAccess",
    paramName,
  };
}

/**
 * Access to a query parameter: req.query.key
 */
function IRQueryAccess(queryName) {
  return {
    type: "QueryAccess",
    queryName,
  };
}

/**
 * Access to a request header: req.headers["user-agent"]
 */
function IRHeaderAccess(headerName) {
  return {
    type: "HeaderAccess",
    headerName,
  };
}

/**
 * A variable reference.
 */
function IRIdentifier(name) {
  return {
    type: "Identifier",
    name,
  };
}

/**
 * A template literal (string interpolation).
 */
function IRConcat(parts) {
  return {
    type: "Concat",
    parts, /* IRExpression[] — mix of literals and expressions */
  };
}

/**
 * A function call expression (for res.text, res.json, etc.)
 */
function IRCall(object, method, args) {
  return {
    type: "Call",
    object,
    method,
    args,
  };
}

module.exports = {
  IRRoute,
  IRHandler,
  IRVariable,
  IRIf,
  IRReturn,
  IRStringLiteral,
  IRNumberLiteral,
  IRComparison,
  IRLogical,
  IRUnary,
  IRParamAccess,
  IRQueryAccess,
  IRHeaderAccess,
  IRIdentifier,
  IRConcat,
  IRCall,
};
