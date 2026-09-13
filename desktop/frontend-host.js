// Run the existing Next.js renderer on a Windows named pipe, never a TCP port.
const http = require("http");
const path = require("path");

for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.("error", (error) => {
    if (error?.code !== "EPIPE") process.exitCode = 1;
  });
}

const webRoot = process.env.KNORVIA_WEB_ROOT;
const pipeName = process.env.KNORVIA_UI_PIPE;
if (!webRoot || !pipeName) throw new Error("Missing desktop renderer configuration");

process.env.NODE_ENV = "production";
process.chdir(webRoot);
const distDir = process.env.KNORVIA_NEXT_DIST_DIR || ".next";
if (!/^\.next(?:-[a-zA-Z0-9_-]+)?$/.test(distDir)) throw new Error("Invalid desktop Next dist directory");
const required = require(path.join(webRoot, distDir, "required-server-files.json"));
const config = required.config;
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);

const next = require(path.join(webRoot, "node_modules", "next"));
const application = next({ dev: false, dir: webRoot, conf: config });

application.prepare().then(() => {
  const server = http.createServer(application.getRequestHandler());
  server.listen(pipeName, () => process.stdout.write("READY\n"));
}).catch((error) => {
  try { process.stderr.write(`${error?.stack || error}\n`, () => {}); } catch {}
  process.exit(1);
});
