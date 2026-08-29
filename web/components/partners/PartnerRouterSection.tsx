"use client";

/**
 * grok-bot Router parity for partners: pick who answers this partner's turns
 * (the LLM pipeline, or a local agent CLI via the subagent registry), plus a
 * local usage ledger panel (turns / tokens / estimated cost).
 */

import { useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getPartnerUsage,
  getRouterBackends,
  updatePartner,
  type PartnerInfo,
  type PartnerRouting,
  type PartnerUsageSummary,
  type RouterBackendsResponse,
} from "@/lib/partners-api";

export function PartnerRouterSection({
  partner,
  onToast,
  onUpdated,
}: {
  partner: PartnerInfo;
  onToast: (msg: string) => void;
  onUpdated: () => void;
}) {
  const { t } = useTranslation();
  const partnerId = partner.partner_id;
  const routing: PartnerRouting = partner.routing ?? {
    backend: "llm",
    kind: "",
    connection: "",
  };
  const [table, setTable] = useState<RouterBackendsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getRouterBackends()
      .then(setTable)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [partnerId]);

  const save = async (next: PartnerRouting) => {
    setSaving(true);
    try {
      await updatePartner(partnerId, { routing: next });
      onToast(t("Router updated — applies from the next message"));
      onUpdated();
    } catch (e) {
      onToast(e instanceof Error ? e.message : t("Save failed"));
    } finally {
      setSaving(false);
    }
  };

  const cliConnections = (table?.connections ?? []).filter(
    (connection) => connection.kind === routing.kind,
  );

  return (
    <section
      data-partner-router=""
      className="rounded-xl border border-[var(--border)] p-4"
    >
      <div className="mb-3">
        <h3 className="text-[13px] font-medium text-[var(--foreground)]">
          {t("Router")}
        </h3>
        <p className="mt-0.5 text-[11.5px] text-[var(--muted-foreground)]">
          {t(
            "Who answers this partner's turns — the configured LLM, or a local agent CLI.",
          )}
        </p>
      </div>

      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-[var(--muted-foreground)]" />
      ) : (
        <div className="space-y-2">
          <button
            type="button"
            data-router-option="llm"
            onClick={() => void save({ backend: "llm", kind: "", connection: "" })}
            className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
              routing.backend === "llm"
                ? "border-[var(--ring)] bg-[var(--accent)]"
                : "border-[var(--border)] hover:border-[var(--ring)]"
            }`}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">
                {t("LLM pipeline")}
              </span>
              <span className="block text-[11.5px] text-[var(--muted-foreground)]">
                {t(
                  "The product chat loop with the models below — tools, memory, knowledge.",
                )}
              </span>
            </span>
            {routing.backend === "llm" && (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--primary)]" />
            )}
          </button>

          {(table?.backends ?? []).map((backend) => {
            const active =
              routing.backend === "cli" && routing.kind === backend.kind;
            const connections = (table?.connections ?? []).filter(
              (connection) => connection.kind === backend.kind,
            );
            return (
              <div
                key={backend.kind}
                data-router-option={backend.kind}
                className={`rounded-lg border transition-colors ${
                  active
                    ? "border-[var(--ring)] bg-[var(--accent)]"
                    : "border-[var(--border)]"
                }`}
              >
                <button
                  type="button"
                  onClick={() =>
                    void save({
                      backend: "cli",
                      kind: backend.kind,
                      connection: "",
                    })
                  }
                  disabled={saving}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">
                      {backend.display_name}
                    </span>
                    <span className="block text-[11.5px] text-[var(--muted-foreground)]">
                      {t(
                        "Turns are driven through this local CLI with this partner's soul.",
                      )}
                    </span>
                  </span>
                  {backend.available ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {backend.version || t("Detected")}
                    </span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--muted-foreground)]">
                      <CircleDashed className="h-3.5 w-3.5" />
                      {t("Not detected")}
                    </span>
                  )}
                </button>
                {active && connections.length > 0 && (
                  <div className="border-t border-[var(--border)] px-3 py-2">
                    <label className="mb-1 block text-[11.5px] font-medium">
                      {t("Working folder")}
                    </label>
                    <select
                      value={routing.connection ?? ""}
                      onChange={(e) =>
                        void save({
                          backend: "cli",
                          kind: backend.kind,
                          connection: e.target.value,
                        })
                      }
                      className="w-full rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--ring)]"
                    >
                      <option value="">{t("Default (home)")}</option>
                      {connections.map((connection) => (
                        <option key={connection.name} value={connection.name}>
                          {connection.name}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
                      {cliConnections.find(
                        (connection) => connection.name === routing.connection,
                      )?.cwd || t("Runs from the home folder.")}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function PartnerUsageSection({ partner }: { partner: PartnerInfo }) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<PartnerUsageSummary | null>(null);

  useEffect(() => {
    void getPartnerUsage(partner.partner_id, 30)
      .then(setUsage)
      .catch(() => {});
  }, [partner.partner_id]);

  const totals = usage?.totals;
  const empty = !totals || totals.turns === 0;

  return (
    <section
      data-partner-usage=""
      className="rounded-xl border border-[var(--border)] p-4"
    >
      <div className="mb-3">
        <h3 className="text-[13px] font-medium text-[var(--foreground)]">
          {t("Usage")}
        </h3>
        <p className="mt-0.5 text-[11.5px] text-[var(--muted-foreground)]">
          {t(
            "Local activity records for the last 30 days — not a provider invoice.",
          )}
        </p>
      </div>
      {!usage ? (
        <Loader2 className="h-4 w-4 animate-spin text-[var(--muted-foreground)]" />
      ) : empty ? (
        <p className="text-[12.5px] text-[var(--muted-foreground)]">
          {t("No recorded turns yet.")}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-[var(--border)] px-3 py-2">
              <p className="text-[11px] text-[var(--muted-foreground)]">
                {t("Turns")}
              </p>
              <p className="text-[15px] font-semibold">
                {formatCount(totals.turns)}
              </p>
            </div>
            <div className="rounded-lg border border-[var(--border)] px-3 py-2">
              <p className="text-[11px] text-[var(--muted-foreground)]">
                {t("LLM calls")}
              </p>
              <p className="text-[15px] font-semibold">
                {formatCount(totals.total_calls)}
              </p>
            </div>
            <div className="rounded-lg border border-[var(--border)] px-3 py-2">
              <p className="text-[11px] text-[var(--muted-foreground)]">
                {t("Tokens")}
              </p>
              <p className="text-[15px] font-semibold">
                {formatCount(totals.total_tokens)}
              </p>
            </div>
            <div className="rounded-lg border border-[var(--border)] px-3 py-2">
              <p className="text-[11px] text-[var(--muted-foreground)]">
                {t("Est. cost")}
              </p>
              <p className="text-[15px] font-semibold">
                ${totals.cost_usd.toFixed(2)}
              </p>
            </div>
          </div>

          {usage.per_backend.length > 0 && (
            <ul className="space-y-1">
              {usage.per_backend.map((row) => (
                <li
                  key={row.backend}
                  className="flex items-center justify-between text-[12px] text-[var(--muted-foreground)]"
                >
                  <span className="font-mono">{row.backend}</span>
                  <span>
                    {formatCount(row.turns)} · {formatCount(row.total_tokens)}{" "}
                    {t("Tokens")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
