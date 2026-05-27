# Cerver

[![Publish](https://github.com/velox0/cerver/actions/workflows/publish.yml/badge.svg)](https://github.com/velox0/cerver/actions/workflows/publish.yml)
[![CI](https://github.com/velox0/cerver/actions/workflows/ci.yml/badge.svg)](https://github.com/velox0/cerver/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@velox0/cerver)](https://www.npmjs.com/package/@velox0/cerver)

<img src="templates/cerver.png" alt="Cerver Logo" width="200px" align="right" />

A lightweight, compile-time web framework that transpiles restricted JavaScript server logic into highly optimized native C HTTP server binaries.

Cerver takes a Next.js-style file-based routing structure (written in a strict subset of JavaScript), parses it, generates equivalent C code, embeds your static assets, and compiles it all into a single, standalone executable that runs with zero Node.js dependency.

## Features

- **Compile-Time Framework**: Your JavaScript is parsed and compiled to native C. There is no JavaScript engine (like V8) or interpreter included in the final binary.
- **Microscopic Footprint**: Generated executables are tiny and start in milliseconds.
- **Single-Binary Deployment**: Static assets (HTML, CSS, JS, images) are automatically minified and embedded directly into the executable as C byte arrays.
- **Native Performance**: Uses `kqueue` (macOS) or `epoll` (Linux) event loops for high-performance non-blocking I/O.
- **File-Based Routing**: Intuitive `routes/` directory structure, supporting dynamic segments (e.g., `/item/[id].js`).

## Benchmarks (Autocannon)

Local loopback runs against `localhost`, 20s per run.

Note: timeouts only appear at the highest concurrency (240 connections). On a single machine, autocannon and the server compete for CPU and kernel resources; the timeouts are likely client/loopback saturation rather than server errors.

| Connections | Pipelining | Avg req/s | Avg latency | p99 latency | Total read | Errors (timeouts) |
| ----------- | ---------- | --------- | ----------- | ----------- | ---------- | ----------------- |
| 60          | 1          | 123,005   | 0.01 ms     | 0 ms        | 21.0 GB    | 0                 |
| 60          | 10         | 125,973   | 4.26 ms     | 10 ms       | 21.5 GB    | 0                 |
| 120         | 1          | 124,214   | 0.15 ms     | 1 ms        | 21.2 GB    | 0                 |
| 120         | 10         | 131,245   | 8.64 ms     | 15 ms       | 22.4 GB    | 0                 |
| 240         | 1          | 124,890   | 0.54 ms     | 1 ms        | 21.3 GB    | 118 (timeout)     |
| 240         | 10         | 123,677   | 9.87 ms     | 14 ms       | 21.1 GB    | 1540 (timeout)    |

## Getting Started

You can run cerver directly using `npx` (requires `gcc` or `clang` and `libcurl` on your system):

```bash
npx @velox0/cerver@latest new my-fast-api
cd my-fast-api
```

Build and Run:

```bash
npx @velox0/cerver@latest build
npx @velox0/cerver@latest run
```

Alternatively, you can install it globally:

```bash
npm i -g @velox0/cerver@latest
cerver new my-fast-api
cd my-fast-api
cerver build
cerver run
```

## Routing

Routes are defined in the `routes/` directory.

`routes/index.js` (maps to `/`)

```javascript
export function GET(req, res) {
  return res.html(200, "<h1>Hello World!</h1>");
}
```

`routes/api/status.js` (maps to `/api/status`)

```javascript
export function GET(req, res) {
  return res.json(200, '{"status": "online"}');
}
```

`routes/users/[id].js` (maps to `/users/:id`)

```javascript
export function GET(req, res) {
  const userId = req.params.id;
  return res.text(200, "User ID: " + userId);
}
```

### Clean URL Asset Mapping

Cerver has a special asset routing convention that prevents folder clutter:

- **Root Index**: `public/index.html` is automatically served at the root `/`.
- **Directory Indexing**: Nested `index.html` files inside directories (e.g. `public/page/index.html`) are **not** implicitly aliased to `/page` (they remain at `/page/index.html`).
- **Clean Folder Slugs**: If an HTML file has the exact same name as its parent directory, it is mapped to the clean directory URL. For example:
  - `public/about/about.html` maps to `/about` (and `/about/`)
  - `public/blog/posts/posts.html` maps to `/blog/posts` (and `/blog/posts/`)
- **Other Static Assets**: All other assets like CSS, JS, images, and non-directory-matching HTML files serve directly at their file paths (e.g., `public/about/style.css` maps to `/about/style.css`).

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

## Outbound API Calls (fetch)

Cerver supports making synchronous outbound HTTP requests using a native `libcurl` implementation. This requires `libcurl` to be installed on the host system (e.g., `libcurl4-openssl-dev` on Linux; pre-installed on macOS).

```javascript
export function POST(req, res) {
  // Simple GET
  const data = fetch("https://api.example.com/data");

  // Full POST with headers and body
  const result = fetch("https://api.example.com/items", {
    method: "POST",
    body: '{"name": "new item"}',
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer token123",
    },
  });

  return res.json(200, result);
}
```

## Supported JavaScript

Cerver supports a strict, synchronous subset of JavaScript suitable for C code generation:

- `if`/`else` statements
- `for` loops (`for (init; condition; update)`) and `while` loops
- `const` / `let` variable declarations
- String and Number literals
- Template literals
- Basic comparisons (`===`, `!==`, `<`, `>`)
- Outbound API calls via `fetch(url, options)`

**Not Supported (Compile-Time Errors):**

- `async`/`await` and Promises
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
  // Optional: compiler customization and cross-target settings
  compile: {
    // cc: "clang", // or "x86_64-linux-gnu-gcc"
    // target: "x86_64-linux-gnu", // full target triple (preferred)
    // targetOs: "linux", // or "darwin" (used with targetArch if target omitted)
    // targetArch: "x86_64", // or "arm64"
    // sysroot: "/path/to/sysroot",
    // cflags: "-O2 -g",
    // ldflags: "-static",
    // lto: true,
    // marchNative: false,
    // compileInfo: false,
  },
};
```

### Cross-Compilation

Pass target details via CLI or `cerver.config.js`. If `target` is set, it is used as-is. If only `targetOs` + `targetArch` are set, Cerver will build a simple `arch-os` target string.

```bash
# Use a full target triple
cerver build --target x86_64-linux-gnu --cc x86_64-linux-gnu-gcc

# Or split OS/arch
cerver build --target-os linux --target-arch arm64
```

Note: when a target is specified, `-march=native` is disabled by default (set `compile.marchNative: true` to force it). Cross-compiling requires an appropriate toolchain and sysroot for the target.

## How It Works

1. **Parser**: Uses Acorn to parse your JS route files into ASTs.
2. **Validator**: Scans the AST to ensure no unsupported JS features are used.
3. **IR**: Transforms the AST into an Intermediate Representation.
4. **Generator**: Emits optimized C code mapping directly to your JS logic.
5. **Asset Pipeline**: Scans the `public/` folder, minifies files, and converts them to C byte arrays.
6. **Compiler**: Invokes `gcc` or `clang` to compile the generated code and the Cerver runtime into a native binary.
