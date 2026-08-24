const fs = require("fs");
const path = require("path");
const vm = require("vm");

const dir = ".next/server/app";
let rootFiles = null;

function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith("_client-reference-manifest.js")) {
      const ctx = { globalThis: { __RSC_MANIFEST: {} } };
      vm.createContext(ctx);
      vm.runInContext(fs.readFileSync(p, "utf8"), ctx);
      for (const [k, m] of Object.entries(ctx.globalThis.__RSC_MANIFEST)) {
        const rf = m.entryJSFiles["[project]/app/layout"];
        if (rf && !rootFiles) rootFiles = rf;
      }
    }
  }
}
walk(dir);

if (!rootFiles) { console.log("no root layout entry found"); process.exit(0); }
console.log("root layout chunks:", rootFiles.length);
const sizes = [];
for (const f of rootFiles) {
  const p = path.join(".next", f.split("\\").join("/"));
  try { sizes.push([fs.statSync(p).size, f]); } catch {}
}
sizes.sort((a, b) => b[0] - a[0]);
for (const [s, f] of sizes.slice(0, 14)) {
  console.log(String(s / 1024 | 0).padStart(5) + " KB ", f.split("static/").pop());
}
console.log("total:", (sizes.reduce((a, x) => a + x[0], 0) / 1024) | 0, "KB");
