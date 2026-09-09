"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleHelp, KeyRound, Loader2, LogOut, Plus, PlugZap, RefreshCw, Send, ShieldCheck, Trash2 } from "lucide-react";
import type { NativeConnectionConfig, NativeConnectionTest, NativeModelProvider, NativeProviderProtocol } from "@/lib/knorvia-native-types";
import { providerError, providerLabel } from "@/lib/native-providers";
import { PROVIDER_PRESETS, presetById, quotaLabel } from "@/lib/provider-presets";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";

type AuthLinkRecord = {
  id: string;
  kind: string;
  displayName: string;
  status: string;
  quotaType: string;
  accountAlias?: string | null;
  detail?: string | null;
  loginUrl?: string | null;
};

type AuthLinkEntry = { link: AuthLinkRecord; liveOp?: { id: string; state: string; authorizeUrl?: string | null; expiresAtMs: number } | null };

const AUTH_STATUS_LABEL: Record<string, { zh: string; en: string }> = {
  disconnected: { zh: "未连接", en: "Disconnected" },
  connecting: { zh: "连接中", en: "Connecting" },
  "needs-user": { zh: "待你登录", en: "Waiting for your login" },
  connected: { zh: "已连接", en: "Connected" },
  expired: { zh: "已过期", en: "Expired" },
  error: { zh: "不可用", en: "Unavailable" },
};

function AccountLinksSection() {
  const { t, connection, request, setNotice } = useWorkbench();
  const [links, setLinks] = useState<AuthLinkEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (connection !== "connected") return;
    try {
      const value = await request<{ links: AuthLinkEntry[] }>("auth/link/list", {});
      setLinks(value.links ?? []);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [connection, request]);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (id: string, method: string, params: Record<string, unknown> = {}) => {
    setBusy(id);
    setError("");
    try {
      await request(method, { id, ...params });
      await load();
      setNotice(t("账号连接状态已更新", "Account connection updated"));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };
  return <section className="nw-connection-settings">
    <div className="nw-settings-section-title"><h2><ShieldCheck size={17} />{t("账号连接", "Account connections")}</h2>
      <button className="nw-button nw-button-small" disabled={connection !== "connected" || busy !== null} onClick={() => void (async () => {
        setBusy("refresh-all"); setError("");
        try { await request("auth/link/refresh", {}); await load(); } catch (cause) { setError(providerError(cause, t)); } finally { setBusy(null); }
      })}>{busy === "refresh-all" ? <Loader2 className="nw-spin" size={13} /> : <RefreshCw size={13} />}{t("检测本机状态", "Detect this machine")}</button>
    </div>
    <p className="nw-help">{t(
      "这里显示真实检测到的账号连接。ChatGPT/Codex 登录使用官方公开流程，由你在浏览器完成；Knorvia 只保存连接状态，不保存 Cookie 或令牌。订阅额度与 API 按量额度分开标注，断开连接不会注销你本机 CLI 的账号。",
      "Only really detected account connections appear here. The ChatGPT/Codex login uses the official public flow completed by you in the browser; Knorvia keeps connection status only — never cookies or tokens. Subscription and metered-API quota are labeled separately, and disconnecting never signs you out of your local CLI.",
    )}</p>
    <div className="nw-saved-providers" aria-label={t("账号连接列表", "Account connections")}>
      {links.map(({ link, liveOp }) => (
        <div key={link.id} className="nw-provider-row">
          <span className="nw-provider-mark"><ShieldCheck size={17} /></span>
          <span className="nw-provider-summary">
            <strong>{link.displayName}</strong>
            <small>
              {t(AUTH_STATUS_LABEL[link.status]?.zh ?? link.status, AUTH_STATUS_LABEL[link.status]?.en ?? link.status)}
              {" · "}
              {link.quotaType === "subscription" ? t("订阅额度（随官方客户端）", "Subscription (via official client)") : link.quotaType === "api" ? t("API 额度", "API quota") : t("额度类型未知", "Quota type unknown")}
              {link.accountAlias ? ` · ${link.accountAlias}` : ""}
            </small>
            {link.detail && <small className="nw-help">{link.detail}</small>}
          </span>
          {liveOp && liveOp.authorizeUrl && (
            <>
              <a className="nw-button nw-button-small" href={liveOp.authorizeUrl} target="_blank" rel="noreferrer">{t("打开登录页", "Open login page")}</a>
              <button className="nw-button nw-button-small" disabled={busy !== null} onClick={() => void run(link.id, "auth/link/connect-cancel")}>{t("取消登录", "Cancel login")}</button>
            </>
          )}
          {!liveOp && link.kind === "oauth" && link.id === "codex" && (
            <button className="nw-button nw-button-small" disabled={busy !== null || connection !== "connected"} onClick={() => void run(link.id, "auth/link/connect-start")}>{t("登录", "Sign in")}</button>
          )}
          <button className="nw-button nw-button-small" disabled={busy !== null || connection !== "connected"} onClick={() => void run(link.id, "auth/link/refresh")}>{t("检测", "Detect")}</button>
          {link.status !== "disconnected" && (
            <button className="nw-button nw-button-small" disabled={busy !== null} title={t("只清除本地状态，不影响你本机 CLI", "Clears local state only; your local CLI is untouched")} onClick={() => void run(link.id, "auth/link/disconnect")}><LogOut size={13} />{t("断开", "Disconnect")}</button>
          )}
        </div>
      ))}
    </div>
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
  </section>;
}

type Draft = { id?: string; revision?: number; name: string; model: string; baseUrl: string; protocol: NativeProviderProtocol; apiKey: string; clearKey: boolean };
const emptyDraft = (): Draft => ({ name: "", model: "", baseUrl: "", protocol: "responses", apiKey: "", clearKey: false });
function draftFor(provider: NativeModelProvider): Draft {
  return { id: provider.id, revision: provider.revision, name: provider.name, model: provider.model ?? "", baseUrl: provider.baseUrl ?? "", protocol: provider.protocol ?? "responses", apiKey: "", clearKey: false };
}

export function ConnectionSettings() {
  const { t, connection, connectionInfo: info, request, models, reconnect, setNotice } = useWorkbench();
  const [draft, setDraft] = useState<Draft | null>(null);
  // Keep unsaved edits in memory when browsing other providers.
  const drafts = useRef(new Map<string, Draft>());
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<NativeConnectionTest>();
  const [deleting, setDeleting] = useState(false);
  const [presetId, setPresetId] = useState("");
  const selectedPreset = presetId ? presetById(presetId) : undefined;
  useEffect(() => {
    if (!draft && info?.providers.length) setDraft(draftFor(info.providers.find(p => p.id === info.activeProviderId) ?? info.providers[0]));
  }, [draft, info]);
  const saved = info?.providers.find(p => p.id === draft?.id);
  const active = Boolean(saved && saved.id === info?.activeProviderId);
  const changed = Boolean(draft && (!saved || draft.name !== saved.name || draft.model !== (saved.model ?? "") || draft.baseUrl !== (saved.baseUrl ?? "") || draft.protocol !== (saved.protocol ?? "responses") || draft.apiKey || draft.clearKey));
  const busy = pending || testing || connection !== "connected";
  const update = (fields: Partial<Draft>) => { setDraft(current => current && ({ ...current, ...fields })); setResult(undefined); setDeleting(false); };
  const select = (provider?: NativeModelProvider) => {
    if (draft) drafts.current.set(draft.id ?? "new", draft);
    setDraft(drafts.current.get(provider?.id ?? "new") ?? (provider ? draftFor(provider) : emptyDraft()));
    setError(""); setResult(undefined); setDeleting(false);
  };
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setPending(true); setError("");
    try { await operation(); } catch (error) { setError(providerError(error, t)); } finally { setPending(false); }
  };

  return <div className="nw-connections-stack">
    <AccountLinksSection />
    <section className="nw-connection-settings">
    <div className="nw-settings-section-title"><h2><PlugZap size={17} />{t("模型提供商", "Model providers")}</h2><button className="nw-button nw-button-small" disabled={busy} onClick={() => select()}><Plus size={14} />{t("添加提供商", "Add provider")}</button></div>
    <p className="nw-help">{t("保存多套模型连接，随时切换。支持 Responses、Chat Completions 和 Claude Messages。当前提供商用于对话和自动化，切换会等待任务空闲。", "Save multiple connections using Responses, Chat Completions or Claude Messages. The current provider serves conversations and automations; switching waits until tasks are idle.")}</p>
    <div className="nw-usage-toolbar nw-provider-preset-picker" role="group" aria-label={t("服务商预设", "Provider presets")}>
      <select
        aria-label={t("从服务商预设添加", "Add from a provider preset")}
        value={presetId}
        onChange={event => {
          const id = event.target.value;
          setPresetId(id);
          const preset = presetById(id);
          if (preset) {
            if (draft) drafts.current.set(draft.id ?? "new", draft);
            setDraft({ ...emptyDraft(), name: t(preset.label.zh, preset.label.en), baseUrl: preset.baseUrl, protocol: preset.protocol });
            setError(""); setResult(undefined); setDeleting(false);
          }
        }}
      >
        <option value="">{t("从服务商预设添加…", "Add from a provider preset…")}</option>
        {PROVIDER_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{t(preset.label.zh, preset.label.en)}</option>)}
      </select>
      {selectedPreset && <span className="nw-help">{quotaLabel(selectedPreset, t)} · {t("预设只填地址与协议，密钥仍由你保存。", "Presets fill address and protocol only; you keep your own key.")}</span>}
    </div>
    {!info ? <div className="nw-connection-offline" role="status"><p>{t("正在读取模型连接…", "Loading model connections…")}</p><button className="nw-button" onClick={() => void reconnect().catch(error => setError(providerError(error, t)))}><RefreshCw size={14} />{t("重新连接", "Reconnect")}</button></div> : <>
      <div className="nw-saved-providers" aria-label={t("已保存的提供商", "Saved providers")}>
        {info.providers.map(provider => <div key={provider.id} className={`nw-provider-row ${draft?.id === provider.id ? "is-selected" : ""}`}>
          <button className="nw-provider-open" aria-pressed={draft?.id === provider.id} disabled={pending || testing} onClick={() => select(provider)}>
            <span className="nw-provider-mark"><PlugZap size={17} /></span><span className="nw-provider-summary"><strong>{providerLabel(provider, t)}</strong><small>{provider.model || t("尚未配置", "Not configured")}{provider.baseUrl && <span> · {provider.baseUrl}</span>}</small></span>
          </button>
          {provider.id === info.activeProviderId ? <span className="nw-provider-current"><Check size={13} />{t("当前使用", "Current")}</span> : <button className="nw-button nw-button-small" disabled={busy || !provider.configured} title={!provider.configured ? t("请先补全连接信息和密钥", "Complete the connection and key first") : undefined} onClick={() => void run(async () => {
            await request("connection/provider/activate", { id: provider.id, revision: provider.revision });
            setResult(undefined); setNotice(t("当前提供商已切换", "Current provider switched"));
          })}>{t("使用", "Use")}</button>}
        </div>)}
      </div>
      {!info.providers.length && !draft && <div className="nw-settings-empty"><PlugZap size={20} aria-hidden="true" /><div><strong>{t("添加你的第一个模型提供商", "Add your first model provider")}</strong><p>{t("使用上方预设，或手动填写服务地址与密钥。", "Start with a preset above, or enter a service URL and key.")}</p></div></div>}
      <p className="nw-key-storage"><ShieldCheck size={14} /><span>{info.transport === "browser" ? t("浏览器预览仅在本次服务运行期间保留配置。桌面应用会加密保存每个提供商的密钥。", "Browser preview keeps connections for this service session. The desktop app saves each provider’s key with system encryption.") : info.secureStorageAvailable ? t("密钥由系统加密保存在此设备，分别保存，界面不会回显。", "Each provider’s key is encrypted on this device and never displayed again.") : t("系统安全存储暂时不可用，请恢复后再保存配置。", "System secure storage is unavailable. Restore it before saving connections.")}</span></p>
      {draft && <form className="nw-provider-editor" onSubmit={event => { event.preventDefault(); void run(async () => {
        const value = await request<NativeConnectionConfig & { savedProviderId: string }>("connection/provider/save", {
          ...(draft.id ? { id: draft.id, revision: draft.revision } : {}), name: draft.name.trim(), model: draft.model.trim(), baseUrl: draft.baseUrl.trim(), protocol: draft.protocol,
          ...(draft.clearKey ? { clearKey: true } : draft.apiKey ? { apiKey: draft.apiKey } : {}),
        });
        drafts.current.delete(draft.id ?? "new");
        const provider = value.providers.find(p => p.id === value.savedProviderId)!;
        setDraft(draftFor(provider)); setResult(undefined);
        setNotice(active ? t("连接已更新", "Connection updated") : t("提供商已保存，可随时切换使用", "Provider saved and ready to switch to"));
      }); }}>
        <div className="nw-provider-editor-title"><strong>{saved ? t("连接详情", "Connection details") : t("新提供商", "New provider")}</strong>{saved && <span>{providerLabel(saved, t)}</span>}</div>
        <fieldset disabled={busy}>
          <div className="nw-field"><span>{t("接口协议", "API protocol")}</span><div className="nw-usage-toolbar" role="group" aria-label={t("接口协议", "API protocol")}>
            {([['responses', 'Responses'], ['chat-completions', 'Chat Completions'], ['anthropic-messages', 'Claude Messages']] as const).map(([value, label]) => <button type="button" key={value} className={`nw-usage-range${draft.protocol === value ? ' is-active' : ''}`} aria-pressed={draft.protocol === value} onClick={() => update({ protocol: value })}>{label}</button>)}
          </div><small className="nw-help">{t("按提供商文档选择，协议和密钥会随此连接一起保存。", "Choose the protocol in your provider’s documentation. It is saved with this connection.")}</small></div>
          <label className="nw-field">{t("提供商名称", "Provider name")}<input required maxLength={80} autoComplete="off" value={draft.name} onChange={event => update({ name: event.target.value })} placeholder={t("例如：日常工作、备用服务", "e.g. Daily work, Backup service")} /></label>
          <div className="nw-form-columns"><label className="nw-field">{t("默认模型", "Default model")}<input aria-label={t("默认模型", "Default model")} required maxLength={256} list="nw-connection-models" autoComplete="off" value={draft.model} onChange={event => update({ model: event.target.value })} placeholder={t("输入服务提供的模型名称", "Enter a model offered by your provider")} /><datalist id="nw-connection-models">{(selectedPreset?.models ?? []).map(entry => <option key={`preset-${entry.model}`} value={entry.model} />)}{models.map(entry => <option key={entry.id} value={entry.model ?? entry.id}>{entry.displayName}</option>)}</datalist></label><label className="nw-field">{t("服务地址", "Service URL")}<input required type="url" maxLength={2048} autoComplete="off" spellCheck={false} value={draft.baseUrl} onChange={event => update({ baseUrl: event.target.value })} placeholder={t("https://…/v1", "https://…/v1")} /></label></div>
          {selectedPreset && draft.model && (() => {
            const presetModel = selectedPreset.models.find(entry => entry.model === draft.model);
            if (!presetModel) return null;
            const efforts = presetModel.reasoningEfforts;
            return <p className="nw-help">
              {efforts ? t(`预设标注该模型支持推理强度：${efforts.join(" / ")}；不支持的档位不会被发送。`, `Preset lists reasoning strengths: ${efforts.join(" / ")}; unsupported levels are never sent.`) : t("预设未标注该模型的推理档位（由服务端能力决定，不会伪造档位）。", "The preset does not list reasoning levels for this model (decided by server capability; levels are never invented).")}
              {presetModel.note ? ` ${t(presetModel.note.zh, presetModel.note.en)}` : ""}
            </p>;
          })()}
          <label className="nw-field"><span><KeyRound size={13} />{t("API 密钥", "API key")}</span><input type="password" maxLength={16384} autoComplete="new-password" spellCheck={false} value={draft.apiKey} disabled={draft.clearKey} onChange={event => update({ apiKey: event.target.value })} placeholder={saved?.apiKeyConfigured ? t("已设置，留空以保留", "Configured; leave blank to keep it") : t("输入模型服务的密钥", "Enter your model service key")} /></label>
          {(saved?.apiKeyConfigured || saved?.credentialStorage === "unavailable") && <label className="nw-checkbox-row"><input type="checkbox" checked={draft.clearKey} onChange={event => update({ clearKey: event.target.checked })} /><span>{t("移除此提供商的密钥", "Remove this provider’s key")}</span></label>}
          {saved?.credentialStorage === "unavailable" && <p className="nw-inline-error">{t("此密钥暂时无法解密，原加密数据仍然保留。可重新输入密钥修复。", "This key cannot be decrypted. Its encrypted data is preserved; enter a new key to repair it.")}</p>}
          <div className="nw-connection-actions">{saved && !active && <button className="nw-button nw-provider-delete" type="button" onClick={() => setDeleting(!deleting)}><Trash2 size={14} />{t("删除提供商", "Delete provider")}</button>}<button className="nw-button" type="button" onClick={() => void run(async () => {
            const value = await request<NativeConnectionConfig>("connection/read");
            const provider = value.providers.find(p => p.id === draft.id);
            drafts.current.delete(draft.id ?? "new"); setDraft(provider ? draftFor(provider) : emptyDraft()); setResult(undefined); setDeleting(false);
          })}><RefreshCw size={14} />{t("重新读取", "Reload")}</button><button className="nw-button nw-button-primary" disabled={!changed || !draft.name.trim() || !draft.model.trim() || !draft.baseUrl.trim()}>{pending ? <Loader2 size={14} className="nw-spin" /> : <Check size={14} />}{t("保存连接", "Save connection")}</button></div>
        </fieldset>
        {deleting && saved && !active && <div className="nw-provider-delete-confirm" role="alert"><span>{t("删除后将移除这项连接和保存的密钥。", "This removes the connection and its saved key.")}</span><button type="button" className="nw-button nw-button-small" disabled={busy} onClick={() => setDeleting(false)}>{t("取消", "Cancel")}</button><button type="button" className="nw-button nw-button-small" disabled={busy} onClick={() => void run(async () => {
          const value = await request<NativeConnectionConfig>("connection/provider/delete", { id: saved.id, revision: saved.revision });
          drafts.current.delete(saved.id); setDraft(draftFor(value.providers.find(p => p.id === value.activeProviderId)!)); setDeleting(false); setResult(undefined);
          setNotice(t("提供商已删除", "Provider deleted"));
        })}>{t("确认删除", "Delete")}</button></div>}
        {active && <div className="nw-provider-probe"><div><strong>{t("验证模型服务", "Verify the model service")}</strong><p>{t("向已保存的服务发送一个简短测试请求，会消耗少量模型额度。", "Send a short request to the saved service. This uses a small amount of model quota.")}</p></div><button className="nw-button" type="button" disabled={busy || changed || !saved?.configured} onClick={async () => {
          setTesting(true); setError(""); setResult(undefined);
          try { setResult(await request<NativeConnectionTest>("connection/test", { probeProvider: true })); }
          catch (error) { setError(providerError(error, t)); } finally { setTesting(false); }
        }}>{testing ? <Loader2 className="nw-spin" size={14} /> : <Send size={14} />}{t("发送测试请求", "Send test request")}</button></div>}
        {result && <div className={`nw-probe-result ${result.providerVerified ? "is-verified" : ""}`} role="status">{result.providerVerified ? <Check size={16} /> : <CircleHelp size={16} />}<span>{result.providerVerified ? t("模型服务已响应测试请求。", "The model service responded to the test request.") : t("尚未通过实际请求验证，请检查连接信息。", "The request could not verify this provider. Check the connection details.")}</span></div>}
      </form>}
    </>}
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
    </section>
  </div>;
}
