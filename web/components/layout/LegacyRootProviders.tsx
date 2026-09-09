"use client";

import { AppShellProvider } from "@/context/AppShellContext";
import { I18nClientBridge } from "@/i18n/I18nClientBridge";
import ToastViewport from "@/components/common/ToastViewport";
import BootSplash from "@/components/common/BootSplash";
import DesktopChrome from "@/components/layout/DesktopChrome";
import WallpaperLayer from "@/components/layout/WallpaperLayer";

/** Old domain routes remain readable without joining the native task runtime. */
export default function LegacyRootProviders({ children }: { children: React.ReactNode }) {
  return <AppShellProvider>
    <WallpaperLayer />
    <DesktopChrome />
    <BootSplash />
    <I18nClientBridge>{children}</I18nClientBridge>
    <ToastViewport />
  </AppShellProvider>;
}
