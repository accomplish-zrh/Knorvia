"""Adapter interface shared by all Office format backends."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class AdapterOutcome:
    """Result of applying one batch to one artifact."""

    new_bytes: bytes
    calculation_required: bool = False
    allowed_parts_hint: list[str] = field(default_factory=list)
    touched_cells: int = 0
    target_addresses: list[str] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)
