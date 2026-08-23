from __future__ import annotations

import asyncio
import json
from pathlib import Path
import stat
import zipfile

import pytest

from knorvia.services.video_studio import ffmpeg_tool as ft


def _fake_pair(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for name in ("ffmpeg", "ffprobe"):
        binary = directory / ft._exe(name)
        binary.write_bytes(b"#!/bin/sh\nexit 0\n" if ft._platform_key() != "windows" else b"MZ")
        if ft._platform_key() != "windows":
            binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
    return directory


class _FakeReader:
    def __init__(self, lines: list[bytes], delay: float = 0.0) -> None:
        self._lines = list(lines)
        self._delay = delay

    async def readline(self) -> bytes:
        if self._delay:
            await asyncio.sleep(self._delay)
        return self._lines.pop(0) if self._lines else b""

    async def read(self, _: int = -1) -> bytes:
        await asyncio.sleep(0)
        return b"".join(self._lines)


class _FakeProcess:
    def __init__(
        self,
        stdout_lines: list[bytes] | None = None,
        stderr: bytes = b"",
        returncode: int = 0,
        *,
        stdout_delay: float = 0.0,
    ) -> None:
        self.stdout = _FakeReader(stdout_lines or [], delay=stdout_delay)
        self.stderr = _FakeReader([stderr])
        self.returncode = returncode
        self.killed = False
        self.communicate_result: tuple[bytes, bytes] = (b"", b"")

    async def wait(self) -> int:
        return self.returncode

    def kill(self) -> None:
        self.killed = True

    async def communicate(self) -> tuple[bytes, bytes]:
        await asyncio.sleep(0)
        return self.communicate_result


class _ExecRecorder:
    def __init__(self, process: _FakeProcess) -> None:
        self.process = process
        self.commands: list[list[str]] = []

    async def __call__(self, *command: str, **kwargs):
        self.commands.append(list(command))
        return self.process


def test_discovery_prefers_env_over_installed_and_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_dir = _fake_pair(tmp_path / "env")
    installed_dir = _fake_pair(tmp_path / "installed" / ft.VERSION)
    path_dir = _fake_pair(tmp_path / "path")
    monkeypatch.setenv(ft.ENV_DIR, str(env_dir))
    monkeypatch.setattr(ft.shutil, "which", lambda name: str(path_dir / ft._exe(name)))
    tool = ft.FFmpegTool(root=tmp_path / "installed")
    runtime = tool.ensure()
    assert runtime.source == "env"
    assert runtime.ffmpeg == env_dir / ft._exe("ffmpeg")


def test_discovery_falls_back_to_installed_then_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    installed_dir = _fake_pair(tmp_path / "installed" / ft.VERSION / "bin")
    path_dir = _fake_pair(tmp_path / "path")
    monkeypatch.delenv(ft.ENV_DIR, raising=False)
    monkeypatch.setattr(ft.shutil, "which", lambda name: str(path_dir / ft._exe(name)))
    tool = ft.FFmpegTool(root=tmp_path / "installed")
    runtime = tool.ensure()
    assert runtime.source == "installed"
    assert runtime.ffmpeg.parent == installed_dir

    (installed_dir / ft._exe("ffmpeg")).unlink()
    tool2 = ft.FFmpegTool(root=tmp_path / "installed")
    runtime2 = tool2.ensure()
    assert runtime2.source == "path"
    assert runtime2.ffprobe == path_dir / ft._exe("ffprobe")


def test_ensure_raises_actionable_error_when_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(ft.ENV_DIR, raising=False)
    monkeypatch.setattr(ft.shutil, "which", lambda _: None)
    tool = ft.FFmpegTool(root=tmp_path / "nowhere")
    with pytest.raises(ft.FFmpegUnavailableError) as exc_info:
        tool.ensure()
    assert "安装" in str(exc_info.value) and "FFmpeg" in str(exc_info.value)


def test_status_reports_install_support(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ft.ENV_DIR, raising=False)
    monkeypatch.setattr(ft.shutil, "which", lambda _: None)
    asset = ft.ReleaseAsset("ffmpeg.zip", "a" * 64, 123)
    tool = ft.FFmpegTool(root=tmp_path, asset=asset)
    status = tool.status()
    assert status == {
        "available": False,
        "source": None,
        "version": ft.VERSION,
        "install_supported": True,
        "download_bytes": 123,
        "engine": "FFmpeg",
    }
    _fake_pair(tool.version_root / "bin")
    assert tool.status()["available"] is True
    assert tool.status()["source"] == "installed"


@pytest.mark.asyncio
async def test_run_builds_argument_array_and_parses_progress(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_dir = _fake_pair(tmp_path / "env")
    monkeypatch.setenv(ft.ENV_DIR, str(env_dir))
    tool = ft.FFmpegTool(root=tmp_path / "root")
    process = _FakeProcess(
        stdout_lines=[
            b"frame=1\n",
            b"out_time_us=1500000\n",
            b"progress=continue\n",
            b"out_time_us=3750000\n",
        ]
    )
    recorder = _ExecRecorder(process)
    monkeypatch.setattr(ft.asyncio, "create_subprocess_exec", recorder)
    seen: list[float] = []
    stdout, _ = await tool.run(
        ["-i", "in.mp4", "-progress", "pipe:1", "out.mp4"],
        on_progress=seen.append,
        expected_total=5.0,
    )
    command = recorder.commands[0]
    assert command[0].endswith(ft._exe("ffmpeg"))
    assert command[1:4] == ["-hide_banner", "-nostdin", "-y"]
    assert command[4:] == ["-i", "in.mp4", "-progress", "pipe:1", "out.mp4"]
    assert seen == [0.3, 0.75]
    assert b"out_time_us" in stdout


@pytest.mark.asyncio
async def test_run_reports_failure_tail(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env_dir = _fake_pair(tmp_path / "env")
    monkeypatch.setenv(ft.ENV_DIR, str(env_dir))
    tool = ft.FFmpegTool(root=tmp_path / "root")
    process = _FakeProcess(stderr=b"codec not found")
    process.returncode = 1
    monkeypatch.setattr(ft.asyncio, "create_subprocess_exec", _ExecRecorder(process))
    with pytest.raises(ft.FFmpegFailedError) as exc_info:
        await tool.run(["-i", "in.mp4", "out.mp4"])
    assert "codec not found" in str(exc_info.value)


@pytest.mark.asyncio
async def test_run_timeout_kills_process(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env_dir = _fake_pair(tmp_path / "env")
    monkeypatch.setenv(ft.ENV_DIR, str(env_dir))
    tool = ft.FFmpegTool(root=tmp_path / "root")
    process = _FakeProcess(stdout_delay=0.5)
    monkeypatch.setattr(ft.asyncio, "create_subprocess_exec", _ExecRecorder(process))
    with pytest.raises(ft.FFmpegFailedError, match="timed out"):
        await tool.run(["-i", "in.mp4", "out.mp4"], timeout=0.05)
    assert process.killed is True


@pytest.mark.asyncio
async def test_probe_media_parses_streams(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env_dir = _fake_pair(tmp_path / "env")
    monkeypatch.setenv(ft.ENV_DIR, str(env_dir))
    tool = ft.FFmpegTool(root=tmp_path / "root")
    payload = {
        "format": {"duration": "12.500"},
        "streams": [
            {"codec_type": "video", "width": 1920, "height": 1080, "avg_frame_rate": "30000/1001"},
            {"codec_type": "audio"},
        ],
    }
    process = _FakeProcess()
    process.communicate_result = (json.dumps(payload).encode(), b"")
    recorder = _ExecRecorder(process)
    monkeypatch.setattr(ft.asyncio, "create_subprocess_exec", recorder)
    probe = await tool.probe_media(tmp_path / "clip.mp4")
    assert probe == ft.MediaProbe(
        duration=12.5, width=1920, height=1080, fps=pytest.approx(29.97, rel=1e-3), has_audio=True
    )
    assert recorder.commands[0][0].endswith(ft._exe("ffprobe"))
    assert "-show_streams" in recorder.commands[0]


@pytest.mark.asyncio
async def test_extract_frame_argument_shape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_dir = _fake_pair(tmp_path / "env")
    monkeypatch.setenv(ft.ENV_DIR, str(env_dir))
    tool = ft.FFmpegTool(root=tmp_path / "root")
    recorder = _ExecRecorder(_FakeProcess())
    monkeypatch.setattr(ft.asyncio, "create_subprocess_exec", recorder)
    output = tmp_path / "frame.jpg"
    output.write_bytes(b"x")  # run() only checks existence afterwards
    await tool.extract_frame(tmp_path / "clip.mp4", 3.5, output)
    args = recorder.commands[0][4:]
    assert args[:4] == ["-ss", "3.500", "-i", str(tmp_path / "clip.mp4")]
    assert "-frames:v" in args and "1" in args


@pytest.mark.asyncio
async def test_extract_last_frame_seeks_backoff_before_duration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_dir = _fake_pair(tmp_path / "env")
    monkeypatch.setenv(ft.ENV_DIR, str(env_dir))
    tool = ft.FFmpegTool(root=tmp_path / "root")
    payload = {"format": {"duration": "4.200"}, "streams": [{"codec_type": "video"}]}
    process = _FakeProcess()
    process.communicate_result = (json.dumps(payload).encode(), b"")
    recorder = _ExecRecorder(process)
    monkeypatch.setattr(ft.asyncio, "create_subprocess_exec", recorder)
    output = tmp_path / "last-frame.png"
    output.write_bytes(b"x")
    await tool.extract_last_frame(tmp_path / "clip.mp4", output)
    assert recorder.commands[0][0].endswith(ft._exe("ffprobe"))
    extract_args = recorder.commands[1][4:]
    assert extract_args[:4] == ["-ss", "4.150", "-i", str(tmp_path / "clip.mp4")]
    assert extract_args[-1] == str(output)

    # A clip shorter than the backoff still seeks to the first frame.
    short = _FakeProcess()
    short.communicate_result = (
        json.dumps({"format": {"duration": "0.02"}}).encode(),
        b"",
    )
    recorder_short = _ExecRecorder(short)
    monkeypatch.setattr(ft.asyncio, "create_subprocess_exec", recorder_short)
    await tool.extract_last_frame(tmp_path / "tiny.mp4", output)
    assert recorder_short.commands[1][4:6] == ["-ss", "0.000"]


def _archive(tmp_path: Path) -> Path:
    archive = tmp_path / f"ffmpeg-{ft.VERSION}-win64-gpl.zip"
    prefix = f"ffmpeg-n{ft.VERSION}-win64-gpl"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(f"{prefix}/bin/{ft._exe('ffmpeg')}", b"binary-ffmpeg")
        bundle.writestr(f"{prefix}/bin/{ft._exe('ffprobe')}", b"binary-ffprobe")
        bundle.writestr(f"{prefix}/LICENSE.txt", "GPL")
        bundle.writestr(f"{prefix}/evil.txt", "dropped")
        bundle.writestr("absolute.bin", "no")
    return archive


def test_install_extracts_binaries_and_writes_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(ft.ENV_DIR, raising=False)
    monkeypatch.setattr(ft.shutil, "which", lambda _: None)
    archive = _archive(tmp_path)
    asset = ft.ReleaseAsset(archive.name, "0" * 64, archive.stat().st_size)
    tool = ft.FFmpegTool(root=tmp_path / "engines", asset=asset)
    monkeypatch.setattr(tool, "_download", lambda target: target.write_bytes(archive.read_bytes()))
    monkeypatch.setattr(tool, "_smoke_test", lambda: None)
    status = tool.install()
    assert status["available"] is True
    assert status["source"] == "installed"
    version_root = tmp_path / "engines" / ft.VERSION
    assert (version_root / "bin" / ft._exe("ffmpeg")).read_bytes() == b"binary-ffmpeg"
    assert (version_root / "bin" / ft._exe("ffprobe")).is_file()
    assert (version_root / "LICENSE.txt").is_file()
    assert not (version_root / "evil.txt").exists()
    manifest = json.loads((version_root / "knorvia-install.json").read_text(encoding="utf-8"))
    assert manifest["version"] == ft.VERSION


def test_download_rejects_size_and_checksum_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import hashlib
    from urllib.error import HTTPError

    class _Response:
        def __init__(self, data: bytes, length: int | None = None) -> None:
            self._data = data
            self.headers = {"Content-Length": str(length if length is not None else len(data))}

        def read(self, _: int = -1) -> bytes:
            data, self._data = self._data, b""
            return data

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    asset = ft.ReleaseAsset("ffmpeg.zip", "f" * 64, 100)
    tool = ft.FFmpegTool(root=tmp_path, asset=asset)
    payload = b"x" * 100
    monkeypatch.setattr(ft, "urlopen", lambda request, timeout=60: _Response(payload))
    with pytest.raises(ft.FFmpegFailedError, match="checksum"):
        tool._download(tmp_path / "ffmpeg.zip")

    good = ft.ReleaseAsset("ffmpeg.zip", hashlib.sha256(payload).hexdigest(), 100)
    tool_good = ft.FFmpegTool(root=tmp_path, asset=good)
    monkeypatch.setattr(ft, "urlopen", lambda request, timeout=60: _Response(payload))
    tool_good._download(tmp_path / "ffmpeg.zip")

    short = ft.ReleaseAsset("ffmpeg.zip", "0" * 64, 200)
    tool_short = ft.FFmpegTool(root=tmp_path, asset=short)
    monkeypatch.setattr(ft, "urlopen", lambda request, timeout=60: _Response(payload))
    with pytest.raises(ft.FFmpegFailedError, match="size mismatch"):
        tool_short._download(tmp_path / "ffmpeg.zip")
    assert not (tmp_path / "ffmpeg.zip").exists()
    del HTTPError


def test_install_without_platform_asset_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(ft.ENV_DIR, raising=False)
    monkeypatch.setattr(ft.shutil, "which", lambda _: None)
    monkeypatch.setattr(ft, "ASSETS", {"windows": None, "linux": None, "darwin": None})
    tool = ft.FFmpegTool(root=tmp_path)
    with pytest.raises(ft.FFmpegUnavailableError, match="package manager"):
        tool.install()
