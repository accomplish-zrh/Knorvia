# Native Knorvia runtime

`knorvia-rs/` contains the current Knorvia protocol, durable store, control plane,
daemon, CLI, provider gateway, Kernel adapter, migration and capability host.
It is the source snapshot used with the current native desktop workbench.
Build caches, runtime state and developer credentials are not included.

## Build Knorvia components

Requires Rust with the 2024 edition and the platform's C/C++ build tools.
The source snapshot was verified with Rust 1.97.0 on Windows.

```sh
cd native/knorvia-rs
cargo test --workspace --locked
cargo build --release --locked -p knorvia-cli -p knorvia-daemon -p knorvia-packs
```

Kernel integration tests require a matching App Server and isolated local model
fixtures. Checks without that runtime may report an explicit environment skip.

## Codex-derived execution engine

Knorvia runs a private App Server as its execution engine. It does not attach to
the user's active Codex session. The accepted upstream baseline is:

- Repository: <https://github.com/openai/codex>
- Commit: `8e6a44b428e31f91b21edc97904fcdf4f0931ade`
- License: Apache-2.0, with upstream third-party notices retained
- Local upstream `codex-rs` changes: none at this handoff

Build that exact commit's `codex-rs` `codex-app-server` package using its own
toolchain and platform instructions. The upstream sources can be checked out
outside this repository. No entire upstream history or build cache is vendored.

```sh
git clone https://github.com/openai/codex.git knorvia-engine
git -C knorvia-engine checkout 8e6a44b428e31f91b21edc97904fcdf4f0931ade
cd knorvia-engine/codex-rs
cargo build --release --locked -p codex-app-server
```

For desktop development set `KNORVIA_DAEMON_BIN` to the built Knorvia daemon and
`KNORVIA_KERNEL_BIN` to the built App Server. The installer stages the App Server
as `knorvia-kernel-appserver.exe`; this is a distribution filename, not a separate
fork of its source. See [desktop build instructions](../desktop/README.md).

The snapshot under `native/knorvia-rs` is the public source of Knorvia's custom
runtime. Future changes should be made here and copied into any separate local
engine workspace only deliberately; do not silently maintain two divergent owners.
