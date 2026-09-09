"""Deterministic safety gate for interactive widget HTML (T3 hard line).

Widget HTML is model-generated content rendered in a sandboxed iframe
(``sandbox="allow-scripts"``, ``referrerpolicy="no-referrer"``, no
``allow-same-origin``). Before anything is persisted it passes this
deterministic gate — two tiers, both pure regex so the outcome never
depends on an LLM:

* strip-tier constructs are REMOVED and the widget keeps playing:
  ``fetch(`` / ``XMLHttpRequest`` / ``WebSocket`` / ``import(``,
  ``window.top``/``window.parent``, ``localStorage``, ``<form action>``;
* document-tier constructs (``<script src>``, nested ``srcdoc``,
  ``javascript:`` URIs) mark the whole document as untrustworthy — the
  scene degrades to a slide (title/key_points kept, ``scene_degraded``
  event, lesson continues). Empty output after cleaning degrades too.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import re

# Removed in place; the widget may keep running without them.
_STRIP_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("fetch-call", re.compile(r"\bfetch\s*\(")),
    ("xmlhttprequest", re.compile(r"\bXMLHttpRequest\b")),
    ("websocket", re.compile(r"\bWebSocket\b")),
    ("dynamic-import", re.compile(r"\bimport\s*\(")),
    ("window-top-parent", re.compile(r"\bwindow\s*\.\s*(?:top|parent)\b")),
    ("localstorage", re.compile(r"\blocalStorage\b")),
    ("form-action", re.compile(r"""\s+action\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)""", re.IGNORECASE)),
]

# One hit means the document cannot be trusted as a whole.
_DEGRADE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("script-src", re.compile(r"<script\b[^>]*\bsrc\s*=", re.IGNORECASE)),
    ("srcdoc-nesting", re.compile(r"\bsrcdoc\s*=", re.IGNORECASE)),
    ("javascript-uri", re.compile(r"javascript\s*:", re.IGNORECASE)),
]


@dataclass
class SanitizeResult:
    html: str
    hits: list[str] = field(default_factory=list)
    degrade: bool = False


def sanitize_widget_html(html: str) -> SanitizeResult:
    """Strip deletable constructs; flag document-tier risks for degradation."""
    clean = html or ""
    hits: list[str] = []
    for name, pattern in _DEGRADE_PATTERNS:
        if pattern.search(clean):
            hits.append(name)
    if hits:
        return SanitizeResult(html="", hits=hits, degrade=True)
    for name, pattern in _STRIP_PATTERNS:
        if pattern.search(clean):
            hits.append(name)
            clean = pattern.sub("", clean)
    if not clean.strip():
        return SanitizeResult(html="", hits=hits, degrade=True)
    return SanitizeResult(html=clean, hits=hits, degrade=False)


__all__ = ["SanitizeResult", "sanitize_widget_html"]
