// Replace the static en/app.json bundle with an empty resource object.
//
// The English locale is a key==value identity map (98%+ of its 3904 keys),
// so i18next's `parseMissingKeyHandler`/fallback already renders every key
// verbatim without shipping 248 KB of JSON in the root shell. Non-identity
// entries (357 keys like 'Loading' -> 'Loading...') are preserved as a small
// overrides file that IS bundled.
import fs from "node:fs";
import path from "node:path";

const webRoot = process.cwd();
const enApp = path.join(webRoot, "locales", "en", "app.json");
const outDir = path.join(webRoot, "locales", "en");
const overrideFile = path.join(outDir, "app.overrides.json");

const json = JSON.parse(fs.readFileSync(enApp, "utf8"));
const overrides = {};
for (const [k, v] of Object.entries(json)) {
  if (typeof v === "string" && k !== v) overrides[k] = v;
}

fs.writeFileSync(
  overrideFile,
  JSON.stringify(overrides, Object.keys(overrides).sort(), 2) + "\n",
);
console.log(
  "wrote app.overrides.json with",
  Object.keys(overrides).length,
  "non-identity keys;",
  "root-shell saving ~= ",
  Math.round((fs.statSync(enApp).size - fs.statSync(overrideFile).size) / 1024),
  "KB",
);
