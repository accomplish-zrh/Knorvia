from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import HTTPException
import pytest

from knorvia.api.routers import video_studio as router
from knorvia.services.video_studio import service
from knorvia.services.video_studio.store import VideoStudioStore

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    + b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
    + b"\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n"
    b"\x2d\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _upload(store: VideoStudioStore, project_id: str, name: str = "portrait.png"):
    return store.import_asset_bytes(project_id, PNG, "image/png", filename=name)


@pytest.fixture()
def project(tmp_path: Path) -> tuple[VideoStudioStore, str]:
    store = VideoStudioStore(tmp_path / "studio")
    created = store.create_project("Cast")
    return store, created["id"]


def test_character_crud_roundtrip(project) -> None:
    store, project_id = project
    portrait = _upload(store, project_id)
    sheet = _upload(store, project_id, "sheet.png")

    character = store.create_character(
        project_id,
        name="  阿澈  ",
        description="蓝发少年侦探",
        reference_asset_ids=[portrait["id"]],
        voice_hint="bright young male",
    )
    assert character["name"] == "阿澈"
    assert character["description"] == "蓝发少年侦探"
    assert character["reference_asset_ids"] == [portrait["id"]]
    assert character["three_view_asset_id"] is None
    assert character["voice_hint"] == "bright young male"

    listed = store.list_characters(project_id)
    assert [item["id"] for item in listed] == [character["id"]]

    updated = store.update_character(project_id, character["id"], name="阿澈·改", voice_hint="calm")
    assert updated["name"] == "阿澈·改"
    assert updated["voice_hint"] == "calm"
    assert updated["description"] == "蓝发少年侦探"

    bound = store.set_character_three_view(project_id, character["id"], sheet["id"])
    assert bound["three_view_asset_id"] == sheet["id"]

    assert store.delete_character(project_id, character["id"]) is True
    assert store.list_characters(project_id) == []
    assert store.get_character(project_id, character["id"]) is None
    # Deleted characters stay soft-deleted: the id cannot be resurrected blind.
    assert store.delete_character(project_id, character["id"]) is False


def test_character_validation_rules(project) -> None:
    store, project_id = project
    with pytest.raises(ValueError, match="name is required"):
        store.create_character(project_id, name="   ")
    with pytest.raises(ValueError, match="reference"):
        store.create_character(project_id, name="幽灵", reference_asset_ids=["asset_x"])

    other = store.create_project("Other")
    foreign = _upload(store, other["id"], "foreign.png")
    with pytest.raises(ValueError):
        store.create_character(project_id, name="跨界", reference_asset_ids=[foreign["id"]])

    first = _upload(store, project_id, "one.png")
    second = _upload(store, project_id, "two.png")
    character = store.create_character(
        project_id, name="重复", reference_asset_ids=[first["id"], first["id"]]
    )
    assert character["reference_asset_ids"] == [first["id"]]
    patched = store.update_character(
        project_id, character["id"], reference_asset_ids=[second["id"]]
    )
    assert patched["reference_asset_ids"] == [second["id"]]


def test_character_cap_fifty_per_project(project, monkeypatch: pytest.MonkeyPatch) -> None:
    store, project_id = project
    portrait = _upload(store, project_id)
    for index in range(50):
        store.create_character(project_id, name=f"角色{index}")
    assert len(store.list_characters(project_id)) == 50
    with pytest.raises(ValueError, match="maximum number of characters"):
        store.create_character(project_id, name="第51个")
    # Deleting frees a slot.
    victim = store.list_characters(project_id)[0]
    assert store.delete_character(project_id, victim["id"])
    revived = store.create_character(project_id, name="补位", reference_asset_ids=[portrait["id"]])
    assert revived["name"] == "补位"


def test_storyboard_character_ids_must_belong_to_project(project) -> None:
    store, project_id = project
    character = store.create_character(project_id, name="主角")
    good = store.save_storyboard(
        project_id,
        {
            "shots": [
                {
                    "id": "s1",
                    "order": 0,
                    "title": "A",
                    "prompt": "a",
                    "character_ids": [character["id"]],
                }
            ]
        },
        expected_revision=0,
    )
    assert good["shots"][0]["character_ids"] == [character["id"]]

    with pytest.raises(ValueError, match="belong to the video project"):
        store.save_storyboard(
            project_id,
            {
                "shots": [
                    {
                        "id": "s2",
                        "order": 0,
                        "title": "B",
                        "prompt": "b",
                        "character_ids": ["character_ghost"],
                    }
                ]
            },
            expected_revision=1,
        )


@pytest.mark.asyncio
async def test_three_view_requires_confirmation_and_reference(
    tmp_path: Path,
) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    created = store.create_project("Cast")
    project_id = created["id"]
    character = store.create_character(project_id, name="阿澈")

    with pytest.raises(PermissionError, match="cost confirmation"):
        await service.create_character_three_view(
            store, project_id=project_id, character_id=character["id"], confirmed_cost=False
        )
    with pytest.raises(ValueError, match="reference image"):
        await service.create_character_three_view(
            store, project_id=project_id, character_id=character["id"], confirmed_cost=True
        )
    with pytest.raises(KeyError):
        await service.create_character_three_view(
            store, project_id=project_id, character_id="character_ghost", confirmed_cost=True
        )


@pytest.mark.asyncio
async def test_three_view_generates_and_binds_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    created = store.create_project("Cast")
    project_id = created["id"]
    portrait = _upload(store, project_id)
    character = store.create_character(
        project_id, name="阿澈", description="蓝发少年侦探", reference_asset_ids=[portrait["id"]]
    )

    import knorvia.services.image_studio.agent as image_agent
    import knorvia.services.image_studio.store as image_store_mod

    class _FakeImageStore:
        def __init__(self, root: Path):
            self.root = root
            self.root.mkdir(parents=True, exist_ok=True)
            self.saved: list[str] = []

        def ensure_default_project(self):
            return {"id": "imgproj"}

        def save_asset(self, _project_id, data: bytes, mime: str, *, kind: str):
            asset_id = f"img_asset_{len(self.saved) + 1}"
            (self.root / f"{asset_id}.png").write_bytes(data)
            self.saved.append(asset_id)
            return {"id": asset_id, "mime_type": mime}

        def get_asset(self, asset_id: str):
            if self.saved and asset_id == self.saved[-1]:
                return {"id": asset_id, "mime_type": "image/png"}
            return None

        def asset_path(self, asset_id: str) -> Path:
            return self.root / f"{asset_id}.png"

    images = _FakeImageStore(tmp_path / "images")
    monkeypatch.setattr(image_store_mod, "get_image_studio_store", lambda: images)

    captured: dict[str, Any] = {}

    def fake_plan(**kwargs):
        return {
            "prompt": kwargs.get("prompt"),
            "parameters": {},
            "input_asset_ids": list(kwargs.get("input_asset_ids") or []),
        }

    async def fake_run(plan: dict[str, Any]) -> dict[str, Any]:
        captured["plan"] = plan
        output = images.save_asset("imgproj", PNG, "image/png", kind="output")
        return {
            "job": {
                "id": "imgjob-3v",
                "status": "succeeded",
                "outputs": [{"asset_id": output["id"]}],
            }
        }

    monkeypatch.setattr(image_agent, "plan_studio_job", fake_plan)
    monkeypatch.setattr(image_agent, "run_studio_image_job", fake_run)

    result = await service.create_character_three_view(
        store,
        project_id=project_id,
        character_id=character["id"],
        confirmed_cost=True,
    )
    plan = captured["plan"]
    # Prompt is built from the character identity + three-view template.
    assert "阿澈" in plan["prompt"]
    assert "three-view" in plan["prompt"]
    assert plan["parameters"].get("n") == 1
    assert "target_resolution" not in plan["parameters"]
    # The first reference image is bridged into Image Studio, not passed raw.
    assert plan["input_asset_ids"] == ["img_asset_1"]
    assert plan["input_asset_ids"] != [portrait["id"]]

    asset = result["asset"]
    assert asset["kind"] == "image"
    # Bridged from Image Studio like shot keyframes: origin reflects the import.
    assert asset["origin"] == "uploaded"
    assert asset["filename"].startswith("three-view-")
    assert result["image_job_id"] == "imgjob-3v"
    refreshed = store.get_character(project_id, character["id"])
    assert refreshed["three_view_asset_id"] == asset["id"]
    assert store.asset_path(asset["id"]).exists()
    assert store.get_asset(asset["id"])["mime_type"] == "image/png"


@pytest.mark.asyncio
async def test_three_view_surfaces_provider_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    created = store.create_project("Cast")
    project_id = created["id"]
    portrait = _upload(store, project_id)
    character = store.create_character(
        project_id, name="阿澈", reference_asset_ids=[portrait["id"]]
    )

    import knorvia.services.image_studio.agent as image_agent
    import knorvia.services.image_studio.store as image_store_mod

    class _FakeImageStore:
        def ensure_default_project(self):
            return {"id": "imgproj"}

        def save_asset(self, _project_id, data: bytes, mime: str, *, kind: str):
            return {"id": "img_asset_1", "mime_type": mime}

        def get_asset(self, asset_id: str):
            return None

        def asset_path(self, asset_id: str) -> Path:
            raise KeyError(asset_id)

    monkeypatch.setattr(image_store_mod, "get_image_studio_store", lambda: _FakeImageStore())

    def fake_plan(**kwargs):
        return {
            "prompt": kwargs.get("prompt"),
            "parameters": {},
            "input_asset_ids": list(kwargs.get("input_asset_ids") or []),
        }

    async def failing(_plan: dict[str, Any]) -> dict[str, Any]:
        return {"job": {"id": "imgjob-x", "status": "failed", "error_message": "boom"}}

    monkeypatch.setattr(image_agent, "plan_studio_job", fake_plan)
    monkeypatch.setattr(image_agent, "run_studio_image_job", failing)
    with pytest.raises(RuntimeError, match="boom"):
        await service.create_character_three_view(
            store, project_id=project_id, character_id=character["id"], confirmed_cost=True
        )
    assert store.get_character(project_id, character["id"])["three_view_asset_id"] is None


@pytest.mark.asyncio
async def test_character_endpoints_crud_and_three_view(
    project, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, project_id = project
    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)
    portrait = _upload(store, project_id)

    created = await router.create_character(
        project_id,
        router.CharacterCreate(
            name="阿澈",
            description="蓝发少年侦探",
            reference_asset_ids=[portrait["id"]],
            voice_hint="bright young male",
        ),
    )
    character = created["character"]
    assert character["name"] == "阿澈"

    listing = await router.list_characters(project_id)
    assert [item["id"] for item in listing["characters"]] == [character["id"]]

    patched = await router.update_character(
        project_id,
        character["id"],
        router.CharacterUpdate(voice_hint="calm"),
    )
    assert patched["character"]["voice_hint"] == "calm"

    denied: list[dict[str, Any]] = []

    async def fake_three_view(_store, *, character_id="", **kwargs):
        if not kwargs.get("confirmed_cost"):
            raise PermissionError("Three-view generation requires explicit cost confirmation.")
        if not character_id or character_id == "ghost":
            raise KeyError(character_id)
        return {"asset": {"id": "a3v", "kind": "image"}, "character": patched["character"]}

    import knorvia.services.video_studio.service as service_mod

    monkeypatch.setattr(service_mod, "create_character_three_view", fake_three_view)
    # The router imports the service lazily; patch the name it resolves.
    payload = router.CharacterThreeViewCreate(confirmed_cost=False)
    with pytest.raises(HTTPException) as exc_info:
        await router.create_character_three_view_endpoint(project_id, character["id"], payload)
    assert exc_info.value.status_code == 409

    allowed = router.CharacterThreeViewCreate(confirmed_cost=True)
    response = await router.create_character_three_view_endpoint(
        project_id, character["id"], allowed
    )
    assert response["asset"]["id"] == "a3v"

    missing = router.CharacterThreeViewCreate(confirmed_cost=True)
    with pytest.raises(HTTPException) as exc_info:
        await router.create_character_three_view_endpoint(project_id, "ghost", missing)
    assert exc_info.value.status_code == 404

    await router.delete_character(project_id, character["id"])
    assert (await router.list_characters(project_id))["characters"] == []
