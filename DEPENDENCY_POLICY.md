# Dependency policy

The bare `knorvia` package is the lightweight runtime. Heavy or externally
exposed functionality is installed through `providers`, `rag`, `documents`,
`media`, `server`, `partners`, `math-animator` or the aggregate `app` extra.

- Direct dependencies require a concrete import or runtime reason.
- Major versions are bounded for parsers, provider SDKs and execution tools.
- Optional modules must import their third-party packages lazily and return a
  clear installation hint when an extra is absent.
- `uv.lock`, requirements mirrors and `pyproject.toml` are updated together.
- High/critical advisories block a release. Temporary exceptions require an
  owner, rationale, compensating control and expiry date.
- Dependency updates run Python tests, Web tests/build, package installation
  probes and critical Playwright journeys.

