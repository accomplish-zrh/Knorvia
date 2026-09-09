"""Univer ``.univer`` container adapter.

Thin re-export over the existing ``knorvia.services.univer_container``
implementation. The container's ``refs`` are recorded metadata (and slide
placeholders) — they are NOT live cross-references, and nothing here may
describe them as such.
"""

from __future__ import annotations

from knorvia.services.univer_container import (  # noqa: F401
    UNIT_TYPES,
    ContainerError,
    add_unit,
    export_unit,
    list_units,
    open_univer,
    pack_univer,
    remove_unit,
)
