/**
 * Media render decision for the file panel (X review P1-1).
 *
 * Resolves what the panel should actually render for a `preview/read`
 * result, covering BOTH transports: the legacy base64 → blob path and the
 * D/C stream path (`{ stream: true, url, expiresAt }` — no base64 field).
 * Before this decision existed, a stream response produced an empty
 * `mediaUrl` and therefore no media element at all.
 */

export type MediaReadResult = {
  supported: boolean;
  tooLarge?: boolean;
  size: number;
  mime?: string;
  base64?: string;
  stream?: boolean;
  url?: string;
  expiresAt?: number;
};

export type MediaRenderPlan =
  | { kind: "video" | "audio" | "pdf" | "image"; url: string; source: "stream" | "blob" }
  | { kind: "none" };

/** Decide the media element and its source URL for one preview/read result. */
export function planMediaRender(media: MediaReadResult | undefined, blobUrl: string): MediaRenderPlan {
  // Stream transport (D/C contract): the URL is authoritative and there is
  // no base64 field.
  if (media?.stream && media.url) {
    const mime = media.mime ?? "";
    if (mime.startsWith("video/")) return { kind: "video", url: media.url, source: "stream" };
    if (mime.startsWith("audio/")) return { kind: "audio", url: media.url, source: "stream" };
    if (mime === "application/pdf") return { kind: "pdf", url: media.url, source: "stream" };
    if (mime.startsWith("image/")) return { kind: "image", url: media.url, source: "stream" };
    return { kind: "none" };
  }
  // Blob transport (legacy base64 fast path).
  if (blobUrl && media?.mime) {
    if (media.mime.startsWith("video/")) return { kind: "video", url: blobUrl, source: "blob" };
    if (media.mime.startsWith("audio/")) return { kind: "audio", url: blobUrl, source: "blob" };
    if (media.mime === "application/pdf") return { kind: "pdf", url: blobUrl, source: "blob" };
    if (media.mime.startsWith("image/")) return { kind: "image", url: blobUrl, source: "blob" };
  }
  return { kind: "none" };
}

/** The 64-hex stream token D embeds as the loopback URL's last segment. */
export function streamTokenFromUrl(url: string): string | null {
  const match = /([0-9a-f]{64})(?:[?#].*)?$/i.exec(url);
  return match ? match[1] : null;
}

/**
 * Component-effect decision (X review item 3): what the preview effect does
 * with a settled preview/read response. Drives the real component logic:
 *   - apply + registerToken  → response is current; render it, register the
 *     stream token for revocation on close/switch
 *   - revokeTokens           → late/overwritten responses whose stream tokens
 *     must be revoked immediately (panel closed or a newer path applied)
 *   - apply === false        → never touch component state (stale response)
 */
export type PreviewEffectDecision = {
  apply: boolean;
  registerToken?: string;
  revokeTokens: string[];
};

export function decidePreviewMediaEffect(input: {
  cancelled: boolean;
  result?: MediaReadResult;
  /** The token currently registered by the component, if any. */
  registeredToken?: string;
}): PreviewEffectDecision {
  const { cancelled, result, registeredToken } = input;
  const revokeTokens: string[] = [];
  const decision: PreviewEffectDecision = { apply: false, revokeTokens };
  if (cancelled) {
    // A response arriving after the panel closed or switched paths: its
    // stream token (if any) is revoked immediately and nothing is applied.
    if (result?.stream && result.url) {
      const token = streamTokenFromUrl(result.url);
      if (token) revokeTokens.push(token);
    }
    return decision;
  }
  // Current text, base64, and unsupported-file results all carry visible
  // state too. Token registration is only an extra step for stream results.
  decision.apply = true;
  if (result?.stream && result.url) {
    const token = streamTokenFromUrl(result.url);
    if (token) decision.registerToken = token;
    decision.apply = true;
  }
  void registeredToken;
  return decision;
}
