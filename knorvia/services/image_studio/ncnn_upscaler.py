from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import tempfile
import threading
import time
from typing import Any
from urllib.request import Request, urlopen
import zipfile

from PIL import Image

from knorvia.runtime.home import get_runtime_data_root

VERSION = "20220424"
RELEASE_BASE = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0"
MAX_ARCHIVE_BYTES = 80 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class ReleaseAsset:
    filename: str
    sha256: str
    size: int

    @property
    def url(self) -> str:
        return f"{RELEASE_BASE}/{self.filename}"


ASSETS = {
    "windows": ReleaseAsset(
        "realesrgan-ncnn-vulkan-20220424-windows.zip",
        "abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d",
        45_474_481,
    ),
    "linux": ReleaseAsset(
        "realesrgan-ncnn-vulkan-20220424-ubuntu.zip",
        "e5aa6eb131234b87c0c51f82b89390f5e3e642b7b70f2b9bbe95b6a285a40c96",
        46_931_474,
    ),
    "darwin": ReleaseAsset(
        "realesrgan-ncnn-vulkan-20220424-macos.zip",
        "e0ad05580abfeb25f8d8fb55aaf7bedf552c375b5b4d9bd3c8d59764d2cc333a",
        51_817_124,
    ),
}


def _platform_key() -> str:
    if os.name == "nt":
        return "windows"
    if platform.system().lower() == "darwin":
        return "darwin"
    return "linux"


def _extension(mime: str) -> str:
    return {"image/jpeg": ".jpg", "image/webp": ".webp"}.get(mime.lower(), ".png")


class NcnnUpscaler:
    def __init__(
        self,
        root: Path | None = None,
        *,
        asset: ReleaseAsset | None = None,
    ) -> None:
        override = os.getenv("KNORVIA_REALESRGAN_DIR", "").strip()
        self.root = (
            Path(override).expanduser().resolve()
            if override
            else (root or get_runtime_data_root() / "engines" / "realesrgan-ncnn-vulkan").resolve()
        )
        self.asset = asset or ASSETS.get(_platform_key())
        self.version_root = self.root / VERSION
        self._install_lock = threading.Lock()

    @property
    def binary(self) -> Path:
        name = "realesrgan-ncnn-vulkan.exe" if os.name == "nt" else "realesrgan-ncnn-vulkan"
        return self.version_root / name

    @property
    def models(self) -> Path:
        return self.version_root / "models"

    def installed(self) -> bool:
        return (
            self.binary.is_file()
            and (self.models / "realesrgan-x4plus.bin").is_file()
            and (self.models / "realesrgan-x4plus.param").is_file()
        )

    def status(self) -> dict[str, Any]:
        return {
            "supported": self.asset is not None,
            "installed": self.installed(),
            "version": VERSION,
            "engine": "Real-ESRGAN NCNN Vulkan",
            "download_bytes": self.asset.size if self.asset else 0,
            "models": ["general", "illustration"],
        }

    def install(self) -> dict[str, Any]:
        if self.installed():
            return self.status()
        if self.asset is None:
            raise RuntimeError("Real-ESRGAN is unavailable on this platform.")
        with self._install_lock:
            if self.installed():
                return self.status()
            self.root.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="install-", dir=self.root) as temp_name:
                temp = Path(temp_name).resolve()
                archive = temp / self.asset.filename
                self._download(archive)
                staged = temp / VERSION
                staged.mkdir()
                self._extract(archive, staged)
                binary = staged / self.binary.name
                if not binary.is_file() or not (staged / "models").is_dir():
                    raise RuntimeError("The Real-ESRGAN archive is incomplete.")
                if os.name != "nt":
                    binary.chmod(binary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP)
                (staged / "knorvia-install.json").write_text(
                    json.dumps(
                        {"version": VERSION, "asset": asdict(self.asset)},
                        indent=2,
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
                if self.version_root.exists():
                    shutil.rmtree(self.version_root)
                staged.replace(self.version_root)
        return self.status()

    def _download(self, target: Path) -> None:
        assert self.asset is not None
        request = Request(self.asset.url, headers={"User-Agent": "Knorvia/ImageStudio"})
        digest = hashlib.sha256()
        received = 0
        with urlopen(request, timeout=60) as response, target.open("wb") as output:  # nosec B310 - pinned manifest URL, content verified by SHA-256
            declared = int(response.headers.get("Content-Length") or 0)
            if declared and declared > MAX_ARCHIVE_BYTES:
                raise RuntimeError("The Real-ESRGAN archive is unexpectedly large.")
            while chunk := response.read(1024 * 1024):
                received += len(chunk)
                if received > MAX_ARCHIVE_BYTES:
                    raise RuntimeError("The Real-ESRGAN archive exceeded the size limit.")
                digest.update(chunk)
                output.write(chunk)
        if received != self.asset.size or digest.hexdigest() != self.asset.sha256:
            target.unlink(missing_ok=True)
            raise RuntimeError("Real-ESRGAN download verification failed.")

    @staticmethod
    def _extract(archive: Path, target: Path) -> None:
        allowed_roots = {"models"}
        allowed_files = {
            "realesrgan-ncnn-vulkan",
            "realesrgan-ncnn-vulkan.exe",
            "vcomp140.dll",
            "vcomp140d.dll",
            "README_windows.md",
            "README_linux.md",
            "README_macos.md",
        }
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                path = PurePosixPath(member.filename)
                if path.is_absolute() or ".." in path.parts or member.is_dir():
                    continue
                if path.parts[0] not in allowed_roots and path.name not in allowed_files:
                    continue
                relative = Path(*path.parts)
                destination = (target / relative).resolve()
                if target not in destination.parents:
                    raise RuntimeError("Unsafe path in the Real-ESRGAN archive.")
                destination.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(member) as source, destination.open("wb") as output:
                    shutil.copyfileobj(source, output)

    async def upscale(
        self,
        content: bytes,
        mime: str,
        target_edge: int,
        *,
        preset: str = "general",
        timeout: int = 180,
    ) -> tuple[bytes, str, dict[str, Any]]:
        await asyncio.to_thread(self.install)
        with Image.open(BytesIO(content)) as image:
            width, height = image.size
        ratio = target_edge / max(width, height)
        scale = max(2, min(4, int(ratio + 0.999)))
        model = "realesrgan-x4plus-anime" if preset == "illustration" else "realesrgan-x4plus"
        jobs_root = self.root / "jobs"
        jobs_root.mkdir(parents=True, exist_ok=True)
        started = time.perf_counter()
        with tempfile.TemporaryDirectory(prefix="upscale-", dir=jobs_root) as temp_name:
            temp = Path(temp_name)
            source = temp / f"input{_extension(mime)}"
            output = temp / "output.png"
            source.write_bytes(content)
            process = await asyncio.create_subprocess_exec(
                str(self.binary),
                "-i",
                str(source),
                "-o",
                str(output),
                "-s",
                str(scale),
                "-m",
                str(self.models),
                "-n",
                model,
                "-f",
                "png",
                "-v",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self.version_root),
            )
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
            except asyncio.CancelledError:
                process.kill()
                await process.wait()
                raise
            except TimeoutError:
                process.kill()
                await process.wait()
                raise RuntimeError("Local AI upscaling timed out.") from None
            if process.returncode != 0 or not output.is_file():
                detail = (stderr or stdout).decode("utf-8", errors="replace").strip()[-500:]
                raise RuntimeError(f"Local AI upscaling failed: {detail or 'unknown error'}")
            result = output.read_bytes()
            log = b"\n".join((stdout, stderr)).decode("utf-8", errors="replace")
            device_match = re.search(r"\[\d+\s+([^\]]+)\]", log)
        with Image.open(BytesIO(result)) as image:
            result_width, result_height = image.size
            if max(result_width, result_height) != target_edge:
                factor = target_edge / max(result_width, result_height)
                exact_size = (
                    max(1, round(result_width * factor)),
                    max(1, round(result_height * factor)),
                )
                resized = image.resize(exact_size, Image.Resampling.LANCZOS)
                encoded = BytesIO()
                resized.save(encoded, format="PNG", optimize=True)
                result = encoded.getvalue()
                result_width, result_height = exact_size
        return (
            result,
            "image/png",
            {
                "method": "real-esrgan-ncnn-vulkan",
                "engine_version": VERSION,
                "model": model,
                "scale": scale,
                "source_width": width,
                "source_height": height,
                "width": result_width,
                "height": result_height,
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "device": device_match.group(1).strip() if device_match else "Vulkan GPU",
            },
        )


_upscaler: NcnnUpscaler | None = None


def get_ncnn_upscaler() -> NcnnUpscaler:
    global _upscaler
    if _upscaler is None:
        _upscaler = NcnnUpscaler()
    return _upscaler


__all__ = ["ASSETS", "NcnnUpscaler", "ReleaseAsset", "VERSION", "get_ncnn_upscaler"]
