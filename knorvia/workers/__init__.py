"""Knorvia Python workers: supervised domain workers speaking Worker RPC.

The daemon spawns these processes for packs whose manifest declares a Python
runtime (e.g. media packs hosting the visualize / manim domain pipelines).
The worker speaks the same framed JSON-RPC over stdio as the Rust pack worker
(initialize / render / shutdown, progress notifications, cooperative cancel)
but hosts Python domain code — the ADR's "Python Workers: Media/Legacy
Bridge" row.

Workers hold no product-store authority: they render content and stream
progress; the daemon stages/verifies/publishes artifacts.
"""

from knorvia.workers.media_worker import MEDIA_PACKS, main

__all__ = ["MEDIA_PACKS", "main"]
