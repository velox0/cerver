"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Scaffold a new cerver project.
 */
function newProject(name) {
  const projectDir = path.resolve(process.cwd(), name);

  if (fs.existsSync(projectDir)) {
    console.error(`cerver: directory "${name}" already exists`);
    process.exit(1);
  }

  console.log(`\n  Creating cerver project: ${name}\n`);

  // Create directory structure
  const dirs = ["", "routes", "public", "public/about", "dist"];

  for (const dir of dirs) {
    fs.mkdirSync(path.join(projectDir, dir), { recursive: true });
  }

  // Copy templates
  const templatesDir = path.join(__dirname, "..", "..", "templates");

  // cerver.config.js
  fs.copyFileSync(
    path.join(templatesDir, "cerver.config.js"),
    path.join(projectDir, "cerver.config.js"),
  );

  // Default route
  fs.copyFileSync(
    path.join(templatesDir, "index.route.js"),
    path.join(projectDir, "routes", "index.js"),
  );

  // Default public/index.html
  fs.writeFileSync(
    path.join(projectDir, "public", "index.html"),
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <link rel="icon" href="/favicon.ico" type="image/x-icon">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main class="stage">
    <section class="frame">
      <div class="copy">
        <h1 class="home-title">${name}</h1>
        <p>Native-speed web apps with a glassy sheen. Your new cerver project is wired, built, and ready to ship.</p>
        <div class="steps">
          <div class="steps-box">
            <div class="steps-title">Next steps</div>
            <ul class="steps-list">
              <li>Edit <strong>public/index.html</strong> to change this page.</li>
              <li>Config lives in <strong>cerver.config.js</strong> at the project root.</li>
              <li>Learn more <strong><a href="/about">about cerver</a></strong>.</li>
            </ul>
          </div>
        </div>
        <div class="meta">
          <span class="dot"></span>
          <span>Powered by cerver</span>
        </div>
      </div>
      <div class="art">
        <img src="/cerver.png" alt="cerver logo">
      </div>
    </section>
    <footer class="footer-home">
      <a href="https://github.com/velox0/cerver" target="_blank" rel="noreferrer">GitHub: github.com/velox0/cerver</a>
    </footer>
  </main>
</body>
</html>
`,
  );

  // Default public/style.css
  fs.writeFileSync(
    path.join(projectDir, "public", "style.css"),
    `@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Unbounded:wght@500;700&family=JetBrains+Mono:wght@400;500&display=swap');

:root {
  --ink: #121316;
  --muted: #4a4f57;
  --paper: #f7f4f1;
  --glass: rgba(255, 255, 255, 0.75);
  --edge: rgba(255, 255, 255, 0.6);
  --pink: #ff7abf;
  --peach: #ffb380;
  --mint: #7de3c9;
  --blue: #6aa9ff;
  --shadow: rgba(18, 19, 22, 0.12);
}

@media (prefers-color-scheme: dark) {
  :root {
    --ink: #f7f8fb;
    --muted: #c2c8d0;
    --paper: #0b0e13;
    --glass: rgba(15, 19, 28, 0.82);
    --edge: rgba(255, 255, 255, 0.08);
    --shadow: rgba(0, 0, 0, 0.5);
    --blue: #58a6ff;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: "Space Grotesk", "Segoe UI", sans-serif;
  color: var(--ink);
  height: 100vh;
  overflow: hidden;
  display: grid;
  place-items: center;
  background-color: var(--paper);
  background-image:
    radial-gradient(circle at 15% 10%, rgba(255, 122, 191, 0.25), transparent 45%),
    radial-gradient(circle at 85% 12%, rgba(255, 179, 128, 0.3), transparent 50%),
    radial-gradient(circle at 82% 82%, rgba(122, 214, 255, 0.25), transparent 55%),
    radial-gradient(circle at 20% 80%, rgba(125, 227, 201, 0.35), transparent 55%),
    linear-gradient(120deg, #f7f4f1 0%, #f2f7ff 100%);
}

@media (prefers-color-scheme: dark) {
  body {
    background-image:
      radial-gradient(circle at 15% 10%, rgba(255, 122, 191, 0.45), transparent 45%),
      radial-gradient(circle at 85% 12%, rgba(255, 179, 128, 0.45), transparent 50%),
      radial-gradient(circle at 82% 82%, rgba(106, 169, 255, 0.45), transparent 55%),
      radial-gradient(circle at 20% 80%, rgba(125, 227, 201, 0.4), transparent 55%),
      linear-gradient(120deg, #0b0e13 0%, #121826 100%);
  }
}

body::before,
body::after {
  content: "";
  position: fixed;
  inset: -20% -10%;
  pointer-events: none;
  z-index: -1;
}

body::before {
  background:
    conic-gradient(from 200deg at 50% 50%, rgba(255, 122, 191, 0.08), rgba(122, 214, 255, 0.08), rgba(125, 227, 201, 0.08), rgba(255, 179, 128, 0.08));
  filter: blur(60px);
  opacity: 0.6;
}

body::after {
  background-image: radial-gradient(circle, rgba(18, 19, 22, 0.04) 1px, transparent 1px);
  background-size: 24px 24px;
  opacity: 0.6;
}

@media (prefers-color-scheme: dark) {
  body::before {
    opacity: 0.95;
    filter: blur(90px);
  }
  body::after {
    background-image: radial-gradient(circle, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
    opacity: 0.2;
  }
}

/* Visited / Non-visited links: Pink / Green hue */
a, a:visited {
  color: #ff57a0;
  text-decoration: none;
  font-weight: 600;
  transition: color 0.2s ease, border-color 0.2s ease;
  border-bottom: 1px solid rgba(255, 87, 160, 0.2);
}

a:hover, a:active {
  color: #10b981;
  border-bottom-color: rgba(16, 185, 129, 0.6);
}

@media (prefers-color-scheme: dark) {
  a, a:visited {
    color: #ff7abf;
    border-bottom-color: rgba(255, 122, 191, 0.2);
  }
  a:hover, a:active {
    color: #7de3c9;
    border-bottom-color: rgba(125, 227, 201, 0.6);
  }
}

/* Home template specific styles */
.stage {
  width: min(1100px, 92vw);
  padding: 4rem 0;
}

.frame {
  position: relative;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 2.5rem;
  align-items: center;
  padding: clamp(2.5rem, 4vw, 4rem);
  border-radius: 32px;
  background: var(--glass);
  border: 1px solid var(--edge);
  box-shadow:
    0 40px 90px -40px var(--shadow),
    inset 0 1px 0 rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  animation: rise 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
}

@media (prefers-color-scheme: dark) {
  .frame {
    box-shadow:
      0 50px 120px -40px rgba(0, 0, 0, 0.75),
      0 0 120px rgba(106, 169, 255, 0.25),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }
}

h1.home-title {
  margin: 0.6rem 0 1rem;
  font-family: "Unbounded", "Space Grotesk", sans-serif;
  font-size: clamp(2.2rem, 4vw, 4.4rem);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.steps {
  margin: 0 0 1.8rem;
}

.steps-box {
  padding: 1rem 1.2rem;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.35);
  border: 1px solid rgba(18, 19, 22, 0.08);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

@media (prefers-color-scheme: dark) {
  .steps-box {
    background: rgba(6, 8, 14, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.12);
  }
}

.steps-title {
  margin: 0 0 0.7rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--muted);
}

.steps-list {
  margin: 0;
  padding-left: 1.1rem;
  display: grid;
  gap: 0.55rem;
  color: var(--muted);
}

.steps-list li::marker {
  color: var(--muted);
}

.steps-list strong {
  color: var(--ink);
  font-weight: 600;
}

.meta {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  font-weight: 600;
  color: var(--ink);
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--pink), var(--blue));
  box-shadow: 0 0 12px rgba(122, 214, 255, 0.8);
}

@media (prefers-color-scheme: dark) {
  .dot {
    box-shadow: 0 0 18px rgba(255, 122, 191, 0.9);
  }
}

.footer-home {
  margin-top: 1.8rem;
  text-align: center;
  font-size: 0.9rem;
  color: var(--muted);
}

.footer-home a {
  color: inherit;
  text-decoration: none;
  font-weight: 600;
}

.footer-home a:hover {
  text-decoration: underline;
}

.art {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 280px;
}

.art::before {
  content: "";
  position: absolute;
  width: min(320px, 70vw);
  aspect-ratio: 1;
  border-radius: 28%;
  background: linear-gradient(140deg, rgba(255, 122, 191, 0.25), rgba(122, 214, 255, 0.2), rgba(125, 227, 201, 0.25));
  filter: blur(10px);
  transform: rotate(18deg);
}

@media (prefers-color-scheme: dark) {
  .art::before {
    filter: blur(18px);
  }
}

.art img {
  width: min(300px, 65vw);
  height: auto;
  border-radius: 18%;
  filter: drop-shadow(0 25px 40px rgba(18, 19, 22, 0.25));
  animation: float 6s ease-in-out infinite;
}

@media (prefers-color-scheme: dark) {
  .art img {
    filter: drop-shadow(0 30px 60px rgba(106, 169, 255, 0.45));
  }
}

@keyframes float {
  0%, 100% { transform: translateY(0px) rotate(-2deg); }
  50% { transform: translateY(-12px) rotate(2deg); }
}

@keyframes rise {
  from { opacity: 0; transform: translateY(18px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@media (max-width: 760px) {
  .stage {
    padding: 2.5rem 0;
  }
  .frame {
    padding: 2.2rem;
  }
  h1.home-title {
    letter-spacing: 0.05em;
  }
  .art {
    order: -1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .frame,
  .art img {
    animation: none;
  }
}

/* Docs template specific styles */
.container {
  width: min(840px, 95vw);
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  padding: 2.5rem clamp(1.5rem, 5vw, 3.5rem);
  border-radius: 24px;
  background: var(--glass);
  border: 1px solid var(--edge);
  box-shadow: 0 30px 70px -30px var(--shadow);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.docs-content {
  overflow-y: auto;
  flex-grow: 1;
  padding-right: 1.5rem;
}

.docs-content::-webkit-scrollbar {
  width: 8px;
}

.docs-content::-webkit-scrollbar-track {
  background: transparent;
}

.docs-content::-webkit-scrollbar-thumb {
  background: rgba(18, 19, 22, 0.1);
  border-radius: 4px;
}

.docs-content::-webkit-scrollbar-thumb:hover {
  background: rgba(18, 19, 22, 0.2);
}

@media (prefers-color-scheme: dark) {
  .docs-content::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.15);
  }
  .docs-content::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.25);
  }
}

.back-link {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 2rem;
  color: var(--muted);
  text-decoration: none;
  font-weight: 600;
  font-size: 0.95rem;
  transition: color 0.2s ease;
  flex-shrink: 0;
  border-bottom: none !important;
}

.back-link:hover {
  color: var(--ink);
}

.markdown-body h1 {
  font-family: "Unbounded", "Space Grotesk", sans-serif;
  font-size: clamp(1.8rem, 3.5vw, 2.8rem);
  margin-top: 0;
  margin-bottom: 1.5rem;
  letter-spacing: -0.02em;
}

.markdown-body h2 {
  font-family: "Unbounded", "Space Grotesk", sans-serif;
  font-size: clamp(1.3rem, 2.5vw, 1.8rem);
  margin-top: 2.5rem;
  margin-bottom: 1rem;
  border-bottom: 2px solid rgba(18, 19, 22, 0.08);
  padding-bottom: 0.4rem;
}

@media (prefers-color-scheme: dark) {
  .markdown-body h2 {
    border-bottom-color: rgba(255, 255, 255, 0.1);
  }
}

.markdown-body h3 {
  font-size: 1.25rem;
  margin-top: 1.8rem;
  margin-bottom: 0.8rem;
}

.markdown-body p, 
.markdown-body li {
  font-size: 1.05rem;
  line-height: 1.7;
  color: var(--muted);
}

.markdown-body p {
  margin: 0 0 1.2rem;
}

.markdown-body ul, 
.markdown-body ol {
  margin: 0 0 1.5rem;
  padding-left: 1.5rem;
}

.markdown-body li {
  margin-bottom: 0.6rem;
}

.markdown-body code {
  font-family: "JetBrains Mono", monospace;
  background: rgba(0, 0, 0, 0.05);
  padding: 0.2rem 0.4rem;
  border-radius: 6px;
  font-size: 0.9rem;
  color: #d13d7a;
}

@media (prefers-color-scheme: dark) {
  .markdown-body code {
    background: rgba(255, 255, 255, 0.08);
    color: #ff7abf;
  }
}

.markdown-body pre {
  background: #181a1f;
  padding: 1.2rem;
  border-radius: 12px;
  overflow-x: auto;
  margin: 1.5rem 0;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.markdown-body pre code {
  background: transparent;
  color: #abb2bf;
  padding: 0;
  font-size: 0.9rem;
}

.markdown-body table {
  width: 100%;
  border-collapse: collapse;
  margin: 1.5rem 0;
  font-size: 0.95rem;
}

.markdown-body th, 
.markdown-body td {
  padding: 0.8rem 1rem;
  text-align: left;
  border-bottom: 1px solid rgba(18, 19, 22, 0.08);
}

@media (prefers-color-scheme: dark) {
  .markdown-body th, 
  .markdown-body td {
    border-bottom-color: rgba(255, 255, 255, 0.1);
  }
}

.markdown-body th {
  font-weight: 600;
  background: rgba(0, 0, 0, 0.02);
}

@media (prefers-color-scheme: dark) {
  .markdown-body th {
    background: rgba(255, 255, 255, 0.04);
  }
}

.markdown-body tr:nth-child(even) {
  background: rgba(0, 0, 0, 0.01);
}

@media (prefers-color-scheme: dark) {
  .markdown-body tr:nth-child(even) {
    background: rgba(255, 255, 255, 0.02);
  }
}

.footer-docs {
  text-align: center;
  font-size: 0.9rem;
  color: var(--muted);
}
`,
  );

  // Copy static assets
  fs.copyFileSync(
    path.join(templatesDir, "cerver.png"),
    path.join(projectDir, "public", "cerver.png"),
  );
  fs.copyFileSync(
    path.join(templatesDir, "favicon.ico"),
    path.join(projectDir, "public", "favicon.ico"),
  );

  // package.json
  fs.writeFileSync(
    path.join(projectDir, "package.json"),
    JSON.stringify(
      {
        name: name,
        version: "0.1.0",
        private: true,
        scripts: {
          build: "cerver build",
          start: "cerver run",
        },
      },
      null,
      2,
    ) + "\n",
  );

  // Read README.md from the cerver project root
  const readmePath = path.join(__dirname, "..", "..", "README.md");
  let readmeContent = "";
  if (fs.existsSync(readmePath)) {
    readmeContent = fs.readFileSync(readmePath, "utf8");
  } else {
    readmeContent = `# Cerver

Cerver is a lightweight compile-time web framework.
`;
  }

  const parsedReadme = parseMarkdown(readmeContent);

  // Generate public/about/about.html
  fs.writeFileSync(
    path.join(projectDir, "public", "about", "about.html"),
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>About ${name}</title>
  <link rel="icon" href="/favicon.ico" type="image/x-icon">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="container">
    <a href="/" class="back-link">&larr; Back to Home</a>
    <div class="docs-content">
      <article class="markdown-body">
        ${parsedReadme}
      </article>
    </div>
    <footer class="footer-docs" style="margin-top: 1.5rem; flex-shrink: 0;">
      Powered by cerver
    </footer>
  </div>
</body>
</html>
`,
  );

  console.log("  Created:");
  console.log("    routes/index.js");
  console.log("    public/index.html");
  console.log("    public/style.css");
  console.log("    public/about/about.html");
  console.log("    public/cerver.png");
  console.log("    public/favicon.ico");
  console.log("    cerver.config.js");
  console.log("    package.json");
  console.log("");
  console.log("  Next steps:");
  console.log(`    cd ${name}`);
  console.log("    cerver build");
  console.log("    cerver run");
  console.log("");
}

function parseMarkdown(md) {
  const lines = md.split("\n");
  const htmlLines = [];
  let inList = false;
  let inCode = false;
  let codeBlock = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("```")) {
      if (inCode) {
        inCode = false;
        htmlLines.push(`<pre><code>${codeBlock.join("\n")}</code></pre>`);
        codeBlock = [];
      } else {
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeBlock.push(line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
      continue;
    }

    if (line.trim().startsWith("- ")) {
      if (!inList) {
        htmlLines.push("<ul>");
        inList = true;
      }
      const itemText = line.trim().slice(2);
      htmlLines.push(`  <li>${inlineFormatting(itemText)}</li>`);
      continue;
    } else if (line.trim().startsWith("|") || line.trim() === "") {
      if (inList) {
        htmlLines.push("</ul>");
        inList = false;
      }
    }

    if (line.startsWith("# ")) {
      htmlLines.push(`<h1>${inlineFormatting(line.slice(2))}</h1>`);
      continue;
    }
    if (line.startsWith("## ")) {
      htmlLines.push(`<h2>${inlineFormatting(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith("### ")) {
      htmlLines.push(`<h3>${inlineFormatting(line.slice(4))}</h3>`);
      continue;
    }

    if (line.trim().startsWith("|")) {
      if (line.includes("---")) {
        continue;
      }
      const cols = line.split("|").map(c => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
      htmlLines.push(`<tr>${cols.map(c => `<td>${inlineFormatting(c)}</td>`).join("")}</tr>`);
      continue;
    }

    if (line.trim() !== "") {
      htmlLines.push(`<p>${inlineFormatting(line)}</p>`);
    }
  }

  if (inList) {
    htmlLines.push("</ul>");
  }

  let joined = htmlLines.join("\n");
  joined = joined.replace(/(<tr>.*?<\/tr>)+/gs, "<table>\n$&\n</table>");

  return joined;
}

function inlineFormatting(text) {
  let escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Map raw Cerver Logo html tag from templates/cerver.png to /cerver.png
  escaped = escaped.replace(/&lt;img src="templates\/cerver\.png" alt="Cerver Logo" width="200px" align="right" \/&gt;/g, '<img src="/cerver.png" alt="Cerver Logo" width="100" style="float: right; margin-left: 1.5rem; border-radius: 12px; max-width: 100%; height: auto;" />');

  // Handle Markdown images: ![alt](url)
  escaped = escaped.replace(/!\[([^\]]*?)\]\(([^)]+?)\)/g, '<img src="$2" alt="$1" style="height: 20px; vertical-align: middle; display: inline-block; margin: 2px;" />');

  // Handle Markdown links: [text](url)
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Handle bold: **text**
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Handle inline code: `code`
  escaped = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");

  return escaped;
}

module.exports = { newProject };
