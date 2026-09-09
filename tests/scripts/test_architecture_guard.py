"""The size-budget guard must actually enforce the documented 800-line cap."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _guard():
    spec = importlib.util.spec_from_file_location(
        "architecture_guard", ROOT / "scripts" / "architecture_guard.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_office_runtime_modules_are_capped_at_800_lines() -> None:
    guard = _guard()
    assert guard.budget_for("knorvia/services/office_artifacts/store.py") == 800
    # A new file created by splitting one is covered too — the rule is a prefix.
    assert guard.budget_for("knorvia/services/office_artifacts/revisions.py") == 800
    assert guard.budget_for("knorvia/tools/office_apply.py") == 800
    assert guard.budget_for("web/lib/office-draft.ts") == 800


def test_the_cap_catches_a_file_the_old_default_waved_through() -> None:
    guard = _guard()
    # 868 lines passed silently when only the 2000-line default applied.
    assert 868 > guard.budget_for("knorvia/services/office_artifacts/store.py")
    assert 868 <= guard.DEFAULT_LIMIT


def test_an_explicit_per_file_pin_still_wins() -> None:
    guard = _guard()
    pinned = "knorvia/services/session/turn_runtime.py"
    assert guard.budget_for(pinned) == guard.LIMITS[pinned]
    assert guard.budget_for("knorvia/services/anything_else.py") == guard.DEFAULT_LIMIT
