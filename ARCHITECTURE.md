# Architecture and ownership

Knorvia is a modular monolith. Entry points depend inward on application and
domain services; domain services may depend on `core`, but `core` must not
import API, CLI, Web or desktop code.

```text
Web / Desktop / CLI / HTTP+WS
              |
        application runtime
   (orchestrator, turns, registries)
              |
   domain services and capabilities
              |
        core protocols/models
              |
 provider, storage and OS adapters
```

## Ownership roles

| Area | Accountable role | Paths |
| --- | --- | --- |
| Runtime protocol | Runtime maintainer | `knorvia/core`, `knorvia/runtime`, `knorvia/services/session` |
| API and identity | Security/API maintainer | `knorvia/api`, `knorvia/multi_user` |
| Learning and knowledge | Learning maintainer | `knorvia/learning`, `knorvia/knowledge`, `knorvia/book` |
| Providers and tools | Agent platform maintainer | `knorvia/services/llm`, `knorvia/tools`, `knorvia/capabilities` |
| Media studios | Media maintainer | `knorvia/services/image_studio`, `knorvia/services/video_studio` |
| Web experience | Web maintainer | `web/app`, `web/components`, `web/lib` |
| Director Desk | 3D maintainer | `web/director-desk-src` |
| Packaging/release | Release maintainer | `packaging`, `desktop`, `scripts/release`, workflows |

Replace roles with repository team handles in `.github/CODEOWNERS` when those
teams exist; do not invent personal owners. Every area needs a primary and a
backup before production release.

## Dependency rules

- Routers validate transport data and call services; business rules do not
  live in routers.
- Stores implement persistence only; orchestration belongs in a service.
- Capabilities communicate through `UnifiedContext`, registries and
  `StreamBus`, not through Web or CLI modules.
- Provider-specific payloads stop at adapters. Persisted studio jobs and tool
  results remain provider-neutral.
- Frontend pages compose feature components; API clients and state machines
  live under `web/lib/<feature>`.
- New source files should remain below 800 lines. Existing larger files are a
  refactoring backlog and must not grow without an explicit exception.

## Refactoring sequence

1. Split pure schemas, validation and mapping helpers first.
2. Add characterization tests around the original public interface.
3. Move one responsibility at a time without changing routes or stored data.
4. Keep compatibility imports for one release when a public Python import
   moves.
5. Remove compatibility shims only with a changelog entry.

Priority seams are the knowledge router, research/question pipelines, video
store, session runtime, built-in tool catalog, and Video/Image Studio pages.

