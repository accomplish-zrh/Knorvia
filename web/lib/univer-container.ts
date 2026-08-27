/**
 * Helpers for Knorvia ``.univer`` multi-unit Office containers.
 *
 * The backend serves a ZIP-backed container. The browser never unpacks it:
 * it asks the outputs unpack proxy for the manifest or a single unit URL,
 * then hands that URL to the existing Xlsx/Docx/Pptx previewers.
 *
 *   GET /api/outputs/<path>.univer/container           → manifest JSON
 *   GET /api/outputs/<path>.univer/container?unit=<id> → native Office bytes
 */

export type UniverUnitType = "sheet" | "doc" | "slide";

export type UniverUnit = {
  id: string;
  type: UniverUnitType;
  file: string;
  name?: string;
};

export type UniverRef = {
  from: string;
  to: string;
  range: string;
  kind?: string;
};

export type UniverManifest = {
  version?: number;
  units: UniverUnit[];
  refs?: UniverRef[];
};

const UNIT_TYPES = new Set<UniverUnitType>(["sheet", "doc", "slide"]);

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Drop any query/hash so we can append ``/container``. */
export function containerBaseUrl(containerUrl: string): string {
  const raw = String(containerUrl || "").trim();
  if (!raw) return "";
  const noHash = raw.split("#")[0] || "";
  const noQuery = noHash.split("?")[0] || "";
  return stripTrailingSlash(noQuery);
}

/** Manifest JSON endpoint for a ``.univer`` output URL. */
export function containerManifestUrl(containerUrl: string): string {
  const base = containerBaseUrl(containerUrl);
  return base ? `${base}/container` : "";
}

/** Native-file endpoint for one unit inside a ``.univer`` container. */
export function containerUnitUrl(containerUrl: string, unitId: string): string {
  const base = containerBaseUrl(containerUrl);
  const id = String(unitId || "").trim();
  if (!base || !id) return "";
  return `${base}/container?unit=${encodeURIComponent(id)}`;
}

export function isUniverFilename(filename: string): boolean {
  return /\.univer$/i.test(String(filename || "").trim());
}

export function previewKindForUnitType(
  unitType: string,
): "xlsx" | "docx" | "pptx" | null {
  const value = String(unitType || "").trim().toLowerCase();
  if (value === "sheet") return "xlsx";
  if (value === "doc") return "docx";
  if (value === "slide") return "pptx";
  return null;
}

export function unitLabel(unit: UniverUnit): string {
  const name = String(unit.name || "").trim();
  if (name) return name;
  return unit.id;
}

export function parseUniverManifest(payload: unknown): UniverManifest {
  const row =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const unitsRaw = Array.isArray(row.units) ? row.units : [];
  const units: UniverUnit[] = [];
  for (const item of unitsRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const id = String(entry.id || "").trim();
    const type = String(entry.type || "").trim().toLowerCase() as UniverUnitType;
    const file = String(entry.file || "").trim();
    if (!id || !UNIT_TYPES.has(type) || !file) continue;
    const name = String(entry.name || "").trim();
    units.push(name ? { id, type, file, name } : { id, type, file });
  }
  const refsRaw = Array.isArray(row.refs) ? row.refs : [];
  const refs: UniverRef[] = [];
  for (const item of refsRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const from = String(entry.from || "").trim();
    const to = String(entry.to || "").trim();
    const range = String(entry.range || entry.data_range || "").trim();
    if (!from || !to || !range) continue;
    const kind = String(entry.kind || "").trim();
    refs.push(kind ? { from, to, range, kind } : { from, to, range });
  }
  const version =
    typeof row.version === "number" && Number.isFinite(row.version)
      ? row.version
      : undefined;
  return version === undefined ? { units, refs } : { version, units, refs };
}

/** Fetch the manifest for a container URL (relative or absolute). */
export async function fetchUniverManifest(
  containerUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<UniverManifest> {
  const url = containerManifestUrl(containerUrl);
  if (!url) {
    throw new Error("Missing .univer container URL");
  }
  const response = await fetcher(url);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Failed to load .univer manifest (${response.status})`);
  }
  return parseUniverManifest(await response.json());
}
