/** Resize the supplied master without redrawing it. ICO frames retain alpha. */
import sharp from "sharp";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const master = await readFile(path.join(root, "assets/figs/logo/knorvia-source.png"));
const png = size => sharp(master).resize(size, size, { fit: "contain" }).png().toBuffer();
async function save(relative, content) {
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}
async function ico(sizes) {
  const frames = await Promise.all(sizes.map(png));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frames[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frames[index].length;
  });
  return Buffer.concat([header, ...frames]);
}
const logo = await png(512);
for (const file of ["web/public/logo.png", "desktop/build/logo.png", "assets/figs/logo/logo.png"]) await save(file, logo);
for (const size of [16, 32]) await save(`web/public/favicon-${size}x${size}.png`, await png(size));
await save("web/public/apple-touch-icon.png", await png(180));
await save("web/public/favicon.ico", await ico([16, 32, 48]));
await save("desktop/build/icon.ico", await ico([16, 24, 32, 48, 64, 128, 256]));
console.log("Updated web, desktop, installer and source logo assets from the supplied master.");
