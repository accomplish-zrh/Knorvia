"""Compare-and-swap publication receipts for merge destinations.

Office drafts can be merged by different processes.  A short per-destination
lock makes the proof and the write one cooperative critical section, while a
receipt lets rollback restore a target only if it still contains the bytes
this merge published.  An unrelated later writer is therefore never erased.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from knorvia.services.office_artifacts.store_io import (
    atomic_write,
    atomic_write_exclusive,
    dir_lock,
    sha256_of,
)


@dataclass(frozen=True)
class FileReceipt:
    path: Path
    previous: bytes | None
    published_hash: str


def _lock_path(path: Path) -> Path:
    canonical = str(path.resolve()).encode("utf-8", errors="surrogatepass")
    token = sha256_of(canonical)[:20]
    return path.parent / f".knorvia-publish-{token}.lock"


def publish_exclusive(path: Path, data: bytes) -> FileReceipt:
    """Publish a new file, refusing an occupied name atomically."""
    with dir_lock(_lock_path(path)):
        atomic_write_exclusive(path, data)
    return FileReceipt(path=path, previous=None, published_hash=sha256_of(data))


def replace_if_hash(path: Path, data: bytes, expected_hash: str) -> FileReceipt | None:
    """Replace an existing file only when cooperative state matches ``expected_hash``."""
    with dir_lock(_lock_path(path)):
        if not path.is_file():
            return None
        previous = path.read_bytes()
        if sha256_of(previous) != expected_hash:
            return None
        atomic_write(path, data)
    return FileReceipt(path=path, previous=previous, published_hash=sha256_of(data))


def rollback(receipt: FileReceipt) -> bool:
    """Undo a publication only while our exact bytes still own the target."""
    with dir_lock(_lock_path(receipt.path)):
        if not receipt.path.is_file():
            return receipt.previous is None
        if sha256_of(receipt.path.read_bytes()) != receipt.published_hash:
            return False
        if receipt.previous is None:
            receipt.path.unlink()
        else:
            atomic_write(receipt.path, receipt.previous)
    return True
