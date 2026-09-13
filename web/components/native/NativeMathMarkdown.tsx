"use client";

/* eslint-disable @next/next/no-img-element */
import { lazy, memo, Suspense, type AnchorHTMLAttributes, type ClassAttributes } from "react";
import type { ExtraProps } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { previewUrl } from "@/lib/native-panel";
import { hasMathSignal, prepareMathMarkdown } from "@/lib/native-math-signal";
export { hasMathSignal };
const MathRenderer = lazy(() => import("./NativeMathRenderer"));

/**
 * Scientific document rendering for the native workbench (B17).
 *
 * Math reuses the already-installed remark-math/rehype-katex with local
 * assets only (no remote fonts or scripts, no raw HTML). KaTeX's own bounds
 * (maxExpand, maxSize) contain macro bombs, untrusted content is never
 * enabled, and a formula that fails to parse degrades to its visible source.
 * Plain chat without math signals keeps the original pipeline, so long
 * conversations pay nothing extra.
 */

export type LinkClick = (href: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }) => void;

// B16: the transform must let bounded file references reach the anchor so the
// click handler can classify them — schemes other than http(s)/file, raw
// protocol-relative URLs, and already-safe web links behave as before.
export function renderableHref(url: string): boolean {
  if (previewUrl(url) || url.startsWith("#")) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return /^file:/i.test(url);
  return !url.startsWith("//");
}

export function isFileCandidate(url: string): boolean {
  return !previewUrl(url) && !url.startsWith("#");
}

export function scrollToAnchor(hash: string, anchor: HTMLAnchorElement) {
  const id = decodeURIComponent(hash.slice(1));
  const root = anchor.closest(".nw-markdown");
  const target = root?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? (id ? document.getElementById(id) : null);
  if (target) { target.scrollIntoView({ block: "start" }); return; }
  anchor.dispatchEvent(new CustomEvent("knorvia:anchor-missing", { bubbles: true }));
}

export const MarkdownContent = memo(function MarkdownContent({ text, onLink, math = false }: { text: string; onLink: LinkClick; math?: boolean }) {
  const renderAnchor = ({ children, href, ...props }: ClassAttributes<HTMLAnchorElement> & AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) => {
    const value = String(href ?? "");
    const local = value.startsWith("#");
    return <a {...props} href={local ? value : value || "#"} target={local || isFileCandidate(value) ? undefined : "_blank"} rel="noopener noreferrer" onClick={event => {
      if (local) { event.preventDefault(); scrollToAnchor(value, event.currentTarget); return; }
      onLink(value, event);
    }} onAuxClick={event => { if (isFileCandidate(value)) event.preventDefault(); }}>{children}</a>;
  };
  const urlTransform = (url: string) => renderableHref(url) ? url : "";
  const plain = <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    urlTransform={urlTransform}
    components={{ a: renderAnchor }}
  >{text}</ReactMarkdown>;
  return math ? <Suspense fallback={plain}><MathRenderer text={prepareMathMarkdown(text).text} components={{ a: renderAnchor }} urlTransform={urlTransform} /></Suspense> : plain;
}, (before, after) => before.text === after.text && before.onLink === after.onLink && before.math === after.math);
