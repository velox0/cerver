<div align="center">
  <img src="templates/cerver.png" alt="Cerver Logo" width="120" />
</div>

# Cerver

A lightweight, compile-time web framework that transpiles restricted JavaScript server logic into highly optimized native C HTTP server binaries.

Cerver takes a Next.js-style file-based routing structure (written in a strict subset of JavaScript), parses it, generates equivalent C code, embeds your static assets, and compiles it all into a single, standalone executable that runs with zero Node.js dependency.

## Features

- **Compile-Time Framework**: Your JavaScript is parsed and compiled to native C. There is no JavaScript engine (like V8) or interpreter included in the final binary.
- **Microscopic Footprint**: Generated executables are typically ~50KB and start in milliseconds.
- **Single-Binary Deployment**: Static assets (HTML, CSS, JS, images) are automatically minified and embedded directly into the executable as C byte arrays.
- **Native Performance**: Uses `kqueue` (macOS) or `epoll` (Linux) event loops for high-performance non-blocking I/O.
- **File-Based Routing**: Intuitive `app/routes/` directory structure, supporting dynamic segments (e.g., `/item/[id].js`).

## Getting Started

1. Install globally (requires `gcc` or `clang` on your system):

```bash
npm i @velox0/cerver@latest
```

2. Create a new project:

```bash
cerver new my-fast-api
cd my-fast-api
```

3. Build and Run:

```bash
cerver build
cerver run
```

## Routing

Routes are defined in the `app/routes/` directory.

`app/routes/index.js` (maps to `/`)

```javascript
export function GET(req, res) {
  return res.html(200, "<h1>Hello World!</h1>");
}
```

`app/routes/api/status.js` (maps to `/api/status`)

```javascript
export function GET(req, res) {
  return res.json(200, '{"status": "online"}');
}
```

`app/routes/users/[id].js` (maps to `/users/:id`)

```javascript
export function GET(req, res) {
  const userId = req.params.id;
  return res.text(200, "User ID: " + userId);
}
```

## The Request & Response Objects

Because Cerver compiles to C, the API surface is restricted.

**Request (`req`)**

- `req.path` — The request URL path
- `req.method` — The HTTP method
- `req.headers["user-agent"]` — Access request headers
- `req.query.search` — Access URL query parameters
- `req.params.id` — Access dynamic path segments

**Response (`res`)**

- `res.text(status, string)` — Send plain text
- `res.json(status, string)` — Send JSON
- `res.html(status, string)` — Send HTML

## Supported JavaScript

Cerver supports a strict, synchronous subset of JavaScript suitable for C code generation:

- `if`/`else` statements
- `const` / `let` variable declarations
- String and Number literals
- Template literals
- Basic comparisons (`===`, `!==`, `<`, `>`)

**Not Supported (Compile-Time Errors):**

- `async`/`await` and Promises
- Loops (`for`, `while`)
- Classes and the `new` keyword
- `eval()`
- Runtime `import`/`require`

## Configuration

`cerver.config.js`:

```javascript
export default {
  port: 8080, // Default port
  embed: true, // Embed assets from public/ into the binary
  minify: true, // Minify HTML/CSS/JS before embedding
  compression: "none", // Future: pre-compress assets
};
```

## How It Works

1. **Parser**: Uses Acorn to parse your JS route files into ASTs.
2. **Validator**: Scans the AST to ensure no unsupported JS features are used.
3. **IR**: Transforms the AST into an Intermediate Representation.
4. **Generator**: Emits optimized C code mapping directly to your JS logic.
5. **Asset Pipeline**: Scans the `public/` folder, minifies files, and converts them to C byte arrays.
6. **Compiler**: Invokes `gcc` or `clang` to compile the generated code and the Cerver runtime into a native binary.
