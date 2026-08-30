"""AI Classroom service (OpenMAIC-inspired interactive lessons)."""

from knorvia.services.classroom.models import ClassroomDocument
from knorvia.services.classroom.store import ClassroomStore, get_classroom_store

__all__ = ["ClassroomDocument", "ClassroomStore", "get_classroom_store"]
