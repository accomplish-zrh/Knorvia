"""The package version is a public attribute, matching the source of truth."""

from __future__ import annotations

from pathlib import Path
import re

import knorvia


def test_package_exports_version() -> None:
    assert isinstance(knorvia.__version__, str)
    assert knorvia.__version__


def test_version_matches_source_of_truth() -> None:
    source = Path(knorvia.__file__).parent / "__version__.py"
    text = source.read_text(encoding="utf-8")
    match = re.search(r'^__version__\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert match, "could not read __version__ from the source file"
    assert knorvia.__version__ == match.group(1)


def test_version_is_a_release_number() -> None:
    # Release freeze: the Video Workbench Parity release.
    assert knorvia.__version__ == "1.8.0"
