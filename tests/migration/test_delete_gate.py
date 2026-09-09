"""DEL-001 删除门禁：旧 Runtime 生产引用清单只能缩短，不能增长。

权威清单：docs/migration/DEL-001-PREP.md（2026-09-05 基线，31 个文件）。
本测试把清单固化为可执行的回归门禁：

* 新文件 import 旧协议（knorvia.core.stream_bus / knorvia.core.stream）→ 失败；
* 清单中的文件已不再 import 旧协议 → 失败并提示从清单与 DEL-001-PREP.md 移除；
* 清单缩短到零 → DEL-001 进入实际源码删除阶段。

豁免：knorvia/runtime/kernel_client.py 是 ADR-001 §6.9 的 LegacyViewAdapter。
"""

from __future__ import annotations

from pathlib import Path

PRODUCT_ROOT = Path(__file__).resolve().parents[2]
PREP_DOC = PRODUCT_ROOT / "docs" / "migration" / "DEL-001-PREP.md"

LEGACY_IMPORT_RE = r"from knorvia\.core\.(stream_bus|stream) import"

# 2026-09-05 基线：与 DEL-001-PREP.md §3 完全一致（按字母序）。
BASELINE: frozenset[str] = frozenset(
    {
        "knorvia/runtime/kernel_client.py",
    }
)

EXEMPT: frozenset[str] = frozenset(
    {
        # ADR-001 §6.9 LegacyViewAdapter：Kernel 事件 → 旧 UI 视图适配器；
        # 最后一个旧消费者删除时一并删除。
        "knorvia/runtime/kernel_client.py",
    }
)


def _current_importers() -> set[str]:
    import re

    pattern = re.compile(LEGACY_IMPORT_RE)
    found: set[str] = set()
    for path in sorted((PRODUCT_ROOT / "knorvia").rglob("*.py")):
        rel = path.relative_to(PRODUCT_ROOT).as_posix()
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if pattern.search(text):
            found.add(rel)
    return found


def test_prep_doc_exists_and_matches_baseline() -> None:
    assert PREP_DOC.is_file(), "DEL-001-PREP.md must stay in the repo"
    text = PREP_DOC.read_text(encoding="utf-8")
    for rel in sorted(BASELINE - EXEMPT):
        assert rel in text, f"{rel} missing from DEL-001-PREP.md inventory"


def test_no_new_legacy_stream_imports() -> None:
    """旧协议不得扩散：新文件 import StreamBus/StreamEvent 即失败。"""
    current = _current_importers()
    allowed = BASELINE
    new = sorted(current - allowed)
    assert not new, (
        "new files started importing the legacy stream protocol; route them "
        f"through the Knorvia Protocol instead: {new}"
    )


def test_inventory_only_shrinks() -> None:
    """清单只能缩短：已迁移的文件必须从 DEL-001-PREP.md 与本门禁的基线一起移除。"""
    current = _current_importers()
    stale = sorted(BASELINE - current)
    assert not stale, (
        "inventory entries no longer import the legacy protocol; remove them "
        f"from docs/migration/DEL-001-PREP.md and this gate's baseline: {stale}"
    )


def test_exempt_files_stay_within_contract() -> None:
    """豁免文件必须仍然存在且确实是适配器（有 stream_as_stream_events）。"""
    for rel in EXEMPT:
        path = PRODUCT_ROOT / rel
        assert path.is_file(), f"exempt file disappeared: {rel}"
        assert (
            "stream_as_stream_events" in path.read_text(encoding="utf-8")
        ), f"exempt file no longer hosts the legacy view adapter: {rel}"
