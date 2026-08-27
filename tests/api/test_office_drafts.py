"""Auth-scoped coverage for ``PATCH /api/v1/chat/office-drafts/{id}``."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from knorvia.services.auth import TokenPayload
from knorvia.services.office_draft import OfficeDraftStore
from knorvia.services.path_service import PathService

AppFactory = Callable[[dict[str, TokenPayload | None], bool], tuple[TestClient, Path, Path]]


@pytest.fixture
def draft_app(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> AppFactory:
    from knorvia.api.routers import auth as auth_router
    from knorvia.api.routers import office_drafts
    from knorvia.multi_user import paths as multi_user_paths

    admin_root = tmp_path / "data"
    users_root = admin_root / "users"
    monkeypatch.setattr(multi_user_paths, "ADMIN_WORKSPACE_ROOT", admin_root)
    monkeypatch.setattr(multi_user_paths, "USERS_ROOT", users_root)
    monkeypatch.setattr(multi_user_paths, "_path_services", {})

    def make_app(
        tokens: dict[str, TokenPayload | None], auth_enabled: bool = True
    ) -> tuple[TestClient, Path, Path]:
        monkeypatch.setattr(auth_router, "AUTH_ENABLED", auth_enabled)
        monkeypatch.setattr(auth_router, "decode_token", lambda token: tokens.get(token))
        app = FastAPI()
        app.include_router(office_drafts.router, prefix="/api/v1")
        return TestClient(app), admin_root, users_root

    return make_app


def _alice_store(users_root: Path) -> tuple[PathService, OfficeDraftStore, str]:
    service = PathService(workspace_root=users_root / "u_alice")
    task_dir = service.get_task_workspace("chat", "turn-1")
    workspace = task_dir / "exec"
    workspace.mkdir(parents=True, exist_ok=True)
    store = OfficeDraftStore(
        task_dir,
        workspace_dir=workspace,
        public_root=service.get_public_outputs_root(),
    )
    draft_id = store.create()
    (store.draft_dir(draft_id) / "report.xlsx").write_bytes(b"draft-bytes")
    store.note_file(draft_id, "report.xlsx")
    return service, store, draft_id


def test_owner_can_merge_from_draft(draft_app) -> None:
    alice = TokenPayload(username="alice", role="user", user_id="u_alice")
    client, _admin_root, users_root = draft_app({"alice-token": alice})
    service, store, draft_id = _alice_store(users_root)
    assert store.status(draft_id)["status"] == "draft"

    with client:
        client.cookies.set("dt_token", "alice-token")
        response = client.patch(
            f"/api/v1/chat/office-drafts/{draft_id}",
            json={"action": "merge"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "merged"
    assert (service.get_task_workspace("chat", "turn-1") / "exec" / "report.xlsx").read_bytes() == (
        b"draft-bytes"
    )


def test_non_admin_user_is_allowed_on_own_draft(draft_app) -> None:
    """Outputs-style auth: a regular user may mutate their own drafts."""
    alice = TokenPayload(username="alice", role="user", user_id="u_alice")
    client, _admin_root, users_root = draft_app({"alice-token": alice})
    _service, store, draft_id = _alice_store(users_root)

    with client:
        client.cookies.set("dt_token", "alice-token")
        response = client.patch(
            f"/api/v1/chat/office-drafts/{draft_id}",
            json={"action": "discard"},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "discarded"
    assert store.status(draft_id)["status"] == "discarded"


def test_other_user_cannot_see_draft(draft_app) -> None:
    tokens = {
        "alice-token": TokenPayload(username="alice", role="user", user_id="u_alice"),
        "bob-token": TokenPayload(username="bob", role="user", user_id="u_bob"),
    }
    client, _admin_root, users_root = draft_app(tokens)
    _service, _store, draft_id = _alice_store(users_root)

    with client:
        client.cookies.set("dt_token", "bob-token")
        response = client.patch(
            f"/api/v1/chat/office-drafts/{draft_id}",
            json={"action": "merge"},
        )

    assert response.status_code == 404
    assert "draft-bytes" not in response.text


def test_unauthenticated_is_401(draft_app) -> None:
    alice = TokenPayload(username="alice", role="user", user_id="u_alice")
    client, _admin_root, users_root = draft_app({"alice-token": alice})
    _service, _store, draft_id = _alice_store(users_root)

    with client:
        response = client.patch(
            f"/api/v1/chat/office-drafts/{draft_id}",
            json={"action": "merge"},
        )

    assert response.status_code == 401


def test_invalid_action_is_422(draft_app) -> None:
    alice = TokenPayload(username="alice", role="user", user_id="u_alice")
    client, _admin_root, users_root = draft_app({"alice-token": alice})
    _service, _store, draft_id = _alice_store(users_root)

    with client:
        client.cookies.set("dt_token", "alice-token")
        response = client.patch(
            f"/api/v1/chat/office-drafts/{draft_id}",
            json={"action": "explode"},
        )

    assert response.status_code == 422


def test_merge_after_discard_conflicts(draft_app) -> None:
    alice = TokenPayload(username="alice", role="user", user_id="u_alice")
    client, _admin_root, users_root = draft_app({"alice-token": alice})
    _service, store, draft_id = _alice_store(users_root)
    store.discard(draft_id)

    with client:
        client.cookies.set("dt_token", "alice-token")
        response = client.patch(
            f"/api/v1/chat/office-drafts/{draft_id}",
            json={"action": "merge"},
        )

    assert response.status_code == 409


def test_get_returns_card_payload(draft_app) -> None:
    alice = TokenPayload(username="alice", role="user", user_id="u_alice")
    client, _admin_root, users_root = draft_app({"alice-token": alice})
    _service, _store, draft_id = _alice_store(users_root)

    with client:
        client.cookies.set("dt_token", "alice-token")
        response = client.get(f"/api/v1/chat/office-drafts/{draft_id}")

    assert response.status_code == 200
    body = response.json()
    assert body["draft_id"] == draft_id
    assert body["status"] == "draft"
    assert body["files"][0]["name"] == "report.xlsx"
