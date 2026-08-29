"""Partner usage ledger: record, aggregate, prune."""

from __future__ import annotations

import pytest

from knorvia.services.partners import usage as usage_ledger


@pytest.fixture(autouse=True)
def partner_dir(partners_root):
    from knorvia.partners.config.paths import get_partner_dir

    get_partner_dir("ada")
    return partners_root


class TestRecordAndSummary:
    def test_record_and_totals(self):
        stored = usage_ledger.record(
            "ada",
            {
                "channel": "telegram",
                "backend": "llm",
                "model": "gpt-test",
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
                "total_calls": 2,
                "cost_usd": 0.01,
            },
        )
        assert stored is not None
        summary = usage_ledger.summary("ada", days=30)
        assert summary["totals"]["turns"] == 1
        assert summary["totals"]["total_tokens"] == 15
        assert summary["totals"]["total_calls"] == 2
        assert summary["totals"]["cost_usd"] == 0.01
        assert summary["per_backend"][0]["backend"] == "llm"
        assert len(summary["per_day"]) == 1

    def test_per_backend_split(self):
        usage_ledger.record("ada", {"backend": "llm", "total_tokens": 10, "total_calls": 1})
        usage_ledger.record(
            "ada", {"backend": "cli:claude_code", "total_tokens": 0, "total_calls": 1}
        )
        summary = usage_ledger.summary("ada", days=30)
        backends = {row["backend"]: row["turns"] for row in summary["per_backend"]}
        assert backends == {"llm": 1, "cli:claude_code": 1}

    def test_window_filters_old_rows(self, monkeypatch):
        row_old = {
            "backend": "llm",
            "ts": 1_000_000.0,
            "total_tokens": 999,
            "total_calls": 1,
        }
        usage_ledger.record("ada", row_old)
        usage_ledger.record("ada", {"backend": "llm", "total_tokens": 1, "total_calls": 1})
        summary = usage_ledger.summary("ada", days=30)
        assert summary["totals"]["total_tokens"] == 1

    def test_garbage_rows_are_skipped(self, partner_dir):
        ledger = partner_dir / "ada" / "usage.jsonl"
        ledger.write_text(
            '{"backend": "llm", "total_tokens": 7, "total_calls": 1}\nnot json at all\n',
            encoding="utf-8",
        )
        summary = usage_ledger.summary("ada", days=30)
        assert summary["totals"]["total_tokens"] == 7

    def test_prune_drops_old_rows(self):
        usage_ledger.record("ada", {"backend": "llm", "ts": 1_000.0, "total_calls": 1})
        usage_ledger.record("ada", {"backend": "llm", "total_calls": 1})
        removed = usage_ledger.prune("ada", max_age_days=90)
        assert removed == 1
        summary = usage_ledger.summary("ada", days=90)
        assert summary["totals"]["turns"] == 1
