"use client";
import { useRef, useState } from 'react';
import { BookOpen, ImagePlus, Loader2, X } from 'lucide-react';
import { saveLibraryFile, type LibraryEntry, type LibraryIndex, type LibraryRequest } from '@/lib/native-library';
import type { StudioReference } from '@/lib/native-studio';
import { errorText } from './NativeWorkbenchProvider';
import { StudioReferenceImage } from './StudioReferenceInputs';
import { Modal } from './WorkbenchShell';

const limitBytes = 20 * 1024 * 1024;
export function SequenceFramePicker({ request, t, value, onChange, disabled = false }: {
  request: LibraryRequest; t: (zh: string, en: string) => string;
  value?: StudioReference; onChange: (value: StudioReference | undefined) => void; disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [picker, setPicker] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [entries, setEntries] = useState<LibraryEntry[]>([]), [query, setQuery] = useState(''), [shown, setShown] = useState(60), [limited, setLimited] = useState(false);
  const select = (entry: LibraryEntry) => { onChange({ id: entry.id, version: entry.sha256, name: entry.name }); setPicker(false); };
  const upload = async (file: File) => {
    if (busy || disabled) return;
    setBusy(true); setError('');
    try {
      if (!file.size || file.size > limitBytes || !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) throw new Error(t('请选择不超过 20 MB 的 PNG、JPG、WebP 或 GIF', 'Choose a PNG, JPG, WebP or GIF under 20 MB'));
      const bitmap = await createImageBitmap(file); bitmap.close();
      select(await saveLibraryFile(request, `创作素材/分镜/${crypto.randomUUID()}/${file.name}`, file));
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const openLibrary = async () => {
    setBusy(true); setError('');
    try {
      const result = await request<LibraryIndex>('library/list');
      setEntries(result.entries.filter(entry => !entry.folder && !entry.trashedAt && entry.size <= limitBytes && /\.(png|jpe?g|webp|gif)$/i.test(entry.name)));
      setLimited(result.limited); setQuery(''); setShown(60); setPicker(true);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const visible = entries.filter(entry => entry.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="ns-sequence-frame" aria-busy={busy}>
    <input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label={t('上传分镜首帧', 'Upload shot first frame')} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} />
    {value && <div className="ns-sequence-frame-value"><StudioReferenceImage reference={value} label={value.name || t('分镜首帧', 'Shot first frame')} /><span title={value.name}>{value.name || t('已固定首帧', 'Pinned first frame')}</span><button className="nw-icon" type="button" disabled={disabled || busy} onClick={() => onChange(undefined)} aria-label={t('移除分镜首帧', 'Remove shot first frame')}><X size={14} /></button></div>}
    <div className="ns-template-tools"><button className="nw-button" type="button" disabled={disabled || busy} onClick={() => input.current?.click()}>{busy ? <Loader2 size={15} className="nw-spin" /> : <ImagePlus size={15} />}{value ? t('替换首帧', 'Replace first frame') : t('添加首帧', 'Add first frame')}</button><button className="nw-button" type="button" disabled={disabled || busy} onClick={() => void openLibrary()}><BookOpen size={15} />{t('资料库', 'Library')}</button></div>
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
    {picker && <Modal title={t('选择分镜首帧', 'Choose shot first frame')} close={() => setPicker(false)}><div className="ns-reference-picker">
      <input autoFocus aria-label={t('搜索图片', 'Search images')} placeholder={t('搜索图片名称', 'Search image names')} value={query} onChange={event => { setQuery(event.target.value); setShown(60); }} />
      <div className="ns-reference-library-grid">{visible.slice(0, shown).map(entry => <button key={entry.id} type="button" onClick={() => select(entry)}><StudioReferenceImage reference={{ id: entry.id, version: entry.sha256 }} label={entry.name} /><span title={entry.path}>{entry.name}</span></button>)}</div>
      {!visible.length && <p className="ns-hint">{t('没有找到图片，可先上传一张。', 'No images found. Upload one to begin.')}</p>}
      {visible.length > shown && <button className="nw-button" type="button" onClick={() => setShown(current => current + 60)}>{t('加载更多', 'Load more')}</button>}
      {limited && <p className="ns-hint">{t('资料库返回了部分目录；找不到的图片可直接上传。', 'Only part of the library was returned. You can upload an image directly.')}</p>}
    </div></Modal>}
  </div>;
}
