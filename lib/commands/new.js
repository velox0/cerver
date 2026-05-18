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
  const dirs = [
    "",
    "app",
    "app/routes",
    "public",
    "dist",
  ];

  for (const dir of dirs) {
    fs.mkdirSync(path.join(projectDir, dir), { recursive: true });
  }

  // Copy templates
  const templatesDir = path.join(__dirname, "..", "..", "templates");

  // cerver.config.js
  fs.copyFileSync(
    path.join(templatesDir, "cerver.config.js"),
    path.join(projectDir, "cerver.config.js")
  );

  // Default route
  fs.copyFileSync(
    path.join(templatesDir, "index.route.js"),
    path.join(projectDir, "app", "routes", "index.js")
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
  <style>
    :root {
      --bg-color: #0f172a;
      --text-color: #f8fafc;
      --accent-color: #38bdf8;
      --card-bg: rgba(30, 41, 59, 0.7);
    }
    body {
      margin: 0;
      padding: 0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg-color);
      color: var(--text-color);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: radial-gradient(circle at top right, #1e293b, #0f172a);
    }
    .container {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      padding: 3rem;
      border-radius: 16px;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      max-width: 500px;
      width: 90%;
      animation: fadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      opacity: 0;
      transform: translateY(20px);
    }
    @keyframes fadeUp {
      to { opacity: 1; transform: translateY(0); }
    }
    .logo {
      width: 120px;
      height: 120px;
      margin-bottom: 1.5rem;
      border-radius: 24%;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
      transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .logo:hover {
      transform: scale(1.08) rotate(-3deg);
    }
    h1 {
      margin: 0 0 1rem 0;
      font-size: 2.5rem;
      font-weight: 700;
      letter-spacing: -0.025em;
    }
    p {
      margin: 0;
      color: #94a3b8;
      font-size: 1.125rem;
      line-height: 1.6;
    }
    .badge {
      display: inline-block;
      margin-top: 2rem;
      padding: 0.5rem 1rem;
      background: rgba(56, 189, 248, 0.1);
      color: var(--accent-color);
      border-radius: 9999px;
      font-size: 0.875rem;
      font-weight: 600;
      border: 1px solid rgba(56, 189, 248, 0.2);
    }
  </style>
</head>
<body>
  <div class="container">
    <img src="/cerver.png" alt="cerver logo" class="logo">
    <h1>${name}</h1>
    <p>Your ultra-fast, native web application is running.</p>
    <div class="badge">Powered by cerver</div>
  </div>
</body>
</html>
`
  );

  // Copy standard static assets
  fs.copyFileSync(
    path.join(templatesDir, "cerver.png"),
    path.join(projectDir, "public", "cerver.png")
  );
  fs.copyFileSync(
    path.join(templatesDir, "favicon.ico"),
    path.join(projectDir, "public", "favicon.ico")
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
      2
    ) + "\n"
  );

  console.log("  Created:");
  console.log("    app/routes/index.js");
  console.log("    public/index.html");
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

module.exports = { newProject };
