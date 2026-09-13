import test from "node:test";
import assert from "node:assert/strict";
import { hasMathSignal, prepareMathMarkdown } from "../lib/native-math-signal";

test("single-symbol inline math coexists with currency and literal code", () => {
  const source = 'Price $5 to $10; $x$ and $2+3$; `$code$`\n```js\nconst a = "$literal$";\n```\n\\$cash and unfinished $z';
  const result = prepareMathMarkdown(source);
  assert.equal(result.math, true);
  assert.ok(result.text.includes('Price \\$5 to \\$10; $x$ and $2+3$; `$code$`'));
  assert.ok(result.text.includes('const a = "$literal$";'));
  assert.ok(result.text.endsWith('\\$cash and unfinished \\$z'));
  assert.equal(hasMathSignal('$x$'), true);
  assert.equal(hasMathSignal('`$x$`'), false);
});

test("bracket formulas normalize without modifying fenced, inline, or indented code", () => {
  const source = '\\(x\\) and \\[y^2\\]\n    code $x$\n> ~~~\n> $literal$\n> ~~~\n``code `$x$` ``';
  const result = prepareMathMarkdown(source);
  assert.ok(result.text.startsWith('$x$ and \n\n$$\ny^2\n$$'));
  assert.ok(result.text.includes('    code $x$'));
  assert.ok(result.text.endsWith('``code `$x$` ``'));
  assert.equal(hasMathSignal('> ~~~\n> $literal$\n> ~~~'), false);
});

test("math signals are detected in inline, block, and bracket forms", () => {
  assert.equal(hasMathSignal("质能方程 $E = mc^2$ 很有名"), true);
  assert.equal(hasMathSignal("$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$"), true);
  assert.equal(hasMathSignal("欧拉公式 \\( e^{i\\pi} + 1 = 0 \\) 很美"), true);
  assert.equal(hasMathSignal("块级：\\[a^2 + b^2 = c^2\\]"), true);
});

test("plain chat, currency, and code stay out of the math pipeline", () => {
  assert.equal(hasMathSignal("这个功能要多少钱？100 元一份，共 3 份。"), false);
  assert.equal(hasMathSignal("价格区间是 $5 到 $6 之间。"), false);
  assert.equal(hasMathSignal("```\nconst price = $input;\n```\n普通说明文字。"), false);
  assert.equal(hasMathSignal(""), false);
});

test("katex renders locally with untrusted content: hostile links never survive", () => {
  // Direct katex use mirrors the configured rehype plugin (trust: false).
  const katex = require("katex");
  const hostile = katex.renderToString("\\href{javascript:alert(1)}{click}", { throwOnError: false, trust: false });
  // The URL must never become a live anchor attribute; untrusted \href is inert.
  assert.doesNotMatch(hostile, /<a [^>]*href\s*=\s*["']?\s*javascript:/i);
  assert.doesNotMatch(hostile, /<script/);
  const malformed = katex.renderToString("\\frac{1", { throwOnError: false });
  assert.match(malformed, /katex-error/);
  // Local bundle only: no remote asset references are emitted.
  const normal = katex.renderToString("E = mc^2", { throwOnError: false });
  // No fetched assets: xmlns namespaces are identifiers, not requests.
  assert.doesNotMatch(normal, /<link|src=["']http|url\(\s*["']?http|@import/);
});

test("macro bombs stay bounded by katex expansion limits", () => {
  const katex = require("katex");
  const bomb = katex.renderToString("\\def\\x{\\x\\x}\\x", { throwOnError: false, maxExpand: 100 });
  assert.equal(typeof bomb, "string");
  assert.ok(bomb.length < 100_000);
});
