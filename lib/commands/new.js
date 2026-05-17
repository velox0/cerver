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
</head>
<body>
  <h1>${name}</h1>
  <p>Served by cerver.</p>
</body>
</html>
`
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
