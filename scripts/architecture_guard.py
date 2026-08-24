"""Prevent known oversized modules from growing during staged decomposition."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LIMIT = 2000
LIMITS = {
    # Frozen at their 1.8.0 sizes (2026-08): both files exceeded their previous
    # budgets during 1.8.0 development. Budgets now pin current reality so the
    # files cannot grow further until staged decomposition lands
    # (ARCHITECTURE.md "Refactoring sequence"). Do NOT raise these again —
    # split instead.
    "knorvia/api/routers/knowledge.py": 2962,
    "knorvia/agents/research/pipeline.py": 2871,
    "web/app/(workspace)/video-studio/page.tsx": 2918,
    "web/components/chat/home/TracePanels.tsx": 2735,
    # Decomposition progress (staged per ARCHITECTURE.md):
    # - video_studio/store.py split 2026-08 into store_base + three domain
    #   mixins (_store_storyboard_board/_uploads_assets/_jobs); facade now
    #   ~590 lines, largest part 723. Budget kept for history until the
    #   file is deleted from LIMITS entirely (default 2000 then applies).
    "knorvia/services/video_studio/store.py": 2000,
    "knorvia/services/video_studio/_store_storyboard_board.py": 2000,
    "knorvia/services/video_studio/_store_uploads_assets.py": 2000,
    "knorvia/services/video_studio/_store_jobs.py": 2000,
    "knorvia/services/video_studio/store_base.py": 2000,
    "knorvia/tools/media_gen_tool.py": 2594,
    "knorvia/services/session/turn_runtime.py": 2212,
    # Session management feature (pin/archive/FTS/export/fork) pushed the
    # store past the default line; next decomposition candidate — extract the
    # FTS/search + export + fork surface into its own module.
    "knorvia/services/session/sqlite_store.py": 2300,
    "web/app/(workspace)/co-writer/[docId]/page.tsx": 2530,
    "knorvia/agents/question/pipeline.py": 2161,
    "web/app/(workspace)/playground/page.tsx": 2082,
    "web/app/(workspace)/home/[[...sessionId]]/page.tsx": 2374,
}
SOURCE_ROOTS = ("knorvia", "knorvia_cli", "web/app", "web/components", "web/lib")
SUFFIXES = {".py", ".ts", ".tsx"}


def main() -> int:
    failures: list[str] = []
    for source_root in SOURCE_ROOTS:
        for path in (ROOT / source_root).rglob("*"):
            if not path.is_file() or path.suffix not in SUFFIXES:
                continue
            relative = path.relative_to(ROOT).as_posix()
            line_count = len(path.read_text(encoding="utf-8").splitlines())
            limit = LIMITS.get(relative, DEFAULT_LIMIT)
            if line_count > limit:
                failures.append(f"{relative}: {line_count} lines (budget {limit})")
    if failures:
        print("Architecture size budget exceeded:")
        print("\n".join(f"- {failure}" for failure in failures))
        return 1
    print("Architecture size budgets passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
