"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Cpu,
  Loader2,
  Plug,
  Radar,
  Trash2,
  X,
} from "lucide-react";

import { agentGlyph } from "@/components/agents/agent-icons";
import PartnerAvatar from "@/components/partners/PartnerAvatar";
import SpaceSectionHeader from "@/components/space/SpaceSectionHeader";
import {
  connectSubagent,
  detectSubagents,
  disconnectSubagent,
  listConnectablePartners,
  listSubagentConnections,
  type ConnectablePartner,
  type SubagentBackendInfo,
  type SubagentConnection,
} from "@/lib/subagents-api";

/**
 * Connected agents — live agents the chat composer can select and consult in
 * real time. CLI detection is machine-global and only runs after the user
 * clicks Detect & connect (never on page load).
 */

const PARTNER_KIND = "partner";

type Lang = { zh: string; en: string };

function backendLabel(kind: string, tr: (l: Lang) => string): string {
  if (kind === "claude_code") return "Claude Code";
  if (kind === "codex") return "Codex";
  if (kind === "gemini") return "Gemini CLI";
  if (kind === "kimi") return "Kimi CLI";
  if (kind === "opencode") return "opencode";
  if (kind === "mimo") return "MiMo Code";
  if (kind === "grok_build") return "Grok Build";
  if (kind === PARTNER_KIND) return tr({ zh: "伙伴", en: "Partner" });
  return kind;
}

export default function ConnectedAgents() {
  const { i18n } = useTranslation();
  const zh = i18n.language?.toLowerCase().startsWith("zh");
  const tr = useCallback((l: Lang) => (zh ? l.zh : l.en), [zh]);

  const [connections, setConnections] = useState<SubagentConnection[]>([]);
  const [partners, setPartners] = useState<ConnectablePartner[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [conns, parts] = await Promise.all([
        listSubagentConnections().catch(() => [] as SubagentConnection[]),
        listConnectablePartners().catch(() => [] as ConnectablePartner[]),
      ]);
      setConnections(conns);
      setPartners(parts);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const partnerName = useCallback(
    (id: string) => partners.find((p) => p.partner_id === id)?.name || id,
    [partners],
  );

  const handleDisconnect = useCallback(
    async (name: string) => {
      if (
        !window.confirm(
          tr({
            zh: `断开「${name}」？这只会移除连接，不影响本机的智能体配置。`,
            en: `Disconnect “${name}”? This only removes the connection; your local agent is untouched.`,
          }),
        )
      )
        return;
      setBusyName(name);
      try {
        await disconnectSubagent(name);
        await load();
      } finally {
        setBusyName(null);
      }
    },
    [load, tr],
  );

  return (
    <section className="space-y-4">
      <SpaceSectionHeader
        icon={Plug}
        title={tr({ zh: "连接的智能体", en: "Connected agents" })}
        description={tr({
          zh: "点「检测并连接」后，Knorvia 会扫描本机已安装的 CLI（Claude Code、Codex、Gemini、Kimi、opencode、MiMo、Grok Build），点一下即可接上，不用自己填路径。也可以连接伙伴。",
          en: "Click Detect & connect and Knorvia scans this computer for installed CLIs (Claude Code, Codex, Gemini, Kimi, opencode, MiMo, Grok Build). One click connects them — no path to type. Partners work the same way.",
        })}
        action={
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--foreground)] px-3 py-1.5 text-[12px] font-medium text-[var(--background)] shadow-sm transition-opacity hover:opacity-90"
          >
            <Radar className="h-3.5 w-3.5" />
            {tr({ zh: "检测并连接", en: "Detect & connect" })}
          </button>
        }
      />

      {loading ? (
        <div className="flex items-center gap-2 px-1 text-[12px] text-[var(--muted-foreground)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {tr({ zh: "读取已连接的智能体…", en: "Loading connected agents…" })}
        </div>
      ) : connections.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--card)]/40 px-4 py-5 text-[12.5px] leading-relaxed text-[var(--muted-foreground)]">
          {tr({
            zh: "尚未连接任何智能体。点右上角「检测并连接」，Knorvia 会找出本机的 opencode 等 CLI，再点一次即可接上。",
            en: "No agents connected yet. Click Detect & connect — Knorvia will find local CLIs such as opencode, then one more click connects them.",
          })}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {connections.map((conn) => {
            const Glyph = agentGlyph(conn.agent_kind);
            const partner =
              conn.agent_kind === PARTNER_KIND
                ? partners.find((p) => p.partner_id === conn.partner_id)
                : undefined;
            return (
              <div
                key={conn.name}
                className="group flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--card)] px-4 py-3"
              >
                {partner ? (
                  <PartnerAvatar
                    name={partner.name}
                    emoji={partner.emoji}
                    color={partner.color}
                    image={partner.avatar}
                    size={40}
                    className="shrink-0"
                  />
                ) : (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--border)]/60 bg-[var(--background)] text-[var(--foreground)]">
                    {Glyph ? (
                      <Glyph size={20} />
                    ) : (
                      <Cpu size={18} strokeWidth={1.6} />
                    )}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-semibold tracking-tight text-[var(--foreground)]">
                    {conn.name}
                  </div>
                  <div className="mt-0.5 truncate text-[11.5px] text-[var(--muted-foreground)]">
                    {backendLabel(conn.agent_kind, tr)}
                    {conn.agent_kind === PARTNER_KIND
                      ? conn.partner_id
                        ? ` · ${partnerName(conn.partner_id)}`
                        : ""
                      : conn.cwd
                        ? ` · ${conn.cwd}`
                        : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDisconnect(conn.name)}
                  disabled={busyName === conn.name}
                  title={tr({ zh: "断开", en: "Disconnect" })}
                  aria-label={tr({ zh: "断开", en: "Disconnect" })}
                  className="rounded-lg border border-[var(--border)]/50 p-2 text-[var(--muted-foreground)] transition-colors hover:border-red-300 hover:text-red-600 disabled:opacity-50 dark:hover:border-red-900 dark:hover:text-red-400"
                >
                  {busyName === conn.name ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {modalOpen && (
        <ConnectModal
          partners={partners}
          existingNames={connections.map((c) => c.name)}
          tr={tr}
          onClose={() => setModalOpen(false)}
          onConnected={() => {
            setModalOpen(false);
            void load();
          }}
        />
      )}
    </section>
  );
}

function uniqueConnectionName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let index = 2;
  while (existing.includes(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function ConnectModal({
  partners,
  existingNames,
  tr,
  onClose,
  onConnected,
}: {
  partners: ConnectablePartner[];
  existingNames: string[];
  tr: (l: Lang) => string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [backends, setBackends] = useState<SubagentBackendInfo[]>([]);
  const [detecting, setDetecting] = useState(true);
  const [detectError, setDetectError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [kind, setKind] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [cwd, setCwd] = useState("");
  const [partnerId, setPartnerId] = useState(partners[0]?.partner_id ?? "");
  const [submitting, setSubmitting] = useState(false);

  const runDetect = useCallback(async () => {
    setDetecting(true);
    setDetectError("");
    try {
      // Keep every known local CLI in the list (Codex, Grok Build, …) even
      // when PATH/PATHEXT probe misses it — hide-only-available was dropping
      // npm .cmd shims like Codex from both Detect and Add.
      const found = await detectSubagents();
      setBackends(found);
      setKind((prev) => {
        if (prev && found.some((backend) => backend.kind === prev)) return prev;
        const firstAvailable = found.find((backend) => backend.available);
        return firstAvailable?.kind || found[0]?.kind || "";
      });
    } catch (caught) {
      setBackends([]);
      setDetectError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setDetecting(false);
    }
  }, []);

  useEffect(() => {
    void runDetect();
  }, [runDetect]);

  const selectedBackend = backends.find((backend) => backend.kind === kind);
  const isPartner = kind === PARTNER_KIND;

  useEffect(() => {
    if (nameTouched) return;
    if (isPartner) {
      const picked = partners.find((p) => p.partner_id === partnerId);
      setName(picked?.name ?? "");
      return;
    }
    if (selectedBackend) {
      setName(uniqueConnectionName(selectedBackend.display_name, existingNames));
    }
  }, [
    existingNames,
    isPartner,
    nameTouched,
    partnerId,
    partners,
    selectedBackend,
  ]);

  const connectDetected = useCallback(
    async (backend: SubagentBackendInfo) => {
      setBusyKey(backend.kind);
      setError("");
      try {
        await connectSubagent({
          name: uniqueConnectionName(backend.display_name, existingNames),
          agent_kind: backend.kind,
          cwd: backend.suggested_cwd || "",
        });
        onConnected();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyKey(null);
      }
    },
    [existingNames, onConnected],
  );

  const connectPartner = useCallback(
    async (partner: ConnectablePartner) => {
      setBusyKey(`partner:${partner.partner_id}`);
      setError("");
      try {
        await connectSubagent({
          name: uniqueConnectionName(partner.name, existingNames),
          agent_kind: PARTNER_KIND,
          partner_id: partner.partner_id,
        });
        onConnected();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyKey(null);
      }
    },
    [existingNames, onConnected],
  );

  const submitAdvanced = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(tr({ zh: "请填写名称。", en: "Please enter a name." }));
      return;
    }
    if (existingNames.includes(trimmed)) {
      setError(
        tr({
          zh: "已存在同名连接。",
          en: "A connection with this name already exists.",
        }),
      );
      return;
    }
    if (isPartner && !partnerId) {
      setError(tr({ zh: "请选择一个伙伴。", en: "Please pick a partner." }));
      return;
    }
    if (!isPartner && !kind) {
      setError(
        tr({
          zh: "请先检测本机智能体。",
          en: "Detect local agents first.",
        }),
      );
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await connectSubagent(
        isPartner
          ? { name: trimmed, agent_kind: PARTNER_KIND, partner_id: partnerId }
          : { name: trimmed, agent_kind: kind, cwd: cwd.trim() },
      );
      onConnected();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }, [cwd, existingNames, isPartner, kind, name, onConnected, partnerId, tr]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[min(88vh,720px)] w-full max-w-md overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-serif text-[16px] font-semibold tracking-tight text-[var(--foreground)]">
            {tr({ zh: "检测并连接", en: "Detect & connect" })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)]"
            aria-label={tr({ zh: "关闭", en: "Close" })}
          >
            <X size={16} />
          </button>
        </div>

        <p className="mb-4 text-[12.5px] leading-relaxed text-[var(--muted-foreground)]">
          {tr({
            zh: "正在按你的操作扫描本机 PATH。找到后点「连接」即可，工作目录默认用用户主目录，不用手填隐藏路径。",
            en: "Scanning this computer’s PATH after your click. Connect what we find — they run in your home folder by default, so you never type a hidden path.",
          })}
        </p>

        {detecting ? (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-dashed border-[var(--border)] px-3 py-3 text-[12.5px] text-[var(--muted-foreground)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {tr({ zh: "正在检测本机智能体…", en: "Detecting local agents…" })}
          </div>
        ) : backends.length > 0 ? (
          <div className="mb-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                {tr({ zh: "本机智能体", en: "Local agents" })}
              </p>
              <button
                type="button"
                onClick={() => void runDetect()}
                className="text-[11.5px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                {tr({ zh: "重新检测", en: "Detect again" })}
              </button>
            </div>
            {backends.map((backend) => {
              const Glyph = agentGlyph(backend.kind);
              return (
                <div
                  key={backend.kind}
                  className={`flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 ${
                    backend.available ? "" : "opacity-80"
                  }`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--border)]/60 bg-[var(--card)]">
                    {Glyph ? <Glyph size={18} /> : <Cpu size={16} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">
                      {backend.display_name}
                    </div>
                    <div className="truncate text-[11px] text-[var(--muted-foreground)]">
                      {backend.available
                        ? backend.version ||
                          tr({ zh: "已安装", en: "Installed" })
                        : backend.detail ||
                          tr({ zh: "未检测到", en: "Not detected" })}
                    </div>
                  </div>
                  {backend.available ? (
                    <button
                      type="button"
                      disabled={busyKey === backend.kind}
                      onClick={() => void connectDetected(backend)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[var(--foreground)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--background)] disabled:opacity-50"
                    >
                      {busyKey === backend.kind ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Plug className="h-3.5 w-3.5" />
                      )}
                      {tr({ zh: "连接", en: "Connect" })}
                    </button>
                  ) : (
                    <span className="shrink-0 rounded-lg border border-dashed border-[var(--border)] px-2.5 py-1.5 text-[11.5px] text-[var(--muted-foreground)]">
                      {tr({ zh: "未安装", en: "Missing" })}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mb-4 space-y-2 rounded-xl border border-dashed border-[var(--border)] px-3 py-3 text-[12.5px] leading-relaxed text-[var(--muted-foreground)]">
            <p>
              {detectError
                ? detectError
                : tr({
                    zh: "没有在本机 PATH 上找到可用的智能体 CLI。安装并登录 opencode、Claude Code、Codex、Gemini、Kimi、MiMo 或 Grok Build 后再检测。",
                    en: "No agent CLI found on this computer’s PATH. Install and sign in to opencode, Claude Code, Codex, Gemini, Kimi, MiMo, or Grok Build, then detect again.",
                  })}
            </p>
            <button
              type="button"
              onClick={() => void runDetect()}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--foreground)]"
            >
              <Radar className="h-3.5 w-3.5" />
              {tr({ zh: "重新检测", en: "Detect again" })}
            </button>
          </div>
        )}

        {partners.length > 0 ? (
          <div className="mb-4 space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
              {tr({ zh: "伙伴", en: "Partners" })}
            </p>
            {partners.map((partner) => (
              <div
                key={partner.partner_id}
                className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5"
              >
                <PartnerAvatar
                  name={partner.name}
                  emoji={partner.emoji}
                  color={partner.color}
                  image={partner.avatar}
                  size={36}
                  className="shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">
                    {partner.name}
                  </div>
                  {partner.description ? (
                    <div className="truncate text-[11px] text-[var(--muted-foreground)]">
                      {partner.description}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={busyKey === `partner:${partner.partner_id}`}
                  onClick={() => void connectPartner(partner)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[12px] font-medium disabled:opacity-50"
                >
                  {busyKey === `partner:${partner.partner_id}` ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plug className="h-3.5 w-3.5" />
                  )}
                  {tr({ zh: "连接", en: "Connect" })}
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => setAdvanced((open) => !open)}
          className="mb-2 inline-flex items-center gap-1 text-[12px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${advanced ? "rotate-180" : ""}`}
          />
          {tr({
            zh: "高级：自定义名称或工作目录",
            en: "Advanced: custom name or folder",
          })}
        </button>

        {advanced ? (
          <div className="space-y-3.5 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-3">
            {(backends.length > 0 || partners.length > 0) && (
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-[var(--foreground)]">
                  {tr({ zh: "智能体", en: "Agent" })}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {backends.map((backend) => (
                    <button
                      key={backend.kind}
                      type="button"
                      onClick={() => setKind(backend.kind)}
                      className={`rounded-lg border px-3 py-2 text-[12.5px] font-medium ${
                        kind === backend.kind
                          ? "border-[var(--primary)] bg-[var(--primary)]/[0.07]"
                          : "border-[var(--border)] text-[var(--muted-foreground)]"
                      }`}
                    >
                      {backend.display_name}
                    </button>
                  ))}
                  {partners.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setKind(PARTNER_KIND)}
                      className={`rounded-lg border px-3 py-2 text-[12.5px] font-medium ${
                        isPartner
                          ? "border-[var(--primary)] bg-[var(--primary)]/[0.07]"
                          : "border-[var(--border)] text-[var(--muted-foreground)]"
                      }`}
                    >
                      {tr({ zh: "伙伴", en: "Partner" })}
                    </button>
                  ) : null}
                </div>
              </div>
            )}

            {isPartner ? (
              <select
                value={partnerId}
                onChange={(event) => setPartnerId(event.target.value)}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[13px] outline-none"
              >
                {partners.map((partner) => (
                  <option key={partner.partner_id} value={partner.partner_id}>
                    {partner.emoji ? `${partner.emoji} ` : ""}
                    {partner.name}
                  </option>
                ))}
              </select>
            ) : null}

            <div>
              <label className="mb-1.5 block text-[12px] font-medium">
                {tr({ zh: "名称", en: "Name" })}
              </label>
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameTouched(true);
                }}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[13px] outline-none"
              />
            </div>

            {!isPartner ? (
              <div>
                <label className="mb-1.5 block text-[12px] font-medium">
                  {tr({
                    zh: "工作目录（可选）",
                    en: "Working directory (optional)",
                  })}
                </label>
                <input
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                  placeholder={
                    selectedBackend?.suggested_cwd ||
                    tr({
                      zh: "留空则使用用户主目录",
                      en: "Leave empty to use your home folder",
                    })
                  }
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 font-mono text-[12px] outline-none"
                />
              </div>
            ) : null}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void submitAdvanced()}
                disabled={submitting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--foreground)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--background)] disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plug className="h-3.5 w-3.5" />
                )}
                {tr({ zh: "连接", en: "Connect" })}
              </button>
            </div>
          </div>
        ) : null}

        {error ? (
          <p className="mt-3 text-[12px] text-red-600 dark:text-red-400">{error}</p>
        ) : null}
      </div>
    </div>
  );
}
