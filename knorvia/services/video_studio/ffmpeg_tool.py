"""Local FFmpeg runtime for the Video Studio composition engine.

Binary discovery order (``ensure_ffmpeg``):

1. ``KNORVIA_FFMPEG_DIR`` environment variable (a directory holding
   ``ffmpeg(.exe)`` / ``ffprobe(.exe)``) — used by the desktop packaging
   which ships the binaries next to the app;
2. ``<data root>/engines/ffmpeg/<VERSION>/`` — populated by
   :meth:`FFmpegTool.install` from a pinned GitHub release;
3. a system-wide ``ffmpeg`` on ``PATH`` (the historical prerequisite).

All subprocess calls go through ``asyncio.create_subprocess_exec`` with
argument arrays (never ``shell=True``), matching the math-animator and
Real-ESRGAN precedents.
"""

from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import tempfile
import threading
from typing import Any, Callable, Sequence
from urllib.request import Request, urlopen
import zipfile

from knorvia.runtime.home import get_runtime_data_root

VERSION = "7.1.5-12-g1fdbca85aa"
RELEASE_BASE = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-14-13-16"
MAX_ARCHIVE_BYTES = 220 * 1024 * 1024
ENV_DIR = "KNORVIA_FFMPEG_DIR"
DEFAULT_PLACEHOLDER_SECONDS = 5.0
MAX_PLACEHOLDER_SECONDS = 30.0
LAST_FRAME_BACKOFF_SECONDS = 0.05


class FFmpegUnavailableError(RuntimeError):
    """Raised when no usable ffmpeg/ffprobe pair can be located."""


class FFmpegFailedError(RuntimeError):
    """Raised when an ffmpeg/ffprobe invocation exits non-zero."""


@dataclass(frozen=True, slots=True)
class ReleaseAsset:
    filename: str
    sha256: str
    size: int

    @property
    def url(self) -> str:
        return f"{RELEASE_BASE}/{self.filename}"


# The Windows static GPL build is the only one distributed through the
# installer; Linux/macOS users overwhelmingly have a package-manager ffmpeg
# on PATH already, so those platforms fall back to discovery only.
ASSETS: dict[str, ReleaseAsset | None] = {
    "windows": ReleaseAsset(
        "ffmpeg-n7.1.5-12-g1fdbca85aa-win64-gpl-7.1.zip",
        "6d55c3fdb589f75d69d75fb59b90b3ca620e5e7a5c534dc78434310c8288cc6d",
        159_540_892,
    ),
    "linux": None,
    "darwin": None,
}


def _platform_key() -> str:
    if os.name == "nt":
        return "windows"
    if platform.system().lower() == "darwin":
        return "darwin"
    return "linux"


def _exe(name: str) -> str:
    return f"{name}.exe" if os.name == "nt" else name


@dataclass(frozen=True, slots=True)
class FFmpegRuntime:
    ffmpeg: Path
    ffprobe: Path
    source: str  # "env" | "installed" | "path"

    @property
    def version(self) -> str:
        return VERSION


@dataclass(frozen=True, slots=True)
class MediaProbe:
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool


class FFmpegTool:
    """Discovery, on-demand installation and subprocess helpers for ffmpeg."""

    def __init__(self, root: Path | None = None, *, asset: ReleaseAsset | None = None) -> None:
        override = os.getenv(ENV_DIR, "").strip()
        self.root = (
            Path(override).expanduser().resolve()
            if override
            else (root or get_runtime_data_root() / "engines" / "ffmpeg").resolve()
        )
        self.asset = asset if asset is not None else ASSETS.get(_platform_key())
        self.version_root = self.root / VERSION
        self._install_lock = threading.Lock()
        self._cached: FFmpegRuntime | None = None
        self._cache_lock = threading.Lock()

    # ── discovery ─────────────────────────────────────────────────────

    def _pair(self, directory: Path) -> FFmpegRuntime | None:
        ffmpeg = directory / _exe("ffmpeg")
        ffprobe = directory / _exe("ffprobe")
        if ffmpeg.is_file() and ffprobe.is_file():
            return FFmpegRuntime(ffmpeg=ffmpeg, ffprobe=ffprobe, source="")
        return None

    def _probe_env(self) -> FFmpegRuntime | None:
        override = os.getenv(ENV_DIR, "").strip()
        if not override:
            return None
        pair = self._pair(Path(override).expanduser().resolve())
        if pair is None:
            return None
        return FFmpegRuntime(ffmpeg=pair.ffmpeg, ffprobe=pair.ffprobe, source="env")

    def _probe_installed(self) -> FFmpegRuntime | None:
        pair = self._pair(self.version_root / "bin")
        if pair is None:
            return None
        return FFmpegRuntime(ffmpeg=pair.ffmpeg, ffprobe=pair.ffprobe, source="installed")

    @staticmethod
    def _probe_path() -> FFmpegRuntime | None:
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if ffmpeg and ffprobe:
            return FFmpegRuntime(ffmpeg=Path(ffmpeg), ffprobe=Path(ffprobe), source="path")
        return None

    def ensure(self) -> FFmpegRuntime:
        cached = self._cached
        if cached is not None and self._pair(cached.ffmpeg.parent):
            return cached
        for probe, source in (
            (self._probe_env, "env"),
            (self._probe_installed, "installed"),
            (self._probe_path, "path"),
        ):
            runtime = probe()
            if runtime is None:
                continue
            if runtime.source != source:
                runtime = FFmpegRuntime(
                    ffmpeg=runtime.ffmpeg, ffprobe=runtime.ffprobe, source=source
                )
            with self._cache_lock:
                self._cached = runtime
            return runtime
        raise FFmpegUnavailableError(
            "The local composition engine (FFmpeg) is not installed. Open Video Studio "
            "→ Export, click “Install the local composition engine”, or put ffmpeg and "
            "ffprobe on PATH / point KNORVIA_FFMPEG_DIR at them. "
            "本地合成引擎（FFmpeg）未安装：请在视频工作室的「导出成片」面板点击"
            "「安装本地合成引擎」，或将 ffmpeg/ffprobe 加入 PATH / 设置 KNORVIA_FFMPEG_DIR。"
        )

    def status(self) -> dict[str, Any]:
        try:
            runtime = self.ensure()
        except FFmpegUnavailableError:
            runtime = None
        return {
            "available": runtime is not None,
            "source": runtime.source if runtime else None,
            "version": VERSION,
            "install_supported": self.asset is not None,
            "download_bytes": self.asset.size if self.asset else 0,
            "engine": "FFmpeg",
        }

    # ── installation (GyanD/codern essentials build, ncnn_upscaler twin) ──

    def installed(self) -> bool:
        return self._pair(self.version_root / "bin") is not None

    def install(self) -> dict[str, Any]:
        if self.installed():
            return self.status()
        if self.asset is None:
            raise FFmpegUnavailableError(
                "No pinned FFmpeg build exists for this platform; install ffmpeg "
                "with your package manager and ensure it is on PATH."
            )
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
                if self._pair(staged / "bin") is None:
                    raise FFmpegFailedError("The FFmpeg archive is incomplete.")
                if os.name != "nt":
                    for binary in (
                        staged / "bin" / _exe("ffmpeg"),
                        staged / "bin" / _exe("ffprobe"),
                    ):
                        binary.chmod(binary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP)
                (staged / "knorvia-install.json").write_text(
                    json.dumps({"version": VERSION, "asset": asdict(self.asset)}, indent=2),
                    encoding="utf-8",
                )
                if self.version_root.exists():
                    shutil.rmtree(self.version_root)
                staged.replace(self.version_root)
            self._smoke_test()
        return self.status()

    def _download(self, target: Path) -> None:
        assert self.asset is not None
        request = Request(self.asset.url, headers={"User-Agent": "Knorvia/VideoStudio"})
        digest = hashlib.sha256()
        received = 0
        with urlopen(request, timeout=60) as response, target.open("wb") as output:  # nosec B310 - pinned manifest URL, content verified by SHA-256
            declared = int(response.headers.get("Content-Length") or 0)
            if declared and declared > MAX_ARCHIVE_BYTES:
                raise FFmpegFailedError("The FFmpeg archive is unexpectedly large.")
            while chunk := response.read(1024 * 1024):
                received += len(chunk)
                if received > MAX_ARCHIVE_BYTES:
                    raise FFmpegFailedError("The FFmpeg archive exceeded the size limit.")
                digest.update(chunk)
                output.write(chunk)
        if received != self.asset.size:
            target.unlink(missing_ok=True)
            raise FFmpegFailedError("FFmpeg download verification failed (size mismatch).")
        if self.asset.sha256 and digest.hexdigest() != self.asset.sha256:
            target.unlink(missing_ok=True)
            raise FFmpegFailedError("FFmpeg download verification failed (checksum).")

    @staticmethod
    def _extract(archive: Path, target: Path) -> None:
        # BtbN archives nest one top-level directory; keep its whole bin/ set
        # (static builds carry the three exes, shared builds add their DLLs)
        # plus the license files.
        allowed_roots = {"bin", "LICENSE.txt"}
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                path = PurePosixPath(member.filename)
                if path.is_absolute() or ".." in path.parts or member.is_dir():
                    continue
                stripped = list(path.parts)
                if stripped and stripped[0].startswith("ffmpeg-"):
                    stripped = stripped[1:]
                if not stripped:
                    continue
                if stripped[0] == "bin":
                    relative = Path("bin") / Path(*stripped[1:])
                elif "/".join(stripped) == "LICENSE.txt":
                    relative = Path("LICENSE.txt")
                else:
                    continue
                destination = (target / relative).resolve()
                if target not in destination.parents:
                    raise FFmpegFailedError("Unsafe path in the FFmpeg archive.")
                destination.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(member) as source, destination.open("wb") as output:
                    shutil.copyfileobj(source, output)

    def _smoke_test(self) -> None:
        import subprocess

        runtime = self._pair(self.version_root / "bin")
        if runtime is None:
            raise FFmpegFailedError("The installed FFmpeg build is incomplete.")
        try:
            probe = subprocess.run(
                [str(runtime.ffprobe), "-version"],
                capture_output=True,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise FFmpegFailedError(f"FFprobe failed its smoke test: {exc}") from exc
        if probe.returncode != 0:
            raise FFmpegFailedError("FFprobe failed its smoke test.")

    # ── subprocess helpers ────────────────────────────────────────────

    async def run(
        self,
        args: Sequence[str],
        *,
        binary: Path | None = None,
        timeout: float = 3600.0,
        on_progress: Callable[[float], None] | None = None,
        expected_total: float | None = None,
        cwd: Path | None = None,
    ) -> tuple[bytes, bytes]:
        """Run ffmpeg/ffprobe with an argument array; never through a shell.

        ``on_progress`` receives the fraction of ``expected_total`` already
        encoded, parsed from ``-progress pipe:1`` ``out_time`` lines.
        """
        runtime = self.ensure()
        executable = str(binary or runtime.ffmpeg)
        command = [executable, "-hide_banner", "-nostdin", "-y", *[str(item) for item in args]]
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(cwd) if cwd else None,
        )

        progress_bytes = bytearray()

        async def _drain_out() -> None:
            assert process.stdout is not None
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                progress_bytes.extend(line)
                text = line.decode("utf-8", errors="replace").strip()
                if on_progress is not None and expected_total and "=" in text:
                    key, _, value = text.partition("=")
                    if key.strip() in {"out_time_us", "out_time_ms"}:
                        try:
                            micros = float(value.strip())
                        except ValueError:
                            continue
                        seconds = (
                            micros / 1_000_000.0
                            if key.strip() == "out_time_us"
                            else micros / 1000.0
                        )
                        if seconds >= 0:
                            on_progress(max(0.0, min(seconds / expected_total, 0.99)))

        async def _drain_err() -> bytes:
            assert process.stderr is not None
            return await process.stderr.read()

        err_task = asyncio.create_task(_drain_err())
        try:
            try:
                _, stderr = await asyncio.wait_for(
                    asyncio.gather(_drain_out(), err_task),
                    timeout=timeout,
                )
            except TimeoutError:
                process.kill()
                await process.wait()
                raise FFmpegFailedError("The local composition timed out.") from None
        except asyncio.CancelledError:
            process.kill()
            await process.wait()
            raise
        finally:
            if not err_task.done():
                err_task.cancel()
        if process.returncode != 0:
            detail = (stderr or progress_bytes).decode("utf-8", errors="replace").strip()[-800:]
            raise FFmpegFailedError(f"FFmpeg failed: {detail or 'unknown error'}")
        return bytes(progress_bytes), stderr

    async def probe_media(self, path: Path) -> MediaProbe:
        runtime = self.ensure()
        command = [
            str(runtime.ffprobe),
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ]
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=60)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise FFmpegFailedError("FFprobe timed out.") from None
        if process.returncode != 0:
            detail = stderr.decode("utf-8", errors="replace").strip()[-300:]
            raise FFmpegFailedError(f"FFprobe failed: {detail or 'unknown error'}")
        payload = json.loads(stdout.decode("utf-8", errors="replace") or "{}")
        streams = payload.get("streams") or []
        video = next((item for item in streams if item.get("codec_type") == "video"), None)
        has_audio = any(item.get("codec_type") == "audio" for item in streams)
        duration = 0.0
        try:
            duration = float(payload.get("format", {}).get("duration") or 0.0)
        except (TypeError, ValueError):
            duration = 0.0
        if duration <= 0 and video:
            try:
                duration = float(video.get("duration") or 0.0)
            except (TypeError, ValueError):
                duration = 0.0
        fps = 0.0
        if video:
            rate = str(video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1")
            if "/" in rate:
                numerator, _, denominator = rate.partition("/")
                try:
                    fps = float(numerator) / float(denominator or 1)
                except (TypeError, ValueError, ZeroDivisionError):
                    fps = 0.0
        return MediaProbe(
            duration=max(0.0, duration),
            width=int((video or {}).get("width") or 0),
            height=int((video or {}).get("height") or 0),
            fps=round(fps, 3),
            has_audio=has_audio,
        )

    async def extract_frame(self, video: Path, timestamp: float, output: Path) -> Path:
        await self.run(
            [
                "-ss",
                f"{max(0.0, float(timestamp)):.3f}",
                "-i",
                str(video),
                "-frames:v",
                "1",
                "-q:v",
                "2",
                str(output),
            ],
            timeout=120,
        )
        if not output.is_file():
            raise FFmpegFailedError("FFmpeg produced no frame.")
        return output

    async def extract_audio(self, media: Path, output: Path) -> Path:
        """Demux any input's audio track into 16 kHz mono PCM WAV.

        The composition engine uses this to feed each shot's audio into the
        STT gateway (Phase D1 ``from_asr`` subtitles); WAV/16k/mono is the
        most universally accepted upload shape.
        """
        await self.run(
            [
                "-i",
                str(media),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-acodec",
                "pcm_s16le",
                str(output),
            ],
            timeout=600,
        )
        if not output.is_file() or output.stat().st_size == 0:
            raise FFmpegFailedError("FFmpeg produced no audio track.")
        return output

    async def extract_last_frame(self, video: Path, output: Path) -> Path:
        """Extract a clip's final frame (the extend continue-from anchor).

        The seek lands one backoff interval before the probed duration so
        container rounding never pushes it past the last decodable frame.
        """
        probe = await self.probe_media(video)
        return await self.extract_frame(
            video, max(0.0, probe.duration - LAST_FRAME_BACKOFF_SECONDS), output
        )

    async def crop_grid_cell(
        self, image: Path, columns: int, rows: int, column: int, row: int, output: Path
    ) -> Path:
        """Crop one cell out of a composition grid (nine-grid keyframe helper)."""
        from PIL import Image

        with Image.open(image) as opened:
            width, height = opened.size
        cell_w = max(1, width // max(1, columns))
        cell_h = max(1, height // max(1, rows))
        x = max(0, min(column, columns - 1)) * cell_w
        y = max(0, min(row, rows - 1)) * cell_h
        await self.run(
            [
                "-i",
                str(image),
                "-vf",
                f"crop={cell_w}:{cell_h}:{x}:{y}",
                str(output),
            ],
            timeout=60,
        )
        if not output.is_file():
            raise FFmpegFailedError("FFmpeg produced no cropped cell.")
        return output

    async def extract_frames(
        self, video: Path, output_dir: Path, *, fps: float | None = None
    ) -> list[Path]:
        """Dump a clip to ``frame_000001.png`` … for the E5 upscale pre-step."""
        output_dir.mkdir(parents=True, exist_ok=True)
        pattern = output_dir / "frame_%06d.png"
        args = ["-i", str(video)]
        if fps and fps > 0:
            args += ["-vf", f"fps={float(fps):.3f}"]
        args += [str(pattern)]
        await self.run(args, timeout=3600)
        return sorted(output_dir.glob("frame_*.png"))

    async def assemble_frames(
        self,
        frame_dir: Path,
        output: Path,
        *,
        fps: float,
        audio_from: Path | None = None,
        size: tuple[int, int] | None = None,
    ) -> Path:
        """Rebuild a video from ``frame_%06d.png`` (optional audio + scale)."""
        args = [
            "-framerate",
            f"{max(1.0, float(fps)):.3f}",
            "-i",
            str(frame_dir / "frame_%06d.png"),
        ]
        if audio_from is not None:
            args += ["-i", str(audio_from)]
        filters = []
        if size is not None:
            width, height = size
            filters.append(
                f"scale={int(width)}:{int(height)}:force_original_aspect_ratio=decrease,"
                f"pad={int(width)}:{int(height)}:(ow-iw)/2:(oh-ih)/2:black,setsar=1"
            )
        if filters:
            args += ["-vf", ",".join(filters)]
        args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast"]
        if audio_from is not None:
            args += ["-map", "0:v:0", "-map", "1:a:0?", "-c:a", "aac", "-shortest"]
        args += [str(output)]
        await self.run(args, timeout=3600)
        if not output.is_file() or output.stat().st_size == 0:
            raise FFmpegFailedError("FFmpeg produced no assembled video.")
        return output


_tool: FFmpegTool | None = None
_tool_lock = threading.Lock()


def get_ffmpeg_tool() -> FFmpegTool:
    global _tool
    with _tool_lock:
        if _tool is None:
            _tool = FFmpegTool()
        return _tool


def ensure_ffmpeg() -> FFmpegRuntime:
    return get_ffmpeg_tool().ensure()


def reset_ffmpeg_tool_cache() -> None:
    """Test hook: drop the memoized runtime so discovery re-runs."""
    global _tool
    with _tool_lock:
        _tool = None


__all__ = [
    "ASSETS",
    "DEFAULT_PLACEHOLDER_SECONDS",
    "FFmpegFailedError",
    "FFmpegRuntime",
    "FFmpegTool",
    "FFmpegUnavailableError",
    "LAST_FRAME_BACKOFF_SECONDS",
    "MAX_PLACEHOLDER_SECONDS",
    "MediaProbe",
    "VERSION",
    "ensure_ffmpeg",
    "get_ffmpeg_tool",
    "reset_ffmpeg_tool_cache",
]
