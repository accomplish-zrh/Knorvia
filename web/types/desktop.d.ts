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

interface Window {
  knorviaDesktop?: {
    fetch(request: DesktopHttpRequest): Promise<DesktopHttpResponse>;
    wsOpen(id: string, path: string): void;
    wsSend(id: string, data: string): void;
    wsClose(id: string): void;
    onWsEvent(id: string, callback: (event: { type: string; data?: string; error?: string }) => void): () => void;
  };
}
