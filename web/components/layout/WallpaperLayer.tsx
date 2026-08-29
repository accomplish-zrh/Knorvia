"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  applyWallpaperToDocument,
  loadDesktopWallpaper,
  readStoredWallpaper,
  subscribeToWallpaper,
  wallpaperSceneFromPath,
} from "@/lib/wallpaper";

/**
 * First-class wallpaper layer: one photo under the chrome, never a fake
 * screenshot overlay. Native controls stay in the React tree above it.
 */
export default function WallpaperLayer() {
  const pathname = usePathname() || "/";

  useEffect(() => {
    applyWallpaperToDocument(readStoredWallpaper());
    void loadDesktopWallpaper();
    return subscribeToWallpaper(applyWallpaperToDocument);
  }, []);

  useEffect(() => {
    const scene = wallpaperSceneFromPath(pathname);
    document.documentElement.setAttribute("data-wallpaper-scene", scene);
    return () => {
      document.documentElement.removeAttribute("data-wallpaper-scene");
    };
  }, [pathname]);

  return (
    <div id="knorvia-wallpaper" aria-hidden="true" data-wallpaper-layer="" />
  );
}