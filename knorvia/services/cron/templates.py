"""Built-in automation templates for the scheduling UI.

A small curated catalog shown on the Automations settings page. Applying a
template is a plain job creation — the router turns a template into a
``CronCreateRequest``-shaped payload with prefilled name/message/schedule,
so templates never bypass :class:`~knorvia.services.cron.service.CronService`
validation or quotas.

Catalog strings are localized here (en + zh) rather than in the web locale
files because the prompt text travels with the created job: it must be the
same language the executor will run it in.
"""

from __future__ import annotations

from dataclasses import dataclass

_LANGUAGES = ("zh", "en")


@dataclass(frozen=True)
class CronTemplate:
    """One predefined automation the user can one-click create from."""

    id: str
    icon: str  # lucide-react icon name, resolved by the web UI
    title: dict[str, str]
    description: dict[str, str]
    # Instruction sent to the chat agent when the scheduled run fires.
    message: dict[str, str]
    schedule: dict  # {"kind": "cron", "expr": ...} | {"kind": "every", ...}


def _t(zh: str, en: str) -> dict[str, str]:
    return {"zh": zh, "en": en}


_TEMPLATES: tuple[CronTemplate, ...] = (
    CronTemplate(
        id="daily-ai-news-brief",
        icon="Newspaper",
        title=_t("每日 AI 新闻简报", "Daily AI news brief"),
        description=_t(
            "每天早上推送 AI 行业热点新闻摘要与趋势分析",
            "Every morning, get a digest of AI industry headlines and trend analysis",
        ),
        message=_t(
            "请联网搜索今天 AI 行业的热点新闻，挑出最重要的 5 条：每条给出摘要、"
            "关键事实和一条趋势判断，最后说明哪些变化值得持续关注。",
            "Search today's top AI industry news on the web and pick the five most "
            "important stories: summarize each with key facts and one trend read, "
            "then note which shifts are worth watching.",
        ),
        schedule={"kind": "cron", "expr": "30 8 * * *"},
    ),
    CronTemplate(
        id="brand-sentiment-weekly",
        icon="Eye",
        title=_t("品牌舆情监控周报", "Brand sentiment weekly"),
        description=_t(
            "每周自动抓取品牌在社交媒体和社区中的提及与评价，生成舆情摘要",
            "Weekly digest of brand mentions and reviews across social media and communities",
        ),
        message=_t(
            "请搜索过去一周社交平台和技术社区中关于我们品牌的提及与评价，"
            "整理成舆情周报：按正面/中性/负面归类，摘出有代表性的原文，"
            "指出需要回应的问题并给出建议口径。",
            "Search last week's mentions and reviews of our brand across social "
            "platforms and tech communities and produce a sentiment weekly: group "
            "feedback positive/neutral/negative, quote representative posts, flag "
            "issues that need a response, and suggest talking points.",
        ),
        schedule={"kind": "cron", "expr": "0 9 * * 1"},
    ),
    CronTemplate(
        id="competitor-watch-weekly",
        icon="Radar",
        title=_t("每周竞品动态追踪", "Competitor watch"),
        description=_t(
            "定期追踪竞品的产品更新、社区反馈和重要新闻",
            "Track competitor releases, community feedback, and major news on a cadence",
        ),
        message=_t(
            "请追踪本周主要竞品的动态：产品更新与发布公告、定价变化、社区反馈和重要新闻，"
            "汇总成一页竞品简报，并指出对我们策略的影响。",
            "Track this week's moves by our main competitors: product updates and launch "
            "announcements, pricing changes, community feedback, and notable news. Summarize "
            "into a one-page brief and call out implications for our strategy.",
        ),
        schedule={"kind": "cron", "expr": "0 10 * * 1"},
    ),
    CronTemplate(
        id="stock-price-monitor",
        icon="TrendingUp",
        title=_t("股价监控与预警", "Stock price monitor"),
        description=_t(
            "每个交易日追踪关注的股票价格变动，异常波动时自动预警",
            "Each trading day, track followed stocks and flag abnormal moves",
        ),
        message=_t(
            "请查询今日关注股票的价格表现（默认列出涨跌幅最大的市场标的即可，"
            "如需具体清单请在下方指令中补充代码），标注异常波动并给出可能原因；"
            "只有当波动超过通常水平时才升级为预警。",
            "Look up today's performance for the stocks we follow (default to the biggest "
            "movers per market unless a specific list is appended below), flag abnormal "
            "volatility with likely causes, and escalate to an alert only when a move is "
            "unusual.",
        ),
        schedule={"kind": "cron", "expr": "0 9 * * 1-5"},
    ),
    CronTemplate(
        id="security-vuln-scan",
        icon="ShieldCheck",
        title=_t("安全漏洞扫描", "Security vulnerability scan"),
        description=_t(
            "定期扫描代码仓库，发现经验证的中高危安全漏洞",
            "Periodically scan code repositories for validated medium/high severity vulnerabilities",
        ),
        message=_t(
            "请扫描当前项目的依赖清单与关键代码路径，找出已验证的中高危安全漏洞："
            "给出漏洞编号、影响范围、修复版本或缓解措施，并按风险排序输出修复清单。",
            "Scan this project's dependency manifests and critical code paths for validated "
            "medium/high severity vulnerabilities: list CVE identifiers, blast radius, fixed "
            "versions or mitigations, and output a remediation checklist sorted by risk.",
        ),
        schedule={"kind": "cron", "expr": "0 7 * * *"},
    ),
    CronTemplate(
        id="bug-hunt-from-commits",
        icon="Bug",
        title=_t("扫描提交发现 Bug", "Commit bug hunt"),
        description=_t(
            "分析最近的代码提交，发现可能导致严重后果的高危 Bug",
            "Analyze recent commits for high-risk bugs with severe consequences",
        ),
        message=_t(
            "请审查最近合并的代码提交（最近 3 天），寻找可能导致崩溃、数据损坏、"
            "安全问题或回归的高危 Bug：说明触发条件与证据，标注严重程度，并给出最小修复方案。",
            "Review commits merged in the last three days for high-risk bugs that could cause "
            "crashes, data corruption, security issues, or regressions: describe trigger "
            "conditions and evidence, rate severity, and propose a minimal fix.",
        ),
        schedule={"kind": "cron", "expr": "0 8 * * 1-5"},
    ),
    CronTemplate(
        id="test-coverage-backfill",
        icon="FlaskConical",
        title=_t("补充测试覆盖", "Test coverage backfill"),
        description=_t(
            "识别最近变更中缺少测试的高风险代码，自动补充测试",
            "Spot high-risk untested changes and add tests for them automatically",
        ),
        message=_t(
            "请检查最近的变更中缺少测试覆盖的高风险代码（边界条件、并发、错误处理），"
            "为其中最关键的部分补充单元测试，运行确认通过后汇报新增用例清单。",
            "Check recent changes for high-risk code without test coverage (edge cases, "
            "concurrency, error handling), write unit tests for the most critical parts, run "
            "them until green, then report which cases were added.",
        ),
        schedule={"kind": "cron", "expr": "0 21 * * 5"},
    ),
    CronTemplate(
        id="daily-changelog-digest",
        icon="ScrollText",
        title=_t("每日变更摘要", "Daily change digest"),
        description=_t(
            "每天汇总项目/代码仓库的变更情况，生成团队可读的工程日报",
            "Summarize daily repository changes into a readable engineering digest",
        ),
        message=_t(
            "请汇总今天的代码提交、文档变更和配置改动，生成一封团队可读的工程日报："
            "按功能/修复/杂务分组，突出影响面较大的变更和仍需跟进的事项。",
            "Summarize today's commits, docs edits, and config changes into a readable "
            "engineering digest: group items by feature/fix/chore, highlight high-impact "
            "changes, and list open follow-ups.",
        ),
        schedule={"kind": "cron", "expr": "0 19 * * *"},
    ),
)


def normalize_language(language: str | None) -> str:
    lang = (language or "").strip().lower()
    return "zh" if lang.startswith("zh") else "en"


def list_templates(language: str | None = None) -> list[dict]:
    """Serialized catalog with strings localized for *language*."""
    lang = normalize_language(language)

    def pick(field: dict[str, str]) -> str:
        return field.get(lang) or field["en"]

    return [
        {
            "id": template.id,
            "icon": template.icon,
            "title": pick(template.title),
            "description": pick(template.description),
            "message": pick(template.message),
            "schedule": dict(template.schedule),
        }
        for template in _TEMPLATES
    ]


def get_template(template_id: str) -> CronTemplate | None:
    for template in _TEMPLATES:
        if template.id == template_id:
            return template
    return None


__all__ = ["CronTemplate", "get_template", "list_templates", "normalize_language"]
