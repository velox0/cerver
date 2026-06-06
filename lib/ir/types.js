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
    method /* "GET" | "POST" */,
    urlPath /* "/item/:id" */,
    params /* ["id"] — extracted from dynamic segments */,
    handler /* IRHandler */,
  };
}

/**
 * A route handler function body.
 */
function IRHandler(variables, body) {
  return {
    type: "Handler",
    variables /* IRVariable[] */,
    body /* IRStatement[] */,
  };
}

/**
 * A local variable declaration.
 */
function IRVariable(name, valueType, initExpr) {
  return {
    type: "Variable",
    name /* C-safe variable name */,
    valueType /* "string" | "number" */,
    initExpr /* IRExpression — the initializer */,
  };
}

/**
 * An if/else statement.
 */
function IRIf(condition, thenBody, elseBody) {
  return {
    type: "If",
    condition /* IRExpression */,
    thenBody /* IRStatement[] */,
    elseBody /* IRStatement[] | null */,
  };
}

/**
 * A while loop.
 */
function IRWhile(condition, body) {
  return {
    type: "While",
    condition /* IRExpression */,
    body /* IRStatement[] */,
  };
}

/**
 * A for loop.
 */
function IRFor(init, condition, update, body) {
  return {
    type: "For",
    init /* IRStatement | IRExpression | null */,
    condition /* IRExpression | null */,
    update /* IRStatement | IRExpression | null */,
    body /* IRStatement[] */,
  };
}

/**
 * A return statement that sends an HTTP response.
 */
function IRReturn(responseType, status, value) {
  return {
    type: "Return",
    responseType /* "text" | "json" | "html" */,
    status /* number */,
    value /* IRExpression — the response body */,
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
    operator /* "==" | "!=" | "===" | "!==" */,
    left /* IRExpression */,
    right /* IRExpression */,
  };
}

/**
 * A conditional expression (test ? consequent : alternate).
 */
function IRConditional(test, consequent, alternate) {
  return {
    type: "Conditional",
    test,
    consequent,
    alternate,
  };
}

/**
 * A logical expression (&&, ||).
 */
function IRLogical(operator, left, right) {
  return {
    type: "Logical",
    operator /* "&&" | "||" */,
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
 * An assignment expression (x = y, x += y, etc.).
 */
function IRAssignment(name, operator, value) {
  return {
    type: "Assignment",
    name /* string */,
    operator /* "=" | "+=" | "-=" | "*=" | "/=" | "%=" */,
    value /* IRExpression */,
  };
}

/**
 * An update expression (x++, --x).
 */
function IRUpdate(name, operator, prefix) {
  return {
    type: "Update",
    name /* string */,
    operator /* "++" | "--" */,
    prefix /* boolean */,
  };
}

/**
 * Access to a request field like req.method or req.path.
 */
function IRRequestField(fieldName) {
  return {
    type: "RequestField",
    fieldName,
  };
}

/**
 * A template literal (string interpolation).
 */
function IRConcat(parts) {
  return {
    type: "Concat",
    parts /* IRExpression[] — mix of literals and expressions */,
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

/**
 * An outbound HTTP fetch call.
 */
function IRFetch(url, method, body, headers) {
  return {
    type: "Fetch",
    url /* IRExpression — the URL */,
    method /* IRExpression | null — "GET", "POST", etc. */,
    body /* IRExpression | null — request body */,
    headers /* Array<{key: IRExpression, value: IRExpression}> | null */,
  };
}

/**
 * A numeric arithmetic expression (+, -, *, /, %).
 * Distinct from IRComparison (which uses strcmp for strings).
 * Both operands must be numeric.
 */
function IRArithmetic(operator, left, right) {
  return {
    type: "Arithmetic",
    operator /* "+" | "-" | "*" | "/" | "%" */,
    left /* IRExpression */,
    right /* IRExpression */,
  };
}

/**
 * A compiled string method call.
 *
 * @param {string} method    - The JS method name ("toLowerCase", "includes", etc.)
 * @param {object} object    - IR expression for the string being operated on
 * @param {object[]} args    - IR expressions for method arguments
 * @param {string} returnType - "string" | "number" — drives emit strategy
 */
function IRStringOp(method, object, args, returnType) {
  return {
    type: "StringOp",
    method,
    object,
    args,
    returnType /* "string" (heap-alloc) | "number" (inline) */,
  };
}


module.exports = {
  IRRoute,
  IRHandler,
  IRVariable,
  IRIf,
  IRWhile,
  IRFor,
  IRReturn,
  IRStringLiteral,
  IRNumberLiteral,
  IRComparison,
  IRConditional,
  IRLogical,
  IRUnary,
  IRParamAccess,
  IRQueryAccess,
  IRHeaderAccess,
  IRIdentifier,
  IRAssignment,
  IRUpdate,
  IRRequestField,
  IRConcat,
  IRCall,
  IRFetch,
  IRArithmetic,
  IRStringOp,
};

