"""Per-partner usage ledger — local request/token/cost records.

grok-bot keeps a local usage surface ("activity records, not an invoice");
partners mirror that: every completed turn appends one row to
``data/partners/{id}/usage.jsonl`` and :func:`summary` folds the window into
totals plus per-day and per-backend breakdowns for the settings UI.

The ledger is deliberately dumb — append-only JSON with best-effort writes —
so accounting can never break a turn.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import threading
import time
from typing import Any

from knorvia.partners.config.paths import get_partner_dir

logger = logging.getLogger(__name__)

_LEDGER_FILE = "usage.jsonl"
#: Keep the ledger bounded: drop rows older than this many days on rewrite.
MAX_AGE_DAYS = 90
DEFAULT_WINDOW_DAYS = 30


def _ledger_path(partner_id: str) -> Path:
    return get_partner_dir(partner_id) / _LEDGER_FILE


def _sanitize_row(row: dict[str, Any]) -> dict[str, Any]:
    """Coerce one ledger row into its stored shape (never raises)."""

    def _int(value: Any) -> int:
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return 0

    def _num(value: Any) -> float:
        try:
            return max(0.0, float(value))
        except (TypeError, ValueError):
            return 0.0

    return {
        "ts": float(row.get("ts") or time.time()),
        "channel": str(row.get("channel") or "web"),
        "backend": str(row.get("backend") or "llm"),
        "model": str(row.get("model") or ""),
        "prompt_tokens": _int(row.get("prompt_tokens")),
        "completion_tokens": _int(row.get("completion_tokens")),
        "total_tokens": _int(row.get("total_tokens")),
        "total_calls": max(1, _int(row.get("total_calls"))),
        "cost_usd": round(_num(row.get("cost_usd")), 6),
    }


def record(partner_id: str, row: dict[str, Any]) -> dict[str, Any] | None:
    """Append one usage row; returns the stored row (None on failure).

    Failures are swallowed — usage accounting is best-effort telemetry and
    must never fail (or even slow down) a partner turn.
    """
    stored = _sanitize_row(row)
    try:
        path = _ledger_path(partner_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(stored, ensure_ascii=False) + "\n")
        return stored
    except OSError:
        logger.warning("Failed to append partner usage row", exc_info=True)
        return None


def _load(partner_id: str) -> list[dict[str, Any]]:
    path = _ledger_path(partner_id)
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(_sanitize_row(json.loads(line)))
            except (json.JSONDecodeError, ValueError):
                continue
    except OSError:
        return []
    return rows


def summary(partner_id: str, *, days: int = DEFAULT_WINDOW_DAYS) -> dict[str, Any]:
    """Fold the last *days* of the ledger into UI-ready aggregates."""
    try:
        days = max(1, min(int(days), MAX_AGE_DAYS))
    except (TypeError, ValueError):
        days = DEFAULT_WINDOW_DAYS

    rows = _load(partner_id)
    cutoff = time.time() - days * 86400
    rows = [row for row in rows if row["ts"] >= cutoff]

    totals = {
        "turns": 0,
        "total_calls": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "cost_usd": 0.0,
    }
    per_day: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "turns": 0,
            "total_calls": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "cost_usd": 0.0,
        }
    )
    per_backend: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "turns": 0,
            "total_calls": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "cost_usd": 0.0,
        }
    )
    for row in rows:
        day = datetime.fromtimestamp(row["ts"], tz=timezone.utc).strftime("%Y-%m-%d")
        backend = row["backend"]
        for bucket in (totals, per_day[day], per_backend[backend]):
            bucket["turns"] += 1
            bucket["total_calls"] += row["total_calls"]
            bucket["prompt_tokens"] += row["prompt_tokens"]
            bucket["completion_tokens"] += row["completion_tokens"]
            bucket["total_tokens"] += row["total_tokens"]
            bucket["cost_usd"] = round(bucket["cost_usd"] + row["cost_usd"], 6)

    return {
        "days": days,
        "totals": totals,
        "per_day": [
            {"day": day, **values} for day, values in sorted(per_day.items(), reverse=True)[:days]
        ],
        "per_backend": [
            {"backend": backend, **values}
            for backend, values in sorted(
                per_backend.items(), key=lambda item: item[1]["turns"], reverse=True
            )
        ],
    }


def prune(partner_id: str, *, max_age_days: int = MAX_AGE_DAYS) -> int:
    """Rewrite the ledger without rows older than the cutoff; returns removed count."""
    path = _ledger_path(partner_id)
    rows = _load(partner_id)
    cutoff = time.time() - max_age_days * 86400
    kept = [row for row in rows if row["ts"] >= cutoff]
    removed = len(rows) - len(kept)
    if removed <= 0:
        return 0
    try:
        temporary = path.with_suffix(f".{threading.get_ident()}.tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            for row in kept:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        temporary.replace(path)
        return removed
    except OSError:
        logger.warning("Failed to prune partner usage ledger", exc_info=True)
        return 0


__all__ = ["record", "summary", "prune", "DEFAULT_WINDOW_DAYS", "MAX_AGE_DAYS"]
