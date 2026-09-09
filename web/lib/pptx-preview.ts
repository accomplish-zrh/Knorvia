/**
 * Lightweight PPTX reader for the preview drawer.
 *
 * A .pptx is a zip of slide XML. We only extract visible text runs so the
 * drawer can show one card per slide instead of a single dumped text blob.
 */

export type PptxSlide = {
  index: number;
  title: string;
  lines: string[];
};

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD_HEADER = 0x06054b50;
const MAX_ZIP_ENTRIES = 4096;
const MAX_PPTX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_XML_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;

export function isPptxPreviewXml(name: string): boolean {
  const normalized = name.replaceAll("\\", "/");
  return (
    normalized === "ppt/presentation.xml" ||
    normalized === "ppt/_rels/presentation.xml.rels" ||
    /^ppt\/slides\/slide\d+\.xml$/i.test(normalized)
  );
}

function viewU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function viewU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

async function inflateRaw(data: Uint8Array, maxOutputBytes: number): Promise<Uint8Array> {
  // This module is imported by a client previewer. Do not add a Node `zlib`
  // fallback here: even a conditional `node:` import is resolved while Next
  // creates the browser bundle. Browsers without this platform API fall back
  // to the normal file preview instead of loading an unbounded JS inflater.
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress PPTX preview data");
  }
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  const stream = new Blob([copy])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxOutputBytes) {
        throw new Error("PPTX XML entry is too large to preview");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function findEocd(buffer: ArrayBuffer): number {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= min; offset -= 1) {
    if (viewU32(view, offset) === EOCD_HEADER) return offset;
  }
  throw new Error("Not a zip archive");
}

export async function readZipTextFiles(
  buffer: ArrayBuffer,
): Promise<Map<string, string>> {
  if (buffer.byteLength > MAX_PPTX_ARCHIVE_BYTES) {
    throw new Error("PPTX file is too large to preview");
  }
  const view = new DataView(buffer);
  const eocd = findEocd(buffer);
  const count = viewU16(view, eocd + 10);
  if (count > MAX_ZIP_ENTRIES) throw new Error("PPTX contains too many entries");
  let cursor = viewU32(view, eocd + 16);
  const files = new Map<string, string>();
  let totalInflatedBytes = 0;

  for (let index = 0; index < count; index += 1) {
    if (viewU32(view, cursor) !== CENTRAL_HEADER) {
      throw new Error("Corrupt zip central directory");
    }
    const compression = viewU16(view, cursor + 10);
    const compressedSize = viewU32(view, cursor + 20);
    const uncompressedSize = viewU32(view, cursor + 24);
    const nameLen = viewU16(view, cursor + 28);
    const extraLen = viewU16(view, cursor + 30);
    const commentLen = viewU16(view, cursor + 32);
    const localOffset = viewU32(view, cursor + 42);
    const name = decodeUtf8(new Uint8Array(buffer, cursor + 46, nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;

    const normalizedName = name.replaceAll("\\", "/");
    if (!isPptxPreviewXml(normalizedName)) continue;
    if (uncompressedSize > MAX_XML_ENTRY_BYTES) {
      throw new Error("PPTX XML entry is too large to preview");
    }
    if (
      compressedSize > 0 &&
      uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO
    ) {
      throw new Error("PPTX entry has a suspicious compression ratio");
    }
    totalInflatedBytes += uncompressedSize;
    if (totalInflatedBytes > MAX_TOTAL_XML_BYTES) {
      throw new Error("PPTX expanded content is too large to preview");
    }

    if (viewU32(view, localOffset) !== LOCAL_HEADER) continue;
    const localNameLen = viewU16(view, localOffset + 26);
    const localExtraLen = viewU16(view, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
    const raw = new Uint8Array(buffer, dataOffset, compressedSize);
    let data: Uint8Array;
    if (compression === 0) data = raw;
    else if (compression === 8) data = await inflateRaw(raw, MAX_XML_ENTRY_BYTES);
    else continue;
    if (data.byteLength > MAX_XML_ENTRY_BYTES || data.byteLength !== uncompressedSize) {
      throw new Error("PPTX entry size does not match its directory record");
    }
    files.set(normalizedName, decodeUtf8(data));
  }
  return files;
}

export function extractTextRuns(xml: string): string[] {
  const runs: string[] = [];
  const pattern = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) {
    const text = match[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    if (text) runs.push(text);
  }
  return runs;
}

export function parseRelationshipTargets(relsXml: string): Record<string, string> {
  const map: Record<string, string> = {};
  const pattern = /Id="([^"]+)"[^>]*Target="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(relsXml))) {
    map[match[1]] = match[2].replace(/^\//, "");
  }
  return map;
}

export function parseSlideOrder(presentationXml: string): string[] {
  const ids: string[] = [];
  const pattern = /<p:sldId\b[^>]*r:id="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(presentationXml))) ids.push(match[1]);
  return ids;
}

export function buildPptxSlides(files: Map<string, string>): PptxSlide[] {
  const presentation = files.get("ppt/presentation.xml") || "";
  const rels = parseRelationshipTargets(
    files.get("ppt/_rels/presentation.xml.rels") || "",
  );
  const order = parseSlideOrder(presentation);
  const paths =
    order.length > 0
      ? order
          .map((id) => rels[id])
          .filter(Boolean)
          .map((target) =>
            target.startsWith("ppt/") ? target : `ppt/${target.replace(/^\.\//, "")}`,
          )
      : [...files.keys()]
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return paths.map((path, index) => {
    const runs = extractTextRuns(files.get(path) || "");
    return {
      index: index + 1,
      title: runs[0] || `Slide ${index + 1}`,
      lines: runs.slice(1),
    };
  });
}

export async function parsePptxBuffer(buffer: ArrayBuffer): Promise<PptxSlide[]> {
  return buildPptxSlides(await readZipTextFiles(buffer));
}
