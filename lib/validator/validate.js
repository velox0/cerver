"use strict";

const walk = require("acorn-walk");

/**
 * Allowed AST node types in cerver route files.
 * Anything not in this set will be rejected.
 */
const ALLOWED_NODES = new Set([
  "Program",
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "FunctionDeclaration",
  "VariableDeclaration",
  "VariableDeclarator",
  "BlockStatement",
  "ExpressionStatement",
  "ReturnStatement",
  "IfStatement",
  "WhileStatement",
  "ForStatement",
  "BinaryExpression",
  "LogicalExpression",
  "UnaryExpression",
  "UpdateExpression",
  "CallExpression",
  "MemberExpression",
  "Identifier",
  "Literal",
  "TemplateLiteral",
  "TemplateElement",
  "ObjectExpression",
  "Property",
  "ArrayExpression",
  "ConditionalExpression",
  "AssignmentExpression",
]);

/**
 * Explicitly banned features with human-readable error messages.
 */
const BANNED_NODES = {
  AwaitExpression: "async/await is not supported",
  YieldExpression: "generators are not supported",
  ForInStatement: "for...in loops are not supported",
  ForOfStatement: "for...of loops are not supported",
  DoWhileStatement: "do...while loops are not supported",
  ClassDeclaration: "classes are not supported",
  ClassExpression: "class expressions are not supported",
  NewExpression: "the 'new' operator is not supported",
  ImportDeclaration: "runtime imports are not supported (use export functions)",
  ImportExpression: "dynamic imports are not supported",
  TryStatement: "try/catch is not supported (errors are compile-time)",
  ThrowStatement: "throw is not supported",
  WithStatement: "'with' is not supported",
  ThisExpression: "'this' is not supported",
  SwitchStatement: "switch statements are not supported (use if/else)",
  LabeledStatement: "labeled statements are not supported",
  BreakStatement: "break is not supported",
  ContinueStatement: "continue is not supported",
  ArrowFunctionExpression:
    "arrow functions are not supported (use named function exports)",
  FunctionExpression:
    "function expressions are not supported (use named function declarations)",
  SpreadElement: "spread syntax is not supported",
  RestElement: "rest parameters are not supported",
  TaggedTemplateExpression: "tagged templates are not supported",
  MetaProperty: "meta properties are not supported",
  SequenceExpression: "comma expressions are not supported",
};

/**
 * Banned function calls.
 */
const BANNED_CALLS = new Set([
  "eval",
  "Function",
  "setTimeout",
  "setInterval",
  "require",
  "import",
]);

/**
 * Validate a route file AST.
 * Throws an error with file location on first violation.
 *
 * @param {object} ast - ESTree AST from Acorn
 * @param {string} filePath - For error messages
 * @param {string} source - Original source for context
 */
function validate(ast, filePath, source) {
  const errors = [];

  function addError(node, message) {
    const loc = node.loc
      ? `${filePath}:${node.loc.start.line}:${node.loc.start.column}`
      : filePath;
    errors.push(`cerver: error: ${loc} — ${message}`);
  }

  /* Check top-level structure: only exports allowed */
  for (const node of ast.body) {
    if (
      node.type !== "ExportNamedDeclaration" &&
      node.type !== "ExportDefaultDeclaration" &&
      node.type !== "VariableDeclaration" &&
      node.type !== "ExpressionStatement"
    ) {
      addError(
        node,
        `top-level ${node.type} is not allowed (only exports and variable declarations)`,
      );
    }

    /* Validate exported functions are named GET or POST */
    if (node.type === "ExportNamedDeclaration" && node.declaration) {
      const decl = node.declaration;
      if (decl.type === "FunctionDeclaration") {
        const name = decl.id.name;
        if (!["GET", "POST"].includes(name)) {
          addError(
            decl,
            `exported function "${name}" is not a valid HTTP method (use GET or POST)`,
          );
        }

        /* Check async */
        if (decl.async) {
          addError(decl, "async functions are not supported");
        }

        /* Validate parameters: must be (req, res) */
        if (decl.params.length !== 2) {
          addError(
            decl,
            `handler function "${name}" must have exactly 2 parameters (req, res)`,
          );
        }
      }
    }
  }

  /* Walk the entire tree checking for banned features */
  walk.full(ast, (node) => {
    /* Check banned node types */
    if (BANNED_NODES[node.type]) {
      addError(node, BANNED_NODES[node.type]);
      return;
    }

    /* Check for unknown node types */
    if (!ALLOWED_NODES.has(node.type)) {
      addError(node, `unsupported syntax: ${node.type}`);
      return;
    }

    /* Check for banned function calls */
    if (node.type === "CallExpression") {
      if (
        node.callee.type === "Identifier" &&
        BANNED_CALLS.has(node.callee.name)
      ) {
        addError(node, `'${node.callee.name}()' is not allowed`);
      }
    }

    /* Validate variable declarations: only const and let */
    if (node.type === "VariableDeclaration") {
      if (node.kind === "var") {
        addError(node, "'var' is not supported (use 'const' or 'let')");
      }
      if (node.declarations.length !== 1) {
        addError(
          node,
          "multiple declarations in one statement are not supported",
        );
      }
    }

    if (node.type === "AssignmentExpression") {
      const okOps = new Set(["=", "+=", "-=", "*=", "/=", "%="]);
      if (!node.left || node.left.type !== "Identifier") {
        addError(node, "assignments must target a simple identifier");
      }
      if (!okOps.has(node.operator)) {
        addError(node, `unsupported assignment operator '${node.operator}'`);
      }
    }

    if (node.type === "UpdateExpression") {
      if (!node.argument || node.argument.type !== "Identifier") {
        addError(node, "update expressions must target a simple identifier");
      }
      if (node.operator !== "++" && node.operator !== "--") {
        addError(node, `unsupported update operator '${node.operator}'`);
      }
    }

    if (node.type === "ForStatement") {
      if (
        node.init &&
        ![
          "VariableDeclaration",
          "AssignmentExpression",
          "UpdateExpression",
          "CallExpression",
        ].includes(node.init.type)
      ) {
        addError(
          node.init,
          "for-loop init must be a variable declaration, assignment, update, or call",
        );
      }

      if (
        node.update &&
        ![
          "AssignmentExpression",
          "UpdateExpression",
          "CallExpression",
        ].includes(node.update.type)
      ) {
        addError(
          node.update,
          "for-loop update must be an assignment, update, or call",
        );
      }
    }
  });

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

module.exports = { validate };
