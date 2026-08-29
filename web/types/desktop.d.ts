type DesktopHttpRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
};

type DesktopHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

type DesktopTitleBarOverlay = {
  color: string;
  symbolColor: string;
};

type DesktopWindowMaterial = {
  material: "none" | "mica" | "acrylic" | "tabbed" | "auto";
  backgroundColor: string;
  vibrancy: "under-window" | null;
};

type DesktopWindowState = {
  maximized: boolean;
};

type DesktopWallpaperImportResult = {
  ok?: boolean;
  canceled?: boolean;
  error?: string;
  source?: string;
};

type DesktopWallpaperPreset = {
  id: string;
  file: string;
  titleEn: string;
  url: string;
  publicUrl: string;
  available: boolean;
};

type DesktopChrome = {
  platform: string;
  captionOverlay: boolean;
  trafficLights: boolean;
  setTitleBarOverlay(overlay: DesktopTitleBarOverlay): void;
  setWindowMaterial(payload: DesktopWindowMaterial): void;
  windowMinimize(): void;
  windowMaximize(): void;
  windowClose(): void;
  windowIsMaximized(): Promise<boolean>;
  onWindowState(callback: (state: DesktopWindowState) => void): () => void;
};

interface Window {
  knorviaDesktop?: {
    fetch(request: DesktopHttpRequest): Promise<DesktopHttpResponse>;
    wsOpen(id: string, path: string): void;
    wsSend(id: string, data: string): void;
    wsClose(id: string): void;
    onWsEvent(id: string, callback: (event: { type: string; data?: string; error?: string }) => void): () => void;
    chrome?: DesktopChrome;
    wallpaper?: {
      getState(): Promise<{ id: string; src: string | null; builtins?: { id: string; title: string; src: string }[] }>;
      setBuiltin(id: string): Promise<{ id: string; src: string | null }>;
      importCustom(): Promise<{ id: string; src: string | null }>;
      clear(): Promise<{ id: string; src: string | null }>;
    };
  };
}
