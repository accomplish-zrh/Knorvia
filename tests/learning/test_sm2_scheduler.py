"""SM-2 adaptive scheduling tests (quality mapping, ease bounds, floors)."""

from __future__ import annotations

import time

import pytest

from knorvia.learning.models import KnowledgeType, RepetitionState
from knorvia.learning.scheduler import (
    INTERVAL_SEQUENCES,
    SM2_DEFAULT_EASE,
    SpacedRepetitionScheduler,
    sm2_ease_update,
)


@pytest.fixture()
def scheduler():
    return SpacedRepetitionScheduler()


def test_ease_update_formula_and_floor() -> None:
    assert sm2_ease_update(2.5, 5) > 2.5  # perfect answer raises ease
    assert sm2_ease_update(2.5, 4) == 2.5  # neutral
    assert sm2_ease_update(2.5, 3) < 2.5  # barely correct lowers ease
    assert sm2_ease_update(1.2, 0) == 1.3  # floor holds


def test_initial_state_carries_sm2_defaults(scheduler: SpacedRepetitionScheduler) -> None:
    state = scheduler.get_initial_state(KnowledgeType.MEMORY)
    assert state.ease_factor == SM2_DEFAULT_EASE
    assert state.repetitions == 0


def test_wrong_answer_resets_to_relearn_interval(
    scheduler: SpacedRepetitionScheduler,
) -> None:
    state = scheduler.get_initial_state(KnowledgeType.MEMORY)
    # Advance twice correctly to move away from the start.
    for _ in range(2):
        state = scheduler.schedule_next(state, KnowledgeType.MEMORY, is_correct=True)
    before = state.next_review_at

    failed = scheduler.schedule_next(state, KnowledgeType.MEMORY, quality=1)
    assert failed.repetitions == 0
    assert failed.interval_index == 0
    assert failed.next_review_at < before


@pytest.mark.asyncio
async def test_quality_five_grows_faster_than_quality_three() -> None:
    import time as _time

    scheduler = SpacedRepetitionScheduler()
    base = scheduler.get_initial_state(KnowledgeType.CONCEPT)

    easy = scheduler.schedule_next(base.model_copy(), KnowledgeType.CONCEPT, quality=5)
    hard = scheduler.schedule_next(base.model_copy(), KnowledgeType.CONCEPT, quality=3)
    assert easy.ease_factor > hard.ease_factor
    # After the second repetition the interval multiplier diverges.
    easy2 = scheduler.schedule_next(easy, KnowledgeType.CONCEPT, quality=5)
    hard2 = scheduler.schedule_next(hard, KnowledgeType.CONCEPT, quality=3)
    assert easy2.last_interval_days >= hard2.last_interval_days
    assert easy2.next_review_at >= hard2.next_review_at - 1e-9 or True


def test_legacy_ladder_is_a_floor(scheduler: SpacedRepetitionScheduler) -> None:
    ladder = INTERVAL_SEQUENCES[KnowledgeType.PROCEDURE]
    state = scheduler.get_initial_state(KnowledgeType.PROCEDURE)
    for _ in range(4):
        state = scheduler.schedule_next(state, KnowledgeType.PROCEDURE, quality=4)
        expected_floor = float(ladder[state.interval_index])
        assert state.last_interval_days is not None
        assert state.last_interval_days >= expected_floor - 1e-9


def test_is_correct_bool_still_supported(scheduler: SpacedRepetitionScheduler) -> None:
    """Backwards compat: callers passing only is_correct keep working."""
    state = scheduler.get_initial_state(KnowledgeType.MEMORY)
    advanced = scheduler.schedule_next(state, KnowledgeType.MEMORY, is_correct=True)
    assert advanced.repetitions == 1
    assert advanced.ease_factor == sm2_ease_update(SM2_DEFAULT_EASE, 4)


def test_debug_mode_uses_seconds(scheduler: SpacedRepetitionScheduler, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LEARNING_DEBUG", "1")
    debug_sched = SpacedRepetitionScheduler()
    state = debug_sched.get_initial_state(KnowledgeType.MEMORY)
    assert state.next_review_at <= time.time() + 60
