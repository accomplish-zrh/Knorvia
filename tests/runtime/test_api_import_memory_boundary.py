from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys


def test_api_import_keeps_optional_heavy_dependencies_cold() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    probe = """
import json
import sys

import knorvia.api.main  # noqa: F401

heavy_roots = {
    "anthropic",
    "docx",
    "fitz",
    "graphrag",
    "llama_index",
    "matplotlib",
    "networkx",
    "numpy",
    "openpyxl",
    "pandas",
    "pptx",
    "pypdf",
}
loaded = sorted(name for name in heavy_roots if name in sys.modules)
print(json.dumps(loaded))
"""

    result = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=repo_root,
        capture_output=True,
        text=True,
    )

    assert result.stdout.strip(), (
        f"probe produced no stdout: rc={result.returncode} stderr_tail={result.stderr[-500:]!r}"
    )
    # The probe prints exactly one JSON line; any other output means the API
    # module logged to stdout instead of stderr during import.
    json_line = next(
        (line for line in result.stdout.splitlines() if line.startswith("[")),
        None,
    )
    assert json_line is not None, f"no JSON line in stdout: {result.stdout[:400]!r}"
    loaded = json.loads(json_line)
    assert loaded == [], f"heavy deps leaked into API import: {loaded}"
