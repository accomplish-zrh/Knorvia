"""Sandbox runner sidecar: a tiny HTTP service that executes untrusted shell.

Runs in its own least-privileged container, isolated from the main app. The
main app talks to it via :class:`knorvia.services.sandbox.backends.RunnerSidecarBackend`,
pointed at it through ``KNORVIA_SANDBOX_RUNNER_URL``.
"""
