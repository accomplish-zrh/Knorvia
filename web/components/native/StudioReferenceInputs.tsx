"use client";
/* eslint-disable @next/next/no-img-element -- These are private local Blob URLs, never public optimizer inputs. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ArrowLeftRight, BookOpen, ImagePlus, Loader2, Plus, X } from 'lucide-react';
import { libraryMime, saveLibraryFile, type LibraryEntry, type LibraryIndex, type LibraryRequest } from '@/lib/native-library';
import type { StudioInput, StudioInputCapabilities, StudioReference } from '@/lib/native-studio';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { Modal } from './WorkbenchShell';

type Target = 'references' | 'firstFrame' | 'lastFrame';
export type StudioReferenceHandle = { importFiles: (files: FileList | File[]) => Promise<void> };
const maxBytes = 20 * 1024 * 1024;

async function readImage(request: LibraryRequest, ref: StudioReference, signal: AbortSignal) {
  let offset = 0, length = 0, version = ref.version, name = ref.name ?? '';
  const parts: Uint8Array<ArrayBuffer>[] = [];
  do {
    signal.throwIfAborted();
    const part = await request<{ entry: LibraryEntry; sha256: string; size: number; base64: string; nextOffset: number | null }>('library/read', { id: ref.id, version, offset });
    signal.throwIfAborted();
    if (part.size > maxBytes) throw new Error('参考图超过 20 MB');
    version ??= part.sha256; name = part.entry.name;
    const bytes = Uint8Array.from(atob(part.base64), ch => ch.charCodeAt(0));
    length += bytes.length;
    if (length > maxBytes || (part.nextOffset !== null && part.nextOffset <= offset)) throw new Error('参考图读取失败');
    parts.push(bytes);
    if (part.nextOffset === null) break;
    offset = part.nextOffset;
  } while (true);
  return new Blob(parts, { type: libraryMime(name) });
}

export function StudioReferenceImage({ reference, label }: { reference: StudioReference; label: string }) {
  return <LoadedReferenceImage key={`${reference.id}:${reference.version ?? ''}`} id={reference.id} version={reference.version} label={label} />;
}
function LoadedReferenceImage({ id, version, label }: { id: string; version?: string; label: string }) {
  const { request, t } = useWorkbench();
  const [source, setSource] = useState(''), [failed, setFailed] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController(); let url = '', started = false;
    const load = () => {
      if (started) return; started = true;
      readImage(request, { id, version }, controller.signal).then(blob => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob); setSource(url);
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    };
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { load(); observer.disconnect(); } }, { rootMargin: '80px' });
    if (element.current) observer.observe(element.current);
    return () => { observer.disconnect(); controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [request, id, version]);
  return <div ref={element} className="ns-reference-image">{source && !failed ? <img src={source} alt={label} onError={() => setFailed(true)} /> : <span className="ns-reference-loading">{failed ? t('素材不可用', 'Unavailable') : <Loader2 size={17} className="nw-spin" />}</span>}</div>;
}

export const StudioReferenceInputs = forwardRef<StudioReferenceHandle, {
  kind: 'image' | 'video'; value: StudioInput; capabilities?: StudioInputCapabilities; disabled: boolean;
  update: (fn: (current: StudioInput) => StudioInput) => void; busy: (value: boolean) => void; error: (value: string) => void;
}>(function StudioReferenceInputs({ kind, value, capabilities, disabled, update, busy, error }, ref) {
  const { request, t } = useWorkbench();
  const input = useRef<HTMLInputElement>(null), target = useRef<Target>('references'), uploading = useRef(false);
  const [picker, setPicker] = useState<Target>(), [entries, setEntries] = useState<LibraryEntry[]>([]), [query, setQuery] = useState('');
  const [preview, setPreview] = useState<StudioReference>(), [dragging, setDragging] = useState<Target>();
  const limit = capabilities?.maxReferences ?? 6;
  const title = (slot: Target) => slot === 'firstFrame' ? t('首帧', 'First frame') : slot === 'lastFrame' ? t('尾帧', 'Last frame') : t('参考图', 'Reference images');
  const add = (entry: LibraryEntry, slot: Target) => {
    const reference = { id: entry.id, version: entry.sha256, name: entry.name };
    update(current => slot === 'references'
      ? { ...current, references: [...current.references.filter(item => item.id !== entry.id), reference] }
      : { ...current, [slot]: reference });
  };
  const importFiles = async (files: FileList | File[], slot: Target = kind === 'image' ? 'references' : 'firstFrame') => {
    if (disabled || uploading.current) return;
    const incoming = Array.from(files); if (!incoming.length) return;
    const available = slot === 'references' ? Math.max(0, limit - value.references.length) : 1;
    if (incoming.length > available) { error(slot === 'references' ? t(`还可以添加 ${available} 张参考图`, `You can add ${available} more references`) : t('每个帧位请选择一张图片', 'Choose one image for each frame')); return; }
    if (incoming.some(file => !file.size || file.size > maxBytes || !/\.(png|jpe?g|webp|gif)$/i.test(file.name))) { error(t('请选择 PNG、JPG、WebP 或 GIF，每张不超过 20 MB', 'Choose PNG, JPG, WebP or GIF, up to 20 MB each')); return; }
    uploading.current = true; busy(true); error('');
    try {
      for (const file of incoming) {
        // Validate decoding before importing so a renamed non-image does not
        // leave a broken attachment in the draft or consume a provider request.
        const bitmap = await createImageBitmap(file); bitmap.close();
        add(await saveLibraryFile(request, `创作素材/${crypto.randomUUID()}/${file.name}`, file), slot);
      }
    } catch (e) { error(errorText(e)); }
    finally { uploading.current = false; busy(false); if (input.current) input.current.value = ''; }
  };
  useImperativeHandle(ref, () => ({ importFiles: files => importFiles(files) }));
  const chooseFile = (slot: Target) => { target.current = slot; input.current?.click(); };
  const chooseLibrary = async (slot: Target) => {
    error('');
    try { const index = await request<LibraryIndex>('library/list'); setEntries(index.entries.filter(entry => !entry.trashedAt && !entry.folder && entry.size <= maxBytes && /\.(png|jpe?g|webp|gif)$/i.test(entry.name))); setQuery(''); setPicker(slot); }
    catch (e) { error(errorText(e)); }
  };
  const frame = (slot: 'firstFrame' | 'lastFrame') => {
    const current = value[slot], supported = !capabilities || capabilities[slot];
    return <div className="ns-frame" data-frame={slot} data-dragging={dragging === slot || undefined} data-unsupported={!supported || undefined}
      onDragOver={event => { event.preventDefault(); event.stopPropagation(); if (supported) setDragging(slot); }} onDragLeave={() => setDragging(undefined)}
      onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragging(undefined); if (supported) void importFiles(event.dataTransfer.files, slot); }}>
      <header><span>{title(slot)}</span><span>{(slot === 'firstFrame' ? capabilities?.requiresFirstFrame : capabilities?.requiresLastFrame) ? t('必填', 'Required') : t('可选', 'Optional')}</span></header>
      {current ? <><button type="button" className="ns-frame-preview" onClick={() => setPreview(current)} aria-label={`${t('预览', 'Preview')} ${title(slot)}`}><StudioReferenceImage reference={current} label={`${title(slot)}: ${current.name ?? current.id}`} /></button><span className="ns-frame-name" title={current.name}>{current.name ?? current.id}</span></>
        : <button type="button" className="ns-frame-empty" disabled={disabled || !supported} onClick={() => chooseFile(slot)} aria-label={`${t('上传', 'Upload')} ${title(slot)}`}><ImagePlus size={22} strokeWidth={1.5} /><span>{supported ? t('点击或拖入图片', 'Click or drop an image') : t('此连接未支持', 'Not configured')}</span></button>}
      <footer><button type="button" disabled={disabled || !supported} onClick={() => chooseLibrary(slot)} aria-label={`${t('从资料库选择', 'Choose from library')} ${title(slot)}`}><BookOpen size={14} />{t('资料库', 'Library')}</button>{current && <><button type="button" disabled={disabled || !supported} onClick={() => chooseFile(slot)} aria-label={`${t('替换', 'Replace')} ${title(slot)}`}>{t('替换', 'Replace')}</button><button type="button" disabled={disabled} onClick={() => update(draft => ({ ...draft, [slot]: undefined }))} aria-label={`${t('移除', 'Remove')} ${title(slot)}`}><X size={14} /></button></>}</footer>
    </div>;
  };
  return <div className="ns-reference-inputs">
    <input hidden ref={input} data-testid="studio-reference-upload" aria-label={t('上传创作素材', 'Upload creation input')} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple={kind === 'image'} onChange={event => { if (event.target.files) void importFiles(event.target.files, target.current); }} />
    {kind === 'image' ? <><div className="ns-reference-topline"><div><ImagePlus size={16} /><span>{t('参考图', 'Reference images')}</span><small>{value.references.length} / {limit}</small></div><div><button type="button" disabled={disabled || value.references.length >= limit} onClick={() => chooseFile('references')} aria-label={t('上传参考图', 'Upload reference')}><Plus size={14} />{t('添加', 'Add')}</button><button type="button" disabled={disabled || value.references.length >= limit} onClick={() => void chooseLibrary('references')} aria-label={t('从资料库选择参考图', 'Choose library reference')}><BookOpen size={14} />{t('资料库', 'Library')}</button></div></div>
      {value.references.length ? <div className="ns-reference-strip">{value.references.map((reference, index) => <div className="ns-reference-tile" key={reference.id}><button type="button" className="ns-reference-preview" onClick={() => setPreview(reference)} aria-label={`${t('预览参考图', 'Preview reference')} ${index + 1}`}><StudioReferenceImage reference={reference} label={reference.name ?? reference.id} /></button><span title={reference.name}>{reference.name ?? reference.id}</span><button type="button" className="ns-reference-remove" disabled={disabled} aria-label={`${t('移除参考图', 'Remove reference')}: ${reference.name ?? reference.id}`} onClick={() => update(current => ({ ...current, references: current.references.filter(item => item.id !== reference.id) }))}><X size={13} /></button></div>)}</div>
        : <p className="ns-reference-help">{limit ? t('也可以把图片拖到这里，或直接粘贴。', 'You can also drag images here or paste them.') : t('此模型未配置参考图支持，可切换模型。', 'Choose another model to use reference images.')}</p>}</>
      : <div className="ns-frame-pair">{frame('firstFrame')}<button type="button" className="ns-frame-swap" disabled={disabled || !value.firstFrame || !value.lastFrame || !capabilities?.lastFrame} aria-label={t('交换首尾帧', 'Swap first and last frames')} title={t('交换首尾帧', 'Swap first and last frames')} onClick={() => update(current => ({ ...current, firstFrame: current.lastFrame, lastFrame: current.firstFrame }))}><ArrowLeftRight size={17} /></button>{frame('lastFrame')}</div>}
    {picker && <Modal title={t('选择', 'Choose') + title(picker)} close={() => setPicker(undefined)}><div className="ns-reference-picker"><input aria-label={t('搜索参考素材', 'Search reference images')} placeholder={t('搜索图片名称', 'Search image names')} value={query} onChange={event => setQuery(event.target.value)} /><div className="ns-reference-library-grid">{entries.filter(entry => entry.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(entry => <button type="button" key={entry.id} disabled={picker === 'references' && (value.references.length >= limit || value.references.some(item => item.id === entry.id))} onClick={() => { add(entry, picker); setPicker(undefined); }}><StudioReferenceImage reference={{ id: entry.id, version: entry.sha256, name: entry.name }} label={entry.name} /><span title={entry.path}>{entry.name}</span></button>)}</div>{!entries.length && <p>{t('还没有图片，先上传一张即可。', 'Upload an image to get started.')}</p>}</div></Modal>}
    {preview && <Modal title={preview.name ?? t('参考图', 'Reference image')} close={() => setPreview(undefined)}><div className="ns-reference-full"><StudioReferenceImage reference={preview} label={preview.name ?? t('参考图', 'Reference image')} /></div></Modal>}
  </div>;
});
