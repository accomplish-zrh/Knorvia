import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  BRAND_MARK_CLASS,
  BRAND_MARK_PRESETS,
  brandMarkClassName,
} from "../lib/brand-mark";

const webRoot = process.cwd();

function read(rel: string) {
  return readFileSync(path.join(webRoot, rel), "utf8");
}

const CHROME_MARK_SITES: { rel: string; sizes: string[]; minCount: number }[] = [
  { rel: "components/sidebar/SidebarShell.tsx", sizes: ["sm", "md"], minCount: 2 },
  { rel: "components/layout/AppShell.tsx", sizes: ["sm"], minCount: 1 },
  { rel: "app/(workspace)/home/[[...sessionId]]/page.tsx", sizes: ["xl"], minCount: 1 },
  { rel: "components/chat/home/SessionLoadingView.tsx", sizes: ["lg"], minCount: 1 },
  { rel: "app/(auth)/login/page.tsx", sizes: ["hero"], minCount: 1 },
  { rel: "app/(auth)/register/page.tsx", sizes: ["hero"], minCount: 1 },
];

test("brandMarkClassName always paints the glass-plate class plus the size box", () => {
  const sm = brandMarkClassName("sm");
  assert.match(sm, new RegExp(`\\b${BRAND_MARK_CLASS}\\b`));
  assert.match(sm, /h-\[22px\]/);
  assert.match(sm, /w-\[22px\]/);
  assert.equal(BRAND_MARK_PRESETS.sm.px, 22);
  assert.equal(BRAND_MARK_PRESETS.md.px, 24);
  assert.equal(BRAND_MARK_PRESETS.xl.px, 40);
  assert.equal(BRAND_MARK_PRESETS.hero.px, 56);
  const extra = brandMarkClassName("md", "group-hover:scale-105");
  assert.match(extra, /\bbrand-mark\b/);
  assert.match(extra, /group-hover:scale-105/);
});

test("chrome mark sites use BrandMark, not an ad-hoc /logo.png Image", () => {
  for (const site of CHROME_MARK_SITES) {
    const src = read(site.rel);
    const hits = src.match(/<BrandMark\b/g) ?? [];
    assert.ok(
      hits.length >= site.minCount,
      `${site.rel} should render BrandMark at least ${site.minCount} time(s), got ${hits.length}`,
    );
    for (const size of site.sizes) {
      assert.match(src, new RegExp(`size="${size}"`));
    }
    assert.doesNotMatch(src, /src=["']\/logo\.png["']/);
  }
});

test("BrandMark component wires the shipped class helper and /logo.png only there", () => {
  const mark = read("components/common/BrandMark.tsx");
  assert.match(mark, /brandMarkClassName/);
  assert.match(mark, /src=["']\/logo\.png["']/);
  assert.match(mark, /from ["']@\/lib\/brand-mark["']/);
});

test("shared overlay and auth chrome use chrome-card, overlay scrim, and auth-aura", () => {
  const palette = read("components/common/CommandPalette.tsx");
  assert.match(palette, /\bchrome-card\b/);
  assert.match(palette, /bg-\[var\(--overlay\)\]/);
  assert.match(palette, /backdrop-blur-\[6px\]/);

  const confirm = read("components/ui/ConfirmDialog.tsx");
  assert.match(confirm, /\bchrome-card\b/);
  assert.match(confirm, /bg-\[var\(--overlay\)\]/);
  assert.match(confirm, /backdrop-blur-\[4px\]/);

  const auth = read("app/(auth)/layout.tsx");
  assert.match(auth, /\bauth-aura\b/);

  const login = read("app/(auth)/login/page.tsx");
  assert.match(login, /\bchrome-card\b/);
  assert.match(login, /<BrandMark/);

  const register = read("app/(auth)/register/page.tsx");
  assert.match(register, /\bchrome-card\b/);
  assert.match(register, /<BrandMark/);
});

test("global chrome CSS defines the squircle ring, 20px card, mint selection", () => {
  const css = read("app/globals.css");
  assert.match(css, /\.brand-mark\s*\{/);
  assert.match(css, /border-radius:\s*22%/);
  assert.match(css, /0 0 0 1px/);
  assert.match(css, /\.chrome-card\s*\{/);
  assert.match(css, /border-radius:\s*20px/);
  assert.match(css, /::selection\s*\{/);
  assert.match(css, /html\.dark ::selection/);
  assert.match(css, /#8fd4c8/);
  assert.match(css, /\.auth-aura\s*\{/);
  assert.match(css, /143,\s*212,\s*200/);
  assert.match(css, /183,\s*182,\s*227/);
});

test("shared Button exposes a keyboard focus-visible ring", () => {
  const button = read("components/ui/Button.tsx");
  assert.match(button, /focus-visible:ring-2/);
  assert.match(button, /focus-visible:ring-\[var\(--ring\)\]/);
});

test("web BootSplash v4 keeps the glass plate class and no motes/breathe", () => {
  const splash = read("components/common/BootSplash.tsx");
  assert.match(splash, /Boot splash v4/);
  assert.match(splash, /\bbrand-mark\b/);
  assert.match(splash, /boot-sheen/);
  assert.match(splash, /boot-aura/);
  assert.match(splash, /rx="28"/);
  assert.doesNotMatch(splash, /boot-mote|className="mote"/);
  assert.doesNotMatch(splash, /breathe/);
});
