"use client";

import Image from "next/image";
import {
  BRAND_MARK_PRESETS,
  brandMarkClassName,
  type BrandMarkSize,
} from "@/lib/brand-mark";

interface BrandMarkProps {
  size?: BrandMarkSize;
  alt?: string;
  className?: string;
  priority?: boolean;
}

/** Glass folded-K. Hairline ring lives in `.brand-mark` so the plate reads on cream and dark rails. */
export default function BrandMark({
  size = "md",
  alt = "",
  className = "",
  priority = false,
}: BrandMarkProps) {
  const { px } = BRAND_MARK_PRESETS[size];
  return (
    <Image
      src="/logo.png"
      alt={alt}
      width={px}
      height={px}
      priority={priority}
      draggable={false}
      className={brandMarkClassName(size, className)}
    />
  );
}
