/** Cache-bust a preview URL after the file on disk changes. */

export function previewRevisionFingerprint(headers: {
  get(name: string): string | null;
}): string {
  return [
    headers.get("etag") || "",
    headers.get("last-modified") || "",
    headers.get("content-length") || "",
  ].join("|");
}

export function withPreviewRevision(
  url: string | null,
  revision: number,
): string | null {
  if (!url) return null;
  if (!revision) return url;
  if (
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    url.startsWith("about:")
  ) {
    return url;
  }
  const joiner = url.includes("?") ? "&" : "?";
  return `${url}${joiner}v=${revision}`;
}

export function canWatchPreviewUrl(url: string | null): boolean {
  if (!url) return false;
  return (
    url.startsWith("/") ||
    url.startsWith("http://") ||
    url.startsWith("https://")
  );
}
