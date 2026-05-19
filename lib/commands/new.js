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
  const dirs = ["", "routes", "public", "dist"];

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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Unbounded:wght@500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --ink: #121316;
      --muted: #4a4f57;
      --paper: #f7f4f1;
      --glass: rgba(255, 255, 255, 0.7);
      --edge: rgba(255, 255, 255, 0.6);
      --pink: #ff7abf;
      --peach: #ffb380;
      --mint: #7de3c9;
      --blue: #6aa9ff;
      --shadow: rgba(18, 19, 22, 0.18);
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      font-family: "Space Grotesk", "Segoe UI", sans-serif;
      color: var(--ink);
      min-height: 100vh;
      display: grid;
      place-items: center;
      background-color: var(--paper);
      background-image:
        radial-gradient(circle at 15% 10%, rgba(255, 122, 191, 0.35), transparent 45%),
        radial-gradient(circle at 85% 12%, rgba(255, 179, 128, 0.4), transparent 50%),
        radial-gradient(circle at 82% 82%, rgba(122, 214, 255, 0.35), transparent 55%),
        radial-gradient(circle at 20% 80%, rgba(125, 227, 201, 0.35), transparent 55%),
        linear-gradient(120deg, #f7f4f1 0%, #f2f7ff 100%);
    }
    body::before,
    body::after {
      content: "";
      position: fixed;
      inset: -20% -10%;
      pointer-events: none;
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
    h1 {
      margin: 0.6rem 0 1rem;
      font-family: "Unbounded", "Space Grotesk", sans-serif;
      font-size: clamp(2.2rem, 4vw, 4.4rem);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    p {
      margin: 0 0 1.5rem;
      font-size: 1.1rem;
      line-height: 1.7;
      color: var(--muted);
      max-width: 32rem;
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
      color: #2c3138;
      font-weight: 600;
    }
    .meta {
      display: inline-flex;
      align-items: center;
      gap: 0.6rem;
      font-weight: 600;
      color: #2c3138;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--pink), var(--blue));
      box-shadow: 0 0 12px rgba(122, 214, 255, 0.8);
    }
    .footer {
      margin-top: 1.8rem;
      text-align: center;
      font-size: 0.9rem;
      color: var(--muted);
    }
    .footer a {
      color: inherit;
      text-decoration: none;
      font-weight: 600;
    }
    .footer a:hover {
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
    .art img {
      width: min(300px, 65vw);
      height: auto;
      border-radius: 18%;
      filter: drop-shadow(0 25px 40px rgba(18, 19, 22, 0.25));
      animation: float 6s ease-in-out infinite;
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
      h1 {
        letter-spacing: 0.05em;
      }
      .art {
        order: -1;
      }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --ink: #f7f8fb;
        --muted: #c2c8d0;
        --paper: #0b0e13;
        --glass: rgba(15, 19, 28, 0.78);
        --edge: rgba(255, 255, 255, 0.12);
        --shadow: rgba(0, 0, 0, 0.65);
      }
      body {
        background-image:
          radial-gradient(circle at 15% 10%, rgba(255, 122, 191, 0.45), transparent 45%),
          radial-gradient(circle at 85% 12%, rgba(255, 179, 128, 0.45), transparent 50%),
          radial-gradient(circle at 82% 82%, rgba(106, 169, 255, 0.45), transparent 55%),
          radial-gradient(circle at 20% 80%, rgba(125, 227, 201, 0.4), transparent 55%),
          linear-gradient(120deg, #0b0e13 0%, #121826 100%);
      }
      body::before {
        opacity: 0.95;
        filter: blur(90px);
      }
      body::after {
        opacity: 0.2;
      }
      .frame {
        box-shadow:
          0 50px 120px -40px rgba(0, 0, 0, 0.75),
          0 0 120px rgba(106, 169, 255, 0.25),
          inset 0 1px 0 rgba(255, 255, 255, 0.08);
      }
      .steps-box {
        background: rgba(6, 8, 14, 0.45);
        border: 1px solid rgba(255, 255, 255, 0.12);
      }
      .steps-list strong {
        color: #eef1f6;
      }
      .meta {
        color: #e6e9ef;
      }
      .dot {
        box-shadow: 0 0 18px rgba(255, 122, 191, 0.9);
      }
      .art::before {
        filter: blur(18px);
      }
      .art img {
        filter: drop-shadow(0 30px 60px rgba(106, 169, 255, 0.45));
      }
      .footer {
        color: #c2c8d0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .frame,
      .art img {
        animation: none;
      }
    }
  </style>
</head>
<body>
  <main class="stage">
    <section class="frame">
      <div class="copy">
        <h1>${name}</h1>
        <p>Native-speed web apps with a glassy sheen. Your new cerver project is wired, built, and ready to ship.</p>
        <div class="steps">
          <div class="steps-box">
            <div class="steps-title">Next steps</div>
            <ul class="steps-list">
              <li>Edit <strong>public/index.html</strong> to change this page.</li>
              <li>Config lives in <strong>cerver.config.js</strong> at the project root.</li>
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
    <footer class="footer">
      <a href="https://github.com/velox0/cerver" target="_blank" rel="noreferrer">GitHub: github.com/velox0/cerver</a>
    </footer>
  </main>
</body>
</html>
`,
  );

  // Copy standard static assets
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

  console.log("  Created:");
  console.log("    routes/index.js");
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
