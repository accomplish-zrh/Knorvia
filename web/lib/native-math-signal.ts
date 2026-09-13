/** Prepare unambiguous math while preserving dollars in prose and code. */
export function prepareMathMarkdown(text: string): { text: string; math: boolean } {
  let output = "", math = false, offset = 0;
  let fence: { char: string; length: number } | undefined;
  while (offset < text.length) {
    if (offset === 0 || text[offset - 1] === "\n") {
      const end = text.indexOf("\n", offset);
      const lineEnd = end < 0 ? text.length : end + 1;
      const line = text.slice(offset, lineEnd);
      const marker = /^(?: {0,3}> ?)* {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length
          && line.slice(marker[0].length).trim() === "") fence = undefined;
        output += line; offset = lineEnd; continue;
      }
      if (marker) {
        fence = { char: marker[1][0], length: marker[1].length };
        output += line; offset = lineEnd; continue;
      }
      if (/^(?: {4}|\t)/.test(line)) { output += line; offset = lineEnd; continue; }
    }
    if (text[offset] === "`") {
      const start = offset;
      while (text[offset] === "`") offset += 1;
      const marker = text.slice(start, offset);
      let end = text.indexOf(marker, offset);
      while (end >= 0 && (text[end - 1] === "`" || text[end + marker.length] === "`")) end = text.indexOf(marker, end + marker.length);
      if (end >= 0) { output += text.slice(start, end + marker.length); offset = end + marker.length; }
      else output += marker;
      continue;
    }
    if (text[offset] === "\\") {
      const delimiter = text[offset + 1];
      if (delimiter === "(" || delimiter === "[") {
        const closing = delimiter === "(" ? "\\)" : "\\]";
        const end = text.indexOf(closing, offset + 2);
        const body = end < 0 ? "" : text.slice(offset + 2, end);
        if (end >= 0 && body.trim() && body.length <= 8192 && !body.includes("$")) {
          output += delimiter === "(" ? `$${body.trim()}$` : `\n\n$$\n${body.trim()}\n$$\n\n`;
          offset = end + 2; math = true; continue;
        }
      }
      output += text.slice(offset, offset + 2); offset += 2; continue;
    }
    if (text[offset] !== "$") { output += text[offset++]; continue; }
    if (text[offset + 1] === "$") {
      const end = text.indexOf("$$", offset + 2);
      if (end >= 0 && end - offset <= 8196) {
        output += text.slice(offset, end + 2); offset = end + 2; math = true; continue;
      }
      output += "\\$\\$"; offset += 2; continue;
    }
    let end = offset + 1;
    while (end < text.length && text[end] !== "\n" && text[end] !== "$") {
      if (text[end] === "\\" && end + 1 < text.length) end += 2;
      else end += 1;
    }
    const body = text.slice(offset + 1, end);
    const currency = /^\d/.test(body) && /[\p{L}\p{N}]/u.test(text[end + 1] ?? "");
    if (text[end] === "$" && body && body.length <= 8192 && !/^\s|\s$/.test(body) && !currency) {
      output += text.slice(offset, end + 1); offset = end + 1; math = true;
    } else { output += "\\$"; offset += 1; }
  }
  return { text: output, math };
}

/** Ordinary conversations avoid invoking Markdown math plugins. */
export function hasMathSignal(text: string): boolean {
  if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) return false;
  return prepareMathMarkdown(text).math;
}
