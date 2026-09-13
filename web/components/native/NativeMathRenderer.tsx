"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

/** Loaded only for a message or document containing a complete formula. */
export default function NativeMathRenderer({ text, components, urlTransform }: {
  text: string; components: Components; urlTransform: (url: string) => string;
}) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
    rehypePlugins={[[rehypeKatex, { throwOnError: false, errorColor: "#b3261e", strict: false, trust: false, maxExpand: 100, maxSize: 20, output: "htmlAndMathml" }]]}
    urlTransform={urlTransform}
    components={components}
  >{text}</ReactMarkdown>;
}
