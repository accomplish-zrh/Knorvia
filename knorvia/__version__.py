"""Single source of truth for the Knorvia version.

To cut a release, bump ``__version__`` here, commit, and tag the commit with
``v<__version__>`` (e.g. ``v1.7.0``). CI verifies the tag matches this value
before publishing to PyPI; the web sidebar badge and CLI banner read from this
file directly.

Versioning is independent from DeepTutor's 1.5.x line; 1.7.0 introduces
Knorvia's durable, agent-accessible Video Studio product line.
"""

__version__ = "1.8.0"

__all__ = ("__version__",)
