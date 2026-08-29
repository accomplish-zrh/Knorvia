from __future__ import annotations

import os
import time

from knorvia.learning.models import (
    KnowledgeType,
    LearningProgress,
    RepetitionState,
    ReviewTask,
)

INTERVAL_SEQUENCES: dict[KnowledgeType, list[int]] = {
    KnowledgeType.MEMORY: [0, 1, 3, 7, 14, 30, 60],
    KnowledgeType.CONCEPT: [3, 7, 14, 30],
    KnowledgeType.PROCEDURE: [3, 7, 14],
    KnowledgeType.DESIGN: [14, 28],
}

_TYPE_PRIORITY: dict[KnowledgeType, int] = {
    KnowledgeType.MEMORY: 2,
    KnowledgeType.CONCEPT: 3,
    KnowledgeType.PROCEDURE: 4,
    KnowledgeType.DESIGN: 5,
}


# SM-2 constants (SuperMemo algorithm, supermemo.com/english/ol/sm2.htm).
SM2_DEFAULT_EASE = 2.5
SM2_MIN_EASE = 1.3


def sm2_ease_update(ease: float, quality: int) -> float:
    """EF' = EF + (0.1 - (5-q)*(0.08 + (5-q)*0.02)), clamped to >= 1.3."""
    updated = ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    return max(SM2_MIN_EASE, round(updated, 4))


class SpacedRepetitionScheduler:
    def __init__(self) -> None:
        # When True, intervals are in seconds instead of days (for testing)
        self.DEBUG_MODE: bool = os.environ.get("LEARNING_DEBUG", "").lower() in ("1", "true", "yes")

    def _seconds_per_unit(self) -> float:
        return 1.0 if self.DEBUG_MODE else 86400.0

    def get_initial_state(self, knowledge_type: KnowledgeType) -> RepetitionState:
        intervals = INTERVAL_SEQUENCES[knowledge_type]
        return RepetitionState(
            interval_index=0,
            consecutive_correct=0,
            consecutive_wrong=0,
            next_review_at=time.time() + intervals[0] * self._seconds_per_unit(),
            ease_factor=SM2_DEFAULT_EASE,
            last_interval_days=float(intervals[0]),
            repetitions=0,
        )

    def schedule_next(
        self,
        state: RepetitionState,
        knowledge_type: KnowledgeType,
        is_correct: bool | None = None,
        quality: int | None = None,
    ) -> RepetitionState:
        """Advance to the next review.

        ``quality`` is the SM-2 0-5 grade when the caller has it; otherwise it
        is derived from ``is_correct`` (True -> 4, False -> 1). Intervals use
        SM-2 multiplication once past the first two repetitions and are never
        shorter than the legacy ladder step for the current index.
        """
        intervals = INTERVAL_SEQUENCES[knowledge_type]
        max_index = len(intervals) - 1

        if quality is None:
            quality = 4 if is_correct else 1
        assert quality is not None
        quality = max(0, min(5, int(quality)))

        ease = state.ease_factor if state.ease_factor is not None else SM2_DEFAULT_EASE
        ease = sm2_ease_update(ease, quality)

        if quality < 3:
            # SM-2 relearn path: forget counts as wrong; interval resets.
            state.consecutive_wrong += 1
            state.consecutive_correct = 0
            state.repetitions = 0
            state.last_interval_days = float(intervals[0])
            state.interval_index = 0
            state.ease_factor = ease
            # Preserve the legacy "two consecutive wrongs resets the counter"
            # behaviour that existing users/tests rely on.
            if state.consecutive_wrong >= 2:
                state.consecutive_wrong = 0
            state.next_review_at = time.time() + intervals[0] * self._seconds_per_unit()
            return state

        # Correct path (quality >= 3): SM-2 interval progression.
        state.consecutive_wrong = 0
        state.consecutive_correct += 1
        state.repetitions += 1

        if state.repetitions == 1:
            interval_days = 1.0
        elif state.repetitions == 2:
            interval_days = 6.0
        else:
            base = state.last_interval_days or float(
                intervals[min(state.interval_index, max_index)]
            )
            interval_days = base * ease

        # Never shorter than the legacy ladder at the advanced index — keeps
        # behaviour recognisable for existing users and bounds regression.
        state.interval_index = min(state.interval_index + 1, max_index)
        ladder_floor = float(intervals[state.interval_index])
        interval_days = max(interval_days, ladder_floor)

        # Two correct answers in a row still fast-forwards one extra ladder
        # step for strong items (preserves the old acceleration behaviour).
        if state.consecutive_correct >= 2:
            state.interval_index = min(state.interval_index + 1, max_index)
            interval_days = max(interval_days, float(intervals[state.interval_index]))
            state.consecutive_correct = 0

        state.last_interval_days = interval_days
        state.ease_factor = ease
        state.next_review_at = time.time() + interval_days * self._seconds_per_unit()
        return state

    def get_due_tasks(self, progress: LearningProgress, max_tasks: int = 5) -> list[ReviewTask]:
        now = time.time()
        due = [t for t in progress.review_queue if t.due_at <= now]
        due.sort(key=lambda t: t.priority)
        return due[:max_tasks]

    def build_review_queue(self, progress: LearningProgress) -> list[ReviewTask]:
        tasks: list[ReviewTask] = []
        error_kps: set[str] = set()
        for rec in progress.error_records:
            if rec.status in ("active", "retrying"):
                error_kps.add(rec.knowledge_point_id)

        for kp_id, state in progress.repetition_states.items():
            kp_type = progress.knowledge_types.get(kp_id, KnowledgeType.MEMORY)
            priority = 1 if kp_id in error_kps else _TYPE_PRIORITY[kp_type]
            tasks.append(
                ReviewTask(
                    id=f"review_{kp_id}",
                    knowledge_point_id=kp_id,
                    knowledge_type=kp_type,
                    due_at=state.next_review_at,
                    priority=priority,
                    state=state,
                )
            )
        return tasks


__all__ = [
    "SpacedRepetitionScheduler",
    "INTERVAL_SEQUENCES",
    "sm2_ease_update",
    "SM2_DEFAULT_EASE",
    "SM2_MIN_EASE",
]
