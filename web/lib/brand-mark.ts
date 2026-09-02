/** Shared glass-plate mark: squircle crop + hairline ring (see `.brand-mark`). */

export const BRAND_MARK_CLASS = "brand-mark";

export const BRAND_MARK_PRESETS = {
  xs: { px: 20, className: "h-5 w-5" },
  sm: { px: 22, className: "h-[22px] w-[22px]" },
  md: { px: 24, className: "h-6 w-6" },
  lg: { px: 32, className: "h-8 w-8" },
  xl: { px: 40, className: "h-10 w-10" },
  hero: { px: 56, className: "h-14 w-14" },
} as const;

export type BrandMarkSize = keyof typeof BRAND_MARK_PRESETS;

/** Class list the chrome mark actually paints. */
export function brandMarkClassName(size: BrandMarkSize = "md", extra = ""): string {
  const { className: box } = BRAND_MARK_PRESETS[size];
  return `${BRAND_MARK_CLASS} select-none ${box} ${extra}`.trim();
}
