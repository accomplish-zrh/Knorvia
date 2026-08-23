from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import pytest

from knorvia.multi_user.models import LOCAL_ADMIN_ID
from knorvia.services.video_studio import service
from knorvia.services.video_studio.board import (
    BOARD_EDGE_ROLES,
    BOARD_TEMPLATE_IDS,
    export_board_to_shots,
    import_storyboard_shots,
    instantiate_template,
    normalize_board,
    place_template,
)
from knorvia.services.video_studio.capability_presets import get_capability_preset
from knorvia.services.video_studio.store import (
    BoardConflictError,
    VideoStudioStore,
)

MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isomtest-video"


def _upload(store: VideoStudioStore, project_id: str, data: bytes, mime: str, name: str):
    upload = store.create_upload(
        project_id, name, mime, len(data), hashlib.sha256(data).hexdigest()
    )
    store.write_upload_part(upload["id"], 0, data)
    return store.complete_upload(upload["id"])


def _option() -> dict[str, Any]:
    return {
        "capabilities": dict(get_capability_preset("seedance-fast-like")["capabilities"]),
        "defaults": {},
    }


def _payload(request_id: str = "board-1", **overrides):
    payload = {
        "operation": "text_to_video",
        "profile_id": "profile",
        "model_id": "model",
        "prompt": "a quiet lake",
        "input_asset_ids": [],
        "parameters": {},
        "client_request_id": request_id,
        "owner_user_id": LOCAL_ADMIN_ID,
        "config_revision": "revision",
    }
    payload.update(overrides)
    return payload


def _node(node_id: str, kind: str = "generate", **overrides) -> dict[str, Any]:
    node: dict[str, Any] = {"id": node_id, "kind": kind, "x": 0, "y": 0}
    node.update(overrides)
    return node


@pytest.fixture()
def project(tmp_path: Path) -> tuple[VideoStudioStore, str]:
    store = VideoStudioStore(tmp_path / "studio")
    created = store.create_project("Board")
    return store, created["id"]


def test_get_board_returns_empty_document(project) -> None:
    store, project_id = project
    board = store.get_board(project_id)
    assert board["revision"] == 0
    assert board["nodes"] == []
    assert board["edges"] == []
    assert board["groups"] == []
    assert board["viewport"] == {"x": 0.0, "y": 0.0, "scale": 1.0}
    assert (tmp_board := store.board_path(project_id)).exists() is False or tmp_board


def test_save_board_roundtrip_and_normalize(project) -> None:
    store, project_id = project
    document = {
        "revision": 0,
        "viewport": {"x": 100, "y": 50, "scale": 2},
        "nodes": [
            _node("note", "text", title="Identity", text="consistent character"),
            _node("gen", "generate", prompt="wide shot", operation="text_to_video"),
            _node("bad-kind", "timetrack"),
            _node("gen", "generate"),
        ],
        "edges": [
            {"id": "e1", "from": "note", "to": "gen", "role": "first-frame"},
            {"id": "e2", "from": "missing", "to": "gen"},
            {"id": "e3", "from": "gen", "to": "gen"},
        ],
        "groups": [{"id": "g1", "title": "Episode"}],
    }
    saved = store.save_board(project_id, document, expected_revision=0)
    assert saved["revision"] == 1
    assert [node["id"] for node in saved["nodes"]] == ["note", "gen"]
    # A first-frame edge must point at an image source in spirit, but the
    # normalizer only enforces structural rules; the role survives.
    assert saved["edges"][0]["role"] == "first-frame"
    assert len(saved["edges"]) == 1
    assert saved["groups"] == []

    again = store.get_board(project_id)
    assert again["revision"] == 1
    assert again["viewport"]["scale"] == 2


def test_board_put_conflict_rejects_stale_revision(project) -> None:
    store, project_id = project
    first = store.save_board(project_id, {"nodes": [_node("n1", "text")]}, expected_revision=0)
    assert first["revision"] == 1
    with pytest.raises(BoardConflictError) as exc_info:
        store.save_board(project_id, {"nodes": [_node("n2", "text")]}, expected_revision=0)
    assert exc_info.value.current_revision == 1
    # The rejected write must not bump the revision or change the document.
    assert store.get_board(project_id)["revision"] == 1
    assert [node["id"] for node in store.get_board(project_id)["nodes"]] == ["n1"]


def test_update_board_patches_without_replacing(project) -> None:
    store, project_id = project
    store.save_board(project_id, {"nodes": [_node("gen", "generate")]})
    saved = store.update_board(
        project_id,
        lambda document: document["nodes"][0].update({"prompt": "golden hour"}),
    )
    assert saved["revision"] == 2
    assert saved["nodes"][0]["prompt"] == "golden hour"


def test_board_caps_nodes_and_edges(project) -> None:
    store, project_id = project
    nodes = [_node(f"n{i}", "text") for i in range(230)]
    # 400 unique directed pairs among the 200 surviving nodes.
    edges = [
        {
            "id": f"e{i}",
            "from": f"n{i % 200}",
            "to": f"n{(i % 200 + 1 + i // 200) % 200}",
        }
        for i in range(500)
    ]
    saved = store.save_board(project_id, {"nodes": nodes, "edges": edges}, expected_revision=0)
    assert len(saved["nodes"]) == 200
    assert len(saved["edges"]) == 400


def test_corrupt_board_falls_back_to_backup(project) -> None:
    store, project_id = project
    # Two writes: the second leaves the first document behind as .bak.
    store.save_board(project_id, {"nodes": [_node("n1", "text")]})
    store.update_board(project_id, lambda document: document["nodes"].append(_node("n2", "text")))
    path = store.board_path(project_id)
    path.write_text("{not json", encoding="utf-8")
    # The backup is the last good document (n1), not the lost latest write.
    board = store.get_board(project_id)
    assert [node["id"] for node in board["nodes"]] == ["n1"]


def test_create_job_persists_board_node_and_rejects_unknown(project, monkeypatch) -> None:
    store, project_id = project
    store.save_board(
        project_id,
        {"nodes": [_node("gen", "generate", prompt="hello"), _node("note", "text")]},
    )
    monkeypatch.setattr(service, "find_video_option", lambda *a, **k: _option())
    job = store.create_job(project_id, _payload("board-job", board_node_id="gen"))
    assert job["board_node_id"] == "gen"

    with pytest.raises(ValueError, match="Board generate node not found"):
        store.create_job(project_id, _payload("board-job-2", board_node_id="missing"))
    with pytest.raises(ValueError, match="Board generate node not found"):
        store.create_job(project_id, _payload("board-job-3", board_node_id="note"))


def test_service_create_video_job_with_board_node(project, monkeypatch) -> None:
    store, project_id = project
    store.save_board(project_id, {"nodes": [_node("gen", "generate")]})
    monkeypatch.setattr(service, "find_video_option", lambda *a, **k: _option())
    monkeypatch.setattr(
        service,
        "capture_video_authorization",
        lambda *_: {"owner_user_id": LOCAL_ADMIN_ID, "config_revision": "revision"},
    )
    monkeypatch.setattr(service, "start_video_job", lambda *_: None)
    job = service.create_video_job(
        store,
        project_id=project_id,
        profile_id="profile",
        model_id="model",
        operation="text_to_video",
        prompt="a quiet lake",
        input_asset_ids=[],
        parameters={},
        client_request_id="board-service-1",
        confirmed_cost=True,
        board_node_id="gen",
    )
    assert job["board_node_id"] == "gen"
    node = store.get_board(project_id)["nodes"][0]
    assert node["status"] == "running"
    assert node["jobId"] == job["id"]


def test_patch_board_job_output_binds_result(project) -> None:
    store, project_id = project
    asset = store.save_output_bytes(project_id, MP4, "video/mp4")
    store.save_board(project_id, {"nodes": [_node("gen", "generate")]})
    board = store.update_board(
        project_id,
        lambda document: document["nodes"][0].update({"jobId": "video_job_x", "status": "running"}),
    )
    changed = store.patch_board_job_output(
        project_id,
        "video_job_x",
        status="succeeded",
        asset_id=asset["id"],
        duration=5.0,
    )
    assert changed is True
    node = store.get_board(project_id)["nodes"][0]
    assert node["status"] == "succeeded"
    assert node["outputAssetId"] == asset["id"]
    assert node["duration"] == 5.0
    # Idempotent second patch reports no change.
    assert (
        store.patch_board_job_output(
            project_id, "video_job_x", status="succeeded", asset_id=asset["id"]
        )
        is False
    )


def test_export_zip_contains_board(project) -> None:
    import zipfile

    store, project_id = project
    store.save_board(project_id, {"nodes": [_node("gen", "generate")]})
    with zipfile.ZipFile(store.export_project(project_id)) as archive:
        manifest = archive.read("manifest.json").decode("utf-8")
    import json

    payload = json.loads(manifest)
    assert payload["board"]["revision"] == 1
    assert payload["board"]["nodes"][0]["id"] == "gen"


# ── templates (spec §5.5) ────────────────────────────────────────────


@pytest.mark.parametrize(
    ("template_id", "node_count", "edge_count"),
    [
        ("shot-i2v", 2, 1),
        ("first-last", 3, 2),
        ("storyboard-6", 7, 6),
        ("character-episode", 6, 8),
        ("extend-chain", 2, 1),
        ("character-card", 7, 4),
    ],
)
def test_templates_place_nodes_without_jobs(
    template_id: str, node_count: int, edge_count: int
) -> None:
    fragment = instantiate_template(template_id)
    assert len(fragment["nodes"]) == node_count
    assert len(fragment["edges"]) == edge_count
    ids = {node["id"] for node in fragment["nodes"]}
    assert len(ids) == node_count  # ids are unique
    for node in fragment["nodes"]:
        # Templates only place nodes — no job state, no model commitment.
        assert "jobId" not in node
        assert "status" not in node
        assert "modelKey" not in node
    for edge in fragment["edges"]:
        assert edge["from"] in ids
        assert edge["to"] in ids
        assert edge["from"] != edge["to"]
        assert edge["role"] in BOARD_EDGE_ROLES
    # The fragment survives the normalizer untouched (server-side save path).
    normalized = normalize_board({"nodes": fragment["nodes"], "edges": fragment["edges"]})
    assert len(normalized["nodes"]) == node_count
    assert len(normalized["edges"]) == edge_count


def test_template_unknown_id_raises() -> None:
    with pytest.raises(ValueError, match="Unknown board template"):
        instantiate_template("storyboard-9")
    assert "storyboard-9" not in BOARD_TEMPLATE_IDS


def test_template_layout_table() -> None:
    """Origin-relative coordinates — must mirror instantiateBoardTemplate."""
    shot = instantiate_template("shot-i2v")
    assert [(n["kind"], n["x"], n["y"]) for n in shot["nodes"]] == [
        ("image", 0.0, 0.0),
        ("generate", 400.0, 0.0),
    ]
    assert shot["nodes"][1]["operation"] == "image_to_video"

    first_last = instantiate_template("first-last")
    assert [(n["kind"], n["x"], n["y"]) for n in first_last["nodes"]] == [
        ("image", 0.0, 0.0),
        ("image", 0.0, 344.0),
        ("generate", 400.0, 0.0),
    ]
    assert {edge["role"] for edge in first_last["edges"]} == {"first-frame", "last-frame"}

    grid = instantiate_template("storyboard-6")
    assert [(n["kind"], n["x"], n["y"]) for n in grid["nodes"]] == [
        ("text", 0.0, 0.0),
        ("generate", 304.0, 0.0),
        ("generate", 688.0, 0.0),
        ("generate", 1072.0, 0.0),
        ("generate", 1456.0, 0.0),
        ("generate", 1840.0, 0.0),
        ("generate", 2224.0, 0.0),
    ]
    assert all(edge["role"] == "reference" for edge in grid["edges"])
    assert {edge["from"] for edge in grid["edges"]} == {grid["nodes"][0]["id"]}

    episode = instantiate_template("character-episode")
    assert [(n["kind"], n["x"], n["y"]) for n in episode["nodes"]] == [
        ("text", 0.0, 0.0),
        ("image", 0.0, 204.0),
        ("generate", 400.0, 0.0),
        ("generate", 784.0, 0.0),
        ("generate", 400.0, 356.0),
        ("generate", 784.0, 356.0),
    ]
    roles = sorted(edge["role"] for edge in episode["edges"])
    assert roles == ["first-frame"] * 4 + ["reference"] * 4

    chain = instantiate_template("extend-chain")
    assert [(n["kind"], n["x"], n["y"]) for n in chain["nodes"]] == [
        ("video", 0.0, 0.0),
        ("generate", 400.0, 0.0),
    ]
    assert chain["nodes"][1]["operation"] == "extend"
    assert chain["edges"][0]["role"] == "continue-from"

    card = instantiate_template("character-card")
    assert [(n["kind"], n["x"], n["y"]) for n in card["nodes"]] == [
        ("text", 0.0, 0.0),
        ("image", 0.0, 204.0),
        ("image", 0.0, 548.0),
        ("generate", 400.0, 0.0),
        ("generate", 400.0, 356.0),
        ("generate", 400.0, 712.0),
        ("generate", 400.0, 1068.0),
    ]
    # Every generate card shares the three-view sheet as its reference.
    assert all(edge["role"] == "reference" for edge in card["edges"])
    assert {edge["from"] for edge in card["edges"]} == {card["nodes"][2]["id"]}
    assert {edge["to"] for edge in card["edges"]} == {node["id"] for node in card["nodes"][3:]}
    assert all(node["operation"] == "image_to_video" for node in card["nodes"][3:])

    # An explicit origin shifts every node by the same offset.
    shifted = instantiate_template("character-episode", (100.0, 40.0))
    assert (shifted["nodes"][0]["x"], shifted["nodes"][0]["y"]) == (100.0, 40.0)
    assert (shifted["nodes"][4]["x"], shifted["nodes"][4]["y"]) == (500.0, 396.0)


def test_template_layout_table_phase_f() -> None:
    """§Phase F3: the seven new scaffolds — origin-relative coordinates that
    must mirror instantiateBoardTemplate in web/lib/video-studio/board-logic.ts."""
    vertical = instantiate_template("vertical-series")
    assert [(n["kind"], n["x"], n["y"]) for n in vertical["nodes"]] == [
        ("text", 0.0, 0.0),
        ("generate", 304.0, 0.0),
        ("generate", 688.0, 0.0),
        ("generate", 1072.0, 0.0),
        ("generate", 1456.0, 0.0),
        ("generate", 1840.0, 0.0),
        ("generate", 2224.0, 0.0),
    ]
    assert all(node.get("ratio") == "9:16" for node in vertical["nodes"][1:])
    assert all(edge["role"] == "reference" for edge in vertical["edges"])

    product = instantiate_template("product-triptych")
    assert [(n["kind"], n["x"], n["y"]) for n in product["nodes"]] == [
        ("image", 0.0, 0.0),
        ("generate", 400.0, 0.0),
        ("generate", 400.0, 356.0),
        ("generate", 400.0, 712.0),
    ]
    assert all(edge["role"] == "first-frame" for edge in product["edges"])
    assert {edge["from"] for edge in product["edges"]} == {product["nodes"][0]["id"]}

    talking = instantiate_template("talking-head")
    assert [(n["kind"], n["x"], n["y"]) for n in talking["nodes"]] == [
        ("image", 0.0, 0.0),
        ("text", 0.0, 344.0),
        ("generate", 400.0, 0.0),
    ]
    assert sorted(edge["role"] for edge in talking["edges"]) == [
        "first-frame",
        "reference",
    ]

    narration = instantiate_template("text-to-video")
    assert [(n["kind"], n["x"], n["y"]) for n in narration["nodes"]] == [
        ("text", 0.0, 0.0),
        ("generate", 304.0, 0.0),
        ("generate", 688.0, 0.0),
        ("generate", 1072.0, 0.0),
        ("generate", 1456.0, 0.0),
    ]
    assert len(narration["edges"]) == 4

    compare = instantiate_template("compare-ab")
    assert [(n["kind"], n["x"], n["y"]) for n in compare["nodes"]] == [
        ("image", 0.0, 0.0),
        ("generate", 400.0, 0.0),
        ("generate", 400.0, 356.0),
    ]
    assert all(edge["role"] == "first-frame" for edge in compare["edges"])

    tutorial = instantiate_template("tutorial-steps")
    assert [(n["kind"], n["x"], n["y"]) for n in tutorial["nodes"]] == [
        ("text", 0.0, 0.0),
        ("video", 0.0, 204.0),
        ("generate", 400.0, 0.0),
        ("generate", 400.0, 356.0),
    ]
    assert all(node["operation"] == "extend" for node in tutorial["nodes"][2:])
    assert sorted(edge["role"] for edge in tutorial["edges"]) == [
        "continue-from",
        "reference",
    ]

    grid = instantiate_template("grid-nine")
    generate_nodes = [node for node in grid["nodes"] if node["kind"] == "generate"]
    assert len(generate_nodes) == 9
    assert len(grid["edges"]) == 9
    xs = {round(node["x"], 2) for node in generate_nodes}
    ys = {round(node["y"], 2) for node in generate_nodes}
    assert xs == {304.0, 688.0, 1072.0}
    assert ys == {0.0, 356.0, 712.0}


def test_template_endpoint_places_nodes(project) -> None:
    """The POST template route reduces to store.update_board + place_template."""
    store, project_id = project
    board = store.update_board(project_id, lambda document: place_template(document, "shot-i2v"))
    assert board["revision"] == 1
    assert len(board["nodes"]) == 2
    assert len(board["edges"]) == 1
    assert board["nodes"][0]["x"] == 0.0

    # A second template lands past the right edge (720 + 64 = 784).
    board = store.update_board(project_id, lambda document: place_template(document, "first-last"))
    assert board["revision"] == 2
    assert len(board["nodes"]) == 5
    assert len(board["edges"]) == 3
    assert board["nodes"][2]["x"] == 784.0

    with pytest.raises(ValueError):
        place_template({}, "not-a-template")


def test_template_does_not_create_jobs(project) -> None:
    store, project_id = project
    for template_id in BOARD_TEMPLATE_IDS:
        store.update_board(
            project_id,
            lambda document, tid=template_id: place_template(document, tid),
        )
    board = store.get_board(project_id)
    assert len(board["nodes"]) == 63  # 2+3+7+6+2+7 + 7+4+3+5+3+4+10 (§F3)
    assert all("jobId" not in node and "status" not in node for node in board["nodes"])
    assert store.list_jobs(project_id) == []


# ── strip ↔ board interop (spec §7.3) ────────────────────────────────


def test_import_storyboard_to_board(project) -> None:
    store, project_id = project
    asset = store.save_output_bytes(project_id, MP4, "video/mp4")
    store.save_storyboard(
        project_id,
        {
            "shots": [
                {"id": "s1", "title": "Opening", "prompt": "aerial pan over the lake"},
                {
                    "id": "s2",
                    "title": "",
                    "prompt": "hero walks north",
                    "output_asset_id": asset["id"],
                },
                {"id": "s3", "title": "Empty", "prompt": "   "},
            ]
        },
        expected_revision=0,
    )
    shots = store.get_storyboard(project_id)["shots"]
    counts: dict[str, int] = {}

    def mutator(document: dict[str, Any]) -> None:
        counts["imported"], counts["skipped"] = import_storyboard_shots(document, shots)

    board = store.update_board(project_id, mutator)
    assert counts["imported"] == 2
    assert counts["skipped"] == 1  # the promptless shot
    generates = [node for node in board["nodes"] if node["kind"] == "generate"]
    assert [node["prompt"] for node in generates] == [
        "aerial pan over the lake",
        "hero walks north",
    ]
    assert generates[0]["title"] == "Opening"
    assert generates[1]["title"] == "Shot 2"  # position-derived fallback title
    assert generates[0]["storyboardShotId"] == shots[0]["id"]
    assert generates[1]["storyboardShotId"] == shots[1]["id"]
    assert generates[0]["operation"] == "text_to_video"
    assert generates[1]["outputAssetId"] == asset["id"]
    # One horizontal row, 64px apart (320 wide nodes → 384 pitch).
    assert [node["x"] for node in generates] == [0.0, 384.0]
    assert generates[0]["y"] == generates[1]["y"] == 0.0
    assert all("jobId" not in node for node in generates)

    # Idempotent: the same shots import as duplicates on a second call.
    def mutator_again(document: dict[str, Any]) -> None:
        counts["imported"], counts["skipped"] = import_storyboard_shots(document, shots)

    board = store.update_board(project_id, mutator_again)
    assert counts["imported"] == 0
    assert counts["skipped"] == 3
    assert len(board["nodes"]) == 2

    # force re-imports even when title+prompt already exist.
    def mutator_force(document: dict[str, Any]) -> None:
        counts["imported"], counts["skipped"] = import_storyboard_shots(document, shots, force=True)

    board = store.update_board(project_id, mutator_force)
    assert counts["imported"] == 2
    assert counts["skipped"] == 1
    assert len(board["nodes"]) == 4


def _png_bytes() -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        + b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
        + b"\x00\x00\x00\x0aIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n\x2d\xb4"
        + b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )


def test_import_refreshes_linked_shot_in_place(project) -> None:
    store, project_id = project
    store.save_storyboard(
        project_id,
        {"shots": [{"id": "s1", "title": "Opening", "prompt": "aerial pan over the lake"}]},
        expected_revision=0,
    )
    shots = store.get_storyboard(project_id)["shots"]

    def import_once(document: dict[str, Any]) -> None:
        document_counts["imported"], document_counts["skipped"] = import_storyboard_shots(
            document, shots
        )

    document_counts: dict[str, int] = {}
    board = store.update_board(project_id, import_once)
    assert document_counts == {"imported": 1, "skipped": 0}
    node = next(item for item in board["nodes"] if item["kind"] == "generate")

    # The shot is edited in the storyboard (new prompt + output asset).
    asset = store.save_output_bytes(project_id, MP4, "video/mp4")
    edited = [dict(shots[0], prompt="slow dolly through the reeds", output_asset_id=asset["id"])]
    store.save_storyboard(project_id, {"shots": edited}, expected_revision=1)
    refreshed = store.get_storyboard(project_id)["shots"]

    def reimport(document: dict[str, Any]) -> None:
        document_counts["imported"], document_counts["skipped"] = import_storyboard_shots(
            document, refreshed
        )

    board = store.update_board(project_id, reimport)
    # The linked card is refreshed in place — never duplicated.
    generates = [item for item in board["nodes"] if item["kind"] == "generate"]
    assert len(generates) == 1
    assert generates[0]["id"] == node["id"]
    assert generates[0]["prompt"] == "slow dolly through the reeds"
    assert generates[0]["outputAssetId"] == asset["id"]
    assert document_counts == {"imported": 0, "skipped": 1}


def test_import_storyboard_places_keyframe_and_voiceover_nodes(project) -> None:
    store, project_id = project
    keyframe = _upload(store, project_id, _png_bytes(), "image/png", "kf.png")
    voiceover = _upload(store, project_id, b"ID3voiceover-audio", "audio/mpeg", "vo.mp3")
    store.save_storyboard(
        project_id,
        {
            "shots": [
                {
                    "id": "s1",
                    "title": "Opening",
                    "prompt": "a quiet lake at dawn",
                    "keyframe_asset_id": keyframe["id"],
                    "voiceover_asset_id": voiceover["id"],
                    "keyframe_prompt": "lake still, mist, first light",
                }
            ]
        },
        expected_revision=0,
    )
    shots = store.get_storyboard(project_id)["shots"]
    # The stored keyframe prompt survives the storyboard round trip.
    assert shots[0]["keyframe_prompt"] == "lake still, mist, first light"

    board = store.update_board(
        project_id,
        lambda document: import_storyboard_shots(document, shots),
    )
    generate = next(node for node in board["nodes"] if node["kind"] == "generate")
    image = next(node for node in board["nodes"] if node["kind"] == "image")
    audio = next(node for node in board["nodes"] if node["kind"] == "audio")
    # A keyframe turns the card into an image-to-video pipeline.
    assert generate["operation"] == "image_to_video"
    assert image["assetId"] == keyframe["id"]
    assert audio["assetId"] == voiceover["id"]
    roles = {(edge["from"], edge["to"]): edge["role"] for edge in board["edges"]}
    assert roles[(image["id"], generate["id"])] == "first-frame"
    assert roles[(audio["id"], generate["id"])] == "audio"
    # Keyframe sits above the card, voiceover below it.
    assert image["y"] < generate["y"] < audio["y"]


def test_export_board_to_storyboard(project) -> None:
    store, project_id = project
    asset = store.save_output_bytes(project_id, MP4, "video/mp4")
    store.save_storyboard(
        project_id,
        {"shots": [{"id": "s0", "title": "Existing", "prompt": "already there"}]},
        expected_revision=0,
    )
    store.save_board(
        project_id,
        {
            "nodes": [
                _node("g1", "generate", prompt="wide shot", operation="text_to_video"),
                _node(
                    "g2",
                    "generate",
                    prompt="close up",
                    title="Reaction",
                    operation="image_to_video",
                    outputAssetId=asset["id"],
                    duration=5,
                ),
                _node("note", "text", text="not exported"),
                _node("g3", "generate"),  # no prompt → not exported
            ]
        },
        expected_revision=0,
    )
    board = store.get_board(project_id)
    exported: dict[str, int] = {}

    def mutator(document: dict[str, Any]) -> None:
        shots, count = export_board_to_shots(board)
        exported["count"] = count
        base = len(document["shots"])
        for index, shot in enumerate(shots):
            shot["order"] = base + index
        document["shots"].extend(shots)

    storyboard = store.update_storyboard(project_id, mutator)
    assert exported["count"] == 2
    assert storyboard["revision"] == 2
    assert len(storyboard["shots"]) == 3  # one existing + two exported
    first, second = storyboard["shots"][1], storyboard["shots"][2]
    assert first["prompt"] == "wide shot"
    assert first["operation"] == "text_to_video"
    assert first["order"] == 1
    assert second["title"] == "Reaction"
    assert second["operation"] == "image_to_video"
    assert second["output_asset_id"] == asset["id"]
    assert second["duration"] == 5
    assert first["id"] != "g1" and second["id"] != "g2"  # fresh shot ids

    # The append survives a full storyboard read/validate round-trip.
    assert len(store.get_storyboard(project_id)["shots"]) == 3


def test_board_camera_field_roundtrip_and_normalize(project) -> None:
    store, project_id = project
    long_motion = "orbit-" + "y" * 80
    saved = store.save_board(
        project_id,
        {
            "nodes": [
                _node("g1", "generate", prompt="push in", camera=" push "),
                _node("g2", "generate", prompt="wide pan", camera=long_motion),
                _node("g3", "generate", prompt="static", camera="   "),
                _node("g4", "generate", prompt="tilt down"),
                _node("t1", "text", text="note", camera="only generate cards badge"),
            ]
        },
        expected_revision=0,
    )
    # The whitelist keeps trimmed camera values; empty stays unset and the
    # text node keeps its (ignored) field rather than crashing the save.
    assert saved["nodes"][0]["camera"] == "push"
    assert saved["nodes"][1]["camera"] == long_motion  # board cap is 4000
    assert "camera" not in saved["nodes"][2]
    assert "camera" not in saved["nodes"][3]
    assert store.get_board(project_id)["nodes"][0]["camera"] == "push"

    # Storyboard → board: the shot's camera lands on the generate card.
    store.save_storyboard(
        project_id,
        {
            "shots": [
                {"id": "s-cam", "title": "Plan", "prompt": "follow the runner", "camera": "follow"}
            ]
        },
        expected_revision=0,
    )
    shots = store.get_storyboard(project_id)["shots"]
    board = store.update_board(project_id, lambda doc: import_storyboard_shots(doc, shots))
    imported = next(n for n in board["nodes"] if n.get("prompt") == "follow the runner")
    assert imported["camera"] == "follow"

    # Board → storyboard: the node camera exports back onto the shot.
    exported_shots, count = export_board_to_shots(
        {
            "nodes": [
                _node("e1", "generate", prompt="orbit the statue", camera="orbit"),
                _node("e2", "generate", prompt="no camera intent"),
                _node("e3", "text", text="not exported", camera="drop me"),
            ]
        }
    )
    assert count == 2
    assert exported_shots[0]["camera"] == "orbit"
    assert "camera" not in exported_shots[1]
    # And the exported shape survives the storyboard validator.
    normalized = store._validate_storyboard(project_id, {"shots": exported_shots})
    assert normalized[0]["camera"] == "orbit"


def test_update_storyboard_rejects_unknown_project(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    with pytest.raises(KeyError):
        store.update_storyboard("video_project_missing", lambda document: None)
