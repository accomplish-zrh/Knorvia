"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

const LegacyRootProviders = dynamic(() => import("./LegacyRootProviders"));

export default function ProductRoot({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/" || pathname === "/workbench" || pathname.startsWith("/workbench/")) {
    return children;
  }
  return <LegacyRootProviders>{children}</LegacyRootProviders>;
}
