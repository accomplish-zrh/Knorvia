"use strict";

const fs = require("node:fs");
const path = require("node:path");
// The builder copies the canonical UI registry next to this module in app.asar.
const palettes = require(fs.existsSync(path.join(__dirname, "appearance-palettes.json")) ? "./appearance-palettes.json" : "../web/lib/appearance-palettes.json");

function nativeBackdropSupported(platform, release) {
  if (platform === "darwin") return true;
  if (platform !== "win32") return false;
  const [major, , build] = String(release).split(".").map(Number);
  return major > 10 || (major === 10 && build >= 22621);
}

function validAppearance(value) {
  return value && typeof value.theme === "string" && Object.hasOwn(palettes, value.theme) && typeof value.frost === "boolean"
    && (value.reducedMotion === undefined || typeof value.reducedMotion === "boolean");
}

// Store only validated appearance values, apart from agent/user assets.
// Atomic replacement keeps the next launch coherent if the app exits mid-save.
function readAppearance(directory) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, "window-appearance.json"), "utf8"));
    return validAppearance(value) ? { theme: value.theme, frost: value.frost,
      ...(typeof value.reducedMotion === "boolean" ? { reducedMotion: value.reducedMotion } : {}),
    } : null;
  } catch { return null; }
}

function saveAppearance(directory, value) {
  if (!validAppearance(value)) return false;
  const previous = readAppearance(directory);
  const reducedMotion = value.reducedMotion ?? previous?.reducedMotion;
  const next = { theme: value.theme, frost: value.frost,
    ...(typeof reducedMotion === "boolean" ? { reducedMotion } : {}),
  };
  if (JSON.stringify(previous) === JSON.stringify(next)) return true;
  const file = path.join(directory, "window-appearance.json");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next));
  fs.renameSync(`${file}.tmp`, file);
  return true;
}

module.exports = { nativeBackdropSupported, readAppearance, saveAppearance, validAppearance, palettes };
