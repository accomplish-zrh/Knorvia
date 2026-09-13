import type { StudioJob, StudioReference } from './native-studio';

export type CanvasNodeKind = 'text' | 'asset' | 'image' | 'video';
export type CanvasEdgeRole = 'context' | 'reference' | 'firstFrame' | 'lastFrame';
export type CanvasNode = {
  id: string; kind: CanvasNodeKind; title: string; x: number; y: number;
  prompt?: string; profileId?: string; reference?: StudioReference;
  settings?: { size?: string; aspect?: string; count?: number; seconds?: number; quality?: string };
  jobId?: string; job?: StudioJob;
};
export type CanvasEdge = { id: string; from: string; to: string; role: CanvasEdgeRole };
export type CanvasDocument = {
  schemaVersion: 1; id: string; title: string; threadId?: string; revision: number;
  globalPrompt: string; nodes: CanvasNode[]; edges: CanvasEdge[];
  createdAt: string; updatedAt: string;
};
export type CanvasSummary = Pick<CanvasDocument, 'id' | 'title' | 'threadId' | 'revision' | 'updatedAt'> & { nodeCount: number };
export type CanvasGenerateResult = { canvas: CanvasDocument; job: StudioJob };

export function canvasEditable(document: CanvasDocument) {
  return { title: document.title, globalPrompt: document.globalPrompt,
    nodes: document.nodes.map(({ job: _job, jobId: _jobId, ...node }) => node),
    edges: document.edges };
}
