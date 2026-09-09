# knorvia-rs

Knorvia public surface on top of the Codex-derived Kernel in `../codex-rs`.

Bins:

- `knorvia` — public CLI (never named `codex`)
- `knorvia-daemon` — product control plane; stdout is protocol frames only

Home: `KNORVIA_HOME` or `%LOCALAPPDATA%\Knorvia`. Not `~/.codex`.

Build (from this directory, with MSVC env on Windows):

```
cargo test --workspace
cargo build --bins
```
