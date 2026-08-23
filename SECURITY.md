# Knorvia security model

## Scope and trust boundaries

Knorvia handles model credentials, private documents, generated media and
agent-triggered side effects. The principal boundaries are:

1. browser/desktop client -> FastAPI HTTP and WebSocket API;
2. authenticated user -> per-user workspace and asset store;
3. agent/tool request -> sandbox, cron executor, MCP server or provider SDK;
4. uploaded/untrusted bytes -> parsers, previewers and media tools;
5. local configuration -> third-party model and channel providers.

`AUTH_ENABLED=false` is a local, single-user mode. It must never be used on a
network-reachable deployment. Production deployments must terminate TLS, set
an explicit origin allow-list, enable authentication and isolate each runtime
workspace with operating-system permissions.

## Threat register

| Area | Principal threats | Required controls | Verification |
| --- | --- | --- | --- |
| Authentication | token theft, weak signing secret, cross-user access, WebSocket bypass | strong external secret, expiry, HTTP/WS parity, admin separation, user ContextVar reset | auth router tests and cross-user negative tests |
| Uploads | path traversal, archive bombs, parser exploits, oversized files, active content | canonical workspace paths, byte/type limits, safe archive members, parser subprocess limits, download as attachment | upload traversal/size/MIME regression tests |
| Sandbox | prompt-command injection, host filesystem/network access, runaway process trees | explicit backend policy, no host shell for remote users, CPU/memory/time limits, process-tree termination, disposable workspaces | sandbox escape and timeout tests on every supported OS |
| Cron | privilege persistence, replay, unsafe command execution, timezone confusion | authenticated ownership, immutable creator, bounded schedule, tool allow-list, audit log, idempotency | ownership/replay/disabled-job tests |
| Credentials | secret disclosure through API/logs/prompts/backups | server-side secret fields, redaction, encrypted-at-rest integration where available, never serialize credentials to clients, scoped tokens | public-schema and log-redaction tests |
| Third parties | dependency compromise, malicious MCP/provider response, SSRF | pinned major versions, dependency audit, URL allow/deny policy, timeouts and response limits | CI dependency audit and SSRF tests |

## Release requirements

- Ruff, frontend lint, Python tests, TypeScript, Web build and critical browser
  journeys must pass.
- `pip-audit`, `npm audit` and Bandit findings rated high/critical block release;
  an exception requires an expiry date and compensating control in this file.
- No real credentials, runtime databases, user files or generated media may be
  included in source or release archives.
- Changes to authentication, uploads, sandboxing, cron or credential schemas
  require a security-focused reviewer in addition to the module owner.

## Time-bounded advisory exceptions

- `PYSEC-2026-1325` (`ecdsa`, transitive through `python-jose`) has no fixed
  release. Knorvia configures the cryptography-backed JWT algorithms and does
  not call `ecdsa` directly. Exception expires **2026-10-01**; migrate token
  handling to a maintained JOSE/JWT implementation before that date.
- ExcelJS currently brings an old `uuid` used by its workbook internals. The
  application does not pass attacker-controlled output buffers to UUID v3/v5/
  v6 generators. This moderate exception expires **2026-10-01** and does not
  waive high/critical npm findings.

## Incident response

Disable the affected capability using its feature flag, rotate exposed
credentials, preserve redacted logs, invalidate sessions, and publish the
affected versions and remediation. Do not attach private workspaces or raw
tokens to public reports.
