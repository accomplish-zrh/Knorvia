import type { LibraryRequest } from './native-library';
export type StudioInputCapabilities = { maxReferences: number; firstFrame: boolean; lastFrame: boolean; requiresFirstFrame: boolean; requiresLastFrame: boolean };
export type StudioProfile = { id: string; name: string; kind: 'image' | 'video'; protocol: 'openai' | 'fal' | 'json' | 'gemini' | 'runway' | 'replicate' | 'comfyui'; baseUrl: string; model: string; authHeader: string; authPrefix: string; agentEnabled: boolean; keyConfigured?: boolean; keyPersistent?: boolean; inputCapabilities?: StudioInputCapabilities; extra: Record<string, unknown>; custom: Record<string, unknown> };
export type StudioReference = { id: string; version?: string; name?: string };
export type StudioInput = { prompt: string; size: string; aspect: string; count: number; seconds: number; quality: string; references: StudioReference[]; firstFrame?: StudioReference; lastFrame?: StudioReference };
export type StudioOutput = { name: string; mime: string; size: number; sha256: string };
export type StudioJob = { id: string; status: string; kind: 'image' | 'video'; profileId: string; provider: { name: string; model: string }; input: StudioInput; phase: string; createdAt: string; updatedAt: string; progress?: number; error?: string; recoverable?: boolean; outputs: StudioOutput[]; remoteMayContinue?: boolean; source?: string };
export type StudioFrameExport = { jobId: string; outputIndex: number; path: string; sha256: string; sourceVideoSha256: string; streamIndex: number; pts: number; timeBase?: string; width: number; height: number; libraryId: string; libraryVersion: string; name: string; file: string; decoder: string; usedFullScan?: boolean };
export type StudioMediaOperation = { executionId: string; key: string; kind: string; label: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled'; stage: string; progress: number; callers: number; error: string; startedAt: number; finishedAt: number };
// C17: a frame export can be cancelled while it decodes; the cancel only
// ends this caller's participation if another caller joined the same decode.
export const cancelFrameExport = (request: (method: string, params?: unknown) => Promise<unknown>, jobId: string, outputIndex = 0) =>
  request('studio/frame/cancel', { id: jobId, index: outputIndex }) as Promise<{ canceled: boolean; stopped: number; jobId: string; outputIndex: number }>;
export const listStudioOperations = (request: (method: string, params?: unknown) => Promise<unknown>) =>
  request('studio/operations/list', {}) as Promise<{ operations: StudioMediaOperation[] }>;
export type StudioSequenceShot = {
  id: string; order: number; prompt: string; profileId: string; seconds: number;
  continuity: 'previous-tail' | 'none'; status: string; attempt: number;
  acceptedPrompt?: string; firstFrame?: StudioReference; jobId?: string;
  templateId?: string; templateRevision?: number; templateParams?: Record<string, unknown>; templateSnapshot?: string;
  job?: { id: string; status: string; phase?: string; progress?: number; error?: string; outputs?: StudioOutput[]; remoteMayContinue?: boolean };
  result?: { outputIndex: number; outputName: string; outputSha256: string; artifactId?: string; usage?: unknown; tailFrame?: { libraryId: string; libraryVersion: string; libraryName: string; ptsTime?: number; frameSha256: string } };
  error?: string; submittedAt?: string; completedAt?: string;
};
export type StudioSequence = {
  id: string; title: string; state: string; revision: number;
  globalPrompt: string; defaults: { profileId: string; seconds: number; size?: string; aspect?: string };
  shots: StudioSequenceShot[]; blockedReason?: string; createdAt: string; updatedAt: string; progress: number;
};
export type StudioTemplate = { id: string; revision: number; name: string; kind: 'any' | 'image' | 'video'; prompt: string; variables: string[]; defaults: Record<string, unknown>; createdAt: string; updatedAt: string; historyCount?: number };
export type StudioSequencePreviewShot = { shotId: string; order: number; status: string; prompt: string | null; accepted?: boolean; templateId?: string; templateRevision?: number; firstFrame?: StudioReference | null; warnings: string[] };
export const studioFinished = (job: StudioJob) => ['succeeded', 'failed', 'cancelled'].includes(job.status);
export const sequenceFinished = (sequence: StudioSequence) => ['completed', 'failed', 'cancelled'].includes(sequence.state);
// Human-readable storyboard states; unknown provider states fall through.
export function sequenceStateLabel(state: string, t: (zh: string, en: string) => string) {
  const labels: Record<string, [string, string]> = {
    ready: ['待开始', 'Ready'], running: ['进行中', 'Running'], paused: ['已暂停', 'Paused'],
    completed: ['已完成', 'Completed'], failed: ['已失败', 'Failed'], cancelled: ['已取消', 'Cancelled'],
    'needs-attention': ['需要处理', 'Needs attention'],
  };
  const [zh, en] = labels[state] ?? [state, state];
  return t(zh, en);
}
export function shotStateLabel(status: string, t: (zh: string, en: string) => string) {
  const labels: Record<string, [string, string]> = {
    'waiting-dependency': ['等待前一段', 'Waiting on previous'], ready: ['待提交', 'Ready'],
    submitted: ['生成中', 'Generating'], completed: ['已完成', 'Completed'],
    failed: ['失败', 'Failed'], cancelled: ['已取消', 'Cancelled'], blocked: ['受阻', 'Blocked'],
  };
  const [zh, en] = labels[status] ?? [status, status];
  return t(zh, en);
}
// Deterministic composed prompt preview: global prompt, then the shot prompt.
export function composePreview(globalPrompt: string | undefined, shotPrompt: string) {
  const head = (globalPrompt ?? '').trim();
  return head ? `${head}\n\n${shotPrompt.trim()}` : shotPrompt.trim();
}
export async function readStudioOutput(request: LibraryRequest, job: StudioJob, index = 0, signal?: AbortSignal) {
  let offset = 0; const output = job.outputs[index];
  if (!output || !Number.isSafeInteger(output.size) || output.size < 0 || output.size > 256 * 1024 * 1024) throw new Error('Media unavailable');
  if (output.sha256 && !/^[a-f0-9]{64}$/i.test(output.sha256)) throw new Error('Invalid media digest');
  signal?.throwIfAborted();
  const bytes = new Uint8Array(output.size);
  do {
    signal?.throwIfAborted();
    const part: Partial<StudioOutput> & { base64: string; nextOffset: number | null } = await request('studio/content', { id: job.id, index, offset });
    signal?.throwIfAborted();
    if (!part || typeof part.base64 !== 'string' || part.base64.length > Math.ceil(Math.min(512 * 1024, output.size - offset) / 3) * 4) throw new Error('Invalid media chunk');
    if ((part.name !== undefined && part.name !== output.name) || (part.mime !== undefined && part.mime !== output.mime) || (part.size !== undefined && part.size !== output.size) || (output.sha256 && part.sha256 !== undefined && part.sha256.toLowerCase() !== output.sha256.toLowerCase())) throw new Error('The media source changed; reopen the output');
    const decoded = Uint8Array.from(atob(part.base64), char => char.charCodeAt(0));
    const end = offset + decoded.length;
    if (end > output.size || (!decoded.length && end < output.size) || (part.nextOffset === null ? end !== output.size : !Number.isSafeInteger(part.nextOffset) || part.nextOffset !== end || end >= output.size)) throw new Error('The media read was incomplete or out of order');
    bytes.set(decoded, offset);
    offset = end;
  } while (offset < output.size);
  if (output.sha256) {
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
    signal?.throwIfAborted();
    if (digest !== output.sha256.toLowerCase()) throw new Error('The media digest changed; reopen the output');
  }
  return new Blob([bytes], { type: output.mime });
}
// Chunked read of an exported tail frame; mirrors readStudioOutput for the
// derived-frame sidecar files.
export async function readStudioFrame(request: LibraryRequest, jobId: string, index = 0, signal?: AbortSignal) {
  let offset: number | null = 0; let size = 0; let sha256 = '';
  const chunks: Uint8Array[] = [];
  do {
    signal?.throwIfAborted();
    const part: { base64: string; nextOffset: number | null; size: number; sha256: string } = await request('studio/frame/content', { id: jobId, index, offset });
    signal?.throwIfAborted();
    const decoded = Uint8Array.from(atob(part.base64), char => char.charCodeAt(0));
    chunks.push(decoded); size = part.size; sha256 = part.sha256;
    if (part.nextOffset !== null && part.nextOffset <= offset) throw new Error('Frame read did not advance');
    offset = part.nextOffset;
  } while (offset !== null);
  return { blob: new Blob(chunks as BlobPart[], { type: 'image/png' }), size, sha256 };
}
