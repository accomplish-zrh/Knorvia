"""Welcome-pack catalog: stable ids, titles, and rendered HTML."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import hashlib
import hmac

from . import pages_api, pages_home, pages_life, pages_start
from .shell import wrap_page
from .v1_legacy import V1_FOLDER_ID, V1_SEED_KEY
from .v2_legacy import V2_SEED_KEY

SEED_VERSION = 3
SEED_KEY = "seed:welcome:v3"
FOLDER_ID = V1_FOLDER_ID
FOLDER_TITLE = "Knorvia 工作台"
V1_META_KEY = V1_SEED_KEY
V2_META_KEY = V2_SEED_KEY


@dataclass(frozen=True)
class WelcomeDocument:
    entry_id: str
    title: str
    sort_order: int
    kicker: str
    lede: str
    html: str


@dataclass(frozen=True)
class _PageSpec:
    entry_id: str
    title: str
    sort_order: int
    kicker: str
    lede: str
    body: str


def _specs() -> tuple[_PageSpec, ...]:
    return (
        _PageSpec(
            "lib_seed_welcome_v1_overview",
            "00 全景 · 这张桌子",
            0,
            "从一张桌子说起",
            "灯、本子、抽屉和书架。大脑要另外请来，不是开机就有。",
            pages_home.body(),
        ),
        _PageSpec(
            "lib_seed_welcome_v1_model",
            "01 结构 · 谁在干活",
            1,
            "先认人",
            "软件、模型、对话、抽屉、书架，各干各的。",
            pages_start.body_model(),
        ),
        _PageSpec(
            "lib_seed_welcome_v1_first_run",
            "02 通电 · 第一次开口",
            2,
            "三格就够",
            "接线、试一句、再干活。不必先背完所有开关。",
            pages_start.body_first_run(),
        ),
        _PageSpec(
            "lib_seed_welcome_v1_map",
            "03 名词 · 别叫混了",
            3,
            "五个亲戚",
            "工具、能力、对话、资料库、知识库：长得很像，活完全不同。",
            pages_start.body_map(),
        ),
        _PageSpec(
            "lib_seed_welcome_v1_api",
            "04 接线 · 请来大脑",
            4,
            "一句话的旅行",
            "你 → Knorvia → 邮局 → 员工 → 钥匙开门 → 回信。Base URL、模型名、API Key 各站一岗。",
            pages_api.body_api(),
        ),
        _PageSpec(
            "lib_seed_welcome_v1_providers",
            "05 名录 · 各家怎么填",
            5,
            "集邮册",
            "只写 Knorvia 里真正登记过的入口。模型名请到你的控制台复制。",
            pages_api.body_providers(),
        ),
        _PageSpec(
            "lib_seed_welcome_v1_verify",
            "06 检测 · 连上了没有",
            6,
            "红灯绿灯",
            "真连接在「设置 → LLM → 运行测试」。这里只教你读报错。",
            pages_api.body_verify(),
        ),
        _PageSpec(
            "lib_seed_welcome_v1_workflow",
            "07 活计 · 今天做什么",
            7,
            "四条小路",
            "搞懂概念、啃教材、写长文、做图做视频——手机上也是一条小径，不是卡片叠罗汉。",
            pages_life.body_workflow(),
        ),
        _PageSpec(
            "lib_seed_welcome_v1_safety",
            "08 边界 · 钥匙与账单",
            8,
            "三只罐子",
            "钥匙等于钱。云端模型会看见你寄出的那一轮。删除导览不会被偷偷种回。",
            pages_life.body_safety(),
        ),
        _PageSpec(
            "lib_seed_welcome_v1_next",
            "09 出门 · 接下来去哪",
            9,
            "推开门",
            "看完导览就离开。去对话、知识库、工作室或命令行。",
            pages_life.body_next(),
        ),
    )


def _nav_html(specs: tuple[_PageSpec, ...], current_id: str) -> str:
    items: list[str] = []
    for spec in specs:
        current = spec.entry_id == current_id
        cls = ' class="current"' if current else ""
        aria = ' aria-current="page"' if current else ""
        items.append(f"<li{cls}{aria}><span>{spec.title}</span></li>")
    joined = "\n".join(items)
    return f"""
      <nav class="rail" aria-label="工作台目录">
        <ol>
          {joined}
        </ol>
        <p class="nav-hint">目录里的篇章都在左侧资料库同一个文件夹中。点那边的标题打开；预览页不能指挥 Knorvia 跳转。</p>
      </nav>
    """


@lru_cache(maxsize=1)
def built_documents() -> tuple[WelcomeDocument, ...]:
    specs = _specs()
    docs: list[WelcomeDocument] = []
    for spec in specs:
        html = wrap_page(
            title=spec.title,
            kicker=spec.kicker,
            lede=spec.lede,
            nav_html=_nav_html(specs, spec.entry_id),
            body=spec.body,
            page_id=spec.entry_id,
        )
        docs.append(
            WelcomeDocument(
                entry_id=spec.entry_id,
                title=spec.title,
                sort_order=spec.sort_order,
                kicker=spec.kicker,
                lede=spec.lede,
                html=html,
            )
        )
    return tuple(docs)


@lru_cache(maxsize=1)
def welcome_html_digests() -> dict[str, str]:
    """Stable entry id → SHA-256 of the current built-in HTML bytes (utf-8)."""
    return {
        doc.entry_id: hashlib.sha256(doc.html.encode("utf-8")).hexdigest()
        for doc in built_documents()
    }


def html_preview_scripts(*, entry_id: str, kind: str, sha256: str) -> bool:
    """True only when this row is an unedited built-in welcome HTML document."""
    if str(kind or "") != "html":
        return False
    expected = welcome_html_digests().get(str(entry_id or ""))
    if not expected:
        return False
    actual = str(sha256 or "").strip().lower()
    if len(actual) != len(expected):
        return False
    return hmac.compare_digest(actual, expected)
