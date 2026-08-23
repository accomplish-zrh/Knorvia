from __future__ import annotations

from io import BytesIO
from pathlib import Path

from PIL import Image
import pytest

from knorvia.services.creative_agent.runner import submit_create_generation
from knorvia.services.creative_library.store import CreativeLibraryStore
from knorvia.services.image_studio.store import ImageStudioStore


def _png() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (8, 8), (30, 90, 20)).save(buffer, format="PNG")
    return buffer.getvalue()


def test_create_generation_uses_image_studio(tmp_path, monkeypatch) -> None:
    library = CreativeLibraryStore(tmp_path / "library")
    image_store = ImageStudioStore(tmp_path / "image-studio")
    started: list[str] = []

    monkeypatch.setattr(
        "knorvia.services.creative_agent.runner.list_usable_models",
        lambda: [
            {
                "profile_id": "p1",
                "model_id": "m1",
                "model_name": "test",
                "profile_name": "p1",
                "is_active_default": True,
                "capabilities": {"operations": ["generate"], "parameters": ["n", "size"]},
            }
        ],
    )
    monkeypatch.setattr(
        "knorvia.services.creative_agent.runner.capture_job_authorization",
        lambda profile_id, model_id: {"owner_user_id": "u1", "config_revision": "r1"},
    )
    monkeypatch.setattr(
        "knorvia.services.creative_agent.runner.start_job",
        lambda store, job_id: started.append(job_id),
    )

    result = submit_create_generation(
        conversation_id=None,
        prompt="a red enamel mug",
        mode="image",
        library=library,
        image_store=image_store,
    )
    assert result["job"]["studio"] == "image"
    assert result["job"]["job_id"]
    assert started == [result["job"]["job_id"]]
    assistant = result["assistant_message"]
    assert assistant["brief"]["user_prompt"] == "a red enamel mug"
    assert "enamel mug" not in assistant["content"] or "Image Studio" in assistant["content"]
    job = image_store.get_job(result["job"]["job_id"])
    assert job is not None
    assert job["prompt"] == "a red enamel mug"


def test_create_rejects_missing_image_model(tmp_path, monkeypatch) -> None:
    library = CreativeLibraryStore(tmp_path / "library")
    image_store = ImageStudioStore(tmp_path / "image-studio")
    monkeypatch.setattr("knorvia.services.creative_agent.runner.list_usable_models", lambda: [])
    with pytest.raises(ValueError, match="image model"):
        submit_create_generation(
            conversation_id=None,
            prompt="a mug",
            mode="image",
            library=library,
            image_store=image_store,
        )


def test_create_video_binds_to_open_video_studio_project(tmp_path, monkeypatch) -> None:
    from knorvia.services.video_studio.store import VideoStudioStore

    library = CreativeLibraryStore(tmp_path / "library")
    video_store = VideoStudioStore(tmp_path / "video-studio")
    desk = video_store.create_project("Open desk")
    video_store.set_active_project(desk["id"])
    started: list[dict] = []

    monkeypatch.setattr(
        "knorvia.services.creative_agent.runner.allowed_videogen_options",
        lambda: {
            "options": [
                {
                    "profile_id": "p-video",
                    "model_id": "m-video",
                    "model_name": "Video",
                    "profile_name": "Provider",
                    "is_active_default": True,
                    "capabilities": {
                        "operations": ["text_to_video"],
                        "durations": [5],
                        "aspect_ratios": ["16:9"],
                    },
                }
            ]
        },
    )

    def fake_create(**kwargs):
        started.append(kwargs)
        return {"id": "video_job_create_1", "status": "queued"}

    monkeypatch.setattr(
        "knorvia.services.creative_agent.runner.create_agent_video_job", fake_create
    )

    result = submit_create_generation(
        conversation_id=None,
        prompt="a quiet lake at dusk",
        mode="video",
        library=library,
        video_store=video_store,
    )
    assert result["job"]["studio"] == "video"
    assert result["job"]["project_id"] == desk["id"]
    assert started[0]["project_id"] == desk["id"]
    assert started[0]["confirmed_cost"] is True
    assert started[0]["prompt"] == "a quiet lake at dusk"
    bound = video_store.get_session_project(f"create:{result['conversation']['id']}")
    assert bound is not None
    assert bound["id"] == desk["id"]


def test_canvas_run_starts_one_paid_video_job(tmp_path, monkeypatch) -> None:
    from knorvia.services.creative_agent.runner import run_canvas
    from knorvia.services.video_studio.store import VideoStudioStore

    library = CreativeLibraryStore(tmp_path / "library")
    video_store = VideoStudioStore(tmp_path / "video-studio")
    project = video_store.create_project("Canvas")
    started: list[str] = []

    monkeypatch.setattr(
        "knorvia.services.creative_agent.runner.allowed_videogen_options",
        lambda: {
            "options": [
                {
                    "profile_id": "p-video",
                    "model_id": "m-video",
                    "is_active_default": True,
                    "capabilities": {"operations": ["text_to_video"]},
                }
            ]
        },
    )
    monkeypatch.setattr(
        "knorvia.services.creative_agent.runner.plan_video_ops",
        lambda *args, **kwargs: [
            {"type": "generate", "id": "gen_a"},
            {"type": "generate", "id": "gen_b"},
        ],
    )
    monkeypatch.setattr(
        "knorvia.services.creative_agent.runner.apply_video_ops",
        lambda board, ops: {
            **board,
            "nodes": [dict(node) for node in (board.get("nodes") or [])],
            "edges": [dict(edge) for edge in (board.get("edges") or [])],
        },
    )
    video_store.update_board(
        project["id"],
        lambda document: document.update(
            {
                "nodes": [
                    {
                        "id": "gen_a",
                        "kind": "generate",
                        "prompt": "first",
                        "x": 0,
                        "y": 0,
                        "width": 320,
                        "height": 292,
                        "z": 0,
                    },
                    {
                        "id": "gen_b",
                        "kind": "generate",
                        "prompt": "second",
                        "x": 400,
                        "y": 0,
                        "width": 320,
                        "height": 292,
                        "z": 1,
                    },
                ]
            }
        ),
    )

    def fake_create(**kwargs):
        started.append(kwargs["board_node_id"])
        return {"id": f"job_{kwargs['board_node_id']}", "status": "queued"}

    monkeypatch.setattr(
        "knorvia.services.creative_agent.runner.create_agent_video_job", fake_create
    )

    run = run_canvas(
        studio="video",
        project_id=project["id"],
        prompt="two cards",
        library=library,
        video_store=video_store,
    )
    assert started == ["gen_a"]
    assert run["job_ids"] == ["job_gen_a"]
