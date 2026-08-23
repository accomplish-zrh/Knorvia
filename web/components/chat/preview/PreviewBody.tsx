"use client";

import { memo } from "react";
import dynamic from "next/dynamic";
import { apiUrl } from "@/lib/api";
import {
  type FilePreviewSource,
  previewKindFor,
} from "./previewerFor";

const PdfPreview = dynamic(() => import("./previewers/PdfPreview"));
const ImagePreview = dynamic(() => import("./previewers/ImagePreview"));
const SvgPreview = dynamic(() => import("./previewers/SvgPreview"));
const MarkdownPreview = dynamic(() => import("./previewers/MarkdownPreview"));
const TextPreview = dynamic(() => import("./previewers/TextPreview"));
const DocxPreview = dynamic(() => import("./previewers/DocxPreview"));
const XlsxPreview = dynamic(() => import("./previewers/XlsxPreview"));
const PptxPreview = dynamic(() => import("./previewers/PptxPreview"));
const OfficeTextPreview = dynamic(
  () => import("./previewers/OfficeTextPreview"),
);
const FallbackPreview = dynamic(() => import("./previewers/FallbackPreview"));

export const PreviewBody = memo(function PreviewBody({
  source,
  previewUrl,
  kind,
}: {
  source: FilePreviewSource;
  previewUrl: string | null;
  kind: ReturnType<typeof previewKindFor> | null;
}) {
  const filename = source.filename;
  const rawExtractedTextUrl = source.extractedTextUrl;
  let extractedTextUrl: string | null = null;
  if (rawExtractedTextUrl) {
    extractedTextUrl =
      rawExtractedTextUrl.startsWith("http") ||
      rawExtractedTextUrl.startsWith("blob:")
        ? rawExtractedTextUrl
        : apiUrl(rawExtractedTextUrl);
  }

  if (kind === "office-text") {
    return (
      <OfficeTextPreview
        filename={filename}
        extractedText={source.extractedText}
        extractedTextUrl={extractedTextUrl}
        url={previewUrl}
      />
    );
  }

  if (!previewUrl) {
    return <FallbackPreview filename={filename} url={null} reason="legacy" />;
  }

  switch (kind) {
    case "pdf":
      return <PdfPreview key={previewUrl} url={previewUrl} filename={filename} />;
    case "docx":
      return <DocxPreview key={previewUrl} url={previewUrl} />;
    case "xlsx":
      return <XlsxPreview key={previewUrl} url={previewUrl} />;
    case "pptx":
      return <PptxPreview key={previewUrl} url={previewUrl} filename={filename} />;
    case "image":
      return <ImagePreview key={previewUrl} url={previewUrl} filename={filename} />;
    case "svg":
      return <SvgPreview url={previewUrl} filename={filename} />;
    case "markdown":
      return (
        <div className="h-full overflow-y-auto">
          <MarkdownPreview url={previewUrl} />
        </div>
      );
    case "code":
    case "text":
      return (
        <div className="h-full overflow-y-auto">
          <TextPreview url={previewUrl} filename={filename} />
        </div>
      );
    case "fallback":
    default:
      return <FallbackPreview filename={filename} url={previewUrl} />;
  }
});

PreviewBody.displayName = "PreviewBody";
