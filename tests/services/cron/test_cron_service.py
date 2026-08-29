"""CronService: scheduling math, persistence, scheduler loop, owner scoping."""

from __future__ import annotations

import asyncio
import time

import pytest

from knorvia.services.cron.service import (
    CronOwner,
    CronSchedule,
    CronService,
    compute_next_run,
    validate_schedule,
)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _chat_owner(user_id: str = "local-admin") -> CronOwner:
    return CronOwner(kind="chat", user_id=user_id, session_id="s1")


class TestComputeNextRun:
    def test_at_future_and_expired(self):
        now = _now_ms()
        assert compute_next_run(CronSchedule(kind="at", at_ms=now + 5000), now) == now + 5000
        assert compute_next_run(CronSchedule(kind="at", at_ms=now - 5000), now) is None

    def test_every(self):
        now = _now_ms()
        assert compute_next_run(CronSchedule(kind="every", every_seconds=60), now) == now + 60_000
        assert compute_next_run(CronSchedule(kind="every", every_seconds=0), now) is None

    def test_cron_expression(self):
        pytest.importorskip("croniter")
        now = _now_ms()
        result = compute_next_run(CronSchedule(kind="cron", expr="0 9 * * *"), now)
        assert result is not None and result > now

    def test_bad_cron_expression_raises(self):
        pytest.importorskip("croniter")
        with pytest.raises(ValueError):
            compute_next_run(CronSchedule(kind="cron", expr="not a cron"), _now_ms())


class TestValidateSchedule:
    def test_rejects_past_at(self):
        with pytest.raises(ValueError):
            validate_schedule(CronSchedule(kind="at", at_ms=_now_ms() - 1000))

    def test_rejects_tiny_interval(self):
        with pytest.raises(ValueError):
            validate_schedule(CronSchedule(kind="every", every_seconds=5))

    def test_rejects_unknown_tz(self):
        pytest.importorskip("croniter")
        with pytest.raises(ValueError):
            validate_schedule(CronSchedule(kind="cron", expr="0 9 * * *", tz="Mars/Olympus"))


class TestJobManagement:
    def test_add_list_cancel_persist(self, tmp_path):
        store = tmp_path / "jobs.json"
        service = CronService(store_path=store)
        job = service.add_job(
            name="reminder",
            message="say hi",
            schedule=CronSchedule(kind="every", every_seconds=60),
            owner=_chat_owner(),
        )
        assert store.exists()

        # A fresh instance sees the persisted job.
        service2 = CronService(store_path=store)
        jobs = service2.list_jobs(owner_key="chat:local-admin")
        assert [j.id for j in jobs] == [job.id]
        assert jobs[0].state.next_run_at_ms is not None

        assert service2.cancel_job(job.id, owner_key="chat:local-admin") is True
        assert CronService(store_path=store).list_jobs() == []

    def test_owner_scoping(self, tmp_path):
        service = CronService(store_path=tmp_path / "jobs.json")
        chat_job = service.add_job(
            name="a",
            message="x",
            schedule=CronSchedule(kind="every", every_seconds=60),
            owner=_chat_owner(),
        )
        partner_job = service.add_job(
            name="b",
            message="y",
            schedule=CronSchedule(kind="every", every_seconds=60),
            owner=CronOwner(kind="partner", partner_id="ada", channel="telegram", chat_id="1"),
        )
        assert [j.id for j in service.list_jobs(owner_key="partner:ada")] == [partner_job.id]
        # Cancelling with the wrong owner is refused.
        assert service.cancel_job(chat_job.id, owner_key="partner:ada") is False
        assert service.remove_owner_jobs("partner:ada") == 1
        assert [j.id for j in service.list_jobs()] == [chat_job.id]

    def test_one_shot_defaults_to_delete_after_run(self, tmp_path):
        service = CronService(store_path=tmp_path / "jobs.json")
        job = service.add_job(
            name="once",
            message="x",
            schedule=CronSchedule(kind="at", at_ms=_now_ms() + 60_000),
            owner=_chat_owner(),
        )
        assert job.delete_after_run is True

    def test_corrupt_store_is_preserved_not_wiped(self, tmp_path):
        store = tmp_path / "jobs.json"
        store.write_text("{not json", encoding="utf-8")
        service = CronService(store_path=store)
        assert service.list_jobs() == []
        # The corrupt original was moved aside, not overwritten.
        assert any(p.name.startswith("jobs") and "corrupt" in p.name for p in tmp_path.iterdir())

    def test_per_owner_quota_is_enforced(self, tmp_path, monkeypatch):
        import knorvia.services.cron.service as service_module

        monkeypatch.setattr(service_module, "MAX_JOBS_PER_OWNER", 1)
        service = CronService(store_path=tmp_path / "jobs.json")
        service.add_job(
            name="one",
            message="x",
            schedule=CronSchedule(kind="every", every_seconds=60),
            owner=_chat_owner("u1"),
        )
        with pytest.raises(ValueError, match="limit"):
            service.add_job(
                name="two",
                message="y",
                schedule=CronSchedule(kind="every", every_seconds=60),
                owner=_chat_owner("u1"),
            )


class TestSchedulerLoop:
    @pytest.mark.asyncio
    async def test_due_job_fires_and_one_shot_is_removed(self, tmp_path):
        fired: list[str] = []

        async def on_job(job):
            fired.append(job.id)
            return "ok", None

        service = CronService(store_path=tmp_path / "jobs.json", on_job=on_job)
        job = service.add_job(
            name="soon",
            message="x",
            schedule=CronSchedule(kind="at", at_ms=_now_ms() + 150),
            owner=_chat_owner(),
        )
        await service.start()
        try:
            for _ in range(40):
                if fired:
                    break
                await asyncio.sleep(0.05)
        finally:
            await service.stop()
        assert fired == [job.id]
        assert service.get_job(job.id) is None  # one-shot removed after run

    @pytest.mark.asyncio
    async def test_failed_run_records_error(self, tmp_path):
        async def on_job(job):
            raise RuntimeError("boom")

        service = CronService(store_path=tmp_path / "jobs.json", on_job=on_job)
        service.add_job(
            name="failing",
            message="x",
            schedule=CronSchedule(kind="every", every_seconds=3600),
            owner=_chat_owner(),
        )
        # Force the job due immediately, then run one tick directly.
        job = service.list_jobs()[0]
        service.run_now(job.id)
        await service._tick()
        refreshed = service.get_job(job.id)
        assert refreshed is not None  # repeating job survives a failure
        assert refreshed.state.last_status == "error"
        assert "boom" in (refreshed.state.last_error or "")
        assert refreshed.state.next_run_at_ms is not None

    @pytest.mark.asyncio
    async def test_timeout_cancels_and_records_error(self, tmp_path, monkeypatch):
        import knorvia.services.cron.service as service_module

        monkeypatch.setattr(service_module, "JOB_TIMEOUT_SECONDS", 0.01)

        async def on_job(_job):
            await asyncio.sleep(60)
            return "ok", None

        service = CronService(store_path=tmp_path / "jobs.json", on_job=on_job)
        job = service.add_job(
            name="slow",
            message="x",
            schedule=CronSchedule(kind="every", every_seconds=3600),
            owner=_chat_owner(),
        )
        service.run_now(job.id)
        await service._tick()
        refreshed = service.get_job(job.id)
        assert refreshed is not None
        assert refreshed.state.last_status == "error"
        assert "timed out" in (refreshed.state.last_error or "")

    @pytest.mark.asyncio
    async def test_two_services_claim_one_due_run_only_once(self, tmp_path):
        store = tmp_path / "jobs.json"
        calls = 0

        async def on_job(_job):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.05)
            return "ok", None

        first = CronService(store_path=store, on_job=on_job)
        job = first.add_job(
            name="shared",
            message="x",
            schedule=CronSchedule(kind="every", every_seconds=3600),
            owner=_chat_owner(),
        )
        first.run_now(job.id)
        second = CronService(store_path=store, on_job=on_job)
        second.list_jobs()

        await asyncio.gather(first._tick(), second._tick())
        await second._tick()
        assert calls == 1


class TestLiveOwnerResolution:
    def test_persisted_admin_snapshot_is_ignored(self, monkeypatch):
        from knorvia.services import auth
        from knorvia.services.cron.executor import _resolve_chat_owner

        monkeypatch.setattr(auth, "AUTH_ENABLED", True)
        monkeypatch.setattr(
            auth,
            "list_users",
            lambda: [
                {
                    "id": "u1",
                    "username": "ada",
                    "role": "user",
                    "disabled": False,
                }
            ],
        )
        user, error = _resolve_chat_owner("u1")
        assert error is None and user is not None
        assert user.role == "user" and user.is_admin is False

    def test_disabled_owner_fails_closed(self, monkeypatch):
        from knorvia.services import auth
        from knorvia.services.cron.executor import _resolve_chat_owner

        monkeypatch.setattr(auth, "AUTH_ENABLED", True)
        monkeypatch.setattr(
            auth,
            "list_users",
            lambda: [
                {
                    "id": "u1",
                    "username": "ada",
                    "role": "admin",
                    "disabled": True,
                }
            ],
        )
        user, error = _resolve_chat_owner("u1")
        assert user is None
        assert "disabled" in (error or "")


class TestMutations:
    def test_set_enabled_and_run_now(self, tmp_path):
        service = CronService(store_path=tmp_path / "jobs.json")
        job = service.add_job(
            name="paused",
            message="x",
            schedule=CronSchedule(kind="every", every_seconds=3600),
            owner=_chat_owner(),
        )
        disabled = service.set_enabled(job.id, False, owner_key="chat:local-admin")
        assert disabled is not None and disabled.enabled is False
        assert service.set_enabled(job.id, False, owner_key="chat:someone-else") is None

        queued = service.run_now(job.id, owner_key="chat:local-admin")
        assert queued is not None
        assert queued.enabled is True
        assert queued.state.next_run_at_ms is not None
        assert queued.state.next_run_at_ms <= _now_ms()

    def test_update_job_name_message_session_and_schedule(self, tmp_path):
        service = CronService(store_path=tmp_path / "jobs.json")
        job = service.add_job(
            name="old",
            message="first",
            schedule=CronSchedule(kind="every", every_seconds=60),
            owner=_chat_owner("u1"),
        )
        updated = service.update_job(
            job.id,
            name="new",
            message="second",
            session_id="s-bound",
            schedule=CronSchedule(kind="every", every_seconds=120),
            owner_key="chat:u1",
        )
        assert updated is not None
        assert updated.name == "new"
        assert updated.message == "second"
        assert updated.owner.session_id == "s-bound"
        assert updated.schedule.every_seconds == 120
        assert service.update_job(job.id, name="nope", owner_key="chat:other") is None

    def test_update_job_rejects_empty_message(self, tmp_path):
        service = CronService(store_path=tmp_path / "jobs.json")
        job = service.add_job(
            name="keep",
            message="first",
            schedule=CronSchedule(kind="every", every_seconds=60),
            owner=_chat_owner(),
        )
        with pytest.raises(ValueError):
            service.update_job(job.id, message="   ")


class TestRunJournal:
    @pytest.mark.asyncio
    async def test_run_is_journalled_and_survives_one_shot_removal(self, tmp_path):
        async def on_job(job):
            return "ok", None

        service = CronService(store_path=tmp_path / "jobs.json", on_job=on_job)
        job = service.add_job(
            name="once",
            message="x",
            schedule=CronSchedule(kind="at", at_ms=_now_ms() + 60_000),
            owner=_chat_owner(),
        )
        service.run_now(job.id)
        await service._tick()
        assert service.get_job(job.id) is None  # one-shot cleaned up…

        runs = service.list_runs(owner_key=_chat_owner().key)
        assert len(runs) == 1  # …but its run stays visible in the journal
        entry = runs[0]
        assert (entry.job_id, entry.job_name, entry.status) == (job.id, "once", "ok")
        assert entry.error is None and entry.duration_ms >= 0

    @pytest.mark.asyncio
    async def test_journal_scopes_by_owner_newest_first(self, tmp_path):
        async def on_job(_job):
            return "ok", None

        service = CronService(store_path=tmp_path / "jobs.json", on_job=on_job)
        for user in ("u1", "u1", "u2"):
            job = service.add_job(
                name=f"job-{user}",
                message="x",
                schedule=CronSchedule(kind="every", every_seconds=3600),
                owner=_chat_owner(user),
            )
            service.run_now(job.id)
            await service._tick()

        mine = service.list_runs(owner_key="chat:u1")
        assert [entry.job_name for entry in mine] == ["job-u1", "job-u1"]
        assert all(entry.owner_key == "chat:u1" for entry in mine)
        assert mine[0].run_at_ms >= mine[1].run_at_ms

        everything = service.list_runs()
        assert {entry.owner_key for entry in everything} == {"chat:u1", "chat:u2"}

    @pytest.mark.asyncio
    async def test_journal_trims_to_cap(self, tmp_path, monkeypatch):
        import knorvia.services.cron.service as service_module

        monkeypatch.setattr(service_module, "MAX_RUN_LOG_ENTRIES", 5)

        async def on_job(_job):
            return "ok", None

        service = CronService(store_path=tmp_path / "jobs.json", on_job=on_job)
        job = service.add_job(
            name="loop",
            message="x",
            schedule=CronSchedule(kind="every", every_seconds=3600),
            owner=_chat_owner(),
        )
        for _ in range(8):
            service.run_now(job.id)
            await service._tick()

        runs = service.list_runs(limit=100)
        assert len(runs) <= 5
        lines = (tmp_path / "jobs.runs.jsonl").read_text(encoding="utf-8").splitlines()
        assert len(lines) <= 5

    def test_torn_tail_line_is_ignored(self, tmp_path):
        log = tmp_path / "jobs.runs.jsonl"
        log.write_text(
            '{"job_id":"a","job_name":"A","owner_key":"chat:u1","run_at_ms":2,'
            '"status":"ok","duration_ms":1,"error":null}\n'
            '{"job_id":"b","job_na',  # crash mid-append
            encoding="utf-8",
        )
        service = CronService(store_path=tmp_path / "jobs.json")
        runs = service.list_runs()
        assert [entry.job_id for entry in runs] == ["a"]
